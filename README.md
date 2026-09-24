# pi-config

Personal configuration and extensions for [Pi Coding Agent](https://pi.dev/).

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

### Workflow Commands (UX Intent Classification)
- **Direct Commands** (argument is source of truth, never blocked by state, legacy, or corrupt files):
  - `/build <task>`: execute a build task directly without requiring an active plan.
  - `/plan <goal>`: create and save a structured plan for the specified goal.
  - `/debug <issue>`: initiate 5-stage systematic debugging workflow directly.
  - `/review <target>`: perform read-only review on the specified target directly.
  - `/btw <question>`: ask a side question without interrupting active tasks.
- **Default Commands** (use state if valid, or offer gentle fallback guidance):
  - `/build`: execute the approved plan if available; otherwise show guidance to `/build <task>` or `/build --from-plan`.
  - `/review`: perform read-only review on active git diff.
  - `/debug`: display usage guidance for systematic debugging.
  - `/btw-list` & `/btw-clear`: view or clear the side-question queue.
- **State-Explicit Commands** (strict validation of session, cwd, and schema):
  - `/build --from-plan`: strictly execute the approved plan from `.pi/active-plan.json`.
  - `/plan approve` / `/plan-approve`: approve the active captured plan.
  - `/plan migrate` / `/plan-migrate`: explicitly migrate unversioned legacy plans to schema version 1.

### Run Registry and Resume (`.pi/runs/`)
- `/run-status [id]`: view detailed status, checkpoint, stage, model, and artifacts for a run.
- `/run-list`: list all runs in `.pi/runs/` with distinction between active process runs and restart-recoverable runs.
- `/run-pause <id>`: pause a running task and mark it as paused.
- `/run-resume <id>`: resume execution directly from the saved checkpoint without re-planning from scratch.
- `/run-cancel <id>`: cancel a run and record finished timestamp.

### Security and Network Guard
- `/security-status`: view security posture, active allowlist, and credential source without exposing secrets.
- `/security-check`: scan workspace and config files for plaintext keys without printing secret values.
- Default endpoint allowlist strictly permits `http://127.0.0.1:20128` and `http://localhost:20128`.
- External non-localhost endpoints require explicit opt-in (`PI_ALLOW_EXTERNAL_ENDPOINTS=1`).
- URL credentials, invalid schemes, and cross-host redirects are blocked automatically.
- API keys are resolved with environment variable priority (`PI_9ROUTER_API_KEY`). Existing keys in config are never deleted or migrated without confirmation.

### Auto Session Titles
Listens for `agent_settled`, generates a 3 to 5 word action title based on conversation context (after 2 user messages), respects the chat language, and never overwrites manual names.

## Models
Comes with preconfigured free OpenCode Zen models via `models.json.example`:
- `MiMo-V2.6-Flash Free`
- `Muse Spark 1.3 Free`
- `Ling 3.0 Flash Fin Free`
- `Nemotron 3.5 Lightning Free`
- `Muse Spark 1.2 Free`
- `Nemotron 3 Ultra Free`

Use `/model` inside Pi to switch models or press `ctrl+p` to cycle.

## Tests

Unit tests and static checks:

```bash
cd ~/.pi/agent
npm test
npm run typecheck
npm run lint
```

End-to-End (E2E) tests against actual Pi runtime:

```bash
npm run test:e2e
```

### E2E Runtime Requirements and Skip Policy
- **Requirement**: Requires an active Pi installation in `~/.pi/agent/install/` (read dynamically via `current-version`) or a custom runtime specified via the `PI_E2E_RUNTIME` environment variable.
- **Offline & Deterministic**: E2E runs completely offline using a local deterministic mock server. It never hits the internet, production 9router, real credentials, or existing user sessions.
- **Skip Policy**: If the local Pi runtime cannot be detected, the E2E suite will be skipped gracefully. When the runtime is detected, all 7 lifecycle and command assertions are strictly enforced.
