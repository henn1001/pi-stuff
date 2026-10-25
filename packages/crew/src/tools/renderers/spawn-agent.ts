import type { SpawnAgentToolDefinition } from "../spawn-agent.ts";
import { renderToolResult, renderPromptCall } from "./shared.ts";

/** Render creation arguments separately from the model-visible JSON result. */
export const spawnAgentRenderers: Pick<SpawnAgentToolDefinition, "renderCall" | "renderResult"> = {
  renderCall(args, theme, context) {
    return renderPromptCall(
      context.expanded ? `task_name: ${args.task_name ?? ""}\n${args.message ?? ""}` : args.message,
      "spawn_agent",
      args.agent_type,
      theme,
      context,
    );
  },
  renderResult: renderToolResult("Launched"),
};