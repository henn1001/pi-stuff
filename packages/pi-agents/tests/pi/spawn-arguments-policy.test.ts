import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { MessagingHub } from "../../src/agents/hub.js";
import { SPAWNING_LIMITS } from "../../src/agents/spawn-support.js";
import { spawningTools } from "../../src/agents/spawning.js";
import { SkillCatalog } from "../../src/catalog/skills.js";
import type { SessionHost } from "../../src/pi/session.js";
import { registerAgentTools } from "../../src/pi/tools.js";

const noSkills = new SkillCatalog(async () => []);

type SpawnTool = Pick<
  ToolDefinition,
  "name" | "parameters" | "prepareArguments"
>;

function tools(): Map<string, SpawnTool> {
  const registered = new Map<string, SpawnTool>();
  const pi = {
    registerTool: (tool: SpawnTool) => registered.set(tool.name, tool),
    getThinkingLevel: () => undefined,
    getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  const host = {
    skills: noSkills,
  } as unknown as SessionHost;
  registerAgentTools(pi, host);
  return registered;
}

describe("Spawn argument policy", () => {
  test("agent_spawn omits null and blank optional strings", () => {
    const tool = tools().get("agent_spawn");
    if (!tool) throw new Error("agent_spawn is not registered");
    for (const empty of [null, "", " \t\n"]) {
      const prepared = tool.prepareArguments?.({
        name: empty,
        agents: [
          {
            job: "review",
            name: empty,
            profile: empty,
            cwd: empty,
          },
        ],
      });
      expect(prepared).toEqual({
        agents: [{ job: "review" }],
      });
      expect(Value.Check(tool.parameters, prepared)).toBe(true);
    }
    const invalid = tool.prepareArguments?.({ agents: [{ job: null }] });
    expect(Value.Check(tool.parameters, invalid)).toBe(false);
  });

  test("agent_spawn reserves configuration fields for profiles", () => {
    const tool = tools().get("agent_spawn");
    if (!tool) throw new Error("agent_spawn is not registered");
    for (const field of ["model", "thinking", "tools", "skills", "spawn"]) {
      expect(tool.parameters).not.toHaveProperty(
        `properties.agents.items.properties.${field}`,
      );
      expect(() =>
        tool.prepareArguments?.({
          agents: [{ job: "review" }],
          [field]: "override",
        }),
      ).toThrow(`Move ${field} into an entry of agents`);
      expect(() =>
        tool.prepareArguments?.({
          agents: [{ job: "review", [field]: "override" }],
        }),
      ).toThrow("in an agent profile");
    }
  });
  test("child agent_spawn rejects configuration overrides at both argument levels", () => {
    const spawn = spawningTools({
      resolve: async () => {
        throw new Error("Unexpected resolution");
      },
      selection: () => {
        throw new Error("Unexpected tool selection");
      },
      limits: SPAWNING_LIMITS,
      hub: new MessagingHub(),
    }).find((tool) => tool.name === "agent_spawn");
    const prepare = spawn?.prepareArguments;
    if (!prepare)
      throw new Error("Child agent_spawn has no argument preparation");
    for (const [field, value] of Object.entries({
      model: "override",
      thinking: "high",
      tools: ["read"],
      skills: [],
      spawn: true,
    })) {
      expect(() =>
        prepare({ agents: [{ job: "look" }], [field]: value }),
      ).toThrow(`Move ${field} into an entry of agents`);
      expect(() =>
        prepare({ agents: [{ job: "look", [field]: value }] }),
      ).toThrow("in an agent profile");
    }
  });
});
