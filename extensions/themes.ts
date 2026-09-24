import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mapping warna background default untuk setiap tema
const THEME_BG_COLORS: Record<string, string> = {
  "gruvbox": "#282828",
  "tokyo-night": "#1a1b26",
  "catppuccin-mocha": "#1e1e2e",
  "dracula": "#282a36",
  "nord": "#2e3440",
  "monokai": "#272822",
  "one-dark": "#282c34",
  "opencode": "#212121",
  "tron": "#0c141f",
  "flexoki": "#100f0f",
  "dark": "#18181e",
  "light": "#ffffff",
};

function setTerminalBackgroundColor(hexColor: string) {
  // OSC 11 mengubah warna background terminal emulator (Windows Terminal, Alacritty, iTerm, WezTerm, dll)
  process.stdout.write(`\x1b]11;${hexColor}\x07`);
}

function applyThemeBg(themeName: string) {
  let hex = THEME_BG_COLORS[themeName];
  if (!hex) {
    try {
      const themeFile = path.join(os.homedir(), ".pi", "agent", "themes", `${themeName}.json`);
      if (fs.existsSync(themeFile)) {
        const parsed = JSON.parse(fs.readFileSync(themeFile, "utf-8"));
        hex = parsed.export?.pageBg || parsed.vars?.bg0 || parsed.vars?.bg || parsed.vars?.base;
      }
    } catch {}
  }
  if (hex) {
    setTerminalBackgroundColor(hex);
  }
}

export default function (pi: ExtensionAPI) {
  // Saat session Pi mulai, langsung sinkronkan background terminal dengan setting tema aktif
  pi.on("session_start", async (_event, ctx) => {
    try {
      const settingsFile = path.join(os.homedir(), ".pi", "agent", "settings.json");
      if (fs.existsSync(settingsFile)) {
        const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
        if (settings.theme) {
          applyThemeBg(settings.theme);
        }
      }
    } catch {}
  });

  // Saat sesi ditutup, reset warna background terminal kembali ke default
  pi.on("session_shutdown", async () => {
    process.stdout.write("\x1b]111\x07");
  });

  pi.registerCommand("themes", {
    description: "Switch theme and synchronize terminal background color",
    handler: async (args, ctx) => {
      try {
        if (!ctx.hasUI) {
          ctx.ui.notify("Command /themes requires interactive UI", "error");
          return;
        }

        const themeSet = new Set<string>(["dark", "light"]);
        const themesDir = path.join(os.homedir(), ".pi", "agent", "themes");

        if (fs.existsSync(themesDir)) {
          const files = fs.readdirSync(themesDir);
          for (const file of files) {
            if (file.endsWith(".json")) {
              themeSet.add(path.basename(file, ".json"));
            }
          }
        }

        const themeList = Array.from(themeSet);

        // Switch theme, persist to settings, and set OSC 11 background
        const switchTheme = (target: string) => {
          const res = ctx.ui.setTheme(target);
          if (res?.success === false) {
            ctx.ui.notify(`Failed: ${res.error}`, "error");
            return;
          }

          // Synchronize terminal background color
          applyThemeBg(target);

          // Persist to ~/.pi/agent/settings.json
          try {
            const settingsFile = path.join(os.homedir(), ".pi", "agent", "settings.json");
            const conf = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf-8")) : {};
            conf.theme = target;
            fs.writeFileSync(settingsFile, JSON.stringify(conf, null, 2), "utf-8");
          } catch {}

          ctx.ui.notify(`Theme and terminal background set to: ${target}`, "info");
        };

        const targetTheme = args?.trim();
        if (targetTheme) {
          if (!themeList.includes(targetTheme)) {
            ctx.ui.notify(
              `Theme '${targetTheme}' not found. Available: ${themeList.join(", ")}`,
              "error"
            );
            return;
          }
          switchTheme(targetTheme);
          return;
        }

        // Interactive theme selection dialog
        const selected = await ctx.ui.select("Select Pi Theme:", themeList);
        if (!selected) return;

        switchTheme(selected);
      } catch (err: any) {
        ctx.ui.notify(`Error: ${err?.message || err}`, "error");
      }
    },
  });
}
