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

// ============================================================================
// Types and Schemas
// ============================================================================

export type WorkflowMode = "idle" | "plan" | "build" | "debug" | "review";

export type PlanStatus = "draft" | "approved" | "running" | "completed" | "failed";

export interface WorkflowPlanV1 {
  schemaVersion: 1;
  sessionId: string;
  cwd: string;
  goal: string;
  status: PlanStatus;
  steps: string[];
  risks: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  createdAt: string;
  updatedAt: string;
  errorSummary?: string;
}

export interface BtwQueueItem {
  id: string;
  question: string;
  contextSummary: string;
  queuedAt: string;
}

export interface SessionWorkflowState {
  activeMode: WorkflowMode;
  currentPlan: WorkflowPlanV1 | null;
  btwActive: boolean;
  btwAbortController: AbortController | null;
  btwQueue: BtwQueueItem[];
}

// Read-only tools allowlist in /plan and /review modes
export const READ_ONLY_TOOL_ALLOWLIST = new Set<string>([
  "read",
  "grep",
  "find",
  "ls",
]);

// Helper terminal text width measurement
export function getVisibleWidth(str: string): number {
  if (!str) return 0;
  const clean = str.replace(/\x1b\[[0-9;]*m/g, "");
  let len = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0) || 0;
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

// ============================================================================
// State Management & Atomic File Persistence
// ============================================================================

const sessionStates = new Map<string, SessionWorkflowState>();

export function getSessionKey(sessionId: string | undefined, cwd: string): string {
  const safeSessionId = sessionId && sessionId.trim() ? sessionId.trim() : "default-session";
  const safeCwd = path.resolve(cwd || process.cwd());
  return `${safeSessionId}:::${safeCwd}`;
}

export function getOrCreateSessionState(sessionId: string | undefined, cwd: string): SessionWorkflowState {
  const key = getSessionKey(sessionId, cwd);
  let state = sessionStates.get(key);
  if (!state) {
    state = {
      activeMode: "idle",
      currentPlan: null,
      btwActive: false,
      btwAbortController: null,
      btwQueue: [],
    };
    sessionStates.set(key, state);
  }
  return state;
}

export function resetSessionWorkflowState(sessionId: string | undefined, cwd: string): void {
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
    return { valid: false, error: "Root data harus berupa object JSON" };
  }

  const obj = data as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    return { valid: false, error: `Versi skema tidak didukung: ${String(obj.schemaVersion)} (diharapkan: 1)` };
  }
  if (typeof obj.sessionId !== "string" || !obj.sessionId.trim()) {
    return { valid: false, error: "Field 'sessionId' wajib berupa string non-kosong" };
  }
  if (typeof obj.cwd !== "string" || !obj.cwd.trim()) {
    return { valid: false, error: "Field 'cwd' wajib berupa string non-kosong" };
  }
  if (typeof obj.goal !== "string" || !obj.goal.trim()) {
    return { valid: false, error: "Field 'goal' wajib berupa string non-kosong" };
  }

  const validStatuses: PlanStatus[] = ["draft", "approved", "running", "completed", "failed"];
  if (typeof obj.status !== "string" || !validStatuses.includes(obj.status as PlanStatus)) {
    return { valid: false, error: `Field 'status' tidak valid: '${String(obj.status)}'` };
  }

  if (!Array.isArray(obj.steps)) {
    return { valid: false, error: "Field 'steps' wajib berupa array string" };
  }
  if (!Array.isArray(obj.risks)) {
    return { valid: false, error: "Field 'risks' wajib berupa array string" };
  }
  if (!Array.isArray(obj.acceptanceCriteria)) {
    return { valid: false, error: "Field 'acceptanceCriteria' wajib berupa array string" };
  }
  if (!Array.isArray(obj.verificationCommands)) {
    return { valid: false, error: "Field 'verificationCommands' wajib berupa array string" };
  }
  if (typeof obj.createdAt !== "string") {
    return { valid: false, error: "Field 'createdAt' wajib berupa string ISO" };
  }
  if (typeof obj.updatedAt !== "string") {
    return { valid: false, error: "Field 'updatedAt' wajib berupa string ISO" };
  }

  const plan: WorkflowPlanV1 = {
    schemaVersion: 1,
    sessionId: obj.sessionId,
    cwd: obj.cwd,
    goal: obj.goal,
    status: obj.status as PlanStatus,
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
    return { success: false, error: `Gagal menyimpan plan secara atomik: ${msg}` };
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
    return { plan: null, diagnostic: `Tidak dapat membaca file .pi/active-plan.json: ${msg}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      plan: null,
      diagnostic: `File .pi/active-plan.json rusak (invalid JSON): ${msg}. Silakan perbaiki atau buat ulang via /plan <tujuan>.`,
    };
  }

  const validation = validatePlanSchema(parsed);
  if (!validation.valid) {
    return {
      plan: null,
      diagnostic: `File .pi/active-plan.json tidak sesuai skema (${validation.error}). Silakan buat ulang via /plan <tujuan>.`,
    };
  }

  const loadedPlan = validation.plan;

  // Verifikasi cwd harus cocok persis dengan canonical path
  if (path.resolve(loadedPlan.cwd) !== path.resolve(cwd)) {
    return {
      plan: null,
      diagnostic: `Plan tersimpan ditujukan untuk direktori lain ('${loadedPlan.cwd}'), bukan direktori aktif saat ini ('${path.resolve(cwd)}').`,
    };
  }

  // Verifikasi session ID bila disediakan
  if (expectedSessionId && loadedPlan.sessionId !== expectedSessionId) {
    return {
      plan: null,
      diagnostic: `Plan tersimpan dibuat pada sesi lain ('${loadedPlan.sessionId}'). Buat rencana baru untuk sesi ini via /plan.`,
    };
  }

  return { plan: loadedPlan };
}

// Parse structured plan generated by the model
export function parseStructuredPlanFromAssistantText(text: string): Partial<WorkflowPlanV1> | null {
  if (!text) return null;

  // 1. Coba cari JSON code block
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
            : Array.isArray(p.verification)
            ? p.verification.map(String)
            : ["npm test"],
        };
      }
    } catch {
      // Fallback ke parser markdown
    }
  }

  // 2. Parser markdown berbasis heading (Steps, Risks, Criteria, Verification)
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
    } else if (/^#{1,4}\s*.*(criteria|kriteria|acceptance|selesai)/i.test(heading)) {
      currentSection = "criteria";
      continue;
    } else if (/^#{1,4}\s*.*(verif|test|perintah|command)/i.test(heading)) {
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

    // Sanitasi data sensitif (API key, authorization header, password)
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
// Provider Query with Guaranteed Timeout Cleanup
// ============================================================================

export interface ProviderEndpointConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export function resolveProviderEndpoint(): ProviderEndpointConfig | null {
  const envUrl = process.env.PI_BTW_URL || process.env.NINE_ROUTER_BASE_URL;
  const envKey = process.env.PI_BTW_API_KEY || process.env.NINE_ROUTER_API_KEY;
  const envModel = process.env.PI_BTW_MODEL;

  if (envUrl) {
    try {
      const parsed = new URL(envUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return {
          baseUrl: parsed.origin,
          apiKey: envKey,
          model: envModel || "ag/gemini-3.8-flash-low",
        };
      }
    } catch {}
  }

  const configPath = path.join(os.homedir(), ".pi", "agent", "9router-config.json");
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (cfg && typeof cfg.baseUrl === "string") {
        const parsed = new URL(cfg.baseUrl);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          return {
            baseUrl: parsed.origin,
            apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey : undefined,
            model: envModel || "ag/gemini-3.8-flash-low",
          };
        }
      }
    } catch {}
  }

  return null;
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
      error: "Endpoint AI lokal tidak ditemukan. Konfigurasikan ~/.pi/agent/9router-config.json atau PI_BTW_URL.",
    };
  }

  const internalController = new AbortController();
  const onExternalAbort = () => internalController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      return { success: false, answer: "", error: "Dibatalkan oleh user" };
    }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // Timer mencakup seluruh siklus fetch + pembacaan body json()
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      internalController.abort();
      reject(new Error("Timeout permintaan model"));
    }, timeoutMs);
  });

  const prompt = [
    contextSummary ? `Konteks kerja saat ini: "${contextSummary}"` : "",
    `Pertanyaan sampingan user: "${question}"`,
    ``,
    `Instruksi:`,
    `- Jawab pertanyaan sampingan secara langsung, ringkas, dan jelas dalam 1 hingga 2 paragraf pendek.`,
    `- Gunakan bahasa yang sama dengan pertanyaan user.`,
    `- Jangan sertakan salam pembuka/penutup. Langsung berikan penjelasan esensial.`,
  ].filter(Boolean).join("\n");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }

  try {
    const fetchPromise = (async () => {
      const res = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: provider.model,
          stream: false,
          max_tokens: 300,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: internalController.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Respon model kosong");
      }
      return content.trim();
    })();

    const result = await Promise.race([fetchPromise, timeoutPromise]);
    return { success: true, answer: result };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAborted = internalController.signal.aborted || (externalSignal?.aborted ?? false);
    return {
      success: false,
      answer: "",
      error: isAborted ? "Permintaan dibatalkan atau melebihi batas waktu (timeout)" : msg,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

// ============================================================================
// Workflow Prompts
// ============================================================================

export function formatPlanPrompt(goal: string): string {
  return [
    `[WORKFLOW MODE: /plan]`,
    `Tujuan Rencana: "${goal}"`,
    ``,
    `ATURAN KETAT MODE READ-ONLY (SCOUTING):`,
    `1. Eksplorasi repositori secara READ-ONLY. Baca berkas, cari referensi, dan periksa struktur tes.`,
    `2. Jangan mengubah, menulis, atau menghapus file source code. Semua tool mutasi (edit, write, bash, powershell) diblokir. Mode ini tidak mengubah source code (hanya menyimpan metadata rencana di .pi/active-plan.json).`,
    `3. Susun rencana terstruktur yang memuat langkah (Steps), risiko & mitigasi (Risks), kriteria selesai (Acceptance Criteria), dan perintah verifikasi (Verification Commands).`,
    `4. Akhiri respon Anda dengan blok JSON terstruktur berikut agar sistem dapat menangkap detail rencana secara otomatis:`,
    `\`\`\`json`,
    `{`,
    `  "plan": {`,
    `    "steps": ["langkah 1...", "langkah 2..."],`,
    `    "risks": ["risiko 1..."],`,
    `    "acceptanceCriteria": ["kriteria 1..."],`,
    `    "verificationCommands": ["npm test"]`,
    `  }`,
    `}`,
    `\`\`\``,
    `Setelah rencana selesai diulas, user dapat menyetujuinya via '/plan approve' lalu menjalankannya via '/build'.`,
  ].join("\n");
}

export function formatBuildPrompt(plan: WorkflowPlanV1): string {
  return [
    `[WORKFLOW MODE: /build]`,
    `Mengeksekusi Rencana yang Disetujui: "${plan.goal}"`,
    ``,
    `Rincian Rencana:`,
    `Langkah Implementasi:`,
    ...plan.steps.map((s, idx) => `  ${idx + 1}. ${s}`),
    `Kriteria Penerimaan:`,
    ...plan.acceptanceCriteria.map((c) => `  - ${c}`),
    `Perintah Verifikasi:`,
    ...plan.verificationCommands.map((v) => `  $ ${v}`),
    ``,
    `ATURAN EKSEKUSI:`,
    `1. Implementasikan langkah demi langkah. Jangan melompat tanpa pengujian.`,
    `2. Jalankan verifikasi/tes setelah tiap langkah selesai.`,
    `3. Buat checkpoint dan pastikan tes berhasil sebelum melangkah ke tahap berikutnya.`,
  ].join("\n");
}

export function formatDebugPrompt(issue: string): string {
  return [
    `[WORKFLOW MODE: /debug]`,
    `Laporan Masalah: "${issue}"`,
    ``,
    `5 TAHAP WORKFLOW DEBUGGING SISTEMATIS (WAJIB DIIKUTI SECARA BERURUTAN):`,
    `1. REPRODUCE: Reproduksi kegagalan dengan pengujian atau pemeriksaan tersempit sebelum menyentuh kode.`,
    `2. ROOT CAUSE INVESTIGATION: Telusuri alur data, call stack, dan error log. JANGAN menebak atau langsung mengubah kode!`,
    `3. HYPOTHESIS: Nyatakan satu hipotesis akar penyebab secara gamblang dan terverifikasi.`,
    `4. MINIMAL FIX: Buat perubahan paling kecil dan aman yang secara presisi menyelesaikan akar masalah.`,
    `5. REGRESSION TEST: Jalankan tes untuk memverifikasi perbaikan dan menjamin tidak ada regresi.`,
  ].join("\n");
}

export function formatReviewPrompt(targetContext?: string): string {
  return [
    `[WORKFLOW MODE: /review]`,
    targetContext ? `Target Review: "${targetContext}"` : `Target Review: Git diff / perubahan aktif`,
    ``,
    `ATURAN KETAT:`,
    `1. MODE INI ADALAH READ-ONLY CODE REVIEW. Dilarang mengedit, memperbaiki, atau mengubah file secara otomatis.`,
    `2. Periksa git diff dan berkas tes yang relevan.`,
    `3. Evaluasi secara mendalam terhadap:`,
    `   - Kebenaran logika & kepatuhan kebutuhan`,
    `   - Cakupan tes (test coverage) & kasus batas (edge cases)`,
    `   - Keamanan, penanganan error & performa`,
    `   - Kompleksitas kode & keterbacaan`,
    `4. Kelompokkan temuan berdasarkan kategori: [CRITICAL], [IMPORTANT], [MINOR], diakhiri dengan kesimpulan kesiapan merge.`,
  ].join("\n");
}

// ============================================================================
// Extension Main Registration
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Helper menampilkan popup modal dialog /btw (ephemeral overlay)
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
          const hint = theme.fg("dim", "Tekan ESC / ENTER / Q untuk menutup (task utama tidak terpengaruh)");
          box.push(padLine(hint, getVisibleWidth("Tekan ESC / ENTER / Q untuk menutup (task utama tidak terpengaruh)")));
          box.push(borderCol("╰" + "─".repeat(innerW + 2) + "╯"));

          const padLeft = Math.max(1, Math.floor((width - (innerW + 4)) / 2));
          const pad = " ".repeat(padLeft);
          return ["", ...box.map((l) => pad + l), ""];
        },
      };
    }, { overlay: true });
  }

  // Helper memproses pertanyaan /btw secara detached
  async function dispatchBtwRequest(ctx: ExtensionContext, question: string) {
    const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
    const state = getOrCreateSessionState(sessionId, ctx.cwd);

    if (state.btwActive) {
      if (state.btwQueue.length >= 3) {
        ctx.ui?.notify("Antrean pertanyaan sampingan /btw penuh (maks 3). Jalankan /btw-clear atau tunggu.", "warning");
        return;
      }
      const contextSummary = extractSanitizedContext(ctx.sessionManager?.getEntries?.() || []);
      state.btwQueue.push({
        id: Math.random().toString(36).slice(2, 8),
        question,
        contextSummary,
        queuedAt: new Date().toISOString(),
      });
      ctx.ui?.notify(`[BTW] Pertanyaan ditambahkan ke antrean (${state.btwQueue.length} menunggu)...`, "info");
      return;
    }

    state.btwActive = true;
    state.btwAbortController = new AbortController();
    const abortSignal = state.btwAbortController.signal;

    const contextSummary = extractSanitizedContext(ctx.sessionManager?.getEntries?.() || []);

    // Non-blocking detached worker
    queueMicrotask(async () => {
      ctx.ui?.setWidget("btw-status", ["⠋ Memproses pertanyaan sampingan /btw di background..."]);

      try {
        const result = await queryBtwAnswer(question, contextSummary, abortSignal, 15000);
        ctx.ui?.setWidget("btw-status", undefined);

        if (abortSignal.aborted) {
          return;
        }

        if (result.success) {
          await showBtwModal(ctx, question, result.answer);
        } else {
          ctx.ui?.notify(`[BTW Gagal] ${result.error || "Tidak ada jawaban"}`, "warning");
        }
      } catch (err: unknown) {
        ctx.ui?.setWidget("btw-status", undefined);
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui?.notify(`[BTW Error] ${msg}`, "error");
      } finally {
        state.btwActive = false;
        state.btwAbortController = null;

        // Proses item berikutnya dari antrean jika ada
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

  // Blokir semua jalur mutasi di mode /plan dan /review
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult> => {
    const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
    const state = getOrCreateSessionState(sessionId, ctx.cwd);

    if (state.activeMode === "plan" || state.activeMode === "review") {
      const toolName = event.toolName;
      if (!READ_ONLY_TOOL_ALLOWLIST.has(toolName)) {
        return {
          block: true,
          reason: `Tool '${toolName}' diblokir: Mode /${state.activeMode} adalah read-only (hanya tool ${Array.from(READ_ONLY_TOOL_ALLOWLIST).join(", ")} yang diizinkan untuk inspeksi).`,
        };
      }
    }
    return {};
  });

  // Saat turn selesai dan fully settled: capture plan dan reset mode sementara
  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
    const state = getOrCreateSessionState(sessionId, ctx.cwd);

    // Tangkap plan terstruktur jika mode /plan baru selesai
    if (state.activeMode === "plan") {
      try {
        const entries = ctx.sessionManager?.getEntries?.() || [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
          if (entry.type === "message" && entry.message?.role === "assistant") {
            let text = "";
            if (Array.isArray(entry.message.content)) {
              text = entry.message.content
                .filter((c: unknown) => typeof c === "object" && c !== null && (c as { type?: string }).type === "text")
                .map((c: unknown) => (c as { text: string }).text || "")
                .join(" ");
            } else if (typeof entry.message.content === "string") {
              text = entry.message.content;
            }

            const parsed = parseStructuredPlanFromAssistantText(text);
            if (parsed && state.currentPlan) {
              state.currentPlan.steps = parsed.steps || state.currentPlan.steps;
              state.currentPlan.risks = parsed.risks || state.currentPlan.risks;
              state.currentPlan.acceptanceCriteria = parsed.acceptanceCriteria || state.currentPlan.acceptanceCriteria;
              state.currentPlan.verificationCommands = parsed.verificationCommands || state.currentPlan.verificationCommands;
              state.currentPlan.updatedAt = new Date().toISOString();

              savePlanAtomic(ctx.cwd, state.currentPlan);
              pi.appendEntry("workflow_plan", state.currentPlan);
            }
            break;
          }
        }
      } catch {}
    }

    // Reset mode agar giliran berikutnya tidak terkunci
    if (state.activeMode === "plan" || state.activeMode === "review" || state.activeMode === "debug") {
      state.activeMode = "idle";
    }
  });

  // Reset state saat session diganti atau ditutup
  pi.on("session_before_switch", async (event, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    resetSessionWorkflowState(sessionId, ctx.cwd);
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    resetSessionWorkflowState(sessionId, ctx.cwd);
  });

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------

  // /btw: Out-of-band side question
  pi.registerCommand("btw", {
    description: "Ajukan pertanyaan sampingan out-of-band tanpa mengganggu task/plan aktif",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const question = args.trim();
      if (!question) {
        ctx.ui?.notify("Gunakan: /btw <pertanyaan>", "warning");
        return;
      }
      await dispatchBtwRequest(ctx, question);
    },
  });

  // /btw-list: Lihat status antrean
  pi.registerCommand("btw-list", {
    description: "Lihat status antrean pertanyaan sampingan /btw",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);

      if (state.btwQueue.length === 0) {
        ctx.ui?.notify(
          state.btwActive
            ? "Sedang memproses 1 pertanyaan sampingan /btw aktif (tidak ada antrean tambahan)."
            : "Antrean /btw kosong.",
          "info"
        );
        return;
      }

      const list = state.btwQueue.map((item, idx) => `${idx + 1}. ${item.question}`).join("\n");
      ctx.ui?.notify(`Antrean /btw (${state.btwQueue.length}):\n${list}`, "info");
    },
  });

  // /btw-clear: Batalkan request aktif dan bersihkan antrean
  pi.registerCommand("btw-clear", {
    description: "Batalkan request /btw aktif dan bersihkan semua antrean",
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

      ctx.ui?.notify(`Membersihkan ${count} aktivitas / antrean /btw.`, "info");
    },
  });

  // /plan <tujuan>: Read-only planning
  pi.registerCommand("plan", {
    description: "Rancang rencana implementasi terstruktur secara read-only sebelum coding",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);

      // Handle sub-command "/plan approve"
      if (trimmed.toLowerCase() === "approve") {
        const { plan, diagnostic } = loadPlanValidated(ctx.cwd, sessionId);
        if (diagnostic || !plan) {
          ctx.ui?.notify(diagnostic || "Belum ada rencana aktif untuk disetujui. Buat dengan /plan <tujuan>.", "warning");
          return;
        }

        plan.status = "approved";
        plan.updatedAt = new Date().toISOString();
        state.currentPlan = plan;

        const saveRes = savePlanAtomic(ctx.cwd, plan);
        if (!saveRes.success) {
          ctx.ui?.notify(saveRes.error || "Gagal menyimpan persetujuan plan.", "error");
          return;
        }

        pi.appendEntry("workflow_plan", plan);
        ctx.ui?.notify(`Rencana untuk '${plan.goal}' telah DISETUJUI. Jalankan /build untuk mengeksekusi.`, "info");
        return;
      }

      if (!trimmed) {
        ctx.ui?.notify("Gunakan: /plan <tujuan> (atau '/plan approve' untuk menyetujui rencana)", "warning");
        return;
      }

      state.activeMode = "plan";

      const now = new Date().toISOString();
      const newPlan: WorkflowPlanV1 = {
        schemaVersion: 1,
        sessionId,
        cwd: path.resolve(ctx.cwd),
        goal: trimmed,
        status: "draft",
        steps: ["Scouting codebase & architecture", "Detailing modules", "Implementation", "Verification"],
        risks: ["Identifikasi risiko berjalan..."],
        acceptanceCriteria: ["Kriteria penerimaan berjalan..."],
        verificationCommands: ["npm test"],
        createdAt: now,
        updatedAt: now,
      };

      state.currentPlan = newPlan;
      savePlanAtomic(ctx.cwd, newPlan);
      pi.appendEntry("workflow_plan", newPlan);

      pi.sendUserMessage(formatPlanPrompt(trimmed));
    },
  });

  // /plan-approve: Command eksplisit menyetujui plan aktif
  pi.registerCommand("plan-approve", {
    description: "Setujui rencana aktif agar dapat dijalankan oleh /build",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);

      const { plan, diagnostic } = loadPlanValidated(ctx.cwd, sessionId);
      if (diagnostic || !plan) {
        ctx.ui?.notify(diagnostic || "Belum ada rencana aktif. Silakan buat rencana via /plan <tujuan>.", "warning");
        return;
      }

      plan.status = "approved";
      plan.updatedAt = new Date().toISOString();
      state.currentPlan = plan;

      const saveRes = savePlanAtomic(ctx.cwd, plan);
      if (!saveRes.success) {
        ctx.ui?.notify(saveRes.error || "Gagal menyimpan persetujuan rencana.", "error");
        return;
      }

      pi.appendEntry("workflow_plan", plan);
      ctx.ui?.notify(`Rencana '${plan.goal}' berhasil DISETUJUI. Jalankan /build untuk memulai.`, "info");
    },
  });

  // /build: Menjalankan rencana yang disetujui
  pi.registerCommand("build", {
    description: "Eksekusi bertahap dari rencana /plan yang telah disetujui",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);

      const { plan, diagnostic } = loadPlanValidated(ctx.cwd, sessionId);
      if (diagnostic || !plan) {
        ctx.ui?.notify(diagnostic || "Belum ada rencana aktif. Silakan buat rencana terlebih dahulu dengan: /plan <tujuan>", "error");
        return;
      }

      if (plan.status === "draft") {
        ctx.ui?.notify(
          `Rencana '${plan.goal}' masih berstatus DRAFT dan belum disetujui. Jalankan '/plan approve' untuk menyetujuinya sebelum /build.`,
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
    },
  });

  // /debug <masalah>: Alur investigasi terstruktur
  pi.registerCommand("debug", {
    description: "Mulai workflow debugging 5 tahap (Reproduce -> Root-Cause -> Hypothesis -> Fix -> Test)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const issue = args.trim();
      if (!issue) {
        ctx.ui?.notify("Gunakan: /debug <deskripsi masalah atau pesan error>", "warning");
        return;
      }

      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);
      state.activeMode = "debug";

      pi.sendUserMessage(formatDebugPrompt(issue));
    },
  });

  // /review: Code review read-only
  pi.registerCommand("review", {
    description: "Lakukan code review read-only pada git diff / perubahan aktif",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
      const state = getOrCreateSessionState(sessionId, ctx.cwd);
      state.activeMode = "review";

      pi.sendUserMessage(formatReviewPrompt(args.trim()));
    },
  });
}
