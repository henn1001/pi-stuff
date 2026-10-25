import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { crewCommand } from "./src/extension/commands/crew.ts";
import { registerSessionInput } from "./src/extension/session-input/index.ts";
import { onMessageEnd } from "./src/extension/hooks/message-end.ts";
import { onBeforeSettle, onSettled } from "./src/extension/hooks/settle.ts";
import { createCrewContext } from "./src/extension/context.ts";
import { createResourceManager } from "./src/extension/resources.ts";
import { createSessionHandlers } from "./src/extension/session.ts";
import { setAgentDir } from "./src/store/agent-home.ts";
import { createState } from "./src/domain/role.ts";
import { createReportTaskTool } from "./src/extension/tools/report-task.ts";
import { createListAgentsTool } from "./src/extension/tools/list-agents.ts";
import { createSpawnAgentTool } from "./src/extension/tools/spawn-agent.ts";
import { createSendMessageTool } from "./src/extension/tools/send-message.ts";
import { MESSAGE_TYPE } from "./src/extension/message-type.ts";
import { createCrewMessageRenderer } from "./src/extension/ui/render.ts";

/**
 * Crew extension entry. Everything registered with pi is listed here; the
 * behavior lives in src/extension/.
 *
 * Tools are always registered. They are active only for the enabled lead or a
 * member (see extension/tool-activation.ts) and are guarded again at execution.
 */
export default function crew(pi: ExtensionAPI): void {
  setAgentDir(getAgentDir());

  const ctx = createCrewContext(pi, createState());
  const session = createSessionHandlers(ctx, createResourceManager(ctx));

  // Flags: what the user can set to configure Crew behavior.
  pi.registerFlag("crew-mode", { type: "string", description: "Activate Crew as lead or member" });
  pi.registerFlag("crew-agent", { type: "string", description: "Crew member agent identifier" });

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
  registerSessionInput(pi, ctx);
  pi.on("message_end", onMessageEnd(ctx));
  pi.on("agent_before_settle", onBeforeSettle(ctx));
  pi.on("agent_settled", onSettled(ctx));
}