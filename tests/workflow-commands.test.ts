import { describe, it, expect, vi, beforeEach } from "vitest";
import workflowExtension, {
  formatBtwPrompt,
  formatPlanPrompt,
  formatBuildPrompt,
  formatDebugPrompt,
  formatReviewPrompt,
  createWorkflowState,
} from "../extensions/workflow-commands.js";

describe("workflow-commands extension tests", () => {
  let commands: Record<string, Function>;
  let eventHandlers: Record<string, Function>;
  let sentMessages: Array<{ content: string; options?: any }>;
  let appendedEntries: Array<{ customType: string; data: any }>;
  let mockUi: { notify: ReturnType<typeof vi.fn> };
  let mockPi: any;

  beforeEach(() => {
    commands = {};
    eventHandlers = {};
    sentMessages = [];
    appendedEntries = [];
    mockUi = { notify: vi.fn() };

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
  });

  it("registers all required slash commands", () => {
    workflowExtension(mockPi);
    expect(commands["btw"]).toBeDefined();
    expect(commands["btw-list"]).toBeDefined();
    expect(commands["btw-clear"]).toBeDefined();
    expect(commands["plan"]).toBeDefined();
    expect(commands["build"]).toBeDefined();
    expect(commands["debug"]).toBeDefined();
    expect(commands["review"]).toBeDefined();
  });

  describe("/btw side questions", () => {
    it("formats /btw prompt properly without altering the main task", () => {
      const prompt = formatBtwPrompt("apa perbedaan npm run dan npx?");
      expect(prompt).toContain("BY-THE-WAY SIDE QUESTION");
      expect(prompt).toContain("apa perbedaan npm run dan npx?");
      expect(prompt).toContain("Do NOT modify, reset, or abandon the current active plan");
      expect(prompt).toContain("main task context remains unchanged");
    });

    it("sends /btw message immediately when agent is idle", async () => {
      workflowExtension(mockPi);
      const ctx: any = { isIdle: () => true, ui: mockUi };
      await commands["btw"]("pertanyaan santai", ctx);

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].content).toContain("pertanyaan santai");
    });

    it("queues /btw safely when agent is busy (isIdle=false)", async () => {
      workflowExtension(mockPi);
      const ctx: any = { isIdle: () => false, ui: mockUi };
      await commands["btw"]("pertanyaan saat sibuk", ctx);

      // Tidak langsung dikirim ke model
      expect(sentMessages.length).toBe(0);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("antrean"),
        "info"
      );

      // Cek antrean via /btw-list
      await commands["btw-list"]("", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("pertanyaan saat sibuk"),
        "info"
      );

      // Saat turn selesai (agent_end), pertanyaan antrean diproses
      await eventHandlers["agent_end"]({}, ctx);
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].content).toContain("pertanyaan saat sibuk");
      expect(sentMessages[0].options?.deliverAs).toBe("followUp");
    });

    it("clears queue via /btw-clear", async () => {
      workflowExtension(mockPi);
      const ctx: any = { isIdle: () => false, ui: mockUi };
      await commands["btw"]("q1", ctx);
      await commands["btw-clear"]("", ctx);

      await commands["btw-list"]("", ctx);
      expect(mockUi.notify).toHaveBeenCalledWith("Antrean /btw kosong.", "info");
    });

    it("intercepts /btw input during streaming and marks as handled", async () => {
      workflowExtension(mockPi);
      const res = await eventHandlers["input"]({
        text: "/btw pertanyaan di tengah streaming",
        source: "user",
        streamingBehavior: "steer",
      });

      expect(res.action).toBe("handled");
    });
  });

  describe("/plan mode", () => {
    it("formats /plan prompt with strict read-only scouting rules", () => {
      const prompt = formatPlanPrompt("Integrate Stripe payments");
      expect(prompt).toContain("WORKFLOW MODE: /plan");
      expect(prompt).toContain("Integrate Stripe payments");
      expect(prompt).toContain("READ-ONLY SCOUTING ONLY");
      expect(prompt).toContain("DO NOT modify, create, or delete any files");
    });

    it("blocks file modification tools ('edit', 'write') when in /plan mode", async () => {
      workflowExtension(mockPi);
      const ctx: any = { cwd: process.cwd(), ui: mockUi };
      await commands["plan"]("Design new auth architecture", ctx);

      // Tool edit diblokir
      const editResult = await eventHandlers["tool_call"]({ toolName: "edit" });
      expect(editResult.block).toBe(true);
      expect(editResult.reason).toContain("read-only");

      // Tool write diblokir
      const writeResult = await eventHandlers["tool_call"]({ toolName: "write" });
      expect(writeResult.block).toBe(true);

      // Tool read & bash tetap diizinkan
      const readResult = await eventHandlers["tool_call"]({ toolName: "read" });
      expect(readResult.block).toBeUndefined();
    });
  });

  describe("/build mode", () => {
    it("refuses to run without an active plan", async () => {
      workflowExtension(mockPi);
      const ctx: any = { cwd: "/empty-test-dir", ui: mockUi };
      await commands["build"]("", ctx);

      expect(sentMessages.length).toBe(0);
      expect(mockUi.notify).toHaveBeenCalledWith(
        expect.stringContaining("Belum ada rencana aktif"),
        "error"
      );
    });

    it("executes build prompt when an active plan exists", async () => {
      workflowExtension(mockPi);
      const ctx: any = { cwd: process.cwd(), ui: mockUi };

      // Buat plan dulu
      await commands["plan"]("Build auth system", ctx);
      expect(sentMessages.length).toBe(1);

      // Jalankan build
      await commands["build"]("", ctx);
      expect(sentMessages.length).toBe(2);
      expect(sentMessages[1].content).toContain("WORKFLOW MODE: /build");
      expect(sentMessages[1].content).toContain("Build auth system");
    });
  });

  describe("/debug mode", () => {
    it("formats 5-stage systematic debugging workflow prompt", () => {
      const prompt = formatDebugPrompt("Database connection timed out");
      expect(prompt).toContain("WORKFLOW MODE: /debug");
      expect(prompt).toContain("Database connection timed out");
      expect(prompt).toContain("1. REPRODUCE");
      expect(prompt).toContain("2. ROOT CAUSE INVESTIGATION");
      expect(prompt).toContain("3. HYPOTHESIS");
      expect(prompt).toContain("4. MINIMAL FIX");
      expect(prompt).toContain("5. REGRESSION TEST");
    });

    it("sends debug prompt upon invocation", async () => {
      workflowExtension(mockPi);
      const ctx: any = { ui: mockUi };
      await commands["debug"]("Null pointer exception on login", ctx);

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].content).toContain("Null pointer exception on login");
    });
  });

  describe("/review mode", () => {
    it("formats read-only code review prompt with priority categories", () => {
      const prompt = formatReviewPrompt("feature/payment branch");
      expect(prompt).toContain("WORKFLOW MODE: /review");
      expect(prompt).toContain("feature/payment branch");
      expect(prompt).toContain("READ-ONLY CODE REVIEW ONLY");
      expect(prompt).toContain("[CRITICAL], [IMPORTANT], [MINOR]");
    });

    it("blocks file modification tools during review mode", async () => {
      workflowExtension(mockPi);
      const ctx: any = { ui: mockUi };
      await commands["review"]("", ctx);

      const editResult = await eventHandlers["tool_call"]({ toolName: "edit" });
      expect(editResult.block).toBe(true);
      expect(editResult.reason).toContain("read-only");
    });
  });
});
