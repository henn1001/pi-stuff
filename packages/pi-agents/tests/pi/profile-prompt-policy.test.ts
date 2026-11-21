import { describe, expect, test } from "bun:test";
import { buildSystemPromptAppendix } from "../../src/pi/prompt.js";

describe("Profile prompt policy", () => {
  test("omits the model catalog and tells agents what to do without profiles", () => {
    const empty = buildSystemPromptAppendix([]);
    expect(empty).toContain(
      "If no profiles are available, omit the profile in agent_spawn calls.",
    );
    expect(empty).toContain("<agent_profiles>\n</agent_profiles>");
    expect(empty).toContain("never invent a profile name");
    expect(empty).not.toContain("<agent_models");
  });

  test("profiles expose only names and descriptions", () => {
    const appendix = buildSystemPromptAppendix([
      {
        name: "reviewer",
        description: "Reviews diffs",
        skills: ["code-review", "unslop"],
        model: "openai/private-model",
        thinking: "high",
        tools: ["read"],
        instructions: "",
        source: "user",
        filePath: "/reviewer.md",
      },
    ]);
    expect(appendix).toContain(
      '<profile name="reviewer">Reviews diffs</profile>',
    );
    expect(appendix).not.toContain("private-model");
    expect(appendix).not.toContain("skills=");
    expect(appendix).not.toContain("thinking=");
    expect(appendix).not.toContain("tools=");
  });
});
