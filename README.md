# pi-config

Personal configuration and extensions for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

Includes a clean startup header with geometric Pi logo, minimal statusline, out-of-band side questions, structured workflow commands, and auto session titles.

## Quick Setup

```bash
# 1. Backup existing config if any
mv ~/.pi/agent ~/.pi/agent.backup

# 2. Clone this repo
git clone https://github.com/flxhrdyn/pi-config.git ~/.pi/agent

# 3. Install packages
cd ~/.pi/agent/npm
npm install

# 4. Copy models template and set your API key
cd ~/.pi/agent
cp models.json.example models.json
```

Create `~/.pi/agent/9router-config.json` if using [9router](https://github.com/flxhrdyn/9router):

```json
{
  "baseUrl": "http://127.0.0.1:20128",
  "apiKey": "sk-your-key-here",
  "enableReasoning": true
}
```

Run Pi:

```bash
pi --no-welcome
```

## Features and Commands

### UI and Navigation
- **Startup Header**: centered 3-piece Pi logo with `[Version]`, `[Model]`, `[Directory]`, and `[Shortcuts]`.
- **Statusline Footer**: mode (`NORMAL` / `BUSY`), active model, git branch with diff count, and context gauge.
- **Breadcrumbs**: live status above the editor showing current tool target and elapsed time.
- `/history`: session switcher with relative timestamps (`31m ago`) and clean auto-titles.
- `/stats`: floating card showing token usage, turn count, uptime, and tool call breakdown.
- `/zen`: toggle startup header on/off.
- `/themes`: switch theme and auto-sync terminal background color.

### Workflow Commands
- `/btw <question>`: ask a side question without interrupting active tasks or polluting chat history.
- `/btw-list` & `/btw-clear`: view or clear the side-question queue.
- `/plan <goal>`: read-only planning mode. Blocks file edits and saves structured plan to `.pi/active-plan.json`.
- `/plan approve`: approve the generated plan.
- `/build`: execute the approved plan step by step with verification tests.
- `/debug <issue>`: 5-stage systematic debugging workflow (Reproduce, Root Cause, Hypothesis, Fix, Test).
- `/review [target]`: read-only code review categorized by critical, important, and minor issues.

### Auto Session Titles
Listens for `agent_settled`, generates a 3 to 5 word action title based on conversation context (after 2 user messages), respects the chat language, and never overwrites manual names.

## Models and Providers

Preconfigured for [9router](https://github.com/flxhrdyn/9router) (`pi-9router-ext`) and local OpenAI-compatible endpoints:

- **Antigravity via 9router**: connects to 9router proxy to access free Gemini models (such as `ag/gemini-3.8-flash-high`, `ag/gemini-3.8-flash-medium`, `ag/gemini-3.8-flash-low`, and Claude models).
- **OpenCode Zen**: 6 free models configured in `models.json.example`:
  - `MiMo-V2.6-Flash Free`
  - `Muse Spark 1.3 Free`
  - `Ling 3.0 Flash Fin Free`
  - `Nemotron 3.5 Lightning Free`
  - `Muse Spark 1.2 Free`
  - `Nemotron 3 Ultra Free`

Use `/model` inside Pi to pick models or press `ctrl+p` to cycle.

## Tests

```bash
cd ~/.pi/agent
npm test
npm run typecheck
npm run lint
```
