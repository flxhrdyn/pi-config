import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Helper mempercantik nama model untuk statusline
function formatModelDisplayName(rawId: string): string {
  if (!rawId) return "pi";

  let clean = rawId.replace(/^(ag|cx|openai|google|anthropic|9router|opencode-zen)\//i, "");

  if (/^opencode\//i.test(clean)) {
    const sub = clean.slice(9);
    if (sub.includes("muse-spark-1.3")) return "Muse Spark 1.3 Free";
    if (sub.includes("muse-spark-1.2")) return "Muse Spark 1.2 Free";
    if (sub.includes("mimo-v2.6")) return "MiMo-V2.6-Flash Free";
    if (sub.includes("ling-3.0")) return "Ling 3.0 Flash Fin Free";
    if (sub.includes("nemotron-3.5")) return "Nemotron 3.5 Lightning Free";
    if (sub.includes("nemotron-3")) return "Nemotron 3 Ultra Free";
  }

  if (/^gemini/i.test(clean)) {
    const parts = clean.split("-");
    let name = "Gemini";
    let version = "";
    let type = "";
    let effort = "";

    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (/^\d+(\.\d+)?$/.test(p)) {
        version = p;
      } else if (p.toLowerCase() === "flash" || p.toLowerCase() === "pro") {
        type = p.charAt(0).toUpperCase() + p.slice(1);
      } else if (["low", "medium", "high", "thinking"].includes(p.toLowerCase())) {
        effort = `(${p.charAt(0).toUpperCase() + p.slice(1)})`;
      }
    }
    return [name, version, type, effort].filter(Boolean).join(" ");
  }

  if (/^claude/i.test(clean)) {
    clean = clean.replace(/claude-?/i, "Claude ");
    clean = clean.replace(/-/g, " ");
    return clean;
  }

  if (/^gpt/i.test(clean)) {
    return clean.replace(/gpt-/i, "GPT-");
  }

  return clean;
}

// Baca nilai reserveTokens dari ~/.pi/agent/settings.json secara dinamis
function getCompactionReserveTokens(modelKey?: string): number {
  const DEFAULT_RESERVE_TOKENS = 16384;
  try {
    const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      const compaction = settings.compaction;
      if (compaction) {
        if (modelKey && compaction.modelOverrides?.[modelKey]?.reserveTokens !== undefined) {
          return Number(compaction.modelOverrides[modelKey].reserveTokens);
        }
        if (compaction.reserveTokens !== undefined) {
          return Number(compaction.reserveTokens);
        }
      }
    }
  } catch {}
  return DEFAULT_RESERVE_TOKENS;
}

// Helper membaca status git (modified, added, deleted, untracked)
function getGitStats(): string | null {
  try {
    const status = execSync("git status --porcelain", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 1000,
    }).trim();

    if (!status) return null;

    let modified = 0;
    let added = 0;
    let deleted = 0;
    let untracked = 0;

    for (const line of status.split("\n")) {
      const x = line[0];
      const y = line[1];
      if (x === "?" && y === "?") untracked++;
      else if (x === "A" || y === "A") added++;
      else if (x === "D" || y === "D") deleted++;
      else if (x === "M" || y === "M" || x === "R") modified++;
    }

    const parts: string[] = [];
    if (modified > 0) parts.push(`~${modified}`);
    if (added > 0) parts.push(`+${added}`);
    if (deleted > 0) parts.push(`-${deleted}`);
    if (untracked > 0) parts.push(`?${untracked}`);

    return parts.length > 0 ? parts.join(" ") : null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let timerId: any = null;
  let startTime = 0;
  let frameIdx = 0;
  let currentAction = "Thinking";
  let currentDetail = "";
  let isBusy = false;
  let requestTuiRender: (() => void) | null = null;
  let zenMode = false;

  // Session activity counters
  let sessionStartTime = Date.now();
  let totalTurnCount = 0;
  let totalToolsExecuted = 0;
  const toolCounts: Record<string, number> = {};

  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  const ensureCustomUI = (ctx: any) => {
    if (!ctx.hasUI) return;
    initCleanVimUI(ctx);
    if (!zenMode) {
      initCustomHeader(ctx);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    ensureCustomUI(ctx);
    // Also execute on next tick to override Pi built-in resetExtensionUI during /reload
    setTimeout(() => ensureCustomUI(ctx), 50);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ensureCustomUI(ctx);
    startTime = Date.now();
    frameIdx = 0;
    currentAction = "Thinking";
    currentDetail = "";
    isBusy = true;
    totalTurnCount++;

    ctx.ui.setWorkingVisible(false);
    updateWorkingWidget(ctx);
    requestTuiRender?.();

    if (timerId) clearInterval(timerId);
    timerId = setInterval(() => {
      frameIdx = (frameIdx + 1) % SPINNER_FRAMES.length;
      updateWorkingWidget(ctx);
    }, 80);
  });

  // Intercept user input: terjemahkan token [Image #N] kembali ke real path sebelum dikirim ke agent/tools
  pi.on("input", async (event) => {
    let text = event.text;
    const imgMap = (globalThis as any).__pi_image_map;
    if (imgMap && imgMap instanceof Map && imgMap.size > 0) {
      let changed = false;
      for (const [badge, realPath] of imgMap.entries()) {
        if (text.includes(badge)) {
          text = text.replaceAll(badge, realPath);
          changed = true;
        }
      }
      if (changed) {
        return { action: "transform", text };
      }
    }
    return { action: "continue" };
  });

  // Render format badge [Image #N] di pesan bubble transcript / history agar tetap ringkas
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType === "user") {
      // Ganti path clipboard menjadi badge pendek jika ada
      return markdown.replace(/[A-Za-z]:\\[^\s`"'<>]+\\pi-clipboard-[a-f0-9-]+\.(png|jpg|jpeg|webp|gif)/gi, (match) => {
        const imgMap = (globalThis as any).__pi_image_map;
        if (imgMap && imgMap instanceof Map) {
          for (const [badge, realPath] of imgMap.entries()) {
            if (realPath.toLowerCase() === match.toLowerCase()) {
              return badge;
            }
          }
        }
        return "[Image]";
      });
    }
    return markdown;
  });

  pi.on("message_update", async (event, ctx) => {
    if (!ctx.hasUI) return;
    const ev = event.assistantMessageEvent as any;
    if (ev) {
      if (ev.type === "thinking_start" || ev.type === "thinking_delta") {
        currentAction = "Reasoning";
        currentDetail = "";
      } else if (ev.type === "text_start" || ev.type === "text_delta") {
        currentAction = "Synthesizing";
        currentDetail = "";
      }
    }
  });

  function formatToolTarget(tool: string, args: any): string {
    if (!args) return "";
    const cwd = process.cwd();
    const home = os.homedir();
    const cleanPath = (p: string) => {
      if (!p) return "";
      const normalized = p.replace(/\\/g, "/");
      const normCwd = cwd.replace(/\\/g, "/");
      const normHome = home.replace(/\\/g, "/");
      if (normalized.startsWith(normCwd + "/")) return normalized.slice(normCwd.length + 1);
      if (normalized.startsWith(normHome)) return "~" + normalized.slice(normHome.length);
      return normalized;
    };

    if (tool === "read" || tool === "edit" || tool === "write") {
      const raw = args.file_path || args.path || "";
      const p = cleanPath(raw);
      const range = args.offset ? `:${args.offset}${args.limit ? `-${args.offset + args.limit - 1}` : ""}` : "";
      return p ? `${p}${range}` : "";
    }
    if (tool === "bash") {
      const cmd = args.command || "";
      return cmd.length > 36 ? cmd.slice(0, 33) + "…" : cmd;
    }
    if (tool.includes("search") || tool === "find" || tool === "grep") {
      const q = args.query || args.pattern || "";
      return q ? `"${q}"` : "";
    }
    return "";
  }

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    const tool = event.toolName;
    totalToolsExecuted++;
    toolCounts[tool] = (toolCounts[tool] || 0) + 1;

    if (tool === "read") currentAction = "Reading";
    else if (tool === "edit" || tool === "write") currentAction = "Writing";
    else if (tool === "bash") currentAction = "Executing";
    else if (tool.includes("search") || tool === "find" || tool === "grep") currentAction = "Searching";
    else currentAction = "Processing";

    currentDetail = formatToolTarget(tool, event.args);
    updateWorkingWidget(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentAction = "Analyzing";
    updateWorkingWidget(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    isBusy = false;
    currentDetail = "";
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    ctx.ui.setWidget("codex-loading", undefined, { placement: "aboveEditor" });
    requestTuiRender?.();
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ensureCustomUI(ctx);
    isBusy = true;
    requestTuiRender?.();
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    isBusy = false;
    requestTuiRender?.();
  });

  pi.on("session_compact_failed", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    isBusy = false;
    requestTuiRender?.();
  });

  function updateWorkingWidget(ctx: any) {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const activeFrame = SPINNER_FRAMES[frameIdx];

    const spinner = ctx.ui.theme.fg("accent", activeFrame);
    const actionPart = ctx.ui.theme.fg("warning", currentAction);
    const detailPart = currentDetail ? " " + ctx.ui.theme.fg("text", currentDetail) : "";
    const metaPart = ctx.ui.theme.fg("dim", ` (${elapsedSec}s • <esc> to stop)`);
    const line = `${spinner} ${actionPart}${detailPart}${metaPart}`;

    ctx.ui.setWidget("codex-loading", [line, ""], { placement: "aboveEditor" });
  }

  function initCleanVimUI(ctx: any) {
    ctx.ui.setWorkingVisible(false);

    if (typeof ctx.ui?.setEditorComponent === "function") {
      ctx.ui.setEditorComponent((tui: any, editorTheme: any, keybindings: any) => {
        return new CustomEditor(tui, editorTheme, keybindings, { embedWorkingStatus: false });
      });
    }

    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      requestTuiRender = () => tui.requestRender();
      const unsub = footerData?.onBranchChange?.(() => tui.requestRender());

      return {
        dispose: unsub || (() => {}),
        invalidate() {},
        render(width: number): string[] {
          // 1. Status Mode: IDLE (Hijau) / BUSY (Kuning)
          const modeLabel = isBusy ? "BUSY" : "IDLE";
          const modePart = isBusy
            ? theme.bold(theme.fg("warning", modeLabel))
            : theme.bold(theme.fg("success", modeLabel));

          // 2. Model: Nama rapi
          const rawId = ctx.model?.id || "pi";
          const cleanModelName = formatModelDisplayName(rawId);
          const thinking = ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? `:${ctx.thinkingLevel}` : "";
          const modelPart = theme.fg("text", `${cleanModelName}${thinking}`);

          // 3. Git branch + Git status (+2 ~1 -1)
          const branch = footerData?.getGitBranch?.() || "";
          let gitPart = "";
          if (branch) {
            const gitDiff = getGitStats();
            const diffStr = gitDiff ? ` ${theme.fg("warning", gitDiff)}` : "";
            gitPart = theme.fg("dim", ` ${branch}`) + diffStr;
          }

          const leftItems = [modePart, modelPart, gitPart].filter(Boolean);
          const leftLine = " " + leftItems.join("  ");

          // 4. Kanan: Context usage
          const fmtTokens = (n: number) => {
            if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
            if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
            return `${n}`;
          };

          let usedPercent = 0;
          let tokenStr = "";
          let contextColorRole: "success" | "warning" | "error" = "success";

          try {
            const usage = ctx.getContextUsage?.();
            if (usage) {
              const tokensUsed = usage.tokens ?? 0;
              const contextWindow = usage.contextWindow ?? 0;

              usedPercent =
                typeof usage.percent === "number"
                  ? Math.min(100, Math.round(usage.percent))
                  : contextWindow > 0
                  ? Math.min(100, Math.round((tokensUsed / contextWindow) * 100))
                  : 0;

              if (contextWindow > 0) {
                tokenStr = `${fmtTokens(tokensUsed)}/${fmtTokens(contextWindow)}`;

                const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
                const reserveTokens = getCompactionReserveTokens(modelKey);
                const compactThreshold = Math.max(0, contextWindow - reserveTokens);
                const ratioToCompact = compactThreshold > 0 ? tokensUsed / compactThreshold : 0;

                if (ratioToCompact >= 0.75 || tokensUsed >= compactThreshold) {
                  contextColorRole = "error";
                } else if (ratioToCompact >= 0.40) {
                  contextColorRole = "warning";
                } else {
                  contextColorRole = "success";
                }
              }
            }
          } catch {}

          const encodingPart = theme.fg("dim", "utf-8");
          const contextPart = theme.fg(contextColorRole, `ctx ${usedPercent}%${tokenStr ? ` (${tokenStr})` : ""}`);

          const rightItems = [encodingPart, contextPart];
          const rightLine = rightItems.join("  ") + " ";

          const gap = Math.max(1, width - visibleWidth(leftLine) - visibleWidth(rightLine));
          const line = leftLine + " ".repeat(gap) + rightLine;

          return [truncateToWidth(line, width)];
        },
      };
    });
  }

  // Header Minimalis: Centered 3-piece Pi logo dengan layout tabular clean
  function initCustomHeader(ctx: any) {
    if (!ctx.ui?.setHeader) return;

    ctx.ui.setHeader((_tui: any, theme: any) => {
      return {
        dispose() {},
        invalidate() {},
        render(width: number): string[] {
          const cwd = process.cwd();
          const home = os.homedir();
          const cleanCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
          const rawId = ctx.model?.id || "pi";
          const modelName = formatModelDisplayName(rawId);
          const thinking = ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ` (${ctx.thinkingLevel})` : "";
          const themeName = ctx.ui?.theme?.name || "gruvbox";

          // 3-Piece Geometric Pi Logo (Coral / Blue / Yellow)
          // Piece 1 (Top arch): syntaxKeyword
          // Piece 2 (Left stem & arm): syntaxFunction
          // Piece 3 (Right pillar): warning
          const p1 = (txt: string) => theme.bold(theme.fg("syntaxKeyword", txt));
          const p2 = (txt: string) => theme.bold(theme.fg("syntaxFunction", txt));
          const p3 = (txt: string) => theme.bold(theme.fg("warning", txt));

          // Center logo horizontally (logo width = 16 characters)
          const padLeft = Math.max(2, Math.floor((width - 16) / 2));
          const pad = " ".repeat(padLeft);

          const logoLines = [
            pad + p1("████████████"),
            pad + p1("████████████"),
            pad + p2("████") + "    " + p1("████"),
            pad + p2("████") + "    " + p1("████"),
            pad + p2("████████") + "    " + p3("████"),
            pad + p2("████████") + "    " + p3("████"),
            pad + p2("████") + "        " + p3("████"),
            pad + p2("████") + "        " + p3("████"),
          ];

          // Format metadata rows centered horizontally as a cohesive block
          const TAG_WIDTH = 14;

          const rowsData = [
            {
              label: "Version",
              val:
                theme.fg("dim", "Local: ") +
                theme.fg("text", "v0.87.1") +
                theme.fg("dim", "  Latest: ") +
                theme.fg("text", "v0.87.1"),
              rawLen: TAG_WIDTH + visibleWidth("Local: v0.87.1  Latest: v0.87.1"),
            },
            {
              label: "Model",
              val: theme.fg("accent", `${modelName}${thinking}`),
              rawLen: TAG_WIDTH + visibleWidth(`${modelName}${thinking}`),
            },
            {
              label: "Directory",
              val: theme.fg("text", cleanCwd),
              rawLen: TAG_WIDTH + visibleWidth(cleanCwd),
            },
            {
              label: "Shortcuts",
              val:
                theme.fg("muted", "/help") +
                theme.fg("dim", " commands  ") +
                theme.fg("muted", "esc 2x") +
                theme.fg("dim", " clear  ") +
                theme.fg("muted", "ctrl+u") +
                theme.fg("dim", " del-line"),
              rawLen: TAG_WIDTH + visibleWidth("/help commands  esc 2x clear  ctrl+u del-line"),
            },
          ];

          const maxRowWidth = Math.max(...rowsData.map((r) => r.rawLen));
          const padMeta = " ".repeat(Math.max(2, Math.floor((width - maxRowWidth) / 2)));

          const rows = rowsData.map((r) => {
            const tag = `[${r.label}]`.padEnd(TAG_WIDTH);
            return `${padMeta}${theme.fg("dim", tag)}${r.val}`;
          });

          const allLines = ["", ...logoLines, "", ...rows, ""];
          return allLines.map((l) => truncateToWidth(l, width));
        },
      };
    });
  }

  // Command /stats: Menampilkan floating statistics overlay box ala Neovim modal
  pi.registerCommand("stats", {
    description: "Tampilkan statistik detail sesi ini (turns, tools, context, runtime)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const elapsedSec = Math.max(0, Math.floor((Date.now() - sessionStartTime) / 1000));
      const mins = Math.floor(elapsedSec / 60);
      const secs = elapsedSec % 60;
      const uptimeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      const rawId = ctx.model?.id || "pi";
      const modelName = formatModelDisplayName(rawId);
      const thinking = ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? ` (${ctx.thinkingLevel})` : "";

      let tokenUsage = "N/A";
      try {
        const usage = ctx.getContextUsage?.();
        if (usage && usage.tokens !== null && usage.tokens !== undefined) {
          tokenUsage = `${usage.tokens.toLocaleString()} tokens`;
          if (usage.contextWindow) {
            tokenUsage += ` / ${(usage.contextWindow / 1000).toFixed(0)}k (${Math.round((usage.tokens / usage.contextWindow) * 100)}%)`;
          }
        }
      } catch {}

      // Hitung historis langsung dari sessionManager agar akurat mencakup seluruh sesi
      let sessionToolCalls = totalToolsExecuted;
      let sessionTurns = totalTurnCount;
      const combinedToolCounts: Record<string, number> = { ...toolCounts };

      try {
        const entries = (ctx.sessionManager?.getEntries?.() || []) as any[];
        let entryToolCalls = 0;
        let entryUserMessages = 0;
        const entryToolMap: Record<string, number> = {};

        for (const entry of entries) {
          if (entry.type === "message") {
            if (entry.message?.role === "user") {
              entryUserMessages++;
            } else if (entry.message?.role === "assistant") {
              const calls = entry.message.content?.filter((c: any) => c.type === "toolCall") || [];
              for (const call of calls) {
                entryToolCalls++;
                entryToolMap[call.name] = (entryToolMap[call.name] || 0) + 1;
              }
            }
          }
        }

        if (entryToolCalls > sessionToolCalls) {
          sessionToolCalls = entryToolCalls;
          Object.assign(combinedToolCounts, entryToolMap);
        }
        if (entryUserMessages > sessionTurns) {
          sessionTurns = entryUserMessages;
        }
      } catch {}

      const toolsSummary = Object.entries(combinedToolCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([t, count]) => `${t}: ${count}`)
        .join("  ");

      const cwd = process.cwd();
      const home = os.homedir();
      const cleanCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

      await ctx.ui.custom((_tui: any, theme: any, _kb: any, done: (res?: unknown) => void) => {
        return {
          dispose() {},
          invalidate() {},
          handleInput(data: string) {
            if (data === "\x1b" || data === "\r" || data === "\n" || data === "q" || data === "Q") {
              done();
              return true;
            }
            return true;
          },
          render(width: number): string[] {
            const innerW = 58;
            const borderCol = (s: string) => theme.fg("borderAccent", s);

            const formatLine = (label: string, valFormatted: string, rawValLen: number) => {
              const left = `  ${label ? theme.fg("dim", label.padEnd(12)) : " ".repeat(12)}${valFormatted}`;
              const rawTotalLen = 2 + 12 + rawValLen;
              const padRight = Math.max(0, innerW - rawTotalLen);
              return `${borderCol("│")}${left}${" ".repeat(padRight)}${borderCol("│")}`;
            };

            const headerVal = theme.bold(theme.fg("accent", "SESSION OVERVIEW")) + theme.fg("dim", " • π v0.87.1");
            const headerLen = visibleWidth("SESSION OVERVIEW • π v0.87.1");

            const modelVal = theme.fg("syntaxFunction", `${modelName}${thinking}`);
            const modelLen = visibleWidth(`${modelName}${thinking}`);

            // Progress bar context
            let ctxPercent = 0;
            try {
              const u = ctx.getContextUsage?.();
              if (u?.percent) ctxPercent = Math.round(u.percent);
            } catch {}
            const barLen = 10;
            const filled = Math.min(barLen, Math.max(0, Math.round((ctxPercent / 100) * barLen)));
            const bar = theme.fg("warning", "█".repeat(filled)) + theme.fg("dim", "░".repeat(barLen - filled));
            const ctxVal = `${tokenUsage}  ${bar}`;
            const ctxLen = visibleWidth(`${tokenUsage}  ${"█".repeat(filled)}${"░".repeat(barLen - filled)}`);

            const actVal = theme.fg("text", `${sessionTurns} turn(s)`) + theme.fg("dim", " • ") + theme.fg("accent", `${sessionToolCalls} tools executed`);
            const actLen = visibleWidth(`${sessionTurns} turn(s) • ${sessionToolCalls} tools executed`);

            const breakdownVal = theme.fg("muted", toolsSummary || "none");
            const breakdownLen = visibleWidth(toolsSummary || "none");

            const uptimeVal = theme.fg("text", uptimeStr);
            const uptimeLen = visibleWidth(uptimeStr);

            const wsVal = theme.fg("text", cleanCwd);
            const wsLen = visibleWidth(cleanCwd);

            const dismissVal = theme.fg("dim", "esc / enter / q to dismiss");
            const dismissLen = visibleWidth("esc / enter / q to dismiss");

            const boxLines = [
              borderCol("╭" + "─".repeat(innerW) + "╮"),
              formatLine("OVERVIEW", headerVal, headerLen),
              borderCol("├" + "─".repeat(innerW) + "┤"),
              formatLine("Model", modelVal, modelLen),
              formatLine("Context", ctxVal, ctxLen),
              formatLine("Activity", actVal, actLen),
              formatLine("Breakdown", breakdownVal, breakdownLen),
              formatLine("Uptime", uptimeVal, uptimeLen),
              formatLine("Workspace", wsVal, wsLen),
              borderCol("├" + "─".repeat(innerW) + "┤"),
              formatLine("", dismissVal, dismissLen),
              borderCol("╰" + "─".repeat(innerW) + "╯"),
            ];

            // Center box horizontally
            const padLeft = Math.max(1, Math.floor((width - (innerW + 2)) / 2));
            const pad = " ".repeat(padLeft);
            return ["", ...boxLines.map((l) => pad + l), ""];
          },
        };
      }, { overlay: true });
    },
  });

  // Command /zen: Toggle Zen mode (sembunyikan/tampilkan header dan statusline)
  pi.registerCommand("zen", {
    description: "Toggle Zen mode (mode fokus minimalis tanpa header)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      zenMode = !zenMode;

      if (zenMode) {
        ctx.ui.setHeader?.(undefined);
        ctx.ui.notify("Zen mode ON (header disembunyikan)", "info");
      } else {
        initCustomHeader(ctx);
        ctx.ui.notify("Zen mode OFF (header dipulihkan)", "info");
      }
    },
  });

  // Command /history: Floating interactive session selector ala Telescope
  pi.registerCommand("history", {
    description: "Pilih dan lanjutkan sesi chat sebelumnya (Telescope session switcher)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
      if (!fs.existsSync(sessionsDir)) {
        ctx.ui.notify("Session folder not found", "warning");
        return;
      }

      // Kumpulkan semua file session jsonl dari semua subfolder
      const sessionList: Array<{
        path: string;
        filename: string;
        time: Date;
        preview: string;
        sizeKb: string;
      }> = [];

      try {
        const traverseDirs = (dir: string) => {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
              traverseDirs(fullPath);
            } else if (item.isFile() && item.name.endsWith(".jsonl")) {
              const stat = fs.statSync(fullPath);
              let preview = "";

              // Baca isi file untuk mengambil judul resmi (session_info) atau fallback pesan user
              try {
                const content = fs.readFileSync(fullPath, "utf8");
                let foundSessionInfoName = "";
                let firstMeaningfulUserPrompt = "";

                for (const line of content.split("\n")) {
                  if (!line) continue;
                  try {
                    const obj = JSON.parse(line);
                    if (obj.type === "session_info" && obj.name && obj.name.trim().length > 0) {
                      foundSessionInfoName = obj.name.trim();
                      // session_info terbaru yang menang
                    }
                    if (!firstMeaningfulUserPrompt && obj.type === "message" && obj.message?.role === "user") {
                      const parts = obj.message.content;
                      if (Array.isArray(parts)) {
                        const txt = parts.find((p: any) => p.type === "text" && p.text && p.text.trim())?.text;
                        if (txt) {
                          const clean = txt.replace(/\s+/g, " ").trim();
                          if (clean.length > 5 && !clean.startsWith("Attached image") && !clean.startsWith("<skill")) {
                            firstMeaningfulUserPrompt = clean.slice(0, 46);
                          }
                        }
                      }
                    }
                  } catch {}
                }

                preview = foundSessionInfoName || firstMeaningfulUserPrompt;
              } catch {}

              sessionList.push({
                path: fullPath,
                filename: item.name,
                time: stat.mtime,
                preview: preview || "Percakapan baru",
                sizeKb: (stat.size / 1024).toFixed(0) + "KB",
              });
            }
          }
        };

        traverseDirs(sessionsDir);
        sessionList.sort((a, b) => b.time.getTime() - a.time.getTime());
      } catch (err) {
        ctx.ui.notify(`Failed to read session list: ${err}`, "error");
        return;
      }

      if (sessionList.length === 0) {
        ctx.ui.notify("No saved session history found", "info");
        return;
      }

      // Helper format waktu relatif ala Codex / Git (misal: "31m ago", "18h ago", "2d ago")
      const formatTimeAgo = (date: Date) => {
        const sec = Math.floor((Date.now() - date.getTime()) / 1000);
        if (sec < 60) return `${Math.max(1, sec)}s ago`;
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        const day = Math.floor(hr / 24);
        return `${day}d ago`;
      };

      // Format opsi untuk SelectList ala Codex
      const options = sessionList.map((s) => {
        const ago = formatTimeAgo(s.time).padEnd(10);
        return `${ago} │ ${s.preview}`;
      });

      const selected = await ctx.ui.select("RESUME SESSION (Telescope History)", options);
      if (!selected) return;

      const idx = options.indexOf(selected);
      if (idx !== -1) {
        const chosen = sessionList[idx];
        if (ctx.switchSession) {
          ctx.ui.notify(`Beralih ke sesi: ${chosen.preview}`, "info");
          await ctx.switchSession(chosen.path);
        } else {
          ctx.ui.notify("switchSession is not supported in the current context", "warning");
        }
      }
    },
  });
}
