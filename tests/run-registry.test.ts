import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import runRegistryExtension, {
  validateRunRecordSchema,
  saveRunRecordAtomic,
  loadRunRecordValidated,
  listRunRecords,
  formatRunResumePrompt,
  markRunProcessActive,
  unmarkRunProcessActive,
  clearActiveProcessRuns,
  type RunRecordV1,
} from "../extensions/run-registry.js";

describe("Task 1: Run Registry and Resume durable extension tests", () => {
  let commands: Record<string, Function>;
  let sentMessages: Array<{ content: string; options?: any }>;
  let mockUi: { notify: ReturnType<typeof vi.fn> };
  let mockPi: any;
  let testCwd: string;

  beforeEach(() => {
    commands = {};
    sentMessages = [];
    mockUi = { notify: vi.fn() };

    mockPi = {
      registerCommand: vi.fn((name: string, def: any) => {
        commands[name] = def.handler;
      }),
      on: vi.fn(),
      sendUserMessage: vi.fn((content: string, options?: any) => {
        sentMessages.push({ content, options });
      }),
      appendEntry: vi.fn(),
    };

    clearActiveProcessRuns();
    testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-registry-test-"));
  });

  afterEach(() => {
    clearActiveProcessRuns();
    try {
      fs.rmSync(testCwd, { recursive: true, force: true });
    } catch {}
  });

  it("registers all required run registry commands", () => {
    runRegistryExtension(mockPi);
    expect(commands["run-status"]).toBeDefined();
    expect(commands["run-list"]).toBeDefined();
    expect(commands["run-pause"]).toBeDefined();
    expect(commands["run-resume"]).toBeDefined();
    expect(commands["run-cancel"]).toBeDefined();
  });

  describe("Schema Validation and Atomic Persistence in .pi/runs/", () => {
    it("validates schema version and required fields", () => {
      expect(validateRunRecordSchema(null).valid).toBe(false);
      expect(validateRunRecordSchema({ schemaVersion: 2 }).valid).toBe(false);

      const validRecord: RunRecordV1 = {
        schemaVersion: 1,
        id: "run-001",
        sessionId: "sess-1",
        cwd: testCwd,
        goalId: "goal-123",
        planId: "plan-456",
        stage: "Implementation",
        status: "running",
        checkpoint: { stepIndex: 2, totalSteps: 5, lastCompletedStep: "Database migration" },
        model: "ag/gemini-3.8-flash-high",
        agent: "general-worker",
        retryCount: 0,
        artifactPaths: ["src/db/migrate.ts"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = validateRunRecordSchema(validRecord);
      expect(result.valid).toBe(true);
    });

    it("saves and loads run records atomically in .pi/runs/", () => {
      const record: RunRecordV1 = {
        schemaVersion: 1,
        id: "run-atomic-test",
        sessionId: "sess-atomic",
        cwd: testCwd,
        stage: "Verification",
        status: "queued",
        checkpoint: { stepIndex: 0, totalSteps: 3 },
        model: "ag/gemini-3.8-flash-medium",
        agent: "coder",
        retryCount: 1,
        lastError: "Connection timeout on previous attempt",
        artifactPaths: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const saveRes = saveRunRecordAtomic(testCwd, record);
      expect(saveRes.success).toBe(true);

      const runFile = path.join(testCwd, ".pi", "runs", "run-atomic-test.json");
      expect(fs.existsSync(runFile)).toBe(true);

      const loaded = loadRunRecordValidated(testCwd, "run-atomic-test");
      expect(loaded.record).not.toBeNull();
      expect(loaded.record?.status).toBe("queued");
      expect(loaded.record?.lastError).toBe("Connection timeout on previous attempt");
    });

    it("safely handles corrupted run JSON file without throwing unhandled exceptions", () => {
      const runsDir = path.join(testCwd, ".pi", "runs");
      fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(path.join(runsDir, "run-corrupted.json"), "{ invalid: [ json ...", "utf8");

      const loaded = loadRunRecordValidated(testCwd, "run-corrupted");
      expect(loaded.record).toBeNull();
      expect(loaded.diagnostic).toContain("invalid JSON");
    });
  });

  describe("Process Active vs Restart-Recoverable Distinction", () => {
    it("differentiates between runs active in current process and restorable runs after restart", async () => {
      runRegistryExtension(mockPi);
      const ctx: any = { cwd: testCwd, ui: mockUi, sessionManager: { getSessionId: () => "sess-test" } };

      const activeRun: RunRecordV1 = {
        schemaVersion: 1,
        id: "run-active-now",
        sessionId: "sess-test",
        cwd: testCwd,
        stage: "Execution",
        status: "running",
        checkpoint: { stepIndex: 1, totalSteps: 4 },
        model: "gemini",
        agent: "coder",
        retryCount: 0,
        artifactPaths: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveRunRecordAtomic(testCwd, activeRun);
      markRunProcessActive("run-active-now");

      const restartedRun: RunRecordV1 = {
        schemaVersion: 1,
        id: "run-restarted-prior",
        sessionId: "sess-old",
        cwd: testCwd,
        stage: "Execution",
        status: "running", // was running when process terminated
        checkpoint: { stepIndex: 2, totalSteps: 4 },
        model: "gemini",
        agent: "coder",
        retryCount: 0,
        artifactPaths: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveRunRecordAtomic(testCwd, restartedRun);
      // 'run-restarted-prior' is NOT in activeProcessRunIds

      // /run-list should show distinction
      await commands["run-list"]("", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("[ACTIVE]"),
        "info"
      );
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("[RESTART]"),
        "info"
      );

      // /run-status checks
      await commands["run-status"]("run-restarted-prior", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("[RESTART-RECOVERABLE]"),
        "info"
      );
    });
  });

  describe("/run-pause, /run-resume, and /run-cancel workflows", () => {
    it("pauses an active run and cancels from process tracking", async () => {
      runRegistryExtension(mockPi);
      const ctx: any = { cwd: testCwd, ui: mockUi };

      const record: RunRecordV1 = {
        schemaVersion: 1,
        id: "run-to-pause",
        sessionId: "sess-1",
        cwd: testCwd,
        stage: "Testing",
        status: "running",
        checkpoint: { stepIndex: 1, totalSteps: 3 },
        model: "gemini",
        agent: "worker",
        retryCount: 0,
        artifactPaths: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveRunRecordAtomic(testCwd, record);
      markRunProcessActive("run-to-pause");

      await commands["run-pause"]("run-to-pause", ctx);

      const reloaded = loadRunRecordValidated(testCwd, "run-to-pause");
      expect(reloaded.record?.status).toBe("paused");
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("paused"),
        "info"
      );
    });

    it("resumes a run from saved checkpoint without re-planning from scratch", async () => {
      runRegistryExtension(mockPi);
      const ctx: any = { cwd: testCwd, ui: mockUi };

      const record: RunRecordV1 = {
        schemaVersion: 1,
        id: "run-to-resume",
        sessionId: "sess-1",
        cwd: testCwd,
        planId: "plan-core-auth",
        goalId: "goal-auth-v1",
        stage: "Implementation",
        status: "paused",
        checkpoint: {
          stepIndex: 2,
          totalSteps: 5,
          lastCompletedStep: "Database schema migration",
        },
        model: "gemini-3.8-flash",
        agent: "builder",
        retryCount: 0,
        artifactPaths: ["db/migrations/01.sql"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveRunRecordAtomic(testCwd, record);

      await commands["run-resume"]("run-to-resume", ctx);

      // Check status became running
      const reloaded = loadRunRecordValidated(testCwd, "run-to-resume");
      expect(reloaded.record?.status).toBe("running");

      // Verify resumption prompt sent to agent uses checkpoint explicitly
      expect(sentMessages.length).toBe(1);
      const prompt = sentMessages[0].content;
      expect(prompt).toContain("[RUN RESUME: run-to-resume]");
      expect(prompt).toContain("Resuming from Step 3 of 5 total steps");
      expect(prompt).toContain("Database schema migration");
      expect(prompt).toContain("DO NOT plan again from scratch");
    });

    it("cancels a run and records finishedAt timestamp", async () => {
      runRegistryExtension(mockPi);
      const ctx: any = { cwd: testCwd, ui: mockUi };

      const record: RunRecordV1 = {
        schemaVersion: 1,
        id: "run-to-cancel",
        sessionId: "sess-1",
        cwd: testCwd,
        stage: "Execution",
        status: "running",
        checkpoint: { stepIndex: 0, totalSteps: 2 },
        model: "gemini",
        agent: "worker",
        retryCount: 0,
        artifactPaths: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveRunRecordAtomic(testCwd, record);

      await commands["run-cancel"]("run-to-cancel", ctx);

      const reloaded = loadRunRecordValidated(testCwd, "run-to-cancel");
      expect(reloaded.record?.status).toBe("cancelled");
      expect(reloaded.record?.finishedAt).toBeTruthy();
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("cancelled"),
        "info"
      );
    });

    it("rejects resuming a completed or cancelled run", async () => {
      runRegistryExtension(mockPi);
      const ctx: any = { cwd: testCwd, ui: mockUi };

      const record: RunRecordV1 = {
        schemaVersion: 1,
        id: "run-done",
        sessionId: "sess-1",
        cwd: testCwd,
        stage: "Execution",
        status: "completed",
        checkpoint: { stepIndex: 3, totalSteps: 3 },
        model: "gemini",
        agent: "worker",
        retryCount: 0,
        artifactPaths: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveRunRecordAtomic(testCwd, record);

      await commands["run-resume"]("run-done", ctx);
      expect(sentMessages.length).toBe(0);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("already completed"),
        "warning"
      );
    });
  });
});
