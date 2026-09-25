import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({ CustomEditor: class {} }));
vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (text: string) => text,
  visibleWidth: (text: string) => text.length,
}));

import customFooterExtension from "../extensions/custom-footer.js";

describe("custom footer command registration", () => {
  it("keeps the custom session picker available without shadowing Pi's built-in /resume", () => {
    const commands = new Map<string, unknown>();
    const pi: any = {
      on: vi.fn(),
      registerMarkdownTransformer: vi.fn(),
      registerCommand: (name: string, command: unknown) => commands.set(name, command),
    };

    customFooterExtension(pi);

    expect(commands.has("resume")).toBe(false);
    expect(commands.has("history")).toBe(true);
  });
});
