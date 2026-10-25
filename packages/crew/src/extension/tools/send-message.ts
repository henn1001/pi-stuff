import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CrewContext } from "../context.ts";
import { assertToolAccess } from "../tool-activation.ts";
import { ToolFailure, prepareArguments, toolError, validateArguments } from "./result.ts";
import { isAgentId, isTaskName } from "../../domain/ids.ts";
import { sendMessageRenderers } from "./renderers/send-message.ts";

const toolDefinition = {
  name: "send_message",
  description: [
    "Prompt a direct child or send your parent agent a message.",
    "Downward messages supplement outstanding work or start a new task assignment when none is outstanding",
    "Upward messages request help or forward information without completing the task assignment.",
  ].join(" "),
  promptSnippet: "Prompt a direct child or send your parent agent a message.",
  promptGuidelines: [
    "Use send_message to prompt a child with new or follow-up instructions or provide progress updates, or clarification to your parent agent.",
    "Do not use send_message for task assignment completion.",
  ],
} as const;

const toolSchema = Type.Object(
  {
    target: Type.String({
      pattern: "\\S",
      description:
        "The parent agent full agent ID, or a direct child's full agent ID or task name.",
    }),
    message: Type.String({
      pattern: "\\S",
      description: "Message to send.",
    }),
  },
  { additionalProperties: false },
);

/** Registered message schema; acceptance is not delivery or assignment settlement. */
export type SendMessageToolDefinition = ToolDefinition<typeof toolSchema, undefined>;

/** Persist explicit input; only the lead coordinator may deliver or resume the recipient. */
export function createSendMessageTool(ctx: CrewContext) {
  return defineTool({
    name: toolDefinition.name,
    label: toolDefinition.name,
    description: toolDefinition.description,
    promptSnippet: toolDefinition.promptSnippet,
    promptGuidelines: [...toolDefinition.promptGuidelines],
    parameters: toolSchema,
    prepareArguments: (params) => prepareArguments(toolDefinition.name, toolSchema, params),
    defaultActive: false,
    renderCall: sendMessageRenderers.renderCall,
    renderResult: sendMessageRenderers.renderResult,

    async execute(_toolCallId, params, signal, _onUpdate) {
      try {
        ctx.refreshSupervision?.();
        validateArguments(toolDefinition.name, toolSchema, params);
        assertToolAccess(ctx, toolDefinition.name);
        if (!isTaskName(params.target) && !isAgentId(params.target)) {
          throw new ToolFailure(
            "invalid_arguments",
            "send_message failed: arguments must match the documented schema and contain non-whitespace text.",
          );
        }
        const accepted = await ctx.execution!.prompt(params.target, params.message, signal);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(accepted) }],
          details: undefined,
        };
      } catch (error) {
        return toolError(toolDefinition.name, error);
      }
    },
  });
}