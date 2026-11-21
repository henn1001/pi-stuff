import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverSkills } from "../../src/catalog/skills.js";
import {
  inheritedTools,
  resolveHelper,
  resolveSpawn,
} from "../../src/pi/spawn.js";

function skill(dir: string, name: string, frontmatter = ""): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: The ${name} skill\n${frontmatter}---\nApply ${name}.\n`,
  );
}

// User skills live in ~/.agents/skills, which tests/setup.ts points at a
// temporary home. `review` is for the user only, like a /skill: command.
const userSkills = path.join(process.env.HOME as string, ".agents", "skills");
skill(userSkills, "style");
skill(userSkills, "review", "disable-model-invocation: true\n");

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
  fs.writeFileSync(
    path.join(dir, ".pi", "agents", "broken.md"),
    "---\nname: broken\ndescription: Broken\nskills: [missing]\n---\n",
  );
  fs.writeFileSync(
    path.join(dir, ".pi", "agents", "reviewer.md"),
    "---\nname: reviewer\ndescription: Reviews\nskills: [review]\n---\nReview.\n",
  );
  return dir;
}

function context(cwd: string, trusted = true): ExtensionContext {
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
    isProjectTrusted: () => trusted,
  } as unknown as ExtensionContext;
}

describe("resolveSpawn", () => {
  test("ad-hoc agents inherit the parent model, thinking level, and tools", async () => {
    const cwd = project();
    // The parent's tools that agents can run, in Pi's order.
    const tools = inheritedTools([
      "codemode",
      "agent_spawn",
      "read",
      "web_search",
      "bash",
    ]);
    expect(tools).toEqual(["read", "bash", "codemode"]);
    expect(
      await resolveSpawn({ job: "x" }, context(cwd), {
        skills: discoverSkills,
        thinking: "high",
        ...(tools ? { tools } : {}),
      }),
    ).toEqual({
      job: "x",
      cwd,
      ambientSkills: true,
      model: { provider: "openai", modelId: "big" },
      thinking: "high",
      tools: ["read", "bash", "codemode"],
    });
    // Profiles name their own; a parent without agent tools leaves Pi's
    // default.
    const spec = await resolveSpawn(
      { job: "x", profile: "checker" },
      context(cwd),
      { skills: discoverSkills, tools: ["read", "bash"] },
    );
    expect(spec.tools).toEqual(["read"]);
    expect(inheritedTools(["web_search"])).toBeUndefined();
  });

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

  test("profiles supply settings, instructions, and skills", async () => {
    const cwd = project();
    const spec = await resolveSpawn(
      { job: "x", profile: "checker" },
      context(cwd),
      { skills: discoverSkills, thinking: "high" },
    );
    expect(spec.model).toEqual({ provider: "openai", modelId: "mini" });
    expect(spec.thinking).toBe("low");
    expect(spec.tools).toEqual(["read"]);
    expect(spec.ambientSkills).toBe(false);
    expect(spec.instructions).toContain("Check things.");
    expect(spec.instructions).toContain("Run the linter.");
  });

  test("reports unknown profiles, profile skills, and directories", async () => {
    const cwd = project();
    for (const [request, error] of [
      [{ job: "x", profile: "nope" }, 'Unknown profile "nope"'],
      [{ job: "x", profile: "broken" }, "missing (unknown)"],
      [{ job: "x", cwd: "missing" }, "Working directory not found"],
    ] as const)
      await expect(
        resolveSpawn(request, context(cwd), { skills: discoverSkills }),
      ).rejects.toThrow(error);
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

  test("profiles can name skills restricted to user invocation", async () => {
    const cwd = project();
    const spec = await resolveSpawn(
      { job: "x", profile: "reviewer" },
      context(cwd),
      { skills: discoverSkills },
    );
    expect(spec.instructions).toContain("Apply review.");
  });

  test("helpers inherit their spawner's settings unless a profile overrides them", async () => {
    const cwd = project();
    const defaults = {
      cwd,
      model: { provider: "openai", modelId: "big" },
      thinking: "high" as const,
    };
    const inherited = await resolveHelper(
      { job: "x" },
      context(cwd),
      defaults,
      discoverSkills,
    );
    expect(inherited.model).toEqual(defaults.model);
    expect(inherited.thinking).toBe("high");
    const profiled = await resolveHelper(
      { job: "x", profile: "checker" },
      context(cwd),
      defaults,
      discoverSkills,
    );
    expect(profiled.model).toEqual({ provider: "openai", modelId: "mini" });
    expect(profiled.thinking).toBe("low");
    expect(profiled.instructions).toContain("Run the linter.");
  });
});
