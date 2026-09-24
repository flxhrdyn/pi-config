# Slash Command Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let explicit slash-command arguments work immediately while retaining strict validation only for explicit state-dependent operations.

**Architecture:** `/build <task>` is a direct build and never reads `.pi/active-plan.json`; `/build` and `/build --from-plan` are the only plan-backed paths. A safe `/plan migrate` backs up recognizable legacy files and creates an unapproved v1 draft.

**Tech Stack:** TypeScript, Pi ExtensionAPI 0.87.1, Vitest, `.pi/active-plan.json`.

**Spec:** Conversation requirements from 2026-09-24: explicit arguments override saved state; only `--from-plan`, `approve`, `resume`, `cancel`, and ID-specific commands require saved state.

## Global Constraints

- Do not change Pi core, `pi-goal-x`, or `pi-subagents`.
- Preserve v1 schema validation, atomic writes, session/CWD isolation, and read-only tool enforcement.
- Direct build must work with legacy, corrupt, or foreign active-plan files and must not mutate them.
- A legacy migration becomes a draft only: `status: "draft"`, `planCaptured: false`, `contentSource: "draft_placeholder"`.
- Keep an on-disk backup before replacing a recognizable legacy plan; retain unparseable source files untouched.
- Tests run offline and must never call 9router.
- Do not commit or push.

## Review Focus

- Explicit direct build bypasses invalid saved state.
- `--from-plan` has no ambiguous task argument behavior.
- Migration never approves/captures a plan.
- Argument-free build still rejects placeholders and foreign plans.
- Direct build never changes an existing plan.

---

### Task 1: Parse build intent before loading state

**Files:**
- Modify: `extensions/workflow-commands.ts`
- Test: `tests/workflow-commands.test.ts`

**Interfaces:**
- Produce `BuildInvocation`, `parseBuildInvocation(args)`, and `formatDirectBuildPrompt(task)`.
- Consume existing `formatBuildPrompt(plan)`.

- [ ] **Step 1: Write failing parser tests**

```ts
expect(parseBuildInvocation("Tambahkan export CSV")).toEqual({ kind: "direct", task: "Tambahkan export CSV" });
expect(parseBuildInvocation("")).toEqual({ kind: "active-plan" });
expect(parseBuildInvocation("--from-plan")).toEqual({ kind: "active-plan" });
expect(parseBuildInvocation("--from-plan Tambahkan CSV")).toEqual({
  kind: "invalid",
  diagnostic: "`--from-plan` tidak menerima task; gunakan `/build <task>` untuk build langsung.",
});
```

- [ ] **Step 2: Run the focused test**

Run: `npm test -- --run tests/workflow-commands.test.ts`

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement the minimal parser and direct prompt**

```ts
export type BuildInvocation =
  | { kind: "direct"; task: string }
  | { kind: "active-plan" }
  | { kind: "invalid"; diagnostic: string };

export function parseBuildInvocation(args: string): BuildInvocation {
  const trimmed = args.trim();
  if (!trimmed || trimmed === "--from-plan") return { kind: "active-plan" };
  if (trimmed.startsWith("--from-plan")) {
    return { kind: "invalid", diagnostic: "`--from-plan` tidak menerima task; gunakan `/build <task>` untuk build langsung." };
  }
  return { kind: "direct", task: trimmed };
}
```

`formatDirectBuildPrompt(task)` must carry existing incremental-build and verification rules, but must not mention, load, approve, replace, or persist an active plan.

- [ ] **Step 4: Verify focused tests pass**

Run: `npm test -- --run tests/workflow-commands.test.ts`

Expected: PASS.

### Task 2: Route `/build` by intent

**Files:**
- Modify: `extensions/workflow-commands.ts`
- Test: `tests/workflow-commands.test.ts`

**Interfaces:**
- Consume `parseBuildInvocation`, `loadPlanValidated`, `formatBuildPrompt`, and `formatDirectBuildPrompt`.

- [ ] **Step 1: Write failing handler tests**

```ts
it("runs direct build despite a legacy active plan", async () => {
  writeLegacyPlanFile(fixtureCwd);
  await invokeCommand("build", "Tambahkan export CSV", commandContext);
  expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Tambahkan export CSV"));
});

it("does not mutate an existing approved plan during direct build", async () => {
  writeApprovedCapturedPlan(fixtureCwd, sessionId);
  await invokeCommand("build", "Tambahkan export CSV", commandContext);
  expect(readPlan(fixtureCwd).goal).toBe("Existing approved plan");
});

it("guides an argument-free build with legacy state to direct build or migration", async () => {
  writeLegacyPlanFile(fixtureCwd);
  await invokeCommand("build", "", commandContext);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("/build <task>"), "warning");
});
```

- [ ] **Step 2: Run the focused test**

Run: `npm test -- --run tests/workflow-commands.test.ts`

Expected: FAIL because `/build` loads the plan before considering its arguments.

- [ ] **Step 3: Implement command routing**

```ts
const invocation = parseBuildInvocation(args);
if (invocation.kind === "invalid") {
  ctx.ui.notify(invocation.diagnostic, "warning");
  return;
}
if (invocation.kind === "direct") {
  state.activeMode = "build";
  pi.sendUserMessage(formatDirectBuildPrompt(invocation.task));
  return;
}
// Only this branch calls loadPlanValidated and retains captured+approved guards.
```

For legacy/invalid plan state in the active-plan branch, show: `Plan tersimpan tidak kompatibel atau tidak valid. Gunakan /build <task> untuk build langsung, atau /plan migrate untuk mengonversi plan lama menjadi draft.`

- [ ] **Step 4: Verify focused tests pass**

Run: `npm test -- --run tests/workflow-commands.test.ts`

Expected: PASS. Add a regression asserting argument-free build still rejects an uncaptured draft.

### Task 3: Add recoverable `/plan migrate`

**Files:**
- Modify: `extensions/workflow-commands.ts`
- Modify: `README.md`
- Test: `tests/workflow-commands.test.ts`

**Interfaces:**
- Produce `parseLegacyPlan(data, cwd, sessionId): WorkflowPlanV1 | null` and `/plan migrate`.
- Consume `savePlanAtomic` and `validatePlanV1`.

- [ ] **Step 1: Write failing migration tests**

```ts
it("backs up recognizable legacy JSON and creates an uncaptured v1 draft", async () => {
  writeLegacyPlanFile(fixtureCwd, { goal: "Refactor auth", steps: ["Inspect auth"] });
  await invokeCommand("plan", "migrate", commandContext);
  expect(readPlan(fixtureCwd)).toMatchObject({
    schemaVersion: 1, status: "draft", planCaptured: false,
    contentSource: "draft_placeholder", goal: "Refactor auth", steps: [],
  });
  expect(legacyBackupExists(fixtureCwd)).toBe(true);
});

it("retains unparseable legacy content untouched", async () => {
  writeRawPlanFile(fixtureCwd, "not json");
  await invokeCommand("plan", "migrate", commandContext);
  expect(readRawPlanFile(fixtureCwd)).toBe("not json");
});
```

- [ ] **Step 2: Run focused tests**

Run: `npm test -- --run tests/workflow-commands.test.ts`

Expected: FAIL because migration does not exist.

- [ ] **Step 3: Implement conservative migration**

Only migrate a JSON object with a non-empty string `goal`. Atomically rename the source to `.pi/active-plan.legacy-<timestamp>.json`, then atomically write a v1 draft using that goal and empty plan fields. Do not copy old steps/risks as trusted content. On unknown/non-JSON input, retain the source and emit an actionable error.

Document:

```text
/build <task>        Direct build; ignores saved plans.
/build               Executes only the active approved plan.
/build --from-plan   Explicit active approved-plan build.
/plan migrate        Backs up a recognizable legacy plan and converts it to a v1 draft.
```

- [ ] **Step 4: Verify migration tests pass**

Run: `npm test -- --run tests/workflow-commands.test.ts`

Expected: PASS.

### Task 4: Full regression verification

**Files:**
- Modify: `tests/workflow-commands.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add cross-command regression tests**

```ts
it("keeps explicit arguments direct for debug and review", async () => {
  await invokeCommand("debug", "Timeout provider", commandContext);
  expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Timeout provider"));
  await invokeCommand("review", "src/auth.ts", commandContext);
  expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("src/auth.ts"));
});

it("never approves a plan during direct build", async () => {
  writeDraftPlaceholderPlan(fixtureCwd, sessionId);
  await invokeCommand("build", "Tambahkan export CSV", commandContext);
  expect(readPlan(fixtureCwd).status).toBe("draft");
});
```

- [ ] **Step 2: Run all verification**

Run: `npm test && npm run typecheck && npm run lint`

Expected: every command exits 0.

- [ ] **Step 3: Review docs**

Confirm README explicitly states: arguments are direct commands; only explicit state operations are strict.

## Self-Review

- Tasks 1–2 implement argument precedence and preserve strict approved-plan execution.
- Task 3 makes old files recoverable without approving/deleting data.
- Task 4 covers direct-build non-mutation and documents the resulting UX.
- No later task references an undefined interface.

## Execution Handoff

Plan saved here. Review it before implementation; the recommended execution is Native because parser, route, migration, and tests share the same extension interfaces and should be changed atomically.
