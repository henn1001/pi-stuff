import { AgentError } from "./types.js";

/** Omit only optional strings; preserve invalid values for schema validation. */
function omitBlankStrings(value: unknown, fields: readonly string[]): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, entry]) =>
        !fields.includes(key) ||
        (entry !== null && !(typeof entry === "string" && entry.trim() === "")),
    ),
  );
}

/** Normalize a single spawn request without changing required or unknown fields. */
export function normalizeSpawnRequest<T>(request: T): T {
  return omitBlankStrings(request, ["name", "profile", "cwd"]) as T;
}

/** How `agent_spawn` takes its agents, in full for its error; the
 * schema shows it more briefly. */
const SPAWN_SHAPE =
  'Arguments are always an agents array, also for a single agent: {"agents": [{"name": "lead", "job": "..."}]}. Each agent\'s fields, such as job, name, profile, and after, go in its own entry; only the group\'s name and failFast sit beside agents.';

/** The arguments of `agent_spawn` beside `agents`. */
const GROUP_FIELDS = new Set(["name", "agents", "failFast"]);

/** Reject `agent_spawn` arguments that put an agent's fields beside
 * `agents`, with how to write them instead. Validation reports what else
 * is wrong. Treat null and blank optional strings as omitted. */
export function prepareSpawnArguments(args: unknown): unknown {
  if (typeof args !== "object" || args === null) return args;
  const misplaced = Object.keys(args).filter((key) => !GROUP_FIELDS.has(key));
  if (misplaced.length > 0)
    throw new AgentError(
      `Move ${misplaced.join(", ")} into an entry of agents. ${SPAWN_SHAPE}`,
    );
  const group = args as Record<string, unknown>;
  if (Array.isArray(group.agents))
    for (const agent of group.agents) {
      if (typeof agent !== "object" || agent === null) continue;
      const configuration = [
        "model",
        "thinking",
        "tools",
        "skills",
        "spawn",
      ].filter((key) => key in agent);
      if (configuration.length > 0)
        throw new AgentError(
          `Configure ${configuration.join(", ")} in an agent profile, not in agent_spawn. Select it with profile, or omit profile to inherit the parent configuration.`,
        );
    }
  return omitBlankStrings(
    {
      ...group,
      ...(Array.isArray(group.agents)
        ? {
            agents: group.agents.map((agent) => normalizeSpawnRequest(agent)),
          }
        : {}),
    },
    ["name"],
  );
}
