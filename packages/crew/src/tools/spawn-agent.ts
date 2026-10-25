import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CrewContext } from "../runtime/context.ts";
import { buildCatalogDescription } from "../prompts/catalog.ts";
import { catalogFor } from "../agents/definitions.ts";
import { automaticMode } from "../runtime/tree-lifecycle.ts";
import { assertSpawnPolicy, relationshipPolicy } from "../runtime/policy.ts";
import { spawnAgent } from "../transport/messaging.ts";
import { isTaskName } from "../transport/protocol.ts";
import { assertToolAccess } from "./access.ts";
import { ToolFailure, prepareArguments, toolError, validateArguments } from "./result.ts";
import { spawnAgentRenderers } from "./renderers/spawn-agent.ts";

const toolDefinition = {
  name: "spawn_agent",
  description: [
    "Start a subagent on a bounded, independent task, this call waits for launch, not task completion.",
    "The call returns after launch; the task outcome arrives separately and is not immediately available.",
  ].join(" "),
  promptSnippet: "Start a subagent on a bounded, independent task.",
  promptGuidelines: ["Use spawn_agent to delegate complex work to an autonomous agent."],
} as const;

const toolSchema = Type.Object(
  {
    task_name: Type.String({
      pattern: "\\S",
      description: "Lowercase name with underscores; Reuse it to target the agent later.",
    }),
    message: Type.String({
      pattern: "\\S",
      description: "Initial task instructions for the new agent.",
    }),
    agent_type: Type.String({
      pattern: "\\S",
      description: "Agent definition name from the eligible spawn catalog.",
    }),
  },
  { additionalProperties: false },
);

/** Registered creation schema; a successful result identifies a durably recorded child. */
export type SpawnAgentToolDefinition = ToolDefinition<typeof toolSchema, undefined>;

/** Submit creation without acquiring coordinator execution authority. */
export function createSpawnAgentTool(ctx: CrewContext) {
  return defineTool({
    name: toolDefinition.name,
    label: toolDefinition.name,
    description: toolDefinition.description,
    promptSnippet: toolDefinition.promptSnippet,
    promptGuidelines: [...toolDefinition.promptGuidelines],
    prepareLoadout: () => ({
      descriptions: {
        [toolDefinition.name]: [
          toolDefinition.description,
          ctx.state.role.kind !== "dormant" && relationshipPolicy(ctx).maySpawn
            ? buildCatalogDescription(catalogFor(ctx.definitions.values(), automaticMode(ctx)))
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    }),
    parameters: toolSchema,
    prepareArguments: (params) => prepareArguments(toolDefinition.name, toolSchema, params),
    defaultActive: false,
    renderCall: spawnAgentRenderers.renderCall,
    renderResult: spawnAgentRenderers.renderResult,

    async execute(_toolCallId, params, signal, _onUpdate, piCtx) {
      try {
        validateArguments(toolDefinition.name, toolSchema, params);
        assertToolAccess(ctx, toolDefinition.name);
        if (!isTaskName(params.task_name)) {
          throw new ToolFailure(
            "invalid_arguments",
            "spawn_agent failed: task_name must match [a-z][a-z0-9_-]{0,63} and must not be a full Pi session ID.",
          );
        }
        const definition = ctx.definitions.get(params.agent_type);
        if (!definition) {
          throw new ToolFailure(
            "unknown_agent_type",
            "spawn_agent failed: agent_type is absent from the loaded catalog.",
          );
        }
        if (definition.disableModelInvocation) {
          throw new ToolFailure(
            "permission_denied",
            "spawn_agent failed: the selected definition disables model invocation.",
          );
        }
        assertSpawnPolicy(ctx, definition);
        const result = await spawnAgent(
          ctx,
          piCtx,
          {
            agent: params.agent_type,
            prompt: params.message,
            task_name: params.task_name,
          },
          "tool",
          signal,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ agent_id: result.sessionId, task_name: result.taskName }),
            },
          ],
          details: undefined,
        };
      } catch (error) {
        return toolError(toolDefinition.name, error);
      }
    },
  });
}