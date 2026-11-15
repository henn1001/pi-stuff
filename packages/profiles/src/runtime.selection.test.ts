import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectProfile } from "./runtime";

async function withProject(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "profiles-selection-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function makePi(flag: string | undefined, settings: unknown): ExtensionAPI {
  return {
    getFlag: () => flag,
    getSettings: () => settings,
  } as unknown as ExtensionAPI;
}

function makeContext(cwd: string): { ctx: ExtensionContext; warnings: string[] } {
  const warnings: string[] = [];
  const ctx = {
    cwd,
    ui: { notify: (message: string) => warnings.push(message) },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  return { ctx, warnings };
}

describe("profile selection", () => {
  test("uses profiles.default on startup when --profile is absent", async () => {
    await withProject(async (cwd) => {
      const name = `default-${randomUUID()}`;
      const { ctx, warnings } = makeContext(cwd);
      const selection = selectProfile(
        makePi(undefined, { profiles: { default: name } }),
        "startup",
        ctx,
      );

      expect(selection).toBeUndefined();
      expect(warnings.some((warning) => warning.includes(`Unknown profile "${name}"`))).toBe(true);
    });
  });

  test("uses profiles.default for /new, while --profile overrides it", async () => {
    await withProject(async (cwd) => {
      const configured = `default-${randomUUID()}`;
      const requested = `cli-${randomUUID()}`;
      const { ctx, warnings } = makeContext(cwd);
      const selection = selectProfile(
        makePi(requested, { profiles: { default: configured } }),
        "new",
        ctx,
      );

      expect(selection).toBeUndefined();
      expect(warnings.some((warning) => warning.includes(`Unknown profile "${requested}"`))).toBe(
        true,
      );
      expect(warnings.some((warning) => warning.includes(configured))).toBe(false);
    });
  });

  test("does not select a configured default on resume or reload", async () => {
    await withProject(async (cwd) => {
      const { ctx, warnings } = makeContext(cwd);
      const pi = makePi(undefined, { profiles: { default: "review" } });

      expect(selectProfile(pi, "resume", ctx)).toBeUndefined();
      expect(selectProfile(pi, "reload", ctx)).toBeUndefined();
      expect(warnings).toEqual([]);
    });
  });

  test("warns and ignores a malformed default setting", async () => {
    await withProject(async (cwd) => {
      const { ctx, warnings } = makeContext(cwd);
      const selection = selectProfile(
        makePi(undefined, { profiles: { default: 42 } }),
        "startup",
        ctx,
      );

      expect(selection).toBeUndefined();
      expect(warnings).toContain(
        'Invalid setting "profiles.default": expected a nonempty profile name; ignoring it.',
      );
    });
  });
});