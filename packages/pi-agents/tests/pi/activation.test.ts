import { describe, expect, test } from "bun:test";
import {
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createActivation } from "../../src/pi/activation.js";

describe("session activation", () => {
  test("concurrent activation starts once and persists only after startup", async () => {
    const sessionManager = SessionManager.inMemory();
    const ctx = { sessionManager } as unknown as ExtensionContext;
    let started = 0;
    let registered = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activation = createActivation(
      {
        appendEntry: (type, data) => {
          sessionManager.appendCustomEntry(type, data);
        },
      },
      async () => {
        started++;
        await ready;
      },
      () => {
        registered++;
      },
    );
    expect(activation.isEnabled()).toBe(false);
    await activation.restore(ctx);
    expect(started).toBe(0);
    const first = activation.enable(ctx);
    const second = activation.enable(ctx);
    expect(first).toBe(second);
    expect(started).toBe(1);
    expect(registered).toBe(0);
    expect(sessionManager.getEntries()).toHaveLength(0);
    release();
    await Promise.all([first, second]);
    await activation.enable(ctx);
    expect(activation.isEnabled()).toBe(true);
    expect(started).toBe(1);
    expect(registered).toBe(1);
    expect(sessionManager.getEntries()).toMatchObject([
      { type: "custom", customType: "pi-agents-enabled" },
    ]);
  });

  test("a fresh instance restores a resumed session without another marker", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendCustomEntry("pi-agents-enabled", {});
    let started = 0;
    let registered = 0;
    let persisted = 0;
    const activation = createActivation(
      {
        appendEntry: () => {
          persisted++;
        },
      },
      async () => {
        started++;
      },
      () => {
        registered++;
      },
    );
    expect(activation.isEnabled()).toBe(false);
    const ctx = { sessionManager } as unknown as ExtensionContext;
    await activation.restore(ctx);
    await activation.restore(ctx);
    expect(activation.isEnabled()).toBe(true);
    expect(started).toBe(1);
    expect(registered).toBe(1);
    expect(persisted).toBe(0);

    const next = createActivation(
      {
        appendEntry: () => {
          persisted++;
        },
      },
      async () => {
        started++;
      },
      () => {
        registered++;
      },
    );
    await next.restore({
      sessionManager: SessionManager.inMemory(),
    } as unknown as ExtensionContext);
    expect(next.isEnabled()).toBe(false);
    expect(started).toBe(1);
  });
});
