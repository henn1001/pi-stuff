import { beforeAll, describe, expect, test } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type AgentInfo, EMPTY_USAGE } from "../../src/agents/types.js";
import { registerCommands } from "../../src/pi/commands.js";
import {
  type OverlaySpec,
  type OverlayState,
  openOverlay,
} from "../../src/ui/overlay.js";
import { Disclosure } from "../../src/ui/rows.js";
import { createWorkspace } from "../../src/ui/workspace.js";

beforeAll(() => initTheme("dark"));

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    id: "1",
    name: "a",
    job: "review a",
    cwd: "/repo",
    model: { provider: "openai", modelId: "sol" },
    state: "idle",
    closed: false,
    createdAt: 0,
    stateSince: 0,
    lastActivityAt: 0,
    usage: { ...EMPTY_USAGE, input: 2_000 },
    activity: {},
    ...overrides,
  };
}

describe("command routing", () => {
  test.each(["command", "shortcut"])(
    "%s confirms activation without opening the overview",
    async (entry) => {
      let command!: (args: string, ctx: never) => Promise<void>;
      let shortcut!: (ctx: never) => Promise<void>;
      let enabled = false;
      let confirmed = false;
      let activations = 0;
      let opened = 0;
      let prompts = 0;
      const ctx = {
        mode: "tui",
        ui: {
          confirm: async () => {
            prompts++;
            return confirmed;
          },
          notify: () => {},
        },
      } as never;
      registerCommands(
        {
          registerCommand: (
            _name: string,
            spec: { handler: typeof command },
          ) => {
            command = spec.handler;
          },
          registerShortcut: (
            key: string,
            spec: { handler: typeof shortcut },
          ) => {
            expect(key).toBe("ctrl+q");
            shortcut = spec.handler;
          },
        } as never,
        {
          activation: {
            isEnabled: () => enabled,
            enable: async () => {
              enabled = true;
              activations++;
            },
          },
          focus: {
            focusPanel: () => {
              opened++;
            },
          },
        } as never,
      );
      const invoke = () =>
        entry === "command" ? command("", ctx) : shortcut(ctx);
      await invoke();
      expect(enabled).toBe(false);
      expect(opened).toBe(0);
      confirmed = true;
      await invoke();
      expect(enabled).toBe(true);
      expect(activations).toBe(1);
      expect(opened).toBe(0);
      await invoke();
      expect(opened).toBe(1);
      expect(prompts).toBe(2);
    },
  );

  test("one namespace, explicit activation, and guarded subcommands", async () => {
    const commands = new Map<
      string,
      {
        handler: (args: string, ctx: never) => Promise<void>;
        getArgumentCompletions: (prefix: string) => unknown;
      }
    >();
    let enabled = false;
    let activations = 0;
    let overviews = 0;
    let confirmations = 0;
    let attached = "";
    const notices: string[] = [];
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        notify: (message: string) => notices.push(message),
        confirm: async () => {
          confirmations++;
          return false;
        },
      },
    } as never;
    registerCommands(
      {
        registerCommand: (name: string, command: never) =>
          commands.set(name, command),
        registerShortcut: () => {},
      } as never,
      {
        host: { current: () => ({ get: (name: string) => ({ id: name }) }) },
        workspace: {},
        focus: {
          focusPanel: () => {
            overviews++;
          },
          attach: (_ctx: unknown, id: string) => {
            attached = id;
          },
        },
        activation: {
          isEnabled: () => enabled,
          enable: async () => {
            enabled = true;
            activations++;
          },
        },
      } as never,
    );
    expect([...commands.keys()]).toEqual(["agents"]);
    const command = commands.get("agents");
    if (!command) throw new Error("Missing /agents");
    expect(command.getArgumentCompletions("")).toEqual([
      { value: "enable", label: "enable" },
      { value: "attach", label: "attach" },
      { value: "messages", label: "messages" },
    ]);
    await command.handler("attach alice", ctx);
    await command.handler("messages", ctx);
    expect(attached).toBe("");
    expect(notices).toEqual([
      "Enable pi-agents first with /agents enable.",
      "Enable pi-agents first with /agents enable.",
    ]);
    await command.handler("", ctx);
    expect(overviews).toBe(0);
    expect(confirmations).toBe(1);
    expect(activations).toBe(0);
    await command.handler("enable", ctx);
    await command.handler("enable", ctx);
    expect(activations).toBe(1);
    expect(notices.at(-1)).toBe("pi-agents is already enabled.");
    await command.handler("", ctx);
    expect(overviews).toBe(1);
    await command.handler("attach alice", ctx);
    expect(attached).toBe("alice");
    await command.handler("disable", ctx);
    expect(enabled).toBe(true);
    expect(notices.at(-1)).toContain("Usage:");
  });
});

describe("full-screen overview", () => {
  test("switching views and attaching from messages retains the agent scope and selection", async () => {
    const alice = agent({ id: "1", name: "alice" });
    const bob = agent({ id: "2", name: "bob" });
    const service = {
      list: () => [alice, bob],
      graphs: () => [],
      agentById: (id: string) => [alice, bob].find((item) => item.id === id),
      messages: () => [
        {
          id: "m",
          from: { id: "2", name: "bob" },
          to: { id: "1", name: "alice" },
          text: "hello",
          sentAt: Date.now(),
          status: "delivered",
        },
      ],
    };
    const host = { ensure: async () => service, current: () => service };
    const panel = { disclosure: new Disclosure(), setSuppressed: () => {} };
    let attached = "";
    const focus: {
      onBrowse?: (ctx: unknown, select?: string) => void;
      attach: (_ctx: unknown, id: string) => void;
    } = {
      attach: (_ctx, id) => {
        attached = id;
      },
    };
    const workspace = createWorkspace({ host, panel, focus } as never);
    let component: Component | undefined;
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    const theme = {
      fg: (_name: string, value: string) => value,
      bold: (value: string) => value,
    };
    let session = "session";
    const ctx = {
      sessionManager: { getSessionId: () => session },
      ui: {
        custom: (factory: (...args: never[]) => Component) =>
          new Promise<void>((resolve) => {
            component = factory(
              tui as never,
              theme as never,
              undefined as never,
              resolve as never,
            );
          }),
      },
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    focus.onBrowse?.(ctx, "agent:1");
    await tick();
    expect(component?.render(80).join("\n")).toContain("▸ ● alice");
    component?.handleInput?.("m");
    await tick();
    expect(component?.render(80).join("\n")).toContain("agent: alice");
    component?.handleInput?.("hello");
    component?.render(80);
    component?.handleInput?.("\u001b[C");
    await tick();
    expect(attached).toBe("1");
    focus.onBrowse?.(ctx, "agent:1");
    await tick();
    component?.render(80);
    component?.handleInput?.("\t");
    await tick();
    const lines = component?.render(80).join("\n") ?? "";
    expect(lines).toContain("agent: alice");
    expect(lines).toContain("filter: hello");
    expect(lines).toContain("▸");
    component?.handleInput?.("\t"); // Retain the query and scope when leaving Messages.
    await tick();
    component?.render(80);
    component?.handleInput?.("\u001b[B");
    expect(component?.render(80).join("\n")).toContain("▸ ● bob");
    component?.handleInput?.("\u001b");
    await tick();

    // A different session must not inherit selection, text query, or agent scope.
    session = "next-session";
    let open = workspace.openMessages(ctx as never);
    await tick();
    const reset = component?.render(80).join("\n") ?? "";
    expect(reset).not.toContain("agent: alice");
    expect(reset).not.toContain("filter: hello");
    component?.handleInput?.("\u001b");
    await open;
    open = workspace.openAgents(ctx as never);
    await tick();
    expect(component?.render(80).join("\n")).toContain("▸ ● alice");
    component?.handleInput?.("\u001b");
    await open;
  });

  test("fills the terminal and restores the selected row and detail scroll", async () => {
    const state: OverlayState = {};
    let items = ["a", "b", "c"];
    const spec: OverlaySpec<string> = {
      title: "Agents",
      fullscreen: true,
      state,
      emptyText: "empty",
      footer: () => ["esc back"],
      items: () => items,
      keyOf: (item) => item,
      row: (item) => item,
      detail: (item) => Array.from({ length: 30 }, (_, i) => `${item} ${i}`),
      onNavigate: () => undefined,
      onAction: () => undefined,
    };
    let component: Component | undefined;
    let options: unknown;
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    const theme = {
      fg: (_name: string, value: string) => value,
      bold: (value: string) => value,
    };
    const ctx = {
      ui: {
        custom: (factory: (...args: never[]) => Component, opts: unknown) => {
          options = opts;
          return new Promise<void>((resolve) => {
            component = factory(
              tui as never,
              theme as never,
              undefined as never,
              resolve as never,
            );
          });
        },
      },
    };
    let open = openOverlay(ctx as never, spec);
    expect(options).toEqual({
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
    });
    expect(component?.render(80)).toHaveLength(24);
    component?.handleInput?.("\u001b[B");
    component?.render(80);
    component?.handleInput?.("\u001b[1;2B");
    expect(component?.render(80).join("\n")).toContain("b 1");
    component?.handleInput?.("\u001b");
    await open;
    expect(state.selectedKey).toBe("b");
    expect(state.detailOffset).toBe(1);
    tui.terminal.rows = 16;
    open = openOverlay(ctx as never, spec);
    const lines = component?.render(80) ?? [];
    expect(lines).toHaveLength(16);
    expect(lines.join("\n")).toContain("b 1");
    component?.handleInput?.("\u001b");
    await open;
    items = ["a", "c"];
    open = openOverlay(ctx as never, spec);
    expect(component?.render(80).join("\n")).toContain("▸ c");
    component?.handleInput?.("\u001b");
    await open;
  });
});
