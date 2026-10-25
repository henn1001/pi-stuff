import type { ListAgentsToolDefinition } from "../list-agents.ts";
import { renderToolResult, renderPromptCall } from "./shared.ts";

/** Render the complete public snapshot, including launch rows that are not navigation targets. */
export const listAgentsRenderers: Pick<ListAgentsToolDefinition, "renderCall" | "renderResult"> = {
  renderCall(_args, theme, context) {
    return renderPromptCall("", "list_agents", undefined, theme, context);
  },
  renderResult: renderToolResult("Agent and launch snapshot"),
};