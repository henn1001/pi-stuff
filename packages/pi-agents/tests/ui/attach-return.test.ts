import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import type { SessionHost } from "../../src/pi/session.js";
import { FocusController } from "../../src/ui/focus.js";
import type { AgentPanel } from "../../src/ui/panel.js";

describe("Return from attach", () => {
  test("detaching releases deliveries before reopening the selected agent in the overview", async () => {
    let close: (() => void) | undefined;
    const events: string[] = [];
    const service = { view: async () => ({}) } as unknown as AgentService;
    const host = { current: () => service } as unknown as SessionHost;
    const panel = {
      setFocused: () => {},
      setSuppressed: (value: boolean) => events.push(`suppressed:${value}`),
    } as unknown as AgentPanel;
    const ctx = {
      mode: "tui",
      ui: {
        onTerminalInput: () => () => {},
        setWorkingVisible: () => {},
        custom: () =>
          new Promise<void>((resolve) => {
            close = resolve;
          }),
      },
    } as unknown as ExtensionContext;
    const focus = new FocusController(host, panel);
    focus.onPaneClosed = () => events.push("deliver");
    focus.onBrowse = (_ctx, select) => events.push(`browse:${select}`);
    focus.install(ctx);
    focus.attach(ctx, "7");
    await Promise.resolve();
    expect(focus.isPaneOpen()).toBe(true);
    close?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(focus.isPaneOpen()).toBe(false);
    expect(events).toEqual([
      "suppressed:true",
      "suppressed:false",
      "deliver",
      "browse:agent:7",
    ]);
    focus.dispose();
  });
});
