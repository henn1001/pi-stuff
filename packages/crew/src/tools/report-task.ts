import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CrewContext } from "../runtime/context.ts";
import { assertToolAccess } from "./access.ts";
import { automaticMode } from "../runtime/tree-lifecycle.ts";
import { ToolFailure, prepareArguments, toolError, validateArguments } from "./result.ts";
import { reportTaskRenderers } from "./renderers/report-task.ts";

const toolDefinition = {
  name: "report_task",
  description: [
    "Submit a task assignment result, question, or blocked outcome to your parent agent.",
    "Do not use use report_task for progress or clarification that should leave the task assignment outstanding.",
    "Do not use report_task when you are an non-interactive agent.",
  ].join(" "),
  promptSnippet:
    "Submit a task assignment result, question, or blocked outcome to your parent agent.",
  promptGuidelines: [
    "Use report_task for a result, question, or blocked outcome that should complete the current task assignment.",
    "Non-interactive agents report automatically; do not call report_task.",
  ],
} as const;

const toolSchema = Type.Object(
  {
    message: Type.String({
      pattern: "\\S",
      description: "Result, question, or blocked outcome for the outstanding task assignment.",
    }),
  },
  { additionalProperties: false },
);

/** Registered report schema; successful submission does not authorize closure. */
export type ReportTaskToolDefinition = ToolDefinition<typeof toolSchema, undefined>;

/** Submit interactive outcomes through the coordinator's assignment-bound settlement path. */
export function createReportTaskTool(ctx: CrewContext) {
  return defineTool({
    name: toolDefinition.name,
    label: toolDefinition.name,
    description: toolDefinition.description,
    promptSnippet: toolDefinition.promptSnippet,
    promptGuidelines: [...toolDefinition.promptGuidelines],
    parameters: toolSchema,
    prepareArguments: (params) => prepareArguments(toolDefinition.name, toolSchema, params),
    defaultActive: false,
    renderCall: reportTaskRenderers.renderCall,
    renderResult: reportTaskRenderers.renderResult,

    async execute(_toolCallId, params, signal) {
      try {
        validateArguments(toolDefinition.name, toolSchema, params);
        assertToolAccess(ctx, toolDefinition.name);
        signal?.throwIfAborted();
        if (ctx.state.role.kind !== "member") {
          throw new ToolFailure(
            "permission_denied",
            "report_task failed: no outstanding parent assignment exists.",
          );
        }
        if (automaticMode(ctx)) {
          throw new ToolFailure(
            "precondition_failed",
            "report_task failed: non-interactive agents complete automatically; explicit reporting requires interactive mode.",
          );
        }
        const accepted = ctx.execution!.report(params.message);
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