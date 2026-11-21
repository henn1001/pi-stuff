import { beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { MessageInfo } from "../../src/agents/types.js";
import { plainStyle } from "../../src/ui/messages.js";
import {
  messageStream,
  openMessageStream,
  type StreamOptions,
  type StreamState,
  streamRow,
} from "../../src/ui/stream.js";

beforeAll(() => initTheme("dark"));

const alpha = { id: "1", name: "alpha" };
const beta = { id: "2", name: "beta" };
const gamma = { id: "3", name: "gamma" };
// Today, since rows show only the time of today's messages.
const today = new Date();
const at = new Date(
  today.getFullYear(),
  today.getMonth(),
  today.getDate(),
  12,
  48,
  30,
).getTime();

function message(
  id: string,
  from: typeof alpha,
  to: typeof alpha,
  text: string,
  offset: number,
): MessageInfo {
  return { id, from, to, text, sentAt: at + offset, status: "delivered" };
}

const messages = [
  message("1", alpha, gamma, "Offer two picnic activities", 0),
  message("2", beta, alpha, "Reserve the central lawn", 1_000),
  message("3", gamma, beta, "Serve wraps and fruit", 2_000),
];

describe("/messages", () => {
  test("a stream is newest first, filtered by text and names", () => {
    const ids = (query?: string) =>
      messageStream(messages, query).map((each) => each.id);
    expect(ids()).toEqual(["3", "2", "1"]);
    // Everything to or from an agent, by name, ignoring case.
    expect(ids("ALPHA")).toEqual(["2", "1"]);
    expect(ids("wraps")).toEqual(["3"]);
    expect(ids("beta → alpha")).toEqual(["2"]);
  });

  test("scopes by identity before applying the text filter", () => {
    const namesake = { id: "4", name: "alpha" };
    const withNamesake = [
      ...messages,
      message("4", namesake, beta, "alpha", 3_000),
    ];
    expect(
      messageStream(withNamesake, "alpha", "1").map((each) => each.id),
    ).toEqual(["2", "1"]);
    expect(
      messageStream(withNamesake, "alpha", "4").map((each) => each.id),
    ).toEqual(["4"]);
  });

  test("a message is one line, its text right after the names", () => {
    const long = message("4", alpha, beta, "one two three\nfour five", 0);
    const row = stripVTControlCharacters(streamRow(long, 30, plainStyle));
    expect(row).toBe("12:48:30 alpha → beta one two…");
  });

  test("fills the terminal and preserves scope, filter, selection and detail when switching views", async () => {
    const state: StreamState = {};
    let component: Component | undefined;
    let overlay: unknown;
    let switched = 0;
    let attached = "";
    const tui = { terminal: { rows: 24 }, requestRender() {} };
    const theme = {
      fg: (_name: string, value: string) => value,
      bold: (value: string) => value,
    };
    const ctx = {
      ui: {
        custom: (
          factory: (...args: never[]) => Component,
          options: unknown,
        ) => {
          overlay = options;
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
    const longMessages = messages.map((item) =>
      item.id === "2"
        ? {
            ...item,
            text: `Reserve the central lawn\n\n${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n")}`,
          }
        : item,
    );
    const options: StreamOptions = {
      messages: () => longMessages,
      state,
      scope: alpha,
      emptyText: "empty",
      attach: (id) => {
        attached = id;
      },
      next: {
        label: "/agents",
        open: () => {
          switched++;
        },
      },
      previous: {
        label: "/agents",
        open: () => {
          switched++;
        },
      },
      live: () => false,
    };
    let open = openMessageStream(ctx as never, options);
    expect(overlay).toEqual({
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
    });
    expect(component?.render(80)).toHaveLength(24);
    component?.handleInput?.("Reserve");
    component?.handleInput?.("\r");
    expect(component?.render(80).join("\n")).toContain(
      "Reserve the central lawn",
    );
    component?.handleInput?.("\u001b[1;2B");
    component?.render(80);
    component?.handleInput?.("\t");
    await open;
    expect(switched).toBe(1);
    expect(state).toMatchObject({
      scope: alpha,
      query: "Reserve",
      selected: "2",
      reading: true,
      detailOffset: 1,
    });

    tui.terminal.rows = 16;
    open = openMessageStream(ctx as never, { ...options, scope: undefined });
    expect(component?.render(80)).toHaveLength(16);
    const restored = component?.render(80).join("\n") ?? "";
    expect(restored).toContain("filter: Reserve");
    expect(restored).toContain("1 earlier lines");
    component?.handleInput?.("\u001b[C");
    await open;
    expect(attached).toBe("1");
    expect(state.reading).toBe(true);
    expect(state.selected).toBe("2");

    open = openMessageStream(ctx as never, { ...options, scope: undefined });
    component?.render(80);
    component?.handleInput?.("\u0018"); // Ctrl+X removes the scope, not the query.
    expect(component?.render(80).join("\n")).not.toContain("agent: alpha");
    component?.handleInput?.("\u001b"); // close detail
    component?.handleInput?.("\u001b"); // clear query
    component?.handleInput?.("\u001b"); // return to main agent
    await open;
    expect(state.scope).toBeUndefined();
    expect(state.query).toBe("");

    open = openMessageStream(ctx as never, {
      ...options,
      scope: { id: "missing", name: "unknown" },
    });
    const empty = component?.render(80) ?? [];
    expect(empty).toHaveLength(16);
    expect(empty.join("\n")).toContain("No messages involving unknown");
    component?.handleInput?.("\u0018");
    expect(component?.render(80).join("\n")).toContain("Serve wraps");
    component?.handleInput?.("\u001b");
    await open;
  });
});
