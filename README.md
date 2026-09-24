# pi-config

A minimalist, theme-agnostic customization layer for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

This repository turns the stock Pi TUI into a clean, distraction-free workspace with a centered geometric Pi logo, a live statusline footer, floating interactive dialogs, and structured workflow commands for side questions, planning, building, debugging, and review.

## Features

- **Centered Startup Header**: 3-piece geometric Pi logo rendered with semantic theme tokens (`syntaxKeyword`, `syntaxFunction`, `warning`), plus a centered metadata block with `[Version]`, `[Model]`, `[Directory]`, and `[Shortcuts]`.
- **Minimal Statusline Footer**: live `NORMAL` and `BUSY` mode indicator, active model name, git branch and diff status, UTF-8 label, and context window usage with color thresholds.
- **Live Breadcrumbs**: working widget above the editor that shows the current tool target (for example `Reading extensions/custom-footer.ts:1-50`) with an elapsed timer.
- **Interactive Dialogs**:
  - `/history`: session switcher with auto-generated titles and relative timestamps (for example `31m ago`).
  - `/stats`: floating card with model, context progress bar, turn count, tool breakdown, uptime, and workspace.
  - `/zen`: focus mode that toggles the startup header.
- **Workflow Commands**:
  - `/btw <question>`: out-of-band side question answered in a popup panel without touching the main task.
  - `/plan <goal>`: read-only scouting mode with steps, risks, acceptance criteria, and verification commands. Mutation tools (`edit`, `write`) are blocked automatically.
  - `/build`: runs the saved `/plan` step by step with checkpointing. Refuses to run without an approved plan.
  - `/debug <issue>`: 5-stage workflow with Reproduce, Root Cause, Hypothesis, Minimal Fix, and Regression Test.
  - `/review [target]`: read-only code review grouped by `[CRITICAL]`, `[IMPORTANT]`, and `[MINOR]`.
- **Auto Session Titles** (`auto-session-title`): short imperative summaries generated after enough context exists, in the conversation language, never overwriting manual names.
- **Model Layer**: 6 free OpenCode Zen models via `models.json` (MiMo, Muse Spark, Ling, Nemotron). See `models.json.example`.
- **27 Skills**: core workflow skills (TDD, systematic debugging, review flow) including 12 skills imported from Claude Code.

## Installation

Requirements:

- [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) v0.87.1 or later
- [Node.js](https://nodejs.org/) 22.19 or later
- [Git](https://git-scm.com/)
- Optional: an OpenAI-compatible endpoint such as [9router](https://github.com/flxhrdyn/9router) at `http://127.0.0.1:20128`

Steps:

```bash
# 1. Back up your existing config if needed
mv ~/.pi/agent ~/.pi/agent.backup

# 2. Clone this repository
git clone https://github.com/flxhrdyn/pi-config.git ~/.pi/agent

# 3. Install extension packages
cd ~/.pi/agent/npm
npm install
```

## Configuration

Secrets are excluded from this repository. See `.gitignore`.

1. Create `~/.pi/agent/9router-config.json`:

```json
{
  "baseUrl": "http://127.0.0.1:20128",
  "apiKey": "sk-your-9router-key",
  "enableReasoning": true
}
```

2. Copy the model template and set your API key:

```bash
cp models.json.example models.json
```

Example provider entry:

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

3. Authenticate providers:

```bash
pi
```

Then run `/login` inside Pi.

## Usage

Start Pi:

```bash
pi --no-welcome
```

Expected result: centered Pi logo, tabular metadata, and a minimal statusline at the bottom.

Useful commands:

- `/stats`: show session overview
- `/history`: switch sessions
- `/model`: select model
- `/themes`: switch color scheme
- `/btw <question>`: ask a side question in a popup panel
- `/plan <goal>` then `/build`: plan first, build after approval

Tip: press `ctrl+p` to cycle models.

## Testing

```bash
cd ~/.pi/agent
npx vitest run
```

Typecheck an extension file:

```bash
npx tsx -c "~/.pi/agent/extensions/workflow-commands.ts"
```

After editing extensions inside Pi, run `/reload`.

## Comparison With Stock Pi

| Layer | Stock Pi | This Repo |
|---|---|---|
| Header | Built-in keybinding hints | Geometric Pi logo with centered metadata |
| Footer | Default token footer | Minimal `NORMAL` and `BUSY` statusline with git stats and context gauge |
| Loading | Generic spinner | Live breadcrumbs with timer |
| Commands | `/model`, `/themes`, core commands | Adds `/history`, `/zen`, `/btw`, `/plan`, `/build`, `/debug`, `/review` |
| Sessions | Raw first-message titles | Generated imperative titles with clean switcher |
| Skills | None bundled | 27 curated skills with tests |

## Project Structure

```text
~/.pi/agent/
├── extensions/
│   ├── auto-session-title.ts  # Auto session naming
│   ├── custom-footer.ts       # Header, footer, widgets, /history, /stats, /zen
│   ├── themes.ts              # /themes switcher and terminal background sync
│   └── workflow-commands.ts   # /btw, /plan, /build, /debug, /review
├── tests/
│   ├── auto-session-title.test.ts
│   └── workflow-commands.test.ts
├── themes/                    # gruvbox, tokyo-night, dracula, catppuccin, and others
├── skills/                    # 27 prompt skills
├── npm/                       # Managed extension packages
├── settings.json              # quietStartup, tuiMode, editorPaddingX
├── models.json.example        # Copy to models.json with your own keys
└── AGENTS.md                  # Global agent guidelines
```

## Contributing

Issues and pull requests are welcome. Please follow these rules:

- Use theme tokens such as `theme.fg()` and `theme.bg()`. Do not hardcode hex colors in extensions.
- Add or update a Vitest case under `tests/` for behavior changes.
- Verify with `/reload` and `npx vitest run` before submitting.

## License

MIT. See [LICENSE](LICENSE).
