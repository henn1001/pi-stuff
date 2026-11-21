import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverSkills } from "../../src/catalog/skills.js";
import { resolveHelper, resolveSpawn } from "../../src/pi/spawn.js";

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-spawn-"));
  fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi", "skills", "lint"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".pi", "skills", "lint", "SKILL.md"),
    "---\nname: lint\ndescription: Lint code\n---\nRun the linter.\n",
  );
  fs.writeFileSync(
    path.join(dir, ".pi", "agents", "checker.md"),
    "---\nname: checker\ndescription: Checks\nmodel: openai/mini\nthinking: low\ntools: [read]\nskills: [lint]\n---\nCheck things.\n",
  );
  fs.writeFileSync(
    path.join(dir, ".pi", "agents", "spawner.md"),
    "---\nname: spawner\ndescription: Delegates work\nspawn: true\n---\n",
  );
  return dir;
}

function context(cwd: string): ExtensionContext {
  const models = [
    {
      provider: "openai",
      id: "mini",
      cost: { input: 1, output: 1 },
      contextWindow: 1,
    },
    {
      provider: "openai",
      id: "big",
      cost: { input: 1, output: 1 },
      contextWindow: 1,
    },
  ];
  return {
    cwd,
    model: { provider: "openai", id: "big" },
    modelRegistry: { getAvailable: () => models, isUsingOAuth: () => false },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

describe("Profile spawn policy", () => {
  test("null and blank optional strings use inherited or profile defaults", async () => {
    const cwd = project();
    const sources = { skills: discoverSkills, thinking: "high" };
    for (const empty of [null, "", " \t\n"]) {
      const request = {
        job: "x",
        name: empty,
        profile: empty,
        cwd: empty,
      };
      expect(await resolveSpawn(request, context(cwd), sources)).toEqual(
        await resolveSpawn({ job: "x" }, context(cwd), sources),
      );
      expect(
        await resolveSpawn(
          { ...request, profile: "checker" },
          context(cwd),
          sources,
        ),
      ).toEqual(
        await resolveSpawn(
          { job: "x", profile: "checker" },
          context(cwd),
          sources,
        ),
      );
    }
  });

  test("only a profile grants permission to spawn", async () => {
    const cwd = project();
    for (const [profile, expected] of [
      [undefined, undefined],
      ["checker", undefined],
      ["spawner", true],
    ] as const) {
      const request = { job: "x", profile };
      const spec = await resolveSpawn(request, context(cwd), {
        skills: discoverSkills,
      });
      expect(spec.spawn).toBe(expected);
      const helper = await resolveHelper(
        request,
        context(cwd),
        { cwd },
        discoverSkills,
      );
      expect(helper.spawn).toBe(expected);
    }
  });
});
