import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  safePostJson,
  validateEndpointUrl,
  resolveSecureApiKey,
  sanitizeErrorMessage,
  isExternalOptInEnabled,
} from "./security-guard.js";
import {
  type CommandIntent,
  notifyStateFallback,
  parseBuildIntent,
  parsePlanIntent,
  parseDebugIntent,
  parseReviewIntent,
  parseBtwIntent,
} from "./command-intent.js";

export {
  type CommandIntent,
  notifyStateFallback,
  parseBuildIntent,
  parsePlanIntent,
  parseDebugIntent,
  parseReviewIntent,
  parseBtwIntent,
};

// ============================================================================
// Types and Schemas
// ============================================================================

export type WorkflowMode = "idle" | "plan" | "build" | "debug" | "review";

export type PlanStatus = "draft" | "approved" | "running" | "completed" | "failed";

export type PlanContentSource = "agent" | "draft_placeholder";

export interface WorkflowPlanV1 {
  schemaVersion: 1;
  sessionId: string;
  cwd: string;
  goal: string;
  status: PlanStatus;
  planCaptured: boolean;
  contentSource: PlanContentSource;
  steps: string[];
  risks: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  createdAt: string;
  updatedAt: string;
  errorSummary?: string;
}

export interface BtwActivity {
  id: string;
  question: string;
  answer?: string;
  status: "pending" | "answered" | "failed";
  error?: string;
  timestamp: string;
}

export interface BtwQueueItem {
  id: string;
  question: string;
  contextSummary: string;
  queuedAt: string;
}

export interface SessionWorkflowState {
  sessionId: string;
  cwd: string;
  activeMode: WorkflowMode;
  currentPlan?: WorkflowPlanV1;
  btwActive: boolean;
  btwQueue: BtwQueueItem[];
  btwAbortController: AbortController | null;
  btwHistory: BtwActivity[];
}

export const READ_ONLY_TOOL_ALLOWLIST = new Set<string>([
  "read",
  "grep",
  "find",
  "ls",
]);

// Map session state scoped per sessionId + canonical cwd
const sessionStates = new Map<string, SessionWorkflowState>();

function getSessionKey(sessionId: string, cwd: string): string {
  return `${sessionId}:::${path.resolve(cwd)}`;
}

export function getOrCreateSessionState(sessionId: string, cwd: string): SessionWorkflowState {
  const key = getSessionKey(sessionId, cwd);
  let state = sessionStates.get(key);
  if (!state) {
    state = {
      sessionId,
      cwd: path.resolve(cwd),
      activeMode: "idle",
      btwActive: false,
      btwQueue: [],
      btwAbortController: null,
      btwHistory: [],
    };
    sessionStates.set(key, state);
  }
  return state;
}

export function resetSessionWorkflowState(sessionId?: string, cwd?: string): void {
  if (!sessionId || !cwd) return;
  const key = getSessionKey(sessionId, cwd);
  const state = sessionStates.get(key);
  if (state) {
    if (state.btwAbortController) {
      state.btwAbortController.abort();
      state.btwAbortController = null;
    }
    state.btwActive = false;
    state.btwQueue = [];
    state.activeMode = "idle";
  }
}

export function clearAllSessionWorkflowStates(): void {
  for (const state of sessionStates.values()) {
    if (state.btwAbortController) {
      state.btwAbortController.abort();
    }
  }
  sessionStates.clear();
}

export function validatePlanSchema(data: unknown): { valid: true; plan: WorkflowPlanV1 } | { valid: false; error: string } {
  if (typeof data !== "object" || data === null) {
    return { valid: false, error: "Root data must be a JSON object" };
  }

  const obj = data as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    return { valid: false, error: `Unsupported schema version: ${String(obj.schemaVersion)} (expected: 1)` };
  }
  if (typeof obj.sessionId !== "string" || !obj.sessionId.trim()) {
    return { valid: false, error: "Field 'sessionId' must be a non-empty string" };
  }
  if (typeof obj.cwd !== "string" || !obj.cwd.trim()) {
    return { valid: false, error: "Field 'cwd' must be a non-empty string" };
  }
  if (typeof obj.goal !== "string" || !obj.goal.trim()) {
    return { valid: false, error: "Field 'goal' must be a non-empty string" };
  }

  const validStatuses: PlanStatus[] = ["draft", "approved", "running", "completed", "failed"];
  if (typeof obj.status !== "string" || !validStatuses.includes(obj.status as PlanStatus)) {
    return { valid: false, error: `Invalid 'status' field: '${String(obj.status)}'` };
  }

  if (typeof obj.planCaptured !== "boolean") {
    return { valid: false, error: "Field 'planCaptured' must be a boolean" };
  }
  const validSources: PlanContentSource[] = ["agent", "draft_placeholder"];
  if (typeof obj.contentSource !== "string" || !validSources.includes(obj.contentSource as PlanContentSource)) {
    return { valid: false, error: `Invalid 'contentSource' field: '${String(obj.contentSource)}'` };
  }

  if (!Array.isArray(obj.steps)) {
    return { valid: false, error: "Field 'steps' must be an array of strings" };
  }
  if (!Array.isArray(obj.risks)) {
    return { valid: false, error: "Field 'risks' must be an array of strings" };
  }
  if (!Array.isArray(obj.acceptanceCriteria)) {
    return { valid: false, error: "Field 'acceptanceCriteria' must be an array of strings" };
  }
  if (!Array.isArray(obj.verificationCommands)) {
    return { valid: false, error: "Field 'verificationCommands' must be an array of strings" };
  }
  if (typeof obj.createdAt !== "string") {
    return { valid: false, error: "Field 'createdAt' must be an ISO date string" };
  }
  if (typeof obj.updatedAt !== "string") {
    return { valid: false, error: "Field 'updatedAt' must be an ISO date string" };
  }

  const plan: WorkflowPlanV1 = {
    schemaVersion: 1,
    sessionId: obj.sessionId,
    cwd: obj.cwd,
    goal: obj.goal,
    status: obj.status as PlanStatus,
    planCaptured: obj.planCaptured,
    contentSource: obj.contentSource as PlanContentSource,
    steps: obj.steps.map(String),
    risks: obj.risks.map(String),
    acceptanceCriteria: obj.acceptanceCriteria.map(String),
    verificationCommands: obj.verificationCommands.map(String),
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    ...(typeof obj.errorSummary === "string" ? { errorSummary: obj.errorSummary } : {}),
  };

  return { valid: true, plan };
}

export function savePlanAtomic(cwd: string, plan: WorkflowPlanV1): { success: boolean; error?: string } {
  try {
    const planDir = path.join(path.resolve(cwd), ".pi");
    if (!fs.existsSync(planDir)) {
      fs.mkdirSync(planDir, { recursive: true });
    }

    const targetFile = path.join(planDir, "active-plan.json");
    const tempFile = path.join(
      planDir,
      `active-plan.json.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    );

    const serialized = JSON.stringify(plan, null, 2);
    fs.writeFileSync(tempFile, serialized, "utf8");
    fs.renameSync(tempFile, targetFile);

    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to save plan atomically: ${msg}` };
  }
}

export function loadPlanValidated(
  cwd: string,
  expectedSessionId?: string
): { plan: WorkflowPlanV1 | null; diagnostic?: string } {
  const planDir = path.join(path.resolve(cwd), ".pi");
  const planFile = path.join(planDir, "active-plan.json");

  if (!fs.existsSync(planFile)) {
    return { plan: null };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(planFile, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { plan: null, diagnostic: `Cannot read file .pi/active-plan.json: ${msg}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      plan: null,
      diagnostic: `File .pi/active-plan.json is corrupted (invalid JSON): ${msg}. Please fix or recreate via /plan <goal>.`,
    };
  }

  // Detect unversioned legacy plan file
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !("schemaVersion" in parsed) &&
    typeof (parsed as Record<string, any>).goal === "string"
  ) {
    return {
      plan: null,
      diagnostic:
        "File .pi/active-plan.json is in legacy format (missing schemaVersion). Run '/plan migrate' to upgrade it to schema version 1, or recreate via /plan <goal>.",
    };
  }

  const validation = validatePlanSchema(parsed);
  if (!validation.valid) {
    return {
      plan: null,
      diagnostic: `File .pi/active-plan.json does not match schema (${validation.error}). Please recreate via /plan <goal>.`,
    };
  }

  const loadedPlan = validation.plan;

  // Verify canonical cwd
  if (path.resolve(loadedPlan.cwd) !== path.resolve(cwd)) {
    return {
      plan: null,
      diagnostic: `Saved plan is designated for another directory ('${loadedPlan.cwd}'), not the active directory ('${path.resolve(cwd)}').`,
    };
  }

  // Verify session ID when provided
  if (expectedSessionId && loadedPlan.sessionId !== expectedSessionId) {
    return {
      plan: null,
      diagnostic: `Saved plan was created in another session ('${loadedPlan.sessionId}'). Create a new plan for this session via /plan <goal>.`,
    };
  }

  return { plan: loadedPlan };
}

/**
 * Explicit migration helper for legacy active-plan files
 */
export function migrateLegacyPlan(
  cwd: string,
  sessionId: string
): { success: boolean; plan?: WorkflowPlanV1; message: string } {
  const planDir = path.join(path.resolve(cwd), ".pi");
  const planFile = path.join(planDir, "active-plan.json");

  if (!fs.existsSync(planFile)) {
    return { success: false, message: "No .pi/active-plan.json file found to migrate." };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(planFile, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Cannot read file .pi/active-plan.json: ${msg}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: `File .pi/active-plan.json is corrupted (invalid JSON): ${msg}. Format is invalid and cannot be migrated automatically. Recreate via /plan <goal>.`,
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { success: false, message: "File .pi/active-plan.json is not a valid JSON object." };
  }

  const rawObj = parsed as Record<string, any>;
  if (rawObj.schemaVersion === 1) {
    const validRes = validatePlanSchema(rawObj);
    if (validRes.valid) {
      return {
        success: true,
        plan: validRes.plan,
        message: "File .pi/active-plan.json already conforms to schema version 1.",
      };
    }
  }

  const resolvedCwd = path.resolve(cwd);
  const resolvedSessionId = sessionId || rawObj.sessionId || "migrated-session";

  const migratedPlan: WorkflowPlanV1 = {
    schemaVersion: 1,
    sessionId: resolvedSessionId,
    cwd: resolvedCwd,
    goal: typeof rawObj.goal === "string" && rawObj.goal.trim() ? rawObj.goal.trim() : "Migrated Plan",
    status: (rawObj.status as PlanStatus) || "draft",
    planCaptured: typeof rawObj.planCaptured === "boolean" ? rawObj.planCaptured : true,
    contentSource: "agent",
    steps: Array.isArray(rawObj.steps) ? rawObj.steps.map(String) : [],
    risks: Array.isArray(rawObj.risks) ? rawObj.risks.map(String) : [],
    acceptanceCriteria: Array.isArray(rawObj.acceptanceCriteria) ? rawObj.acceptanceCriteria.map(String) : [],
    verificationCommands: Array.isArray(rawObj.verificationCommands)
      ? rawObj.verificationCommands.map(String)
      : rawObj.verificationCommand
      ? [String(rawObj.verificationCommand)]
      : ["npm test"],
    createdAt: typeof rawObj.createdAt === "string" ? rawObj.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const saveRes = savePlanAtomic(cwd, migratedPlan);
  if (!saveRes.success) {
    return { success: false, message: saveRes.error || "Failed to save migrated plan." };
  }

  return {
    success: true,
    plan: migratedPlan,
    message: `Plan '${migratedPlan.goal}' was successfully migrated to schema version 1.`,
  };
}

// Parse structured plan generated by the model
export function parseStructuredPlanFromAssistantText(text: string): Partial<WorkflowPlanV1> | null {
  if (!text) return null;

  // 1. Try JSON code block
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const p = parsed.plan || parsed;
      if (Array.isArray(p.steps) && p.steps.length > 0) {
        return {
          steps: p.steps.map(String),
          risks: Array.isArray(p.risks) ? p.risks.map(String) : [],
          acceptanceCriteria: Array.isArray(p.acceptanceCriteria) ? p.acceptanceCriteria.map(String) : [],
          verificationCommands: Array.isArray(p.verificationCommands)
            ? p.verificationCommands.map(String)
            : Array.isArray(p.verificationCommand)
            ? p.verificationCommand.map(String)
            : typeof p.verificationCommand === "string"
            ? [p.verificationCommand]
            : ["npm test"],
        };
      }
    } catch {}
  }

  // 2. Markdown heading parser (Steps, Risks, Criteria, Verification)
  const steps: string[] = [];
  const risks: string[] = [];
  const criteria: string[] = [];
  const commands: string[] = [];

  let currentSection = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const heading = trimmed.toLowerCase();

    if (/^#{1,4}\s*.*(step|fase|langkah|phase)/i.test(heading)) {
      currentSection = "steps";
      continue;
    } else if (/^#{1,4}\s*.*(risk|risiko|hazard)/i.test(heading)) {
      currentSection = "risks";
      continue;
    } else if (/^#{1,4}\s*.*(criteria|kriteria|acceptance|done)/i.test(heading)) {
      currentSection = "criteria";
      continue;
    } else if (/^#{1,4}\s*.*(verif|test|command)/i.test(heading)) {
      currentSection = "commands";
      continue;
    }

    if (/^#{1,4}\s+/i.test(trimmed)) {
      currentSection = "";
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || /^\d+\.\s+/.test(trimmed)) {
      const item = trimmed.replace(/^[-*]\s+|\d+\.\s+/, "").trim();
      if (!item) continue;

      if (currentSection === "steps") steps.push(item);
      else if (currentSection === "risks") risks.push(item);
      else if (currentSection === "criteria") criteria.push(item);
      else if (currentSection === "commands") commands.push(item);
    }
  }

  if (steps.length > 0) {
    return {
      steps,
      risks,
      acceptanceCriteria: criteria,
      verificationCommands: commands.length > 0 ? commands : ["npm test"],
    };
  }

  return null;
}

// ============================================================================
// Sanitized Context Extraction
// ============================================================================

export function extractSanitizedContext(entries: unknown[]): string {
  if (!Array.isArray(entries) || entries.length === 0) return "";

  const conversation = entries
    .filter((e) => {
      const entry = e as { type?: string; message?: { role?: string } };
      return (
        entry.type === "message" &&
        (entry.message?.role === "user" || entry.message?.role === "assistant")
      );
    })
    .slice(-4);

  const lines: string[] = [];

  for (const item of conversation) {
    const entry = item as { message: { role: string; content: unknown } };
    const role = entry.message.role === "user" ? "User" : "Assistant";
    let rawText = "";

    if (Array.isArray(entry.message.content)) {
      rawText = entry.message.content
        .filter((c: unknown) => typeof c === "object" && c !== null && (c as { type?: string }).type === "text")
        .map((c: unknown) => (c as { text: string }).text || "")
        .join(" ");
    } else if (typeof entry.message.content === "string") {
      rawText = entry.message.content;
    }

    // Sanitize sensitive tokens
    const sanitized = rawText
      .replace(/sk[_-][a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
      .replace(/Bearer\s+[a-zA-Z0-9_.-]+/gi, "Bearer [REDACTED_TOKEN]")
      .replace(/(?:password|secret|token)\s*[:=]\s*[^\s]+/gi, "secret: [REDACTED]")
      .replace(/\s+/g, " ")
      .trim();

    if (sanitized && !sanitized.startsWith("Attached image") && !sanitized.startsWith("<skill")) {
      lines.push(`${role}: ${sanitized.slice(0, 100)}`);
    }
  }

  return lines.join("\n").slice(0, 400);
}

// ============================================================================
// Provider Query with Guaranteed Timeout Cleanup & Security Guard
// ============================================================================

export interface ProviderEndpointConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export function resolveProviderEndpoint(): ProviderEndpointConfig | null {
  const envUrl = process.env.PI_BTW_URL || process.env.NINE_ROUTER_BASE_URL;
  const envModel = process.env.PI_BTW_MODEL;

  let rawUrl = envUrl;
  if (!rawUrl) {
    const configPath = path.join(os.homedir(), ".pi", "agent", "9router-config.json");
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (typeof cfg?.baseUrl === "string") {
          rawUrl = cfg.baseUrl;
        }
      } catch {}
    }
  }

  if (!rawUrl) {
    rawUrl = "http://127.0.0.1:20128";
  }

  const allowExternal = isExternalOptInEnabled();
  const validation = validateEndpointUrl(rawUrl, allowExternal);
  if (!validation.valid || !validation.url) {
    return null;
  }

  const secret = resolveSecureApiKey();

  return {
    baseUrl: validation.url.origin,
    apiKey: secret.apiKey,
    model: envModel || "ag/gemini-3.8-flash-low",
  };
}

export async function queryBtwAnswer(
  question: string,
  contextSummary: string,
  externalSignal?: AbortSignal,
  timeoutMs = 12000
): Promise<{ success: boolean; answer: string; error?: string }> {
  const provider = resolveProviderEndpoint();
  if (!provider) {
    return {
      success: false,
      answer: "",
      error: "AI endpoint rejected or invalid under security allowlist policy.",
    };
  }

  const prompt = [
    contextSummary ? `Current workflow context: "${contextSummary}"` : "",
    `User side question: "${question}"`,
    ``,
    `Instructions:`,
    `- Answer the side question directly, concisely, and clearly in 1 or 2 short paragraphs.`,
    `- Match the language of the user's question.`,
    `- Provide essential explanation directly without opening or closing greetings.`,
  ].filter(Boolean).join("\n");

  const targetUrl = `${provider.baseUrl}/v1/chat/completions`;
  const payload = {
    model: provider.model,
    stream: false,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  };

  const res = await safePostJson<{ choices?: Array<{ message?: { content?: string } }> }>(
    targetUrl,
    payload,
    provider.apiKey,
    {
      timeoutMs,
      externalSignal,
      allowExternal: isExternalOptInEnabled(),
    }
  );

  if (!res.success || !res.data) {
    return {
      success: false,
      answer: "",
      error: res.error || "Failed to query side model.",
    };
  }

  const content = res.data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return {
      success: false,
      answer: "",
      error: "Empty model response.",
    };
  }

  return { success: true, answer: content.trim() };
}

// ============================================================================
// Workflow Prompts
// ============================================================================

export function formatPlanPrompt(goal: string): string {
  return [
    `[WORKFLOW MODE: /plan]`,
    `Plan Goal: "${goal}"`,
    ``,
    `STRICT READ-ONLY SCOUTING RULES:`,
    `1. Explore repository strictly READ-ONLY. Read files, search references, inspect test setups.`,
    `2. Do not modify, write, or delete source code files. All mutation tools (edit, write, bash, powershell) are blocked. This mode does not alter source code (only saves plan metadata to .pi/active-plan.json).`,
    `3. Produce a structured plan containing Steps, Risks & Mitigations, Acceptance Criteria, and Verification Commands.`,
    `4. Conclude your response with the following structured JSON block so the system can capture plan details automatically:`,
    `\`\`\`json`,
    `{`,
    `  "plan": {`,
    `    "steps": ["step 1...", "step 2..."],`,
    `    "risks": ["risk 1..."],`,
    `    "acceptanceCriteria": ["criteria 1..."],`,
    `    "verificationCommands": ["npm test"]`,
    `  }`,
    `}`,
    `\`\`\``,
    `After reviewing the plan, the user can approve it via '/plan approve' and execute it via '/build'.`,
  ].join("\n");
}

export function formatDirectBuildPrompt(task: string): string {
  return [
    `[WORKFLOW MODE: /build]`,
    `Direct Task: "${task}"`,
    ``,
    `DIRECT EXECUTION RULES:`,
    `1. Treat the above task as the primary source of truth.`,
    `2. Implement changes step by step in an incremental, measured manner.`,
    `3. Run narrow tests or checks after every significant change.`,
    `4. Report modified files and verification results.`,
  ].join("\n");
}

export function formatBuildPrompt(plan: WorkflowPlanV1): string {
  return [
    `[WORKFLOW MODE: /build]`,
    `Executing Approved Plan: "${plan.goal}"`,
    ``,
    `Plan Details:`,
    `Implementation Steps:`,
    ...plan.steps.map((s, idx) => `  ${idx + 1}. ${s}`),
    `Acceptance Criteria:`,
    ...plan.acceptanceCriteria.map((c) => `  - ${c}`),
    `Verification Commands:`,
    ...plan.verificationCommands.map((v) => `  $ ${v}`),
    ``,
    `EXECUTION RULES:`,
    `1. Implement step by step. Do not jump ahead without verification.`,
    `2. Run tests or checks after each step finishes.`,
    `3. Create checkpoints and confirm tests pass before proceeding to the next step.`,
  ].join("\n");
}

export function formatDebugPrompt(issue: string): string {
  return [
    `[WORKFLOW MODE: /debug]`,
    `Reported Issue: "${issue}"`,
    ``,
    `5-STAGE SYSTEMATIC DEBUGGING WORKFLOW (MUST BE FOLLOWED SEQUENTIALLY):`,
    `1. REPRODUCE: Reproduce failure with the narrowest check or test before touching code.`,
    `2. ROOT CAUSE INVESTIGATION: Trace data flow, call stack, and error logs. DO NOT guess or jump to editing code!`,
    `3. HYPOTHESIS: State one clear, falsifiable root cause hypothesis.`,
    `4. MINIMAL FIX: Apply the smallest, safest change that precisely addresses the root cause.`,
    `5. REGRESSION TEST: Run tests to verify the fix and ensure no regressions occurred.`,
  ].join("\n");
}

export function formatReviewPrompt(targetContext?: string): string {
  return [
    `[WORKFLOW MODE: /review]`,
    targetContext ? `Review Target: "${targetContext}"` : `Review Target: Git diff / active changes`,
    ``,
    `STRICT RULES:`,
    `1. THIS MODE IS READ-ONLY CODE REVIEW. Do not edit, patch, or alter files automatically.`,
    `2. Inspect git diff and relevant test files.`,
    `3. Thoroughly evaluate logic correctness, test coverage, security, error handling, performance, and code readability.`,
    `4. Group findings into: [CRITICAL], [IMPORTANT], [MINOR], followed by a merge readiness summary.`,
  ].join("\n");
}

// ============================================================================
// Extension Main Registration
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Modal overlay for /btw responses
  async function showBtwModal(ctx: ExtensionContext, question: string, answerText: string) {
    if (!ctx.hasUI || !ctx.ui?.custom) return;

    await ctx.ui.custom((_tui, theme, _kb, done: (res?: unknown) => void) => {
      return {
        dispose() {},
        invalidate() {},
        handleInput(data: string) {
          if (data === "\x1b" || data === "\r" || data === "\n" || data === "q" || data === "Q") {
            done();
          }
        },
        render(width: number): string[] {
          const maxBoxWidth = Math.min(width - 4, 76);
          const innerW = maxBoxWidth - 4;

          const qLines = wrapText(`Q: ${question}`, innerW);
          const aLines = wrapText(answerText, innerW);

          const borderCol = (s: string) => theme.fg("borderAccent", s);
          const padLine = (content: string, rawLen: number) => {
            const gap = Math.max(0, innerW - rawLen);
            return `${borderCol("│")}  ${content}${" ".repeat(gap)}${borderCol("│")}`;
          };

          const titleText = theme.bold(theme.fg("accent", "BY-THE-WAY SIDE QUESTION"));
          const titleLen = getVisibleWidth("BY-THE-WAY SIDE QUESTION");

          const box: string[] = [
            borderCol("╭" + "─".repeat(innerW + 2) + "╮"),
            padLine(titleText, titleLen),
            borderCol("├" + "─".repeat(innerW + 2) + "┤"),
          ];

          for (const q of qLines) {
            box.push(padLine(theme.fg("warning", q), getVisibleWidth(q)));
          }

          box.push(borderCol("├" + "─".repeat(innerW + 2) + "┤"));

          for (const a of aLines) {
            box.push(padLine(theme.fg("text", a), getVisibleWidth(a)));
          }

          box.push(borderCol("├" + "─".repeat(innerW + 2) + "┤"));
          const hint = theme.fg("dim", "Press ESC / ENTER / Q to close (main task unaffected)");
          box.push(padLine(hint, getVisibleWidth("Press ESC / ENTER / Q to close (main task unaffected)")));
          box.push(borderCol("╰" + "─".repeat(innerW + 2) + "╯"));

          const padLeft = Math.max(1, Math.floor((width - (innerW + 4)) / 2));
          const pad = " ".repeat(padLeft);
          return ["", ...box.map((l) => pad + l), ""];
        },
      };
    }, { overlay: true });
  }

  // Detached worker for /btw questions
  async function dispatchBtwRequest(ctx: ExtensionContext, question: string) {
    const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
    const state = getOrCreateSessionState(sessionId, ctx.cwd);

    if (state.btwActive) {
      if (state.btwQueue.length >= 3) {
        ctx.ui?.notify("Side question queue is full (max 3). Run /btw-clear or wait.", "warning");
        return;
      }
      const contextSummary = extractSanitizedContext(ctx.sessionManager?.getEntries?.() || []);
      state.btwQueue.push({
        id: Math.random().toString(36).slice(2, 8),
        question,
        contextSummary,
        queuedAt: new Date().toISOString(),
      });
      ctx.ui?.notify(`[BTW] Question added to queue (${state.btwQueue.length} pending)...`, "info");
      return;
    }

    state.btwActive = true;
    state.btwAbortController = new AbortController();
    const abortSignal = state.btwAbortController.signal;

    const contextSummary = extractSanitizedContext(ctx.sessionManager?.getEntries?.() || []);
    ctx.ui?.notify(`[BTW] Processing question: "${question}"...`, "info");

    // Non-blocking detached worker
    queueMicrotask(async () => {
      ctx.ui?.setWidget("btw-status", ["⠋ Processing /btw side question in background..."]);

      try {
        const result = await queryBtwAnswer(question, contextSummary, abortSignal, 15000);
        ctx.ui?.setWidget("btw-status", undefined);

        if (abortSignal.aborted) {
          return;
        }

        if (result.success) {
          await showBtwModal(ctx, question, result.answer);
        } else {
          ctx.ui?.notify(`[BTW Failed] ${result.error || "No answer"}`, "warning");
        }
      } catch (err: unknown) {
        ctx.ui?.setWidget("btw-status", undefined);
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui?.notify(`[BTW Error] ${msg}`, "error");
      } finally {
        state.btwActive = false;
        state.btwAbortController = null;

        // Process next item in queue if available
        if (state.btwQueue.length > 0) {
          const next = state.btwQueue.shift();
          if (next) {
            void dispatchBtwRequest(ctx, next.question);
          }
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // Lifecycle Handlers
  // --------------------------------------------------------------------------

  // Block mutation tools in /plan and /review modes
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult> => {
    const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
    const state = getOrCreateSessionState(sessionId, ctx.cwd);

    if (state.activeMode === "plan" || state.activeMode === "review") {
      const toolName = event.toolName;
      if (!READ_ONLY_TOOL_ALLOWLIST.has(toolName)) {
        return {
          block: true,
          reason: `Tool '${toolName}' blocked: /${state.activeMode} mode is read-only (only ${Array.from(READ_ONLY_TOOL_ALLOWLIST).join(", ")} are permitted for inspection).`,
        };
      }
    }
    return {};
  });

  // Capture structured plan and reset mode upon agent settlement
  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
    const state = getOrCreateSessionState(sessionId, ctx.cwd);

    if (state.activeMode === "plan" && state.currentPlan && !state.currentPlan.planCaptured) {
      try {
        const entries = (ctx.sessionManager?.getEntries?.() || []) as Array<{
          type?: string;
          message?: { role?: string; content?: unknown };
        }>;

        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.type === "message" && entry.message?.role === "assistant") {
            let assistantText = "";
            if (typeof entry.message.content === "string") {
              assistantText = entry.message.content;
            } else if (Array.isArray(entry.message.content)) {
              assistantText = entry.message.content
                .filter((p: unknown) => typeof p === "object" && p !== null && (p as { type?: string }).type === "text")
                .map((p: unknown) => (p as { text: string }).text || "")
                .join("\n");
            }

            const parsed = parseStructuredPlanFromAssistantText(assistantText);
            if (parsed && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
              state.currentPlan.steps = parsed.steps;
              state.currentPlan.risks = parsed.risks || [];
              state.currentPlan.acceptanceCriteria = parsed.acceptanceCriteria || [];
              state.currentPlan.verificationCommands = parsed.verificationCommands || ["npm test"];
              state.currentPlan.planCaptured = true;
              state.currentPlan.contentSource = "agent";
              state.currentPlan.updatedAt = new Date().toISOString();

              savePlanAtomic(ctx.cwd, state.currentPlan);
              pi.appendEntry("workflow_plan", state.currentPlan);
            }
            break;
          }
        }
      } catch {}
    }

    if (state.activeMode === "plan" || state.activeMode === "review" || state.activeMode === "debug") {
      state.activeMode = "idle";
    }
  });

  // Reset state upon session switch or shutdown
  pi.on("session_before_switch", async (event, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    resetSessionWorkflowState(sessionId, ctx.cwd);
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    resetSessionWorkflowState(sessionId, ctx.cwd);
  });

  // Approval helper for /plan approve or /plan-approve
  function handlePlanApprove(
    ctx: ExtensionCommandContext,
    sessionId: string,
    state: SessionWorkflowState
  ): void {
    const { plan, diagnostic } = loadPlanValidated(ctx.cwd, sessionId);
    if (diagnostic || !plan) {
      ctx.ui?.notify(
        diagnostic || "No active plan available to approve. Create a plan via /plan <goal> or migrate via /plan migrate.",
        "warning"
      );
      return;
    }

    if (!plan.planCaptured || plan.contentSource !== "agent" || plan.steps.length === 0) {
      ctx.ui?.notify(
        "Real plan has not been extracted from assistant output yet (still in draft placeholder status). Wait for assistant to finish analysis or ensure structured steps are present before approving.",
        "warning"
      );
      return;
    }

    plan.status = "approved";
    plan.updatedAt = new Date().toISOString();
    state.currentPlan = plan;

    const saveRes = savePlanAtomic(ctx.cwd, plan);
    if (!saveRes.success) {
      ctx.ui?.notify(saveRes.error || "Failed to save plan approval.", "error");
      return;
    }

    pi.appendEntry("workflow_plan", plan);
    ctx.ui?.notify(`Plan for '${plan.goal}' has been APPROVED. Run /build to execute.`, "info");
  }

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------

  // /btw: Out-of-band side question
  pi.registerCommand("btw", {
    description: "Ask an out-of-band side question without interrupting active tasks or context",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const intent = parseBtwIntent(args);
      if (intent.kind === "default") {
        ctx.ui?.notify("Use: /btw <question> to ask a side question.", "info");
        return;
      }
      if (intent.kind === "direct") {
        await dispatchBtwRequest(ctx, intent.argument);
      }
    },
  });

  // /btw-list: View queue status
  pi.registerCommand("btw-list", {
    description: "View status of /btw side question queue",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);

      if (state.btwQueue.length === 0) {
        ctx.ui?.notify(
          state.btwActive
            ? "Currently processing 1 active /btw question (no additional items queued)."
            : "/btw queue is empty.",
          "info"
        );
        return;
      }

      const list = state.btwQueue.map((item, idx) => `${idx + 1}. ${item.question}`).join("\n");
      ctx.ui?.notify(`/btw queue (${state.btwQueue.length}):\n${list}`, "info");
    },
  });

  // /btw-clear: Cancel active request and clear queue
  pi.registerCommand("btw-clear", {
    description: "Cancel active /btw request and clear all queued items",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);

      const count = state.btwQueue.length + (state.btwActive ? 1 : 0);
      if (state.btwAbortController) {
        state.btwAbortController.abort();
        state.btwAbortController = null;
      }
      state.btwActive = false;
      state.btwQueue = [];
      ctx.ui?.setWidget("btw-status", undefined);

      ctx.ui?.notify(`Cleared ${count} active / queued /btw items.`, "info");
    },
  });

  // /plan <goal>: Read-only planning
  pi.registerCommand("plan", {
    description: "Design structured implementation plan in read-only mode before coding",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const intent = parsePlanIntent(args);
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);

      // C. State-explicit: /plan approve
      if (intent.kind === "state-explicit" && intent.operation === "approve") {
        handlePlanApprove(ctx, sessionId, state);
        return;
      }

      // C. State-explicit: /plan migrate
      if (intent.kind === "state-explicit" && intent.operation === "migrate") {
        const res = migrateLegacyPlan(ctx.cwd, sessionId);
        ctx.ui?.notify(res.message, res.success ? "info" : "error");
        return;
      }

      // A. Direct command: /plan <goal>
      if (intent.kind === "direct") {
        state.activeMode = "plan";

        const now = new Date().toISOString();
        const newPlan: WorkflowPlanV1 = {
          schemaVersion: 1,
          sessionId,
          cwd: path.resolve(ctx.cwd),
          goal: intent.argument,
          status: "draft",
          planCaptured: false,
          contentSource: "draft_placeholder",
          steps: [],
          risks: [],
          acceptanceCriteria: [],
          verificationCommands: ["npm test"],
          createdAt: now,
          updatedAt: now,
        };

        state.currentPlan = newPlan;
        savePlanAtomic(ctx.cwd, newPlan);
        pi.appendEntry("workflow_plan", newPlan);

        pi.sendUserMessage(formatPlanPrompt(intent.argument));
        return;
      }

      // B. Default command: /plan (no arguments)
      const { plan } = loadPlanValidated(ctx.cwd, sessionId);
      if (plan) {
        ctx.ui?.notify(
          `Active plan: '${plan.goal}' [${plan.status.toUpperCase()}]. Use '/plan approve' to approve, or '/plan <goal>' to create a new plan.`,
          "info"
        );
        return;
      }

      ctx.ui?.notify("Use: /plan <goal> (or '/plan approve' to approve active plan)", "warning");
    },
  });

  // /plan-approve: Explicit command to approve active plan
  pi.registerCommand("plan-approve", {
    description: "Approve active plan so it can be executed by /build",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);
      handlePlanApprove(ctx, sessionId, state);
    },
  });

  // /plan-migrate: Explicit command to migrate legacy plan file
  pi.registerCommand("plan-migrate", {
    description: "Migrate legacy plan file to JSON schema version 1",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const res = migrateLegacyPlan(ctx.cwd, sessionId);
      ctx.ui?.notify(res.message, res.success ? "info" : "error");
    },
  });

  // /build: Run approved plan or direct task
  pi.registerCommand("build", {
    description: "Execute direct task (/build <task>) or approved plan (/build)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const intent = parseBuildIntent(args);
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);

      // A. Direct command: /build <task>
      if (intent.kind === "direct") {
        state.activeMode = "build";
        pi.sendUserMessage(formatDirectBuildPrompt(intent.argument));
        return;
      }

      // C. State-explicit command: /build --from-plan
      if (intent.kind === "state-explicit" && intent.operation === "from-plan") {
        const { plan, diagnostic } = loadPlanValidated(ctx.cwd, sessionId);
        if (diagnostic || !plan) {
          ctx.ui?.notify(
            diagnostic || "No active plan available. Create a plan via /plan <goal> or migrate via /plan migrate.",
            "error"
          );
          return;
        }

        if (!plan.planCaptured || plan.contentSource !== "agent" || plan.steps.length === 0) {
          ctx.ui?.notify(
            `Plan '${plan.goal}' does not have concrete steps extracted from the assistant yet. Recreate via /plan or wait for analysis to complete.`,
            "error"
          );
          return;
        }

        if (plan.status === "draft") {
          ctx.ui?.notify(
            `Plan '${plan.goal}' is still in DRAFT status and has not been approved. Run '/plan approve' to approve it before /build.`,
            "warning"
          );
          return;
        }

        state.activeMode = "build";
        plan.status = "running";
        plan.updatedAt = new Date().toISOString();
        savePlanAtomic(ctx.cwd, plan);
        pi.appendEntry("workflow_plan", plan);

        pi.sendUserMessage(formatBuildPrompt(plan));
        return;
      }

      // B. Default command: /build (without argument)
      const { plan } = loadPlanValidated(ctx.cwd, sessionId);
      if (plan && plan.status === "approved" && plan.planCaptured && plan.steps.length > 0) {
        state.activeMode = "build";
        plan.status = "running";
        plan.updatedAt = new Date().toISOString();
        savePlanAtomic(ctx.cwd, plan);
        pi.appendEntry("workflow_plan", plan);

        pi.sendUserMessage(formatBuildPrompt(plan));
        return;
      }

      if (plan && plan.status === "draft") {
        ctx.ui?.notify(
          `Active plan '${plan.goal}' is still in DRAFT status. Run '/plan approve' to approve, or '/build <task>' to build directly.`,
          "warning"
        );
        return;
      }

      notifyStateFallback(
        ctx,
        "build",
        "/build Add CSV export",
        "/build --from-plan"
      );
    },
  });

  // /debug <issue>: Structured investigation workflow
  pi.registerCommand("debug", {
    description: "Start 5-stage systematic debugging workflow (Reproduce -> Root-Cause -> Hypothesis -> Fix -> Test)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const intent = parseDebugIntent(args);
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);

      // A. Direct command: /debug <issue>
      if (intent.kind === "direct") {
        state.activeMode = "debug";
        pi.sendUserMessage(formatDebugPrompt(intent.argument));
        return;
      }

      // B. Default command: /debug
      ctx.ui?.notify("Use: /debug <issue description or error message>", "warning");
    },
  });

  // /review: Read-only code review
  pi.registerCommand("review", {
    description: "Perform read-only code review on git diff or specific target",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const intent = parseReviewIntent(args);
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);
      state.activeMode = "review";

      // A. Direct command: /review <target>
      if (intent.kind === "direct") {
        pi.sendUserMessage(formatReviewPrompt(intent.argument));
        return;
      }

      // B. Default command: /review (git diff)
      pi.sendUserMessage(formatReviewPrompt(""));
    },
  });
}

function getVisibleWidth(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= maxWidth) {
      lines.push(rawLine);
      continue;
    }
    const words = rawLine.split(" ");
    let cur = "";
    for (const w of words) {
      if ((cur + (cur ? " " : "") + w).length <= maxWidth) {
        cur += (cur ? " " : "") + w;
      } else {
        if (cur) lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}
