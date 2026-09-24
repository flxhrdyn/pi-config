# pi-config

A Neovim-inspired, theme-agnostic customization layer for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) — the extensible terminal AI coding agent.

This repository turns the stock Pi TUI into a minimalist, Vim-style workspace: a centered geometric Pi logo, a live statusline footer, Telescope-style interactive dialogs, and structured workflow commands for side questions, planning, building, debugging, and review.

## What's Included

- **Neovim-Style Startup Header** — Centered 3-piece geometric Pi logo (Coral / Blue / Yellow) rendered with semantic theme tokens (`syntaxKeyword`, `syntaxFunction`, `warning`), plus a centered metadata block:
  `[Version]`, `[Model]`, `[Directory]`, `[Shortcuts]`.
- **Vim Statusline Footer** — Live `NORMAL` / `BUSY` mode indicator, active model name, git branch + diff status (`~2 +1 -1`), UTF-8 label, and context window usage with smart color thresholds.
- **Live Breadcrumbs** — Streaming working widget above the editor showing the current tool target (`Reading extensions/custom-footer.ts:1-50`, `Executing git status`) with elapsed timer and `<esc> to stop`.
- **Floating Telescope Dialogs**:
  - `/history` — Neovim Telescope session switcher with auto-generated titles and relative timestamps (`31m ago`).
  - `/stats` — Rounded floating card with model, context progress bar, turn count, tool breakdown, uptime, and workspace.
  - `/zen` — Zen focus mode: toggles the startup header on/off.
- **Workflow Extensions**:
  - `/btw <question>` — Out-of-band side question (see details below).
  - `/plan <goal>` — Read-only scouting mode with structured plan, risks, acceptance criteria, and verification commands. Mutation tools (`edit`, `write`) are automatically blocked.
  - `/build` — Executes the saved `/plan` step-by-step with checkpointing. Refuses to run without an approved plan.
  - `/debug <issue>` — Enforces the 5-stage systematic workflow: Reproduce → Root Cause → Hypothesis → Minimal Fix → Regression Test.
  - `/review [target]` — Read-only code review scored by [CRITICAL] / [IMPORTANT] / [MINOR].
- **Auto Session Titles** (`auto-session-title`) — Imperative 3–5 word session summaries (like Codex/Antigravity) generated once context exists (2+ user messages), respecting the conversation language and never overwriting manual names.
- **Model Layer** — 6 free OpenCode Zen models via `models.json` (MiMo, Muse Spark, Ling, Nemotron), documented in the [example file](models.json.example).
- **27 Skills** — Core superpowers (TDD, systematic debugging, review flow). Includes 12 unique skills imported from Claude Code (`clone-website-*`, `grilling`, `impeccable`, `vercel-*`, `context7-mcp`, `writing-guidelines`, `deploy-to-vercel`).

## Screenshots

Run Pi and compare your terminal against:

| Startup Header | Session Switcher | Stats Modal |
|---|---|---|
| Centered geometric Pi logo + tabular metadata | Relative timestamps, clean titles, no nerd-font glyphs | Rounded floating card with context progress bar |

> Tip: Press `ctrl+p` to cycle models, `/themes` to switch color schemes, `/stats` for a session overview.

## Replicate This Setup

### 1. Prerequisites
- [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) v0.87.1+
- [Node.js](https://nodejs.org/) 22.19+ and [Git](https://git-scm.com/)
- Optional: [9router](https://github.com/flxhrdyn/9router) or any OpenAI-compatible endpoint at `http://127.0.0.1:20128`

### 2. Clone Into the Pi Agent Directory
```bash
# Backup your existing config first if needed
mv ~/.pi/agent ~/.pi/agent.backup

# Clone this repository
git clone https://github.com/flxhrdyn/pi-config.git ~/.pi/agent
```

### 3. Install Extension Packages
```bash
cd ~/.pi/agent/npm
npm install
```

### 4. Configure Models & Credentials
Secrets are intentionally **excluded** from this repository (see `.gitignore`):

1. Create `~/.pi/agent/9router-config.json`:
```json
{
  "baseUrl": "http://127.0.0.1:20128",
  "apiKey": "sk-your-9router-key",
  "enableReasoning": true
}
```

2. Copy the models template and fill in your API key:
```bash
cp models.json.example models.json
```
Or define your own OpenAI-compatible provider (Ollama, vLLM, 9router, OpenCode Zen, etc.):
```json
{
  "providers": {
    "opencode-zen": {
      "name": "OpenCode Zen",
      "baseUrl": "http://127.0.0.1:20128/v1",
      "api": "openai-completions",
      "apiKey": "sk-your-key-here",
      "models": [
        { "id": "opencode/mimo-v2.6-flash-free", "name": "MiMo-V2.6-Flash Free" }
      ]
    }
  }
}
```

3. Authenticate providers: `pi` → `/login`

### 5. Launch & Verify
```bash
pi --no-welcome
```
Expected: centered Pi logo, tabular metadata, Vim statusline at bottom.
Try: `/stats`, `/history`, `/model`, `/themes`, `/btw apa itu useMemo?`

### 6. Run the Test Suite
```bash
cd ~/.pi/agent
npx vitest run
```

## What's Custom vs Stock Pi

| Layer | Stock Pi | This Repo Adds |
|---|---|---|
| Header | Built-in keybinding hints | 3-piece geometric Pi logo, centered metadata |
| Footer | Default token footer | Vim `NORMAL` / `BUSY` statusline, git stats, context gauge |
| Loading | Generic spinner | Live breadcrumbs (`Reading …:1-50`) with timer |
| Commands | `/model`, `/themes`, `/stats` (core) | `/history`, `/zen`, `/btw`, `/plan`, `/build`, `/debug`, `/review` |
| Sessions | Raw first-message titles | LLM-generated imperative titles, Telescope switcher |
| Skills | None bundled | 27 curated skills with tests |

## Project Structure

```
~/.pi/agent/
├── extensions/
│   ├── auto-session-title.ts  # Codex-style auto session naming
│   ├── custom-footer.ts       # Header, footer, widgets, /history, /stats, /zen
│   ├── themes.ts              # /themes switcher + terminal background sync
│   └── workflow-commands.ts   # /btw, /plan, /build, /debug, /review
├── tests/
│   ├── auto-session-title.test.ts
│   └── workflow-commands.test.ts
├── themes/                    # gruvbox, tokyo-night, dracula, catppuccin, ...
├── skills/                    # 27 prompt skills (TDD, debugging, vercel, ...)
├── npm/                       # Managed extension packages
├── settings.json              # quietStartup, tuiMode, editorPaddingX
├── models.json.example        # Copy to models.json with your own keys
└── AGENTS.md                  # Global agent guidelines
```

## Contributing

Issues and pull requests are welcome. Keep additions theme-agnostic (use `theme.fg()` / `theme.bg()` tokens, never hardcoded hex in extensions), covered by a Vitest case in `tests/`, and verified with `/reload` + `npx vitest run`.

## License

MIT — see [LICENSE](LICENSE).
