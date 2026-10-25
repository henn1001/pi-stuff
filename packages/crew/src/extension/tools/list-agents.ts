import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CrewContext } from "../context.ts";
import { agentListing } from "../../store/queries/agents.ts";
import { assertToolAccess } from "../tool-activation.ts";
import { prepareArguments, toolError, validateArguments } from "./result.ts";
import { listAgentsRenderers } from "./renderers/list-agents.ts";

const toolDefinition = {
  name: "list_agents",
  description: [
    "List your parent agent, direct children, and launch requests, including connectivity, process, assignment, and resumability state.",
    "Reuse known agent IDs or task names instead of calling list_agents again.",
  ].join(" "),
  promptSnippet: "List your parent agent, direct children, and launch requests.",
  promptGuidelines: [
    "Use list_agents to discover agent IDs and inspect availability, resumability, and launch outcomes.",
  ],
} as const;

const toolSchema = Type.Object({}, { additionalProperties: false });

/** Registered read-only listing schema; results contain only the public neighborhood projection. */
export type ListAgentsToolDefinition = ToolDefinition<typeof toolSchema, undefined>;

/** Read durable neighbors and launch summaries without initiating observation or coordination. */
export function createListAgentsTool(ctx: CrewContext) {
  return defineTool({
    name: toolDefinition.name,
    label: toolDefinition.name,
    description: toolDefinition.description,
    promptSnippet: toolDefinition.promptSnippet,
    promptGuidelines: [...toolDefinition.promptGuidelines],
    parameters: toolSchema,
    prepareArguments: (params) => prepareArguments(toolDefinition.name, toolSchema, params),
    defaultActive: false,
    renderCall: listAgentsRenderers.renderCall,
    renderResult: listAgentsRenderers.renderResult,

    async execute(_toolCallId, params, signal) {
      try {
        validateArguments(toolDefinition.name, toolSchema, params);
        assertToolAccess(ctx, toolDefinition.name);
        signal?.throwIfAborted();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(agentListing(ctx)) }],
          details: undefined,
        };
      } catch (error) {
        return toolError(toolDefinition.name, error);
      }
    },
  });
}