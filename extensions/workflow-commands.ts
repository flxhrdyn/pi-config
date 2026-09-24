import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Helper lebar teks terminal sederhana tanpa dependensi luar
export function getVisibleWidth(str: string): number {
  if (!str) return 0;
  // Hapus ANSI escape sequences
  const clean = str.replace(/\x1b\[[0-9;]*m/g, "");
  let len = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0) || 0;
    // Karakter CJK / fullwidth
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      len += 2;
    } else {
      len += 1;
    }
  }
  return len;
}

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

export function wrapText(text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (getVisibleWidth(cur + " " + w) <= maxW) {
      cur += " " + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
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

// Panggil model ringan secara detached untuk menjawab pertanyaan sampingan tanpa mencemari riwayat utama
export async function queryBtwAnswer(question: string, contextSummary: string): Promise<string> {
  const configPath = path.join(os.homedir(), ".pi", "agent", "9router-config.json");
  if (!fs.existsSync(configPath)) {
    return "Layanan AI lokal belum terkonfigurasi di 9router-config.json.";
  }

  let cfg: { baseUrl?: string; apiKey?: string } = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return "Gagal membaca konfigurasi 9router.";
  }

  const baseUrl = cfg.baseUrl || "http://127.0.0.1:20128";
  const apiKey = cfg.apiKey || "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  const prompt = [
    `Context of current work: "${contextSummary.slice(0, 300)}"`,
    `User side question: "${question}"`,
    ``,
    `Instructions:`,
    `- Answer the side question directly, concisely, and accurately in 1 to 3 short paragraphs.`,
    `- Match the language of the user's question.`,
    `- Do NOT include greetings or filler. Output only the clear explanation.`,
  ].join("\n");

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "ag/gemini-3.8-flash-low",
        stream: false,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!res.ok) {
      return `Gagal memanggil model sampingan (${res.status} ${res.statusText}).`;
    }

    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" ? content.trim() : "Tidak ada respon dari model.";
  } catch (err: any) {
    clearTimeout(timer);
    return `Koneksi timeout atau gagal: ${err.message || String(err)}`;
  }
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

  // Helper menampilkan selector panel /btw (persis seperti dialog /model)
  async function showBtwModal(ctx: any, question: string, answerText: string) {
    if (!ctx.ui?.custom) return;

    // Tanpa overlay: true agar menggantikan editor area persis seperti showModelSelector
    await ctx.ui.custom((_tui: any, theme: any, _kb: any, done: () => void) => {
      return {
        dispose() {},
        invalidate() {},
        handleInput(data: string) {
          // Tutup saat user menekan ESC, Enter, atau q
          if (data === "\x1b" || data === "\r" || data === "\n" || data === "q" || data === "Q") {
            done();
            return true;
          }
          return true;
        },
        render(width: number): string[] {
          const borderLine = theme.fg("borderAccent", "─".repeat(width));
          const qLines = wrapText(question, Math.max(20, width - 4));
          const aLines = wrapText(answerText, Math.max(20, width - 4));

          const lines: string[] = [
            borderLine,
            theme.bold(theme.fg("warning", "By-The-Way Side Question")),
            "",
          ];

          // Question line ala input model selector
          lines.push(theme.fg("accent", "› ") + theme.bold(theme.fg("text", qLines[0])));
          for (let i = 1; i < qLines.length; i++) {
            lines.push("  " + theme.bold(theme.fg("text", qLines[i])));
          }

          lines.push("");

          // Answer lines
          for (const a of aLines) {
            lines.push("  " + theme.fg("text", a));
          }

          lines.push("");
          lines.push(
            theme.fg("dim", "Escape / Enter to close  ·  main task runs in background")
          );
          lines.push(borderLine);

          return lines;
        },
      };
    });
  }

  // Intercept input: Jika streaming sedang aktif dan user mengetik /btw, jalankan query out-of-band paralel
  pi.on("input", async (event, ctx) => {
    const trimmed = event.text.trim();
    if (!trimmed.startsWith("/btw ")) return { action: "continue" };

    const question = trimmed.slice(5).trim();
    if (!question) return { action: "handled" };

    // Ambil cuplikan konteks percakapan terakhir
    let contextSummary = "";
    try {
      const entries = (ctx.sessionManager?.getEntries?.() || []) as any[];
      const recent = entries.slice(-6);
      contextSummary = recent
        .filter((e) => e.type === "message" && e.message?.content)
        .map((e) => `${e.message.role}: ${JSON.stringify(e.message.content).slice(0, 100)}`)
        .join("\n");
    } catch {}

    // Jalankan secara paralel di background tanpa memblokir atau menahan streaming turn utama
    queueMicrotask(async () => {
      ctx.ui?.notify?.(`[BTW] Menjawab pertanyaan sampingan di background...`, "info");
      const answer = await queryBtwAnswer(question, contextSummary);
      await showBtwModal(ctx, question, answer);
    });

    return { action: "handled" };
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

  // 1. Command /btw (bila dipanggil saat idle)
  pi.registerCommand("btw", {
    description: "Ajukan pertanyaan sampingan tanpa mengubah goal atau active workflow (Out-of-band box)",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (!question) {
        ctx.ui?.notify?.("Gunakan: /btw <pertanyaan sampingan>", "warning");
        return;
      }

      let contextSummary = "";
      try {
        const entries = (ctx.sessionManager?.getEntries?.() || []) as any[];
        const recent = entries.slice(-6);
        contextSummary = recent
          .filter((e) => e.type === "message" && e.message?.content)
          .map((e) => `${e.message.role}: ${JSON.stringify(e.message.content).slice(0, 100)}`)
          .join("\n");
      } catch {}

      ctx.ui?.notify?.(`[BTW] Memproses pertanyaan sampingan...`, "info");
      const answer = await queryBtwAnswer(question, contextSummary);
      await showBtwModal(ctx, question, answer);
    },
  });

  // Command /btw-list
  pi.registerCommand("btw-list", {
    description: "Lihat status fitur pertanyaan sampingan /btw",
    handler: async (_args, ctx) => {
      ctx.ui?.notify?.("Mekanisme /btw aktif dalam mode Out-of-band (muncul sebagai box popup tanpa memblokir task).", "info");
    },
  });

  // Command /btw-clear
  pi.registerCommand("btw-clear", {
    description: "Reset status / antrean /btw",
    handler: async (_args, ctx) => {
      state.btwQueue = [];
      ctx.ui?.notify?.("Antrean / status /btw bersih.", "info");
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
