import { describe, it, expect, vi } from "vitest";
import {
  cleanTitle,
  generateLocalFallbackTitle,
  requestLlmTitle,
} from "../extensions/auto-session-title.js";
import autoSessionTitleExtension from "../extensions/auto-session-title.js";

describe("auto-session-title hardened extension tests", () => {
  it("cleans titles by removing outer quotes, formatting, and excess words", () => {
    expect(cleanTitle('"Skrip Backup Database"')).toBe("Skrip Backup Database");
    expect(cleanTitle("Chat tentang: Perbaikan Bug Auth Token")).toBe("Perbaikan Bug Auth Token");
    expect(
      cleanTitle("Optimizing React Components In Large Production Web Applications With Memoization")
    ).toBe("Optimizing React Components In Large Production");
  });

  it("generates simple local fallback from recent substantive messages", () => {
    const idTitle = generateLocalFallbackTitle(["tes", "tolong buatkan skrip backup database postgresql"]);
    expect(idTitle).toBeTruthy();
    expect(idTitle.toLowerCase()).toContain("backup");

    const enTitle = generateLocalFallbackTitle(["hi", "how to optimize react component rendering"]);
    expect(enTitle).toBeTruthy();
    expect(enTitle.toLowerCase()).toContain("optimize");
  });

  it("does not name on the first user message", async () => {
    let sessionName = "";
    const mockPi: any = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === "agent_settled") {
          const mockCtx: any = {
            sessionManager: {
              getSessionName: () => sessionName,
              getSessionId: () => "sess-title-1",
              getEntries: () => [
                { type: "message", message: { role: "user", content: [{ type: "text", text: "tes" }] } },
                { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ready" }] } },
              ],
            },
          };
          handler({}, mockCtx);
        }
      }),
      getSessionName: () => sessionName,
      setSessionName: (name: string) => {
        sessionName = name;
      },
      appendEntry: vi.fn(),
    };

    autoSessionTitleExtension(mockPi);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessionName).toBe("");
  });

  it("names session on agent_settled after 2 user messages and at least 1 assistant response", async () => {
    let sessionName = "";
    let appendedEntry: any = null;

    const mockPi: any = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === "agent_settled") {
          const mockCtx: any = {
            sessionManager: {
              getSessionName: () => sessionName,
              getSessionId: () => "sess-title-2",
              getEntries: () => [
                { type: "message", message: { role: "user", content: [{ type: "text", text: "halo" }] } },
                { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Halo, ada yang bisa dibantu?" }] } },
                { type: "message", message: { role: "user", content: [{ type: "text", text: "tolong buatkan skrip backup database postgresql" }] } },
                { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Berikut skripnya..." }] } },
              ],
            },
          };
          handler({}, mockCtx);
        }
      }),
      getSessionName: () => sessionName,
      setSessionName: (name: string) => {
        sessionName = name;
      },
      appendEntry: vi.fn((type: string, data: unknown) => {
        appendedEntry = { type, data };
      }),
    };

    autoSessionTitleExtension(mockPi);

    for (let i = 0; i < 80; i++) {
      if (sessionName) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(sessionName).toBeTruthy();
    expect(sessionName.toLowerCase()).toContain("backup");
    expect(appendedEntry).toBeTruthy();
    expect(appendedEntry.type).toBe("auto_session_title");
  });

  it("does not overwrite manually renamed or existing session name", async () => {
    let sessionName = "Manual Title Set By User";
    const setSessionNameSpy = vi.fn();

    const mockPi: any = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === "agent_settled") {
          const mockCtx: any = {
            sessionManager: {
              getSessionName: () => sessionName,
              getSessionId: () => "sess-title-3",
              getEntries: () => [
                { type: "message", message: { role: "user", content: [{ type: "text", text: "halo" }] } },
                { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Halo" }] } },
                { type: "message", message: { role: "user", content: [{ type: "text", text: "buatkan skrip backup" }] } },
                { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Siap" }] } },
              ],
            },
          };
          handler({}, mockCtx);
        }
      }),
      getSessionName: () => sessionName,
      setSessionName: setSessionNameSpy,
      appendEntry: vi.fn(),
    };

    autoSessionTitleExtension(mockPi);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(setSessionNameSpy).not.toHaveBeenCalled();
    expect(sessionName).toBe("Manual Title Set By User");
  });

  it("prevents overwrite if session was renamed right before commit", async () => {
    let sessionName = "";
    let callCount = 0;

    const mockPi: any = {
      on: vi.fn((event: string, handler: Function) => {
        if (event === "agent_settled") {
          const mockCtx: any = {
            sessionManager: {
              getSessionName: () => {
                callCount++;
                // Simulate user renaming right before final commit
                if (callCount > 1) return "User Changed Title Mid-Flight";
                return "";
              },
              getSessionId: () => "sess-title-race",
              getEntries: () => [
                { type: "message", message: { role: "user", content: [{ type: "text", text: "halo" }] } },
                { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Halo" }] } },
                { type: "message", message: { role: "user", content: [{ type: "text", text: "buatkan skrip backup" }] } },
                { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Siap" }] } },
              ],
            },
          };
          handler({}, mockCtx);
        }
      }),
      getSessionName: () => (callCount > 1 ? "User Changed Title Mid-Flight" : ""),
      setSessionName: vi.fn((name: string) => {
        sessionName = name;
      }),
      appendEntry: vi.fn(),
    };

    autoSessionTitleExtension(mockPi);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // setSessionName should NOT have committed because checkBeforeCommit detected the manual title
    expect(sessionName).toBe("");
  });

  it("falls back gracefully when LLM request times out without unhandled rejection", async () => {
    const res = await requestLlmTitle("some prompt", 1);
    expect(res).toBeNull();
  });
});
