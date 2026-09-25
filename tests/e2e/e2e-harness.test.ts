import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { DeterministicMockServer } from "../fixtures/mock-server.js";
import { resolvePiRuntime, loadPiSdk, createFixtureProject, redactSecrets } from "../fixtures/e2e-helper.js";
import { savePlanAtomic, loadPlanValidated, type WorkflowPlanV1 } from "../../extensions/workflow-commands.js";
import { saveRunRecordAtomic, loadRunRecordValidated, type RunRecordV1 } from "../../extensions/run-registry.js";

const runtimeInfo = resolvePiRuntime();

// Skip E2E gracefully bila runtime Pi lokal tidak tersedia
const runOrSkip = runtimeInfo ? describe : describe.skip;

runOrSkip("E2E Harness: Actual Pi Runtime & Deterministic Extension Testing", () => {
  let mockServer: DeterministicMockServer;
  let serverUrl = "";
  let piSdk: any;
  let fixture: { dir: string; cleanup: () => void };
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    mockServer = new DeterministicMockServer();
    serverUrl = await mockServer.start();

    // Pastikan lingkungan offline dan terarah ke server mock deterministik
    process.env.PI_OFFLINE = "1";
    process.env.PI_ALLOW_EXTERNAL_ENDPOINTS = "0";
    process.env.PI_BTW_URL = serverUrl;
    process.env.PI_BTW_API_KEY = "mock-btw-key-redacted";
    process.env.PI_TITLE_URL = serverUrl;
    process.env.PI_TITLE_API_KEY = "mock-title-key-redacted";

    piSdk = await loadPiSdk();
  }, 15000);

  afterAll(async () => {
    process.env = originalEnv;
    if (mockServer) {
      await mockServer.stop();
    }
  });

  beforeEach(() => {
    fixture = createFixtureProject();
    mockServer.clearLogs();
  });

  afterEach(() => {
    if (fixture) {
      fixture.cleanup();
    }
  });

  function makeContext(session: any, fixtureDir: string, overrides: Record<string, any> = {}) {
    return {
      cwd: fixtureDir,
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setWidget: vi.fn(),
        theme: { fg: (_c: string, s: string) => s },
        ...(overrides.ui || {}),
      },
      sessionManager: session.sessionManager,
      isIdle: () => true,
      model: session.model,
      ...overrides,
    };
  }

  it("verifies Pi runtime resolution without hardcoded paths", () => {
    expect(runtimeInfo).not.toBeNull();
    expect(runtimeInfo?.runtimePath).toContain("dist");
    expect(fs.existsSync(runtimeInfo!.runtimePath)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Skenario 1: /plan -> capture -> /plan approve -> /build --from-plan
  // --------------------------------------------------------------------------
  it("Scenario 1: /plan lifecycle (draft creation -> captured -> approved -> /build --from-plan)", async () => {
    const { createAgentSession } = piSdk;
    const notifiedMessages: string[] = [];
    const sentMessages: string[] = [];

    const { session, extensionsResult } = await createAgentSession({
      cwd: fixture.dir,
    });

    const findCmd = (name: string) => {
      for (const ext of extensionsResult.extensions) {
        if (ext.commands.has(name)) return ext.commands.get(name)!.handler;
      }
      return null;
    };

    const planHandler = findCmd("plan");
    const buildHandler = findCmd("build");
    expect(planHandler).not.toBeNull();
    expect(buildHandler).not.toBeNull();

    const cmdCtx: any = makeContext(session, fixture.dir, {
      ui: {
        notify: vi.fn((msg: string) => notifiedMessages.push(redactSecrets(msg))),
        setWidget: vi.fn(),
        theme: { fg: (_c: string, s: string) => s },
      },
    });

    // 1. Jalankan /plan <goal>
    await planHandler!("Bangun sistem auth JWT", cmdCtx);

    const planFile = path.join(fixture.dir, ".pi", "active-plan.json");
    expect(fs.existsSync(planFile)).toBe(true);

    const draft = JSON.parse(fs.readFileSync(planFile, "utf8"));
    expect(draft.status).toBe("draft");
    expect(draft.planCaptured).toBe(false);
    expect(draft.goal).toBe("Bangun sistem auth JWT");

    // 2. Simulasi respon asisten memuat structured plan
    const simulatedAssistantMsg = [
      "Berikut rencana kerja:",
      "```json",
      JSON.stringify({
        plan: {
          steps: ["Setup JWT utility", "Buat middleware auth", "Buat endpoint login"],
          risks: ["Token secret exposure"],
          acceptanceCriteria: ["Endpoint mengembalikan 200 OK"],
          verificationCommands: ["npm test"],
        },
      }),
      "```",
    ].join("\n");

    // Cari handler agent_settled pada extension
    for (const ext of extensionsResult.extensions) {
      const settledHandlers = ext.handlers.get("agent_settled");
      if (settledHandlers) {
        // Mock getEntries agar asisten message terbaca
        session.sessionManager.getEntries = () => [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: simulatedAssistantMsg }],
            },
          },
        ];

        for (const h of settledHandlers) {
          await h({}, cmdCtx);
        }
      }
    }

    // Periksa plan captured
    const captured = JSON.parse(fs.readFileSync(planFile, "utf8"));
    expect(captured.planCaptured).toBe(true);
    expect(captured.contentSource).toBe("agent");
    expect(captured.steps.length).toBe(3);

    // 3. Setujui rencana via /plan approve
    await planHandler!("approve", cmdCtx);
    const approved = JSON.parse(fs.readFileSync(planFile, "utf8"));
    expect(approved.status).toBe("approved");

    // 4. Eksekusi via /build --from-plan
    session.sendUserMessage = async (msg: string) => {
      sentMessages.push(msg);
      return Promise.resolve();
    };

    await buildHandler!("--from-plan", cmdCtx);
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(sentMessages[0]).toContain("Executing Approved Plan");
    expect(sentMessages[0]).toContain("Setup JWT utility");
  }, 15000);

  // --------------------------------------------------------------------------
  // Skenario 2: /build <task> kebal terhadap plan legacy, corrupt, atau sesi lain
  // --------------------------------------------------------------------------
  it("Scenario 2: /build <task> runs directly without dependency on broken active-plan", async () => {
    const { createAgentSession } = piSdk;
    const { session, extensionsResult } = await createAgentSession({ cwd: fixture.dir });

    const buildExt = extensionsResult.extensions.find((e: any) => e.commands.has("build"));
    const buildHandler = buildExt!.commands.get("build")!.handler;

    const planDir = path.join(fixture.dir, ".pi");
    fs.mkdirSync(planDir, { recursive: true });
    const planFile = path.join(planDir, "active-plan.json");

    // A. Uji dengan berkas legacy
    const legacyContent = JSON.stringify({ goal: "Legacy goal", steps: ["L1"] });
    fs.writeFileSync(planFile, legacyContent, "utf8");

    const sent: string[] = [];
    session.sendUserMessage = async (m: string) => {
      sent.push(m);
      return Promise.resolve();
    };

    const cmdCtx: any = makeContext(session, fixture.dir);
    await buildHandler("Buat fitur export Excel", cmdCtx);

    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("Buat fitur export Excel");
    expect(fs.readFileSync(planFile, "utf8")).toBe(legacyContent); // State lama utuh!

    // B. Uji dengan berkas korup
    const corruptContent = "{ broken json content...";
    fs.writeFileSync(planFile, corruptContent, "utf8");

    await buildHandler("Buat fitur import CSV", cmdCtx);
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain("Buat fitur import CSV");
    expect(fs.readFileSync(planFile, "utf8")).toBe(corruptContent); // State korup tidak disentuh

    // C. Uji dengan berkas milik sesi lain
    const otherSessPlan: WorkflowPlanV1 = {
      schemaVersion: 1,
      sessionId: "other-foreign-session-id",
      cwd: path.resolve(fixture.dir),
      goal: "Foreign goal",
      status: "approved",
      planCaptured: true,
      contentSource: "agent",
      steps: ["Step 1"],
      risks: [],
      acceptanceCriteria: [],
      verificationCommands: ["npm test"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(planFile, JSON.stringify(otherSessPlan, null, 2), "utf8");

    await buildHandler("Optimasi query database", cmdCtx);
    expect(sent.length).toBe(3);
    expect(sent[2]).toContain("Optimasi query database");
    const reloaded = JSON.parse(fs.readFileSync(planFile, "utf8"));
    expect(reloaded.sessionId).toBe("other-foreign-session-id");
  }, 15000);

  // --------------------------------------------------------------------------
  // Skenario 3: /plan dan /review memblokir mutasi & mengizinkan read-only
  // --------------------------------------------------------------------------
  it("Scenario 3: /plan and /review strictly block mutations while allowing read-only tools", async () => {
    const { createAgentSession } = piSdk;
    const { session, extensionsResult } = await createAgentSession({ cwd: fixture.dir });

    const wfExt = extensionsResult.extensions.find((e: any) => e.commands.has("plan"));
    const toolCallHandlers = wfExt!.handlers.get("tool_call") || [];
    expect(toolCallHandlers.length).toBeGreaterThan(0);

    const cmdCtx: any = makeContext(session, fixture.dir);

    // 1. Set mode /plan
    await wfExt!.commands.get("plan")!.handler("Rancang arsitektur", cmdCtx);

    const checkTool = async (toolName: string, input: any) => {
      for (const h of toolCallHandlers) {
        const res = await h({ toolName, input }, cmdCtx);
        if (res?.block) return res;
      }
      return { block: false };
    };

    // Alat mutasi harus diblokir
    expect((await checkTool("edit", { path: "src/app.ts" })).block).toBe(true);
    expect((await checkTool("write", { path: "src/app.ts" })).block).toBe(true);
    expect((await checkTool("bash", { command: "rm -rf dist" })).block).toBe(true);
    expect((await checkTool("powershell", { command: "Remove-Item" })).block).toBe(true);

    // Alat read-only harus diizinkan
    expect((await checkTool("read", { path: "src/app.ts" })).block).toBe(false);
    expect((await checkTool("grep", { pattern: "auth" })).block).toBe(false);
    expect((await checkTool("find", { glob: "*.ts" })).block).toBe(false);
    expect((await checkTool("ls", { path: "." })).block).toBe(false);
  }, 15000);

  // --------------------------------------------------------------------------
  // Skenario 4: /btw tidak masuk transcript utama, mendukung queue & cancel
  // --------------------------------------------------------------------------
  it("Scenario 4: /btw side-query stays out-of-band and supports /btw-clear", async () => {
    const { createAgentSession } = piSdk;
    const { session, extensionsResult } = await createAgentSession({ cwd: fixture.dir });

    const wfExt = extensionsResult.extensions.find((e: any) => e.commands.has("btw"));
    const btwHandler = wfExt!.commands.get("btw")!.handler;
    const clearHandler = wfExt!.commands.get("btw-clear")!.handler;

    const notified: string[] = [];
    const cmdCtx: any = makeContext(session, fixture.dir, {
      ui: {
        notify: vi.fn((m) => notified.push(m)),
        setWidget: vi.fn(),
      },
    });

    // Jalankan /btw
    await btwHandler("Pertanyaan sampingan user: Apa fungsi memoization?", cmdCtx);

    // Pastikan tidak ada entri pesan user yang disuntikkan ke transcript sesi utama
    const entries = session.sessionManager.getEntries?.() || [];
    const hasInTranscript = entries.some(
      (e: any) => e.type === "message" && e.message?.content?.includes("fungsi memoization")
    );
    expect(hasInTranscript).toBe(false);

    // Jalankan /btw-clear
    await clearHandler("", cmdCtx);
    expect(cmdCtx.ui.setWidget).toHaveBeenCalledWith("btw-status", undefined);
    expect(notified.some((m) => m.includes("Cleared"))).toBe(true);
  }, 15000);

  // --------------------------------------------------------------------------
  // Skenario 5: Auto-title (tidak di chat pertama, jalan setelahnya, lindungi nama manual)
  // --------------------------------------------------------------------------
  it("Scenario 5: Auto-title timing and manual title protection", async () => {
    const { createAgentSession } = piSdk;
    const { session, extensionsResult } = await createAgentSession({ cwd: fixture.dir });

    const titleExt = extensionsResult.extensions.find((e: any) => e.path.includes("auto-session-title"));
    expect(titleExt).toBeDefined();

    const settledHandlers = titleExt!.handlers.get("agent_settled") || [];
    expect(settledHandlers.length).toBeGreaterThan(0);

    let sessionName: string | undefined;
    session.setSessionName = (name: string) => {
      sessionName = name;
    };
    session.getSessionName = () => sessionName;
    session.sessionManager.getSessionName = () => sessionName;

    const extCtx: any = makeContext(session, fixture.dir);

    // 1. Giliran pertama (1 pesan user) -> tidak boleh menamai
    const turn1 = [
      { type: "message", message: { role: "user", content: "Halo bot" } },
      { type: "message", message: { role: "assistant", content: "Halo, ada yang bisa dibantu?" } },
    ];
    session.sessionManager.getEntries = () => turn1;
    session.sessionManager.getBranch = () => turn1;

    for (const h of settledHandlers) {
      await h({}, extCtx);
    }
    // Tunggu microtask
    await new Promise((r) => setTimeout(r, 100));
    expect(sessionName).toBeUndefined();

    // 2. Giliran kedua (2 pesan user) -> harus menamai otomatis via mock LLM
    const turn2 = [
      { type: "message", message: { role: "user", content: "Halo bot" } },
      { type: "message", message: { role: "assistant", content: "Halo" } },
      { type: "message", message: { role: "user", content: "Buat sistem otentikasi login pengguna" } },
      { type: "message", message: { role: "assistant", content: "Baik, sedang disiapkan." } },
    ];
    session.sessionManager.getEntries = () => turn2;
    session.sessionManager.getBranch = () => turn2;

    for (const h of settledHandlers) {
      await h({}, extCtx);
    }

    // Tunggu response mock LLM selesai
    for (let i = 0; i < 30; i++) {
      if (sessionName) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sessionName).toBe("Bangun Sistem Autentikasi Pengguna");

    // 3. User mengubah nama manual -> panggil agent_settled lagi -> tidak boleh ditimpa lagi
    session.setSessionName("Nama Manual Kustom");
    expect(sessionName).toBe("Nama Manual Kustom");

    for (const h of settledHandlers) {
      await h({}, extCtx);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(sessionName).toBe("Nama Manual Kustom");
  }, 15000);

  // --------------------------------------------------------------------------
  // Skenario 6: Run registry (checkpoint disimpan -> failure recoverable -> resume checkpoint)
  // --------------------------------------------------------------------------
  it("Scenario 6: Run registry checkpointing and non-replanning resume", async () => {
    const { createAgentSession } = piSdk;
    const { session, extensionsResult } = await createAgentSession({ cwd: fixture.dir });

    const runExt = extensionsResult.extensions.find((e: any) => e.commands.has("run-resume"));
    const resumeHandler = runExt!.commands.get("run-resume")!.handler;

    const testRun: RunRecordV1 = {
      schemaVersion: 1,
      id: "run-e2e-checkpoint-1",
      sessionId: session.sessionId,
      cwd: path.resolve(fixture.dir),
      stage: "Database Migration",
      status: "paused",
      checkpoint: {
        stepIndex: 2,
        totalSteps: 5,
        lastCompletedStep: "Create users table",
      },
      model: "gemini-3.8-flash",
      agent: "coder",
      retryCount: 1,
      artifactPaths: ["db/migrations/01.sql"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveRunRecordAtomic(fixture.dir, testRun);

    const sent: string[] = [];
    session.sendUserMessage = async (msg: string) => {
      sent.push(msg);
      return Promise.resolve();
    };

    const cmdCtx: any = makeContext(session, fixture.dir);
    await resumeHandler("run-e2e-checkpoint-1", cmdCtx);

    expect(sent.length).toBe(1);
    const resumeMsg = sent[0];
    expect(resumeMsg).toContain("[RUN RESUME: run-e2e-checkpoint-1]");
    expect(resumeMsg).toContain("Resuming from Step 3 of 5 total steps");
    expect(resumeMsg).toContain("Create users table");
    expect(resumeMsg).toContain("DO NOT plan again from scratch");

    // Verifikasi status run di disk menjadi running
    const updated = loadRunRecordValidated(fixture.dir, "run-e2e-checkpoint-1");
    expect(updated.record?.status).toBe("running");
  }, 15000);

  // --------------------------------------------------------------------------
  // Skenario 7: Compaction lifecycle Pi tidak merusak state aktif
  // --------------------------------------------------------------------------
  it("Scenario 7: Pi compaction lifecycle preserves plan, run, and extension states", async () => {
    const { createAgentSession } = piSdk;
    const { session, extensionsResult } = await createAgentSession({ cwd: fixture.dir });

    // 1. Siapkan state plan aktif
    const activePlan: WorkflowPlanV1 = {
      schemaVersion: 1,
      sessionId: session.sessionId,
      cwd: path.resolve(fixture.dir),
      goal: "Fitur Pembayaran",
      status: "approved",
      planCaptured: true,
      contentSource: "agent",
      steps: ["Step 1", "Step 2"],
      risks: [],
      acceptanceCriteria: [],
      verificationCommands: ["npm test"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    savePlanAtomic(fixture.dir, activePlan);

    // 2. Siapkan run record aktif
    const activeRun: RunRecordV1 = {
      schemaVersion: 1,
      id: "run-compact-e2e",
      sessionId: session.sessionId,
      cwd: path.resolve(fixture.dir),
      stage: "Execution",
      status: "running",
      checkpoint: { stepIndex: 1, totalSteps: 3 },
      model: "gemini",
      agent: "coder",
      retryCount: 0,
      artifactPaths: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveRunRecordAtomic(fixture.dir, activeRun);

    // 3. Picu simulasi event compaction Pi (session_before_compact -> session_compact)
    const extCtx: any = makeContext(session, fixture.dir, {
      ui: {
        setWorkingVisible: vi.fn(),
        setFooter: vi.fn(),
      },
    });

    for (const ext of extensionsResult.extensions) {
      const beforeCompactHandlers = ext.handlers.get("session_before_compact") || [];
      for (const h of beforeCompactHandlers) {
        await h({ type: "session_before_compact", reason: "manual" }, extCtx);
      }
    }

    // Pasca compaction event
    for (const ext of extensionsResult.extensions) {
      const compactHandlers = ext.handlers.get("session_compact") || [];
      for (const h of compactHandlers) {
        await h({ type: "session_compact", reason: "manual" }, extCtx);
      }
    }

    // 4. Verifikasi seluruh state di disk tetap utuh dan valid
    const loadedPlan = loadPlanValidated(fixture.dir, session.sessionId);
    expect(loadedPlan.plan).not.toBeNull();
    expect(loadedPlan.plan?.goal).toBe("Fitur Pembayaran");
    expect(loadedPlan.plan?.status).toBe("approved");

    const loadedRun = loadRunRecordValidated(fixture.dir, "run-compact-e2e");
    expect(loadedRun.record).not.toBeNull();
    expect(loadedRun.record?.status).toBe("running");
  }, 15000);
});
