import { describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings } from "@earendil-works/pi-tui";
import { EMPTY_USAGE } from "../../src/agents/types.js";
import { openAgentPane } from "../../src/ui/attach.js";

describe("Attach workspace", () => {
  test("fills the terminal and detaches only with an empty editor", async () => {
    initTheme("dark");
    let component: Component | undefined;
    let options: unknown;
    let stopped = 0;
    const view = { items: [], docs: {} };
    const conversation = {
      watch: {
        value: {},
        start: () => {},
        stop: async () => {
          stopped++;
        },
      },
      transcript: { merge: () => view },
    };
    const service = {
      view: async () => conversation,
      agentById: () => ({
        id: "1",
        name: "reviewer",
        cwd: "/repo",
        state: "idle",
        usage: EMPTY_USAGE,
      }),
    };
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    const theme = { fg: (_name: string, value: string) => value };
    const ctx = {
      ui: {
        setWorkingVisible: () => {},
        custom: (factory: (...args: never[]) => Component, opts: unknown) => {
          options = opts;
          return new Promise<void>((resolve) => {
            component = factory(
              tui as never,
              theme as never,
              getKeybindings() as never,
              resolve as never,
            );
          });
        },
      },
    };
    const open = openAgentPane(ctx as never, service as never, "1");
    await Promise.resolve();
    expect(options).toEqual({
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
    });
    const lines = component?.render(80) ?? [];
    expect(lines).toHaveLength(24);
    expect(lines[0]).toContain("Agents › reviewer");
    component?.handleInput?.("draft");
    component?.handleInput?.("\u001b[D");
    expect(stopped).toBe(0);
    // Clear the draft, then detach.
    component?.handleInput?.("\u0001");
    component?.handleInput?.("\u000b");
    component?.handleInput?.("\u001b[D");
    await open;
    expect(stopped).toBe(1);
  });
});
