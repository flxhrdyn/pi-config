import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface WorkflowPlan {
  goal: string;
  steps: string[];
  risks: string[];
  acceptanceCriteria: string[];
  verificationCommand: string;
  createdAt: string;
}

export interface BtwItem {
  id: string;
  question: string;
  queuedAt: string;
}

// In-memory state per session
export interface WorkflowState {
  currentPlan: WorkflowPlan | null;
  activeMode: "idle" | "plan" | "build" | "debug" | "review";
  btwQueue: BtwItem[];
  isProcessingBtw: boolean;
}

export function createWorkflowState(): WorkflowState {
  return {
    currentPlan: null,
    activeMode: "idle",
    btwQueue: [],
    isProcessingBtw: false,
  };
}

export function formatBtwPrompt(question: string): string {
  return [
    `[BY-THE-WAY SIDE QUESTION]`,
    `Question: "${question}"`,
    ``,
    `IMPORTANT RULES FOR THIS RESPONSE:`,
    `1. This is a side question. Do NOT modify, reset, or abandon the current active plan, goal, or task.`,
    `2. Provide a direct, concise, and accurate answer to the side question.`,
    `3. Do NOT save this answer into project memory, persistent checkpoints, or active plans.`,
    `4. Conclude your response with a 1-line note confirming that the main task context remains unchanged.`,
  ].join("\n");
}

export function formatPlanPrompt(goal: string): string {
  return [
    `[WORKFLOW MODE: /plan]`,
    `Goal: "${goal}"`,
    ``,
    `STRICT RULES:`,
    `1. READ-ONLY SCOUTING ONLY: Explore repository context, inspect files, check tests.`,
    `2. DO NOT modify, create, or delete any files. Mutation tools ('edit', 'write') are strictly forbidden in /plan mode.`,
    `3. Produce a structured plan containing:`,
    `   - Step-by-step implementation phases`,
    `   - Identified risks and mitigations`,
    `   - Acceptance criteria for each phase`,
    `   - Exact verification and test commands`,
    `4. Once reviewed, the user can execute the plan using '/build'.`,
  ].join("\n");
}

export function formatBuildPrompt(plan: WorkflowPlan): string {
  return [
    `[WORKFLOW MODE: /build]`,
    `Executing Approved Plan: "${plan.goal}"`,
    ``,
    `Plan Details:`,
    `Steps:`,
    ...plan.steps.map((s, idx) => `  ${idx + 1}. ${s}`),
    `Acceptance Criteria:`,
    ...plan.acceptanceCriteria.map((c) => `  - ${c}`),
    `Verification Command: ${plan.verificationCommand || "npm test"}`,
    ``,
    `EXECUTION RULES:`,
    `1. Implement step-by-step. Do not jump ahead.`,
    `2. Run verification after each step.`,
    `3. Checkpoint progress and confirm passing tests before proceeding to next step.`,
  ].join("\n");
}

export function formatDebugPrompt(issue: string): string {
  return [
    `[WORKFLOW MODE: /debug]`,
    `Reported Issue: "${issue}"`,
    ``,
    `MANDATORY 5-STAGE SYSTEMATIC DEBUGGING WORKFLOW:`,
    `1. REPRODUCE: Reproduce the failure with the narrowest check or test before touching any code.`,
    `2. ROOT CAUSE INVESTIGATION: Trace data flow, examine errors, check call stack. Do NOT guess or change code yet.`,
    `3. HYPOTHESIS: State the single root cause clearly.`,
    `4. MINIMAL FIX: Make the smallest safe change that resolves the root cause without unrelated refactoring.`,
    `5. REGRESSION TEST: Run tests to verify the fix and ensure no regressions occur.`,
  ].join("\n");
}

export function formatReviewPrompt(targetContext?: string): string {
  return [
    `[WORKFLOW MODE: /review]`,
    targetContext ? `Target: "${targetContext}"` : `Target: Current unstaged/recent diff`,
    ``,
    `STRICT RULES:`,
    `1. READ-ONLY CODE REVIEW ONLY. Do NOT edit, fix, or modify code automatically.`,
    `2. Inspect git diff and relevant test files.`,
    `3. Evaluate rigorously on:`,
    `   - Correctness & adherence to requirements`,
    `   - Test coverage & edge cases`,
    `   - Security, error handling & performance`,
    `   - Code complexity & maintainability`,
    `4. Report findings categorized by: [CRITICAL], [IMPORTANT], [MINOR], followed by an overall readiness assessment.`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  const state = createWorkflowState();

  // Helper untuk menyimpan plan ke file lokal dan appendEntry
  function savePlan(plan: WorkflowPlan, cwd: string) {
    state.currentPlan = plan;
    pi.appendEntry("workflow_plan", plan);

    try {
      const planDir = path.join(cwd, ".pi");
      if (!fs.existsSync(planDir)) {
        fs.mkdirSync(planDir, { recursive: true });
      }
      fs.writeFileSync(path.join(planDir, "active-plan.json"), JSON.stringify(plan, null, 2), "utf8");
    } catch {
      // Abaikan jika folder tidak writable
    }
  }

  // Load existing plan from disk if available
  function loadPersistedPlan(cwd: string): WorkflowPlan | null {
    if (state.currentPlan) return state.currentPlan;
    try {
      const planFile = path.join(cwd, ".pi", "active-plan.json");
      if (fs.existsSync(planFile)) {
        const data = JSON.parse(fs.readFileSync(planFile, "utf8"));
        if (data && data.goal && Array.isArray(data.steps)) {
          state.currentPlan = data;
          return data;
        }
      }
    } catch {}
    return null;
  }

  // Intercept input: Jika streaming sedang aktif dan user mengirim /btw, antrekan dengan aman
  pi.on("input", async (event) => {
    const trimmed = event.text.trim();
    if (!trimmed.startsWith("/btw ")) return { action: "continue" };

    // Jika input tiba saat ada turn streaming/running
    if (event.streamingBehavior !== undefined) {
      const question = trimmed.slice(5).trim();
      if (question) {
        state.btwQueue.push({
          id: Math.random().toString(36).slice(2, 9),
          question,
          queuedAt: new Date().toISOString(),
        });
        return { action: "handled" };
      }
    }
    return { action: "continue" };
  });

  // Proses antrean /btw setelah turn utama selesai
  pi.on("agent_end", async (_event, ctx) => {
    // Reset mode jika bukan build
    if (state.activeMode === "plan" || state.activeMode === "review") {
      state.activeMode = "idle";
    }

    if (state.btwQueue.length > 0 && !state.isProcessingBtw) {
      state.isProcessingBtw = true;
      const nextItem = state.btwQueue.shift();
      if (nextItem) {
        ctx.ui?.notify?.(`Memproses pertanyaan sampingan antrean: "${nextItem.question.slice(0, 30)}..."`, "info");
        pi.sendUserMessage(formatBtwPrompt(nextItem.question), { deliverAs: "followUp" });
      }
      state.isProcessingBtw = false;
    }
  });

  // Enforce read-only di mode /plan dan /review
  pi.on("tool_call", async (event) => {
    if (state.activeMode === "plan" || state.activeMode === "review") {
      if (event.toolName === "edit" || event.toolName === "write") {
        return {
          block: true,
          reason: `Tool '${event.toolName}' diblokir: Mode /${state.activeMode} adalah read-only dan dilarang mengubah file.`,
        };
      }
    }
    return {};
  });

  // 1. Command /btw
  pi.registerCommand("btw", {
    description: "Ajukan pertanyaan sampingan tanpa mengubah goal atau active workflow",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        ctx.ui?.notify?.("Gunakan: /btw <pertanyaan sampingan>", "warning");
        return;
      }

      // Jika agent sedang sibuk dan ctx.isIdle bernilai false, antrekan
      if (ctx.isIdle && !ctx.isIdle()) {
        state.btwQueue.push({
          id: Math.random().toString(36).slice(2, 9),
          question,
          queuedAt: new Date().toISOString(),
        });
        ctx.ui?.notify?.("Sesi sedang aktif. Pertanyaan /btw telah dimasukkan ke antrean dan akan dijawab setelah turn selesai.", "info");
        return;
      }

      pi.sendUserMessage(formatBtwPrompt(question));
    },
  });

  // Command /btw-list
  pi.registerCommand("btw-list", {
    description: "Lihat daftar antrean pertanyaan sampingan /btw yang menunggu",
    handler: async (_args, ctx) => {
      if (state.btwQueue.length === 0) {
        ctx.ui?.notify?.("Antrean /btw kosong.", "info");
        return;
      }
      const list = state.btwQueue.map((item, idx) => `${idx + 1}. ${item.question}`).join("\n");
      ctx.ui?.notify?.(`Antrean /btw (${state.btwQueue.length}):\n${list}`, "info");
    },
  });

  // Command /btw-clear
  pi.registerCommand("btw-clear", {
    description: "Bersihkan seluruh antrean pertanyaan sampingan /btw",
    handler: async (_args, ctx) => {
      const count = state.btwQueue.length;
      state.btwQueue = [];
      ctx.ui?.notify?.(`Dibersihkan ${count} antrean /btw.`, "info");
    },
  });

  // 2. Command /plan <tujuan>
  pi.registerCommand("plan", {
    description: "Rancang rencana implementasi terstruktur secara read-only sebelum coding",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) {
        ctx.ui?.notify?.("Gunakan: /plan <tujuan atau fitur yang ingin dibangun>", "warning");
        return;
      }

      state.activeMode = "plan";

      // Inisialisasi draft plan
      const draftPlan: WorkflowPlan = {
        goal,
        steps: ["Scout codebase", "Detailing architecture", "Implement changes", "Verify"],
        risks: [],
        acceptanceCriteria: [],
        verificationCommand: "npm test",
        createdAt: new Date().toISOString(),
      };
      savePlan(draftPlan, ctx.cwd);

      pi.sendUserMessage(formatPlanPrompt(goal));
    },
  });

  // 3. Command /build
  pi.registerCommand("build", {
    description: "Eksekusi implementasi bertahap dari rencana /plan yang sudah tersedia",
    handler: async (_args, ctx) => {
      const plan = loadPersistedPlan(ctx.cwd);
      if (!plan || !plan.goal) {
        ctx.ui?.notify?.("Belum ada rencana aktif. Silakan buat rencana terlebih dahulu dengan: /plan <tujuan>", "error");
        return;
      }

      state.activeMode = "build";
      pi.sendUserMessage(formatBuildPrompt(plan));
    },
  });

  // 4. Command /debug <masalah>
  pi.registerCommand("debug", {
    description: "Mulai workflow debugging sistematis 5 tahap (Reproduce -> Root-Cause -> Fix -> Test)",
    handler: async (args, ctx) => {
      const issue = args.trim();
      if (!issue) {
        ctx.ui?.notify?.("Gunakan: /debug <deskripsi masalah atau pesan error>", "warning");
        return;
      }

      state.activeMode = "debug";
      pi.sendUserMessage(formatDebugPrompt(issue));
    },
  });

  // 5. Command /review
  pi.registerCommand("review", {
    description: "Review kode dan diff secara read-only (correctness, tests, security, edge cases)",
    handler: async (args, ctx) => {
      state.activeMode = "review";
      pi.sendUserMessage(formatReviewPrompt(args.trim()));
    },
  });
}
