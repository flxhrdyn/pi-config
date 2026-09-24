import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Membersihkan string judul: hilangkan kutip, awalan "chat tentang", simbol aneh, dan batasi 6 kata
export function cleanTitle(raw: string): string {
  if (!raw) return "";
  let clean = raw
    .replace(/^["'`“”]+|["'`“”]+$/g, "")   // Hapus kutip luar
    .replace(/[#*_~`]/g, "")               // Hapus markdown
    .replace(/^(chat\s+tentang|topik:|judul:|title:)\s*/i, "")
    .replace(/[^\p{L}\p{N}\s\-_/]/gu, " ") // Hapus emoji & karakter kontrol
    .replace(/\s+/g, " ")
    .trim();

  // Batasi maksimal 6 kata
  const words = clean.split(" ").filter(Boolean);
  if (words.length > 6) {
    clean = words.slice(0, 6).join(" ");
  }

  // Kapitalisasi huruf awal
  if (clean.length > 0) {
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  return clean;
}

// Fallback lokal sederhana: ambil 5 kata awal dari pesan user yang substantif tanpa hardcode kamus bahasa
export function generateLocalFallbackTitle(userTexts: string[]): string {
  // Cari pesan yang lebih dari 6 karakter (melewati pesan pendek seperti "tes", "hi")
  const target = userTexts.find((t) => t.trim().length > 6) || userTexts[userTexts.length - 1] || "";
  const words = target
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  return cleanTitle(words.slice(0, 5).join(" "));
}

// Panggil LLM lokal (9router) secara terisolasi dengan timeout 3 detik
export async function requestLlmTitle(
  promptContext: string,
  timeoutMs: number = 3000
): Promise<string | null> {
  const configPath = path.join(os.homedir(), ".pi", "agent", "9router-config.json");
  if (!fs.existsSync(configPath)) return null;

  let cfg: { baseUrl?: string; apiKey?: string } = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }

  const baseUrl = cfg.baseUrl || "http://127.0.0.1:20128";
  const apiKey = cfg.apiKey || "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Instruksi universal: LLM mendeteksi sendiri bahasa percakapan dan merangkum dalam bahasa aslinya
  const instruction = `Task: Provide a concise title (3 to 5 words) summarizing this user request: "${promptContext}".
Rules:
1. Match the exact language of the request (if Indonesian use Indonesian, if English use English).
2. Do not translate.
3. Output ONLY the title text. No quotes, no markdown, no explanation.`;

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
        max_tokens: 25,
        messages: [{ role: "user", content: instruction }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!res.ok) return null;

    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      const firstLine = content.split(/[\r\n]+/)[0]?.trim();
      return cleanTitle(firstLine);
    }
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  const activeRequests = new Set<string>();

  pi.on("agent_end", async (_event, ctx) => {
    // 1. Cek apakah sesi sudah punya nama (manual atau dari generate sebelumnya)
    const existingName = ctx.sessionManager?.getSessionName?.() || pi.getSessionName();
    if (existingName && existingName.trim().length > 0) {
      return;
    }

    // 2. Ambil riwayat percakapan
    const entries = (ctx.sessionManager?.getEntries?.() || []) as any[];
    const userTexts: string[] = [];
    let assistantMessageCount = 0;
    let hasCustomMetadata = false;

    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "auto_session_title") {
        hasCustomMetadata = true;
      }
      if (entry.type === "message") {
        if (entry.message?.role === "user") {
          const parts = entry.message.content;
          if (Array.isArray(parts)) {
            const txt = parts
              .filter((p: any) => p.type === "text" && p.text)
              .map((p: any) => p.text)
              .join(" ")
              .trim();
            if (txt && !txt.startsWith("Attached image")) {
              userTexts.push(txt);
            }
          }
        } else if (entry.message?.role === "assistant") {
          assistantMessageCount++;
        }
      }
    }

    // Guard: Jangan proses jika metadata menandai sudah pernah dinamai
    if (hasCustomMetadata) return;

    // Syarat: Respons asisten pertama sudah selesai DAN minimal ada 2 pesan user
    if (userTexts.length < 2 || assistantMessageCount < 1) {
      return;
    }

    const sessionId = ctx.sessionManager?.getSessionId?.() || "default";
    if (activeRequests.has(sessionId)) {
      return;
    }
    activeRequests.add(sessionId);

    // 3. Eksekusi detached / non-blocking di background (tidak menahan chat loop)
    queueMicrotask(async () => {
      try {
        const currentName = ctx.sessionManager?.getSessionName?.() || pi.getSessionName();
        if (currentName && currentName.trim().length > 0) {
          return;
        }

        const contextSample = userTexts.slice(0, 3).join(" | ").slice(0, 300);

        // Fallback lokal sederhana (langsung siap pakai)
        const localFallback = generateLocalFallbackTitle(userTexts);

        // Minta rangkuman judul cerdas dari LLM (timeout 3 detik)
        let finalTitle = await requestLlmTitle(contextSample, 3000);

        // Jika LLM timeout / gagal, gunakan fallback lokal
        if (!finalTitle || finalTitle.length < 3) {
          finalTitle = localFallback;
        }

        if (finalTitle && finalTitle.length > 0) {
          pi.setSessionName(finalTitle);
          pi.appendEntry("auto_session_title", { generated: true, title: finalTitle });
        }
      } catch {
        // Senyap: error tidak boleh mengganggu chat utama
      } finally {
        activeRequests.delete(sessionId);
      }
    });
  });
}
