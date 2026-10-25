import type { ReportTaskToolDefinition } from "../report-task.ts";
import { renderToolResult, renderPromptCall } from "./shared.ts";

/** Render interactive report submission without implying settlement. */
export const reportTaskRenderers: Pick<ReportTaskToolDefinition, "renderCall" | "renderResult"> = {
  renderCall(args, theme, context) {
    return renderPromptCall(args.message, "report_task", undefined, theme, context);
  },
  renderResult: renderToolResult("Durably accepted · not delivery or settlement"),
};