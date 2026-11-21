import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSkills } from "../../src/catalog/skills.js";
import {
  graphContent,
  type NodeDetails,
  resultContent,
} from "../../src/pi/messages.js";
import {
  buildProfilesPrompt,
  buildSystemPromptAppendix,
  guidance,
  profileCatalog,
} from "../../src/pi/prompt.js";
import { prepareArguments } from "../../src/pi/tools.js";
import { formatPairs } from "../../src/ui/tool-views.js";

describe("system prompt appendix", () => {
  test("lists guidance and usable profiles", async () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-agents-project-"),
    );
    fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".pi", "agents", "scout.md"),
      "---\nname: scout\ndescription: Finds code\nthinking: low\n---\nBe fast.\n",
    );
    const models = [
      { provider: "openai", id: "gpt", name: "GPT" },
    ] as unknown as Parameters<typeof profileCatalog>[2];
    fs.writeFileSync(
      path.join(project, ".pi", "agents", "broken.md"),
      "---\nname: broken\ndescription: Broken\nskills: [missing]\n---\n",
    );
    fs.writeFileSync(
      path.join(project, ".pi", "agents", "offline.md"),
      "---\nname: offline\ndescription: Offline\nmodel: nope/x\n---\n",
    );
    const { profiles, issues } = await profileCatalog(
      project,
      true,
      models,
      discoverSkills,
    );
    expect(profiles.map((profile) => profile.name)).toEqual(["scout"]);
    expect(issues).toEqual([
      "profile broken: unavailable skills: missing (unknown)",
      "profile offline: no available model matches nope/x",
    ]);
    const appendix = buildSystemPromptAppendix(profiles);
    expect(appendix).toBe(
      [guidance(), buildProfilesPrompt(profiles)].join("\n"),
    );
  });

  test("a single-shot run waits for the results it needs", () => {
    expect(guidance()).toContain("end your turn");
    expect(guidance()).not.toContain("This run ends with your answer");
    expect(buildSystemPromptAppendix([], true)).toContain(guidance(true));
    expect(guidance(true)).toContain(
      "call agent_wait for the results you need before you answer",
    );
    expect(guidance(true)).not.toContain("end your turn");
  });
});

describe("result messages", () => {
  test("answered and failed results read clearly", () => {
    const base = { version: 1 as const, agentId: "1", name: "reviewer" };
    expect(
      resultContent({ ...base, kind: "answered", body: "All good." }),
    ).toBe("Agent reviewer answered:\n\nAll good.");
    expect(
      resultContent({ ...base, kind: "failed", body: "rate limited" }),
    ).toBe("Agent reviewer failed: rate limited");
  });
});

describe("graph result messages", () => {
  const node = (
    name: string,
    kind: NodeDetails["kind"],
    body: string,
    end: boolean,
  ): NodeDetails => ({ agentId: name, name, kind, body, end, inputs: [] });

  test("one end agent reads as its answer; problems are named", () => {
    expect(
      graphContent({
        version: 1,
        graphId: "7",
        name: "review",
        policy: "allSettled",
        nodes: [
          node("api", "answered", "Two routes.", false),
          node("docs", "failed", "rate limited", false),
          node("merge", "answered", "One overview.", true),
        ],
      }),
    ).toBe(
      [
        "Graph review: merge answered:",
        "",
        "One overview.",
        "",
        "Other agents: docs failed: rate limited.",
      ].join("\n"),
    );
    expect(
      graphContent({
        version: 1,
        graphId: "7",
        name: "chain",
        policy: "allSettled",
        nodes: [
          node("first", "failed", "boom", false),
          node("second", "skipped", "", true),
        ],
      }),
    ).toBe(
      "Graph chain: second was skipped because none of its inputs answered.\n\nOther agents: first failed: boom.",
    );
  });

  test("several end agents read under their own headings", () => {
    expect(
      graphContent({
        version: 1,
        graphId: "7",
        name: "review",
        policy: "failFast",
        nodes: [
          node("api", "answered", "Two routes.", true),
          node("docs", "failed", "rate limited", true),
          node("tests", "stopped", "", true),
        ],
      }),
    ).toBe(
      [
        "Graph review finished: 1 answered, 1 failed, 1 stopped.",
        "",
        "## api (answered)",
        "Two routes.",
        "",
        "## docs (failed)",
        "Error: rate limited",
        "",
        "## tests (stopped)",
      ].join("\n"),
    );
  });
});

describe("tool calls", () => {
  test("explicit arguments render as key=value pairs", () => {
    expect(
      formatPairs({
        profile: "explorer",
        model: "anthropic/claude-haiku-4-5",
        tools: ["read", "grep"],
        cwd: "src dir",
        wait: undefined,
      }),
    ).toBe(
      'profile=explorer model=anthropic/claude-haiku-4-5 tools=[read,grep] cwd="src dir"',
    );
  });
});

describe("tool arguments", () => {
  test("timeouts that aren't positive numbers mean none", () => {
    expect(prepareArguments({ names: ["a"], timeout: false })).toEqual({
      names: ["a"],
    });
    expect(prepareArguments({ timeout: "120" })).toEqual({ timeout: 120 });
  });
});
