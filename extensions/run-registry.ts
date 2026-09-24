import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Types and Schemas (Run Record V1)
// ============================================================================

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "paused"
  | "failed"
  | "completed"
  | "cancelled";

export interface RunCheckpoint {
  stepIndex: number;
  totalSteps: number;
  lastCompletedStep?: string;
  data?: Record<string, unknown>;
}

export interface RunRecordV1 {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  cwd: string;
  goalId?: string;
  planId?: string;
  stage: string;
  status: RunStatus;
  checkpoint: RunCheckpoint;
  model: string;
  agent: string;
  retryCount: number;
  lastError?: string;
  artifactPaths: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

// ============================================================================
// Process-Level Active Run Tracking
// ============================================================================

const activeProcessRunIds = new Set<string>();

export function markRunProcessActive(runId: string): void {
  activeProcessRunIds.add(runId);
}

export function unmarkRunProcessActive(runId: string): void {
  activeProcessRunIds.delete(runId);
}

export function isRunProcessActive(runId: string): boolean {
  return activeProcessRunIds.has(runId);
}

export function clearActiveProcessRuns(): void {
  activeProcessRunIds.clear();
}

// ============================================================================
// Schema Validation & Validation Helpers
// ============================================================================

export function validateRunRecordSchema(
  data: unknown
): { valid: true; record: RunRecordV1 } | { valid: false; error: string } {
  if (typeof data !== "object" || data === null) {
    return { valid: false, error: "Root data must be a JSON object" };
  }

  const obj = data as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    return { valid: false, error: `Unsupported schema version: ${String(obj.schemaVersion)} (expected: 1)` };
  }
  if (typeof obj.id !== "string" || !obj.id.trim()) {
    return { valid: false, error: "Field 'id' must be a non-empty string" };
  }
  if (typeof obj.sessionId !== "string" || !obj.sessionId.trim()) {
    return { valid: false, error: "Field 'sessionId' must be a non-empty string" };
  }
  if (typeof obj.cwd !== "string" || !obj.cwd.trim()) {
    return { valid: false, error: "Field 'cwd' must be a non-empty string" };
  }
  if (typeof obj.stage !== "string") {
    return { valid: false, error: "Field 'stage' must be a string" };
  }

  const validStatuses: RunStatus[] = [
    "queued",
    "running",
    "waiting_for_approval",
    "paused",
    "failed",
    "completed",
    "cancelled",
  ];
  if (typeof obj.status !== "string" || !validStatuses.includes(obj.status as RunStatus)) {
    return { valid: false, error: `Invalid 'status' field: '${String(obj.status)}'` };
  }

  if (typeof obj.checkpoint !== "object" || obj.checkpoint === null) {
    return { valid: false, error: "Field 'checkpoint' must be an object" };
  }
  const cp = obj.checkpoint as Record<string, unknown>;
  if (typeof cp.stepIndex !== "number" || typeof cp.totalSteps !== "number") {
    return { valid: false, error: "Field 'checkpoint' must contain stepIndex and totalSteps as numbers" };
  }

  if (typeof obj.model !== "string") {
    return { valid: false, error: "Field 'model' must be a string" };
  }
  if (typeof obj.agent !== "string") {
    return { valid: false, error: "Field 'agent' must be a string" };
  }
  if (typeof obj.retryCount !== "number") {
    return { valid: false, error: "Field 'retryCount' must be a number" };
  }
  if (!Array.isArray(obj.artifactPaths)) {
    return { valid: false, error: "Field 'artifactPaths' must be an array of strings" };
  }
  if (typeof obj.createdAt !== "string" || typeof obj.updatedAt !== "string") {
    return { valid: false, error: "Fields 'createdAt' and 'updatedAt' must be ISO strings" };
  }

  const record: RunRecordV1 = {
    schemaVersion: 1,
    id: obj.id,
    sessionId: obj.sessionId,
    cwd: obj.cwd,
    stage: obj.stage,
    status: obj.status as RunStatus,
    checkpoint: {
      stepIndex: cp.stepIndex,
      totalSteps: cp.totalSteps,
      ...(typeof cp.lastCompletedStep === "string" ? { lastCompletedStep: cp.lastCompletedStep } : {}),
      ...(typeof cp.data === "object" && cp.data !== null ? { data: cp.data as Record<string, unknown> } : {}),
    },
    model: obj.model,
    agent: obj.agent,
    retryCount: obj.retryCount,
    artifactPaths: obj.artifactPaths.map(String),
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    ...(typeof obj.goalId === "string" ? { goalId: obj.goalId } : {}),
    ...(typeof obj.planId === "string" ? { planId: obj.planId } : {}),
    ...(typeof obj.lastError === "string" ? { lastError: obj.lastError } : {}),
    ...(typeof obj.startedAt === "string" ? { startedAt: obj.startedAt } : {}),
    ...(typeof obj.finishedAt === "string" ? { finishedAt: obj.finishedAt } : {}),
  };

  return { valid: true, record };
}

// ============================================================================
// Storage & Persistence (.pi/runs/<id>.json)
// ============================================================================

export function getRunsDirectory(cwd: string): string {
  return path.join(path.resolve(cwd), ".pi", "runs");
}

export function saveRunRecordAtomic(cwd: string, record: RunRecordV1): { success: boolean; error?: string } {
  try {
    const runsDir = getRunsDirectory(cwd);
    if (!fs.existsSync(runsDir)) {
      fs.mkdirSync(runsDir, { recursive: true });
    }

    const targetFile = path.join(runsDir, `${record.id}.json`);
    const tempFile = path.join(
      runsDir,
      `${record.id}.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    );

    const serialized = JSON.stringify(record, null, 2);
    fs.writeFileSync(tempFile, serialized, "utf8");
    fs.renameSync(tempFile, targetFile);

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to save run record atomically: ${msg}` };
  }
}

export function loadRunRecordValidated(
  cwd: string,
  runId: string
): { record: RunRecordV1 | null; diagnostic?: string } {
  const runsDir = getRunsDirectory(cwd);
  const targetFile = path.join(runsDir, `${runId}.json`);

  if (!fs.existsSync(targetFile)) {
    return { record: null, diagnostic: `Run with ID '${runId}' not found at ${targetFile}.` };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(targetFile, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { record: null, diagnostic: `Cannot read file ${targetFile}: ${msg}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { record: null, diagnostic: `File ${targetFile} is corrupted (invalid JSON): ${msg}` };
  }

  const validation = validateRunRecordSchema(parsed);
  if (!validation.valid) {
    return { record: null, diagnostic: `File ${targetFile} does not match schema (${validation.error})` };
  }
  if (!validation.record) {
    return { record: null, diagnostic: `File ${targetFile} is empty or invalid.` };
  }

  // Canonical directory check
  if (path.resolve(validation.record.cwd) !== path.resolve(cwd)) {
    return {
      record: null,
      diagnostic: `Run '${runId}' is registered for another directory ('${validation.record.cwd}'), not the active directory ('${path.resolve(cwd)}').`,
    };
  }

  return { record: validation.record };
}

export function listRunRecords(cwd: string): { records: RunRecordV1[]; diagnostics: string[] } {
  const runsDir = getRunsDirectory(cwd);
  const records: RunRecordV1[] = [];
  const diagnostics: string[] = [];

  if (!fs.existsSync(runsDir)) {
    return { records, diagnostics };
  }

  let files: string[] = [];
  try {
    files = fs.readdirSync(runsDir);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    diagnostics.push(`Failed to read directory ${runsDir}: ${msg}`);
    return { records, diagnostics };
  }

  for (const file of files) {
    if (!file.endsWith(".json") || file.includes(".tmp.")) continue;
    const runId = file.replace(/\.json$/, "");
    const res = loadRunRecordValidated(cwd, runId);
    if (res.record) {
      records.push(res.record);
    } else if (res.diagnostic) {
      diagnostics.push(res.diagnostic);
    }
  }

  // Sort by updatedAt descending
  records.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return { records, diagnostics };
}

// ============================================================================
// Prompts & Formatters
// ============================================================================

export function formatRunResumePrompt(run: RunRecordV1): string {
  const nextStepIndex = run.checkpoint.stepIndex + 1;
  const total = run.checkpoint.totalSteps;

  return [
    `[RUN RESUME: ${run.id}]`,
    `Stage: "${run.stage}" | Plan ID: "${run.planId || "none"}" | Goal ID: "${run.goalId || "none"}"`,
    `Resume Checkpoint: Resuming from Step ${nextStepIndex} of ${total} total steps.`,
    run.checkpoint.lastCompletedStep ? `Last completed step: "${run.checkpoint.lastCompletedStep}"` : `No previously completed step.`,
    ``,
    `STRICT RESUME RULES:`,
    `1. Use the saved plan and checkpoint above. DO NOT plan again from scratch.`,
    `2. Directly continue execution starting from the unfinished step (${nextStepIndex}).`,
    `3. After step completion, update checkpoint and verify results before proceeding.`,
  ].join("\n");
}

export function detectActiveGoalReference(ctx: ExtensionContext): string | undefined {
  try {
    const entries = ctx.sessionManager?.getEntries?.() || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as { type?: string; customType?: string; data?: any };
      if (e.type === "custom" && (e.customType === "goal" || e.customType === "pi_goal")) {
        if (e.data && typeof e.data.id === "string") return e.data.id;
      }
    }
  } catch {}
  return undefined;
}

// ============================================================================
// Extension Registration
// ============================================================================

export default function (pi: ExtensionAPI) {
  // 1. /run-status [id]
  pi.registerCommand("run-status", {
    description: "Display status details, stage, checkpoint, and artifacts for a run",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const runId = args.trim();
      let targetRecord: RunRecordV1 | null = null;

      if (runId) {
        const res = loadRunRecordValidated(ctx.cwd, runId);
        if (!res.record) {
          ctx.ui?.notify(res.diagnostic || `Run '${runId}' not found.`, "error");
          return;
        }
        targetRecord = res.record;
      } else {
        const { records } = listRunRecords(ctx.cwd);
        if (records.length === 0) {
          ctx.ui?.notify("No run history in this directory. Use /run-list to see available runs.", "info");
          return;
        }
        const active = records.find((r) => isRunProcessActive(r.id));
        targetRecord = active || records[0];
      }

      const isCurrentActive = isRunProcessActive(targetRecord.id);
      const isRecoverable = !isCurrentActive && (targetRecord.status === "running" || targetRecord.status === "paused");

      const processIndicator = isCurrentActive
        ? "[ACTIVE IN CURRENT PROCESS]"
        : isRecoverable
        ? "[RESTART-RECOVERABLE]"
        : "[PERSISTED RECORD]";

      const infoLines = [
        `=== RUN STATUS: ${targetRecord.id} ===`,
        `Process Status : ${processIndicator}`,
        `Status         : ${targetRecord.status.toUpperCase()}`,
        `Stage          : ${targetRecord.stage}`,
        `Checkpoint     : Step ${targetRecord.checkpoint.stepIndex} of ${targetRecord.checkpoint.totalSteps}${
          targetRecord.checkpoint.lastCompletedStep ? ` (Last: ${targetRecord.checkpoint.lastCompletedStep})` : ""
        }`,
        `Plan ID        : ${targetRecord.planId || "(none)"}`,
        `Goal ID        : ${targetRecord.goalId || "(none)"}`,
        `Model / Agent  : ${targetRecord.model} / ${targetRecord.agent}`,
        `Retries        : ${targetRecord.retryCount}`,
        targetRecord.lastError ? `Last Error     : ${targetRecord.lastError}` : "",
        `Artifacts      : ${targetRecord.artifactPaths.length > 0 ? targetRecord.artifactPaths.join(", ") : "(none)"}`,
        `Created        : ${targetRecord.createdAt}`,
        `Updated        : ${targetRecord.updatedAt}`,
      ].filter(Boolean);

      ctx.ui?.notify(infoLines.join("\n"), "info");
    },
  });

  // 2. /run-list
  pi.registerCommand("run-list", {
    description: "List all persistent runs in .pi/runs/ for this project",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const { records, diagnostics } = listRunRecords(ctx.cwd);

      if (records.length === 0) {
        ctx.ui?.notify("No runs found in .pi/runs/.", "info");
        return;
      }

      const lines = [
        `=== RUN REGISTRY (${records.length} runs found) ===`,
        ...records.map((r, idx) => {
          const isActive = isRunProcessActive(r.id);
          const isRecoverable = !isActive && (r.status === "running" || r.status === "paused");
          const tag = isActive ? "[ACTIVE]" : isRecoverable ? "[RESTART]" : `[${r.status.toUpperCase()}]`;
          return `${idx + 1}. ${tag} ${r.id} (${r.stage}) - Step ${r.checkpoint.stepIndex}/${r.checkpoint.totalSteps} (Updated: ${r.updatedAt})`;
        }),
      ];

      if (diagnostics.length > 0) {
        lines.push("", "Diagnostics / Warnings:");
        diagnostics.forEach((d) => lines.push(`  - ${d}`));
      }

      ctx.ui?.notify(lines.join("\n"), "info");
    },
  });

  // 3. /run-pause <id>
  pi.registerCommand("run-pause", {
    description: "Pause an active run and save its checkpoint",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui?.notify("Run ID is required: /run-pause <id>", "warning");
        return;
      }

      const res = loadRunRecordValidated(ctx.cwd, runId);
      if (!res.record) {
        ctx.ui?.notify(res.diagnostic || `Run '${runId}' not found.`, "error");
        return;
      }

      const record = res.record;
      if (record.status === "completed" || record.status === "cancelled") {
        ctx.ui?.notify(`Run '${runId}' is already ${record.status} and cannot be paused.`, "warning");
        return;
      }

      record.status = "paused";
      record.updatedAt = new Date().toISOString();

      const saveRes = saveRunRecordAtomic(ctx.cwd, record);
      if (!saveRes.success) {
        ctx.ui?.notify(saveRes.error || "Failed to update run status.", "error");
        return;
      }

      unmarkRunProcessActive(runId);
      ctx.ui?.notify(`Run '${runId}' paused. Use /run-resume ${runId} to resume.`, "info");
    },
  });

  // 4. /run-resume <id>
  pi.registerCommand("run-resume", {
    description: "Resume a run directly from its saved checkpoint without replanning from scratch",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui?.notify("Run ID is required: /run-resume <id>", "warning");
        return;
      }

      const res = loadRunRecordValidated(ctx.cwd, runId);
      if (!res.record) {
        ctx.ui?.notify(res.diagnostic || `Run '${runId}' not found.`, "error");
        return;
      }

      const record = res.record;
      if (record.status === "completed") {
        ctx.ui?.notify(`Run '${runId}' is already completed and cannot be resumed.`, "warning");
        return;
      }
      if (record.status === "cancelled") {
        ctx.ui?.notify(`Run '${runId}' was cancelled and cannot be resumed.`, "warning");
        return;
      }

      record.status = "running";
      record.updatedAt = new Date().toISOString();

      const saveRes = saveRunRecordAtomic(ctx.cwd, record);
      if (!saveRes.success) {
        ctx.ui?.notify(saveRes.error || "Failed to update run resume status.", "error");
        return;
      }

      markRunProcessActive(runId);
      ctx.ui?.notify(`Resuming run '${runId}' from Step ${record.checkpoint.stepIndex + 1}/${record.checkpoint.totalSteps}...`, "info");

      pi.sendUserMessage(formatRunResumePrompt(record));
    },
  });

  // 5. /run-cancel <id>
  pi.registerCommand("run-cancel", {
    description: "Cancel a run and record finished timestamp",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const runId = args.trim();
      if (!runId) {
        ctx.ui?.notify("Run ID is required: /run-cancel <id>", "warning");
        return;
      }

      const res = loadRunRecordValidated(ctx.cwd, runId);
      if (!res.record) {
        ctx.ui?.notify(res.diagnostic || `Run '${runId}' not found.`, "error");
        return;
      }

      const record = res.record;
      record.status = "cancelled";
      record.finishedAt = new Date().toISOString();
      record.updatedAt = new Date().toISOString();

      const saveRes = saveRunRecordAtomic(ctx.cwd, record);
      if (!saveRes.success) {
        ctx.ui?.notify(saveRes.error || "Failed to update run cancellation.", "error");
        return;
      }

      unmarkRunProcessActive(runId);
      ctx.ui?.notify(`Run '${runId}' cancelled.`, "info");
    },
  });
}
