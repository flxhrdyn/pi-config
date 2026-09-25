import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  safePostJson,
  validateEndpointUrl,
  resolveSecureApiKey,
  isExternalOptInEnabled,
} from "./security-guard.js";

// Membersihkan string judul: hilangkan kutip, awalan obrolan, karakter kontrol, dan batasi 6 kata
export function cleanTitle(raw: string): string {
  if (!raw) return "";
  let clean = raw
    .replace(/^["'`“”]+|["'`“”]+$/g, "")
    .replace(/[#*_~`]/g, "")
    .replace(/^(chat\s+tentang|topik:|judul:|title:)\s*/i, "")
    .replace(/[^\p{L}\p{N}\s\-_/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = clean.split(" ").filter(Boolean);
  if (words.length > 6) {
    clean = words.slice(0, 6).join(" ");
  }

  if (clean.length > 0) {
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  return clean;
}

const NON_TASK_PROMPTS = new Set([
  "hi", "hello", "hey", "halo", "hai", "pagi", "siang", "sore", "malam",
  "good morning", "good afternoon", "good evening", "test", "tes", "thanks",
  "thank you", "makasih", "terima kasih", "ok", "oke", "okay", "lanjut", "continue",
  "halo bot", "hello bot", "hi bot",
]);

const NON_TASK_COMMAND = /^\/(?:resume|new|tree|fork|sessions|help|compact|clear|quit|exit)(?:\s|$)/i;
const TASK_COMMAND = /^\/(?:plan|build|debug|review)\s+([\s\S]+)$/i;

/** Return the first task-bearing prompt, ignoring greetings and session-control commands. */
export function selectInitialTitlePrompt(userTexts: string[]): string | null {
  for (const rawText of userTexts) {
    let prompt = rawText.trim();
    if (!prompt || NON_TASK_COMMAND.test(prompt)) continue;

    const taskCommand = prompt.match(TASK_COMMAND);
    if (taskCommand) {
      prompt = taskCommand[1].trim();
    } else if (/^\/[\w-]+(?:\s|$)/.test(prompt)) {
      continue;
    }

    const normalized = prompt
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (NON_TASK_PROMPTS.has(normalized)) continue;
    if (prompt.length <= 8 && normalized.split(" ").length < 2) continue;

    return prompt;
  }

  return null;
}

// Fallback lokal sederhana: ambil 5 kata awal dari prompt tugas pertama.
export function generateLocalFallbackTitle(userTexts: string[]): string {
  const target = selectInitialTitlePrompt(userTexts) || "";
  const words = target
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  return cleanTitle(words.slice(0, 5).join(" "));
}

export interface TitleEndpointConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export function resolveTitleEndpoint(): TitleEndpointConfig | null {
  const envUrl = process.env.PI_TITLE_URL || process.env.NINE_ROUTER_BASE_URL;
  const envModel = process.env.PI_TITLE_MODEL;

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

// Request LLM title dengan timeout menyeluruh dan security guard
export async function requestLlmTitle(
  promptContext: string,
  timeoutMs = 3000
): Promise<string | null> {
  const endpoint = resolveTitleEndpoint();
  if (!endpoint) return null;

  const instruction = `Task: Summarize the primary objective of this user request into a short imperative action title of 3 to 5 words (similar to: "Fix pi extension conflict", "Disconnect Claude Code from 9router", "Configure postgresql backup script", "Use terra model").
User prompt: "${promptContext}"
Rules:
1. Match the exact language of the request (if Indonesian use Indonesian, if English use English).
2. Do not translate.
3. Output ONLY the title text. No punctuation, no quotes, no conversational filler.`;

  const targetUrl = `${endpoint.baseUrl}/v1/chat/completions`;
  const payload = {
    model: endpoint.model,
    stream: false,
    max_tokens: 25,
    messages: [{ role: "user", content: instruction }],
  };

  try {
    const res = await safePostJson<{ choices?: Array<{ message?: { content?: string } }> }>(
      targetUrl,
      payload,
      endpoint.apiKey,
      {
        timeoutMs,
        allowExternal: isExternalOptInEnabled(),
      }
    );

    if (!res.success || !res.data) return null;

    const content = res.data.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      const firstLine = content.split(/[\r\n]+/)[0]?.trim();
      return cleanTitle(firstLine);
    }
    return null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  const activeRequests = new Set<string>();

  // Use stable agent_settled lifecycle (instead of agent_end) to avoid naming during retries or auto-compaction
  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    // 1. Cek apakah sesi sudah memiliki nama (baik manual atau generate sebelumnya)
    const existingName = ctx.sessionManager?.getSessionName?.() || pi.getSessionName();
    if (existingName && existingName.trim().length > 0) {
      return;
    }

    // Use only the active path: getEntries() also includes abandoned/forked branches.
    const entries = (ctx.sessionManager?.getBranch?.() || []) as Array<{
      type?: string;
      customType?: string;
      message?: { role?: string; content?: unknown };
    }>;

    const userTexts: string[] = [];
    let assistantMessageCount = 0;
    let hasCustomMetadata = false;

    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "auto_session_title") {
        hasCustomMetadata = true;
      }
      if (entry.type === "message" && entry.message) {
        if (entry.message.role === "user") {
          const parts = entry.message.content;
          if (Array.isArray(parts)) {
            const txt = parts
              .filter((p: unknown) => typeof p === "object" && p !== null && (p as { type?: string }).type === "text")
              .map((p: unknown) => (p as { text: string }).text || "")
              .join(" ")
              .trim();
            if (txt && !txt.startsWith("Attached image") && !txt.startsWith("<skill")) {
              userTexts.push(txt);
            }
          } else if (typeof entry.message.content === "string") {
            const txt = entry.message.content.trim();
            if (txt && !txt.startsWith("Attached image") && !txt.startsWith("<skill")) {
              userTexts.push(txt);
            }
          }
        } else if (entry.message.role === "assistant") {
          assistantMessageCount++;
        }
      }
    }

    if (hasCustomMetadata) return;

    const titlePrompt = selectInitialTitlePrompt(userTexts);

    // Wait until at least one assistant turn has completed for a real task prompt.
    if (!titlePrompt || assistantMessageCount < 1) {
      return;
    }

    const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
    if (activeRequests.has(sessionId)) {
      return;
    }
    activeRequests.add(sessionId);

    // Eksekusi detached di background
    queueMicrotask(async () => {
      try {
        // Cek kembali nama sesi sebelum memanggil model
        const currentName = ctx.sessionManager?.getSessionName?.() || pi.getSessionName();
        if (currentName && currentName.trim().length > 0) {
          return;
        }

        // Codex-style stable history label: derive once from the first task-bearing request.
        const contextSample = titlePrompt.slice(0, 300);

        // Fallback lokal instan
        const localFallback = generateLocalFallbackTitle([titlePrompt]);

        // Minta rangkuman dari model
        let finalTitle = await requestLlmTitle(contextSample, 3500);

        if (!finalTitle || finalTitle.length < 3) {
          finalTitle = localFallback;
        }

        // Check again right before committing the session name to prevent overwriting manual titles
        const checkBeforeCommit = ctx.sessionManager?.getSessionName?.() || pi.getSessionName();
        if (checkBeforeCommit && checkBeforeCommit.trim().length > 0) {
          return;
        }

        if (finalTitle && finalTitle.length > 0) {
          pi.setSessionName(finalTitle);
          pi.appendEntry("auto_session_title", { generated: true, title: finalTitle });
        }
      } catch {
        // Non-critical: failure in title generation should not disrupt user interaction
      } finally {
        activeRequests.delete(sessionId);
      }
    });
  });
}
