# pi-config

A minimalist, theme-agnostic customization layer for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

This repository turns the stock Pi terminal UI into a clean workspace with a centered startup header, a minimal statusline, floating dialogs, and workflow commands for side questions, planning, building, debugging, and review.

## Included

### Extensions (`extensions/`)

Four TypeScript extensions, loaded from `~/.pi/agent/extensions/`:

- `custom-footer.ts`
  - Startup header with a centered 3-piece geometric Pi logo, colored with theme tokens `syntaxKeyword`, `syntaxFunction`, and `warning`.
  - Centered metadata rows: `[Version]`, `[Model]`, `[Directory]`, `[Shortcuts]`.
  - Footer statusline: `NORMAL` and `BUSY` indicator, active model with thinking level, git branch with `~`/`+`/`-` diff counts, `utf-8` label, and `ctx` usage with color thresholds.
  - Working widget above the editor: current action, tool target, elapsed seconds, and `<esc> to stop`.
  - Clipboard image handling: pasted image paths are shortened to `[Image #N]` badges in user messages.
  - Commands:
    - `/stats`: overlay card with model, token usage, turn count, tool call breakdown, uptime, and working directory.
    - `/zen`: hide or restore the startup header.
    - `/history`: session picker that prefers the stored `session_info` name, falls back to the first meaningful user message, and sorts newest first with relative timestamps.
- `themes.ts`
  - `/themes` command to list and switch themes and persist the choice to `settings.json`.
  - Syncs the terminal emulator background (OSC 11) with the active theme, with per-theme defaults and fallback to the theme file.
  - Resets the terminal background on session shutdown.
- `auto-session-title.ts`
  - Listens for `agent_end`, waits until there are at least 2 user messages and 1 assistant message, then generates a short imperative title (max 6 words) in the conversation language.
  - Runs detached via `queueMicrotask` with a 3s timeout, records `auto_session_title` metadata, and never overwrites an existing or manual session name.
- `workflow-commands.ts`
  - `/btw <question>`: out-of-band side question. Runs a detached lightweight model call with recent conversation context and shows the answer in a `ctx.ui.custom` panel. Does not inject into chat history, plans, or checkpoints.
  - `/btw-list`, `/btw-clear`: inspect or clear the side-question queue.
  - `/plan <goal>`: sends a read-only planning prompt and stores a draft plan to `.pi/active-plan.json` plus a `workflow_plan` entry. Blocks `edit` and `write` through `tool_call`.
  - `/build`: requires a stored plan, otherwise shows an error pointing to `/plan`. Sends a step-by-step build prompt with checkpoint rules.
  - `/debug <issue>`: sends the 5-stage prompt (Reproduce, Root Cause, Hypothesis, Minimal Fix, Regression Test).
  - `/review [target]`: sends a read-only review prompt and blocks `edit` and `write`.

### Tests (`tests/`)

Vitest suites run with `npx vitest run`:

- `auto-session-title.test.ts`: title cleanup and fallback, skip on first message, naming after enough context, no overwrite of manual names, timeout fallback.
- `workflow-commands.test.ts`: command registration, `/btw` modal behavior, plan read-only enforcement, `/build` rejection without a plan, `/debug` and `/review` prompt contents.

### Themes (`themes/`)

Ten JSON themes: `catppuccin-mocha`, `dracula`, `flexoki`, `gruvbox`, `monokai`, `nord`, `one-dark`, `opencode`, `tokyo-night`, `tron`. Active theme is `gruvbox` (see `settings.json`).

### Skills (`skills/`)

27 skill directories, each with `SKILL.md` plus supporting files:

`brainstorming`, `clone-website-full`, `clone-website-lite`, `clone-website-medium`, `context7-mcp`, `deploy-to-vercel`, `diagnosing-superpowers`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `grilling`, `impeccable`, `receiving-code-review`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `vercel-cli-with-tokens`, `vercel-optimize`, `vercel-react-native-skills`, `vercel-react-view-transitions`, `verification-before-completion`, `writing-guidelines`, `writing-plans`, `writing-skills`.

### Settings and packages

- `settings.json`: theme `gruvbox`, packages `npm:pi-9router-ext`, `npm:pi-subagents`, `npm:pi-web-access`, `npm:pi-goal-x`, `editorPaddingX` 1, `tuiMode` fullscreen, `quietStartup` true.
- `npm/package.json`: private `pi-extensions` manifest for the four npm packages above.
- `models.json.example`: example `opencode-zen` provider with 6 free models. Copy to `models.json` and set your own key. Real keys stay out of git.
- `AGENTS.md`: working guidelines for agents in this repo.

## Installation

Requirements:

- [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) 0.87.1 or later
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
| Loading | Generic spinner | Working widget with action, target, and timer |
| Commands | Core commands | Adds `/history`, `/zen`, `/stats`, `/themes`, `/btw`, `/plan`, `/build`, `/debug`, `/review` |
| Sessions | Raw first-message titles | Generated short titles after enough context |
| Skills | None bundled | 27 skill directories with prompt files |

## Project Structure

```text
~/.pi/agent/
├── extensions/
│   ├── auto-session-title.ts
│   ├── custom-footer.ts
│   ├── themes.ts
│   └── workflow-commands.ts
├── tests/
│   ├── auto-session-title.test.ts
│   └── workflow-commands.test.ts
├── themes/
├── skills/
├── npm/
├── settings.json
├── models.json.example
└── AGENTS.md
```

## Contributing

Issues and pull requests are welcome. Please follow these rules:

- Use theme tokens such as `theme.fg()` and `theme.bg()`. Do not hardcode hex colors in extensions.
- Add or update a Vitest case under `tests/` for behavior changes.
- Verify with `/reload` and `npx vitest run` before submitting.

## License

MIT. See [LICENSE](LICENSE).
