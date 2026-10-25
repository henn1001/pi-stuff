import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { crewCommand } from "./src/commands/crew.ts";
import { onBeforeAgentStart } from "./src/hooks/before-agent-start.ts";
import { onInput } from "./src/hooks/input.ts";
import { observeProcessing } from "./src/runtime/assignments.ts";
import { onMessageEnd } from "./src/hooks/message-end.ts";
import { onBeforeSettle, onSettled } from "./src/hooks/settle.ts";
import { createCrewContext } from "./src/runtime/context.ts";
import { createResourceManager } from "./src/runtime/resources.ts";
import { createSessionHandlers } from "./src/runtime/session.ts";
import { createState } from "./src/runtime/state.ts";
import { createReportTaskTool } from "./src/tools/report-task.ts";
import { createListAgentsTool } from "./src/tools/list-agents.ts";
import { createSpawnAgentTool } from "./src/tools/spawn-agent.ts";
import { createSendMessageTool } from "./src/tools/send-message.ts";
import { MESSAGE_TYPE } from "./src/runtime/types.ts";
import { createCrewMessageRenderer } from "./src/ui/render.ts";

/**
 * Crew extension entry. Everything registered with pi is listed here; the
 * behavior lives in tools/, commands/, hooks/ and ui/.
 *
 * Tools are always registered. They are active only for the enabled lead or a
 * member (see tools/access.ts) and are guarded again at execution.
 */
export default function crew(pi: ExtensionAPI): void {
  pi.registerFlag("crew-mode", { type: "string", description: "Activate Crew as lead or member" });
  pi.registerFlag("crew-agent", {
    type: "string",
    description: "Definition for independently activated Crew member",
  });
  const ctx = createCrewContext(pi, createState());
  const session = createSessionHandlers(ctx, createResourceManager(ctx));

  // Tools: what the model can call.
  pi.registerTool(createSpawnAgentTool(ctx));
  pi.registerTool(createSendMessageTool(ctx));
  pi.registerTool(createReportTaskTool(ctx));
  pi.registerTool(createListAgentsTool(ctx));

  // Commands: what the user can type.
  pi.registerCommand("crew", crewCommand(ctx));

  // Rendering.
  pi.registerMessageRenderer(MESSAGE_TYPE, createCrewMessageRenderer(ctx));

  // Session hooks: establish and release session-scoped resources.
  pi.on("session_start", session.start);
  pi.on("session_shutdown", session.shutdown);

  // Run hooks persist local evidence without authorizing delivery or completion.
  pi.on("input", onInput(ctx));
  pi.on("before_agent_start", onBeforeAgentStart(ctx));
  pi.on("message_end", onMessageEnd(ctx));
  pi.on("context", (event) => observeProcessing(ctx, event));
  pi.on("agent_before_settle", onBeforeSettle(ctx));
  pi.on("agent_settled", onSettled(ctx));
}