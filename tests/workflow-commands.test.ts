import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import workflowExtension, {
  formatPlanPrompt,
  formatBuildPrompt,
  formatDirectBuildPrompt,
  formatDebugPrompt,
  formatReviewPrompt,
  wrapText,
  validatePlanSchema,
  savePlanAtomic,
  loadPlanValidated,
  migrateLegacyPlan,
  parseStructuredPlanFromAssistantText,
  extractSanitizedContext,
  queryBtwAnswer,
  getOrCreateSessionState,
  clearAllSessionWorkflowStates,
  parseBuildIntent,
  parsePlanIntent,
  parseDebugIntent,
  parseReviewIntent,
  parseBtwIntent,
  notifyStateFallback,
  type WorkflowPlanV1,
} from "../extensions/workflow-commands.js";

describe("workflow-commands hardened extension tests", () => {
  let commands: Record<string, Function>;
  let eventHandlers: Record<string, Function>;
  let sentMessages: Array<{ content: string; options?: any }>;
  let appendedEntries: Array<{ customType: string; data: any }>;
  let mockUi: { notify: ReturnType<typeof vi.fn>; custom: ReturnType<typeof vi.fn>; setWidget: ReturnType<typeof vi.fn> };
  let mockPi: any;
  let testCwd: string;

  beforeEach(() => {
    commands = {};
    eventHandlers = {};
    sentMessages = [];
    appendedEntries = [];
    mockUi = { notify: vi.fn(), custom: vi.fn(), setWidget: vi.fn() };

    mockPi = {
      registerCommand: vi.fn((name: string, def: any) => {
        commands[name] = def.handler;
      }),
      on: vi.fn((event: string, handler: Function) => {
        eventHandlers[event] = handler;
      }),
      sendUserMessage: vi.fn((content: string, options?: any) => {
        sentMessages.push({ content, options });
      }),
      appendEntry: vi.fn((customType: string, data: any) => {
        appendedEntries.push({ customType, data });
      }),
    };

    clearAllSessionWorkflowStates();

    testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-test-"));
  });

  afterEach(() => {
    clearAllSessionWorkflowStates();
    try {
      fs.rmSync(testCwd, { recursive: true, force: true });
    } catch {}
  });

  it("registers all required workflow commands without relying on pi.on('input')", () => {
    workflowExtension(mockPi);
    expect(commands["btw"]).toBeDefined();
    expect(commands["btw-list"]).toBeDefined();
    expect(commands["btw-clear"]).toBeDefined();
    expect(commands["plan"]).toBeDefined();
    expect(commands["plan-approve"]).toBeDefined();
    expect(commands["build"]).toBeDefined();
    expect(commands["debug"]).toBeDefined();
    expect(commands["review"]).toBeDefined();
    // Verify pi.on("input") is NOT used for /btw interception
    expect(eventHandlers["input"]).toBeUndefined();
  });

  describe("P0.1: Real Read-Only Mode enforcement", () => {
    it("blocks ALL mutation paths (edit, write, bash, powershell, custom_tools) in /plan mode", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-plan-1" },
      };

      await commands["plan"]("Design payment module", ctx);

      // Mutative tools blocked
      const editBlock = await eventHandlers["tool_call"]({ toolName: "edit" }, ctx);
      expect(editBlock.block).toBe(true);
      expect(editBlock.reason).toContain("read-only");

      const writeBlock = await eventHandlers["tool_call"]({ toolName: "write" }, ctx);
      expect(writeBlock.block).toBe(true);

      const bashBlock = await eventHandlers["tool_call"]({ toolName: "bash" }, ctx);
      expect(bashBlock.block).toBe(true);

      const psBlock = await eventHandlers["tool_call"]({ toolName: "powershell" }, ctx);
      expect(psBlock.block).toBe(true);

      const customMcpBlock = await eventHandlers["tool_call"]({ toolName: "mcp_deploy" }, ctx);
      expect(customMcpBlock.block).toBe(true);

      // Inspection tools permitted
      const readPermit = await eventHandlers["tool_call"]({ toolName: "read" }, ctx);
      expect(readPermit.block).toBeUndefined();

      const grepPermit = await eventHandlers["tool_call"]({ toolName: "grep" }, ctx);
      expect(grepPermit.block).toBeUndefined();

      const findPermit = await eventHandlers["tool_call"]({ toolName: "find" }, ctx);
      expect(findPermit.block).toBeUndefined();

      const lsPermit = await eventHandlers["tool_call"]({ toolName: "ls" }, ctx);
      expect(lsPermit.block).toBeUndefined();
    });

    it("blocks ALL mutation paths in /review mode as well", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-review-1" },
      };

      await commands["review"]("HEAD~1..HEAD", ctx);

      const bashBlock = await eventHandlers["tool_call"]({ toolName: "bash" }, ctx);
      expect(bashBlock.block).toBe(true);
      expect(bashBlock.reason).toContain("read-only");

      const editBlock = await eventHandlers["tool_call"]({ toolName: "edit" }, ctx);
      expect(editBlock.block).toBe(true);
    });

    it("resets mode to idle after agent_settled so subsequent turns are not locked", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-unlock-1", getEntries: () => [] },
      };

      await commands["plan"]("Architect system", ctx);
      const stateBefore = getOrCreateSessionState("sess-unlock-1", testCwd);
      expect(stateBefore.activeMode).toBe("plan");

      // When settled, mode resets
      await eventHandlers["agent_settled"]({}, ctx);
      const stateAfter = getOrCreateSessionState("sess-unlock-1", testCwd);
      expect(stateAfter.activeMode).toBe("idle");

      // Tools no longer blocked
      const editPermit = await eventHandlers["tool_call"]({ toolName: "edit" }, ctx);
      expect(editPermit.block).toBeUndefined();
      const bashPermit = await eventHandlers["tool_call"]({ toolName: "bash" }, ctx);
      expect(bashPermit.block).toBeUndefined();
    });

    it("resets mode and cancels pending background tasks on session switch or shutdown", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-switch-1", getEntries: () => [] },
      };

      await commands["plan"]("Design API", ctx);
      const state = getOrCreateSessionState("sess-switch-1", testCwd);
      state.btwActive = true;
      state.btwAbortController = new AbortController();
      const abortSpy = vi.spyOn(state.btwAbortController, "abort");

      await eventHandlers["session_before_switch"]({}, ctx);
      expect(abortSpy).toHaveBeenCalled();
      expect(state.activeMode).toBe("idle");
      expect(state.btwActive).toBe(false);
    });
  });

  describe("P0.2 & P0.3: Stateful Plan Validation, Atomic Persistence & Approval Flow", () => {
    it("validates plan schema and detects invalid or corrupted data", () => {
      expect(validatePlanSchema(null).valid).toBe(false);
      expect(validatePlanSchema({ schemaVersion: 2 }).valid).toBe(false);
      expect(validatePlanSchema({ schemaVersion: 1, sessionId: "s", cwd: "c" }).valid).toBe(false);

      const validPlan: WorkflowPlanV1 = {
        schemaVersion: 1,
        sessionId: "s1",
        cwd: testCwd,
        goal: "Refactor auth",
        status: "draft",
        planCaptured: false,
        contentSource: "draft_placeholder",
        steps: ["Step 1"],
        risks: ["Risk 1"],
        acceptanceCriteria: ["Criteria 1"],
        verificationCommands: ["npm test"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(validatePlanSchema(validPlan).valid).toBe(true);
    });

    it("saves plan atomically and recovers successfully", () => {
      const plan: WorkflowPlanV1 = {
        schemaVersion: 1,
        sessionId: "sess-atomic-1",
        cwd: testCwd,
        goal: "Build cache system",
        status: "draft",
        planCaptured: true,
        contentSource: "agent",
        steps: ["Setup cache", "Add tests"],
        risks: ["Memory leak"],
        acceptanceCriteria: ["Tests pass"],
        verificationCommands: ["npm test"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const res = savePlanAtomic(testCwd, plan);
      expect(res.success).toBe(true);

      const loaded = loadPlanValidated(testCwd, "sess-atomic-1");
      expect(loaded.plan).not.toBeNull();
      expect(loaded.plan?.goal).toBe("Build cache system");
    });

    it("rejects corrupted plan file with an actionable diagnostic message", () => {
      const planDir = path.join(testCwd, ".pi");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, "active-plan.json"), "{ corrupted json ...", "utf8");

      const loaded = loadPlanValidated(testCwd);
      expect(loaded.plan).toBeNull();
      expect(loaded.diagnostic).toContain("invalid JSON");
    });

    it("detects unversioned legacy plan and guides user to /plan migrate", () => {
      const planDir = path.join(testCwd, ".pi");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, "active-plan.json"),
        JSON.stringify({
          goal: "Legacy plan goal",
          steps: ["Step 1", "Step 2"],
          verificationCommand: "npm test",
        }),
        "utf8"
      );

      const loaded = loadPlanValidated(testCwd, "current-sess");
      expect(loaded.plan).toBeNull();
      expect(loaded.diagnostic).toContain("/plan migrate");

      // Now explicit migration succeeds
      const mig = migrateLegacyPlan(testCwd, "current-sess");
      expect(mig.success).toBe(true);
      expect(mig.plan?.schemaVersion).toBe(1);
      expect(mig.plan?.goal).toBe("Legacy plan goal");

      // After migration, loadPlanValidated succeeds
      const reloaded = loadPlanValidated(testCwd, "current-sess");
      expect(reloaded.plan).not.toBeNull();
      expect(reloaded.plan?.schemaVersion).toBe(1);
    });

    it("rejects plan from a different session or cwd", () => {
      const plan: WorkflowPlanV1 = {
        schemaVersion: 1,
        sessionId: "other-session",
        cwd: path.resolve(testCwd),
        goal: "Build feature",
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
      savePlanAtomic(testCwd, plan);

      // Check with different session ID
      const loaded = loadPlanValidated(testCwd, "my-current-session");
      expect(loaded.plan).toBeNull();
      expect(loaded.diagnostic).toContain("created in another session");
    });

    it("/plan approve rejects if real plan has not been captured from agent output", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-placeholder-test" },
      };

      await commands["plan"]("Implement OAuth", ctx);

      // Attempting to approve before agent outputs a real plan must be rejected
      await commands["plan"]("approve", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("Real plan has not been extracted"),
        "warning"
      );

      // /build --from-plan must also reject
      await commands["build"]("--from-plan", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("does not have concrete steps"),
        "error"
      );
    });

    it("/build strictly rejects plans that are still in 'draft' status until approved", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: {
          getSessionId: () => "sess-draft-build",
          getEntries: () => [
            {
              type: "message",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "```json\n" + JSON.stringify({
                      plan: {
                        steps: ["Setup OAuth client", "Add callback endpoint"],
                        risks: ["Token leakage"],
                        acceptanceCriteria: ["Login returns 200"],
                        verificationCommands: ["npm test"],
                      },
                    }) + "\n```",
                  },
                ],
              },
            },
          ],
        },
      };

      await commands["plan"]("Implement OAuth", ctx);
      // Simulate assistant finishing plan analysis
      await eventHandlers["agent_settled"]({}, ctx);

      // /build must reject draft even if captured, because not yet approved
      await commands["build"]("", ctx);
      expect(sentMessages.length).toBe(1); // Only the /plan message, /build did NOT trigger
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("DRAFT"),
        "warning"
      );

      // Approve plan via /plan approve
      await commands["plan"]("approve", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("APPROVED"),
        "info"
      );

      // /build now proceeds
      await commands["build"]("", ctx);
      expect(sentMessages.length).toBe(2);
      expect(sentMessages[1].content).toContain("WORKFLOW MODE: /build");
      expect(sentMessages[1].content).toContain("Implement OAuth");
    });

    it("captures real structured plan from agent output upon agent_settled", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: {
          getSessionId: () => "sess-real-capture",
          getEntries: () => [
            {
              type: "message",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: [
                      "Analisis arsitektur selesai. Berikut rencananya:",
                      "```json",
                      JSON.stringify({
                        plan: {
                          steps: ["Buat schema migration", "Implementasi handler", "Verifikasi unit test"],
                          risks: ["Downtime migrasi database"],
                          acceptanceCriteria: ["Status code 200", "Token tersimpan aman"],
                          verificationCommands: ["npm test tests/auth.test.ts"],
                        },
                      }),
                      "```",
                    ].join("\n"),
                  },
                ],
              },
            },
          ],
        },
      };

      await commands["plan"]("Setup database schema", ctx);
      await eventHandlers["agent_settled"]({}, ctx);

      const loaded = loadPlanValidated(testCwd, "sess-real-capture");
      expect(loaded.plan?.steps).toEqual([
        "Buat schema migration",
        "Implementasi handler",
        "Verifikasi unit test",
      ]);
      expect(loaded.plan?.risks).toContain("Downtime migrasi database");
      expect(loaded.plan?.verificationCommands).toContain("npm test tests/auth.test.ts");
    });
  });

  describe("P0.4: Out-Of-Band /btw Side Questioning", () => {
    it("handles /btw from registered command without injecting into transcript", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-btw-oob", getEntries: () => [] },
      };

      await commands["btw"]("apa fungsi index pada database?", ctx);

      // No message dispatched to main agent turn
      expect(sentMessages.length).toBe(0);
      expect(mockUi.setWidget).toHaveBeenCalledWith(
        "btw-status",
        expect.any(Array)
      );
    });

    it("enforces concurrency limit (max 1 active, bounded queue max 3)", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-btw-queue", getEntries: () => [] },
      };

      const state = getOrCreateSessionState("sess-btw-queue", testCwd);
      state.btwActive = true; // Simulate ongoing request

      await commands["btw"]("q1", ctx);
      expect(state.btwQueue.length).toBe(1);

      await commands["btw"]("q2", ctx);
      expect(state.btwQueue.length).toBe(2);

      await commands["btw"]("q3", ctx);
      expect(state.btwQueue.length).toBe(3);

      // 4th request rejected because bounded queue is full
      await commands["btw"]("q4", ctx);
      expect(state.btwQueue.length).toBe(3);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("queue is full"),
        "warning"
      );
    });

    it("/btw-clear aborts active controller, empties queue, and cleans widget", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-btw-clear", getEntries: () => [] },
      };

      const state = getOrCreateSessionState("sess-btw-clear", testCwd);
      state.btwActive = true;
      state.btwAbortController = new AbortController();
      const abortSpy = vi.spyOn(state.btwAbortController, "abort");
      state.btwQueue = [
        { id: "1", question: "q1", contextSummary: "", queuedAt: "" },
      ];

      await commands["btw-clear"]("", ctx);

      expect(abortSpy).toHaveBeenCalled();
      expect(state.btwActive).toBe(false);
      expect(state.btwQueue.length).toBe(0);
      expect(mockUi.setWidget).toHaveBeenCalledWith("btw-status", undefined);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("Cleared"),
        "info"
      );
    });

    it("sanitizes context snapshot by stripping sensitive keys and tokens", () => {
      const mockEntries = [
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Koneksikan dengan sk_test_mock_secret_key_1234567890 dan password=rahasia123" }],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 token received" }],
          },
        },
      ];

      const sanitized = extractSanitizedContext(mockEntries);
      expect(sanitized).not.toContain("sk_test_mock_secret_key_1234567890");
      expect(sanitized).toContain("[REDACTED_API_KEY]");
      expect(sanitized).toContain("[REDACTED_TOKEN]");
      expect(sanitized).toContain("secret: [REDACTED]");
    });
  });

  describe("P0.5: Side-query Provider & Timeout Safety", () => {
    it("handles timeout or abort gracefully without crashing or treating error as normal answer", async () => {
      const controller = new AbortController();
      controller.abort(); // pre-aborted

      const res = await queryBtwAnswer("test question", "context", controller.signal, 100);
      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
      expect(res.answer).toBe("");
    });
  });

  describe("UX Principle Required Test Matrix: Direct Commands are never blocked by state", () => {
    const directCommands = [
      ["plan", "Tambahkan login Google"],
      ["build", "Tambahkan export CSV"],
      ["debug", "Request timeout"],
      ["review", "src/auth.ts"],
      ["btw", "Apa beda useMemo dan useCallback?"],
    ];

    describe.each(directCommands)("Direct command: /%s with argument '%s'", (cmdName, cmdArg) => {
      it("runs successfully and preserves legacy plan on disk", async () => {
        workflowExtension(mockPi);
        const planDir = path.join(testCwd, ".pi");
        fs.mkdirSync(planDir, { recursive: true });
        const legacyContent = JSON.stringify({
          goal: "Old legacy unversioned plan",
          steps: ["Step 1", "Step 2"],
        });
        fs.writeFileSync(path.join(planDir, "active-plan.json"), legacyContent, "utf8");

        const ctx: any = {
          cwd: testCwd,
          ui: mockUi,
          sessionManager: { getSessionId: () => "sess-matrix-1" },
        };

        await commands[cmdName](cmdArg, ctx);

        if (cmdName !== "btw") {
          expect(sentMessages.length).toBeGreaterThan(0);
          expect(sentMessages[sentMessages.length - 1].content).toContain(cmdArg);
        } else {
          expect(mockUi.notify).toHaveBeenCalled();
        }

        // Old legacy state on disk MUST NOT be changed or overwritten by direct commands
        if (cmdName !== "plan") {
          const currentDiskContent = fs.readFileSync(path.join(planDir, "active-plan.json"), "utf8");
          expect(currentDiskContent).toBe(legacyContent);
        }
      });

      it("runs successfully and preserves corrupt plan on disk", async () => {
        workflowExtension(mockPi);
        const planDir = path.join(testCwd, ".pi");
        fs.mkdirSync(planDir, { recursive: true });
        const corruptContent = "{ corrupted active-plan JSON !!!";
        fs.writeFileSync(path.join(planDir, "active-plan.json"), corruptContent, "utf8");

        const ctx: any = {
          cwd: testCwd,
          ui: mockUi,
          sessionManager: { getSessionId: () => "sess-matrix-2" },
        };

        await commands[cmdName](cmdArg, ctx);

        if (cmdName !== "btw") {
          expect(sentMessages.length).toBeGreaterThan(0);
          expect(sentMessages[sentMessages.length - 1].content).toContain(cmdArg);
        } else {
          expect(mockUi.notify).toHaveBeenCalled();
        }

        // Corrupt plan on disk MUST NOT be changed by direct commands
        if (cmdName !== "plan") {
          const currentDiskContent = fs.readFileSync(path.join(planDir, "active-plan.json"), "utf8");
          expect(currentDiskContent).toBe(corruptContent);
        }
      });

      it("runs successfully when active plan belongs to another session", async () => {
        workflowExtension(mockPi);
        const planDir = path.join(testCwd, ".pi");
        fs.mkdirSync(planDir, { recursive: true });
        const otherSessionPlan: WorkflowPlanV1 = {
          schemaVersion: 1,
          sessionId: "completely-different-session-xyz",
          cwd: path.resolve(testCwd),
          goal: "Plan from other session",
          status: "approved",
          planCaptured: true,
          contentSource: "agent",
          steps: ["Step A"],
          risks: [],
          acceptanceCriteria: [],
          verificationCommands: ["npm test"],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(planDir, "active-plan.json"), JSON.stringify(otherSessionPlan, null, 2), "utf8");

        const ctx: any = {
          cwd: testCwd,
          ui: mockUi,
          sessionManager: { getSessionId: () => "sess-matrix-3" },
        };

        await commands[cmdName](cmdArg, ctx);

        if (cmdName !== "btw") {
          expect(sentMessages.length).toBeGreaterThan(0);
          expect(sentMessages[sentMessages.length - 1].content).toContain(cmdArg);
        } else {
          expect(mockUi.notify).toHaveBeenCalled();
        }

        if (cmdName !== "plan") {
          const loaded = JSON.parse(fs.readFileSync(path.join(planDir, "active-plan.json"), "utf8"));
          expect(loaded.sessionId).toBe("completely-different-session-xyz");
        }
      });
    });
  });

  describe("UX Principle: State-explicit commands strictly validate and report recovery", () => {
    it("/build --from-plan rejects missing or corrupt plan and mentions recovery command", async () => {
      workflowExtension(mockPi);
      const planDir = path.join(testCwd, ".pi");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, "active-plan.json"), "{ invalid json", "utf8");

      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-explicit-1" },
      };

      await commands["build"]("--from-plan", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("invalid JSON"),
        "error"
      );
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("/plan"),
        "error"
      );
    });

    it("/build --from-plan rejects plan from another session without silently falling back", async () => {
      workflowExtension(mockPi);
      const plan: WorkflowPlanV1 = {
        schemaVersion: 1,
        sessionId: "sess-prior",
        cwd: path.resolve(testCwd),
        goal: "Feature A",
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
      savePlanAtomic(testCwd, plan);

      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-current" },
      };

      await commands["build"]("--from-plan", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("created in another session"),
        "error"
      );
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("/plan <goal>"),
        "error"
      );
    });

    it("/plan approve rejects corrupt plan and mentions recovery", async () => {
      workflowExtension(mockPi);
      const planDir = path.join(testCwd, ".pi");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, "active-plan.json"), "{ bad json", "utf8");

      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-explicit-2" },
      };

      await commands["plan"]("approve", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("invalid JSON"),
        "warning"
      );
    });

    it("/plan-migrate migrates legacy plan and rejects unparseable plan", async () => {
      workflowExtension(mockPi);
      const planDir = path.join(testCwd, ".pi");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(
        path.join(planDir, "active-plan.json"),
        JSON.stringify({ goal: "Legacy goal", steps: ["S1"] }),
        "utf8"
      );

      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-explicit-3" },
      };

      await commands["plan-migrate"]("", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("successfully migrated"),
        "info"
      );

      const loaded = loadPlanValidated(testCwd, "sess-explicit-3");
      expect(loaded.plan?.schemaVersion).toBe(1);
      expect(loaded.plan?.goal).toBe("Legacy goal");
    });

    it("/build without args provides friendly fallback guidance when no approved plan exists", async () => {
      workflowExtension(mockPi);
      const ctx: any = {
        cwd: testCwd,
        ui: mockUi,
        sessionManager: { getSessionId: () => "sess-default-fallback" },
      };

      await commands["build"]("", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("/build Add CSV export"),
        "warning"
      );
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("/build --from-plan"),
        "warning"
      );
    });
  });
});
