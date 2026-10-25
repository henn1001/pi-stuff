import type { CoordinatorContext } from "../../extension/coordinator-context.ts";
import { processPresence, rowProcess } from "../../store/process-identity.ts";
import { herdr } from "../../herdr/cli.ts";
import { closePane } from "../../herdr/command.ts";
import { completionIdle } from "../reconcile.ts";

/** Install the sole automatic-close consumer, fenced by settlement and exact Herdr/process identity. */
export function registerClosePlanner(lead: CoordinatorContext): void {
  const { crew: ctx, coordinatorStore: ledger, coordinator } = lead;
  const owner = ctx.ownership;
  if (!owner) {
    throw new Error("Crew execution unavailable.");
  }
  coordinator.register("close", async (operation, signal) => {
    const instance = ledger.db
      .prepare(
        "SELECT i.*,s.session_file FROM instances i JOIN sessions s USING(workspace_id,session_id) JOIN completion_authorizations c USING(workspace_id,session_id,instance_id) WHERE i.workspace_id=? AND i.session_id=? AND i.instance_id=? AND i.status='running' AND i.auto_exit=1 AND i.takeover=0 AND c.state='settled' AND c.assignment_id=? AND 'close:'||c.request_id=?",
      )
      .get(
        owner.workspaceId,
        operation.recipientSessionId,
        operation.payload,
        operation.assignmentId,
        operation.requestId,
      );
    if (
      !instance ||
      operation.callerSessionId !== owner.sessionId ||
      processPresence(rowProcess(instance)) !== "alive" ||
      !ledger.completionCurrent(operation.requestId.slice(6))
    ) {
      return undefined;
    }
    if (
      !(await completionIdle(
        ctx,
        operation.recipientSessionId!,
        String(instance.instance_id),
        signal,
        true,
      ))
    ) {
      return undefined;
    }
    const observed = await herdr(["agent", "list"]);
    signal.throwIfAborted();
    const agent = observed.agents.find(
      (entry: { pane_id: string }) => entry.pane_id === instance.pane_id,
    );
    const identity = agent?.agent_session;
    if (
      agent?.agent !== "pi" ||
      !(
        (identity?.kind === "id" && identity.value === operation.recipientSessionId) ||
        (identity?.kind === "path" && identity.value === instance.session_file)
      )
    ) {
      return undefined;
    }
    return {
      command: "close",
      recipientInstanceId: String(instance.instance_id),
      async execute(executionSignal) {
        executionSignal.throwIfAborted();
        const eligible = ledger.db
          .prepare(
            "SELECT 1 FROM instances WHERE workspace_id=? AND session_id=? AND instance_id=? AND status='running' AND takeover=0",
          )
          .get(owner.workspaceId, operation.recipientSessionId, instance.instance_id!);
        if (
          !eligible ||
          processPresence(rowProcess(instance)) !== "alive" ||
          !ledger.completionCurrent(operation.requestId.slice(6)) ||
          !(await completionIdle(
            ctx,
            operation.recipientSessionId!,
            String(instance.instance_id),
            executionSignal,
            true,
          )) ||
          !ledger.completionCurrent(operation.requestId.slice(6))
        ) {
          return {
            state: "failed",
            failure: {
              code: "precondition_failed",
              message: "Crew execution unavailable.",
              agentId: operation.recipientSessionId!,
            },
          };
        }
        await closePane(String(instance.pane_id));
        return { state: "succeeded" };
      },
    };
  });
}