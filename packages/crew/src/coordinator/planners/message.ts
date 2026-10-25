import { randomUUID } from "node:crypto";
import { herdr } from "../../herdr/cli.ts";
import { promptAgent } from "../../herdr/command.ts";
import { NotConnectedError, UnresponsiveError, request } from "../../ipc/socket.ts";
import type { CoordinatorContext } from "../../extension/coordinator-context.ts";
import type { CommandPlanner } from "../coordinator.ts";
import { processPresence, rowProcess } from "../../store/process-identity.ts";
import { prepareResume, resumeChild } from "./resume.ts";
import { completionIdle } from "../reconcile.ts";

/** Private terminal transport marker. It is consumed before Pi constructs model-visible input. */
const DELIVERY_PREFIX = "[[crew-delivery:";
const DELIVERY_SUFFIX = "]]";

/** Install the sole lead consumers for messages and assignment outcomes. Producers remain separate. */
export function registerMessagingPlanners(lead: CoordinatorContext): void {
  const { crew: ctx, coordinatorStore: ledger, coordinator } = lead;
  const owner = ctx.ownership;
  if (!owner) {
    throw new Error("Crew execution unavailable.");
  }
  const planner: CommandPlanner = async (operation, signal) => {
    const recipient = operation.recipientSessionId!;
    const completion =
      operation.kind === "automatic_report"
        ? ledger.db
            .prepare(
              "SELECT c.instance_id,i.status FROM completion_authorizations c JOIN instances i USING(workspace_id,session_id,instance_id) WHERE c.workspace_id=? AND c.request_id=? AND c.state='authorized' AND i.takeover=0",
            )
            .get(owner.workspaceId, operation.requestId)
        : undefined;
    if (operation.kind === "automatic_report") {
      if (
        !completion ||
        !ledger.completionCurrent(operation.requestId) ||
        (completion.status !== "exited" &&
          !(await completionIdle(
            ctx,
            operation.callerSessionId,
            String(completion.instance_id),
            signal,
            true,
          ))) ||
        !ledger.completionCurrent(operation.requestId)
      ) {
        return undefined;
      }
    }
    const child = ledger.db
      .prepare(
        "SELECT * FROM agent_tree WHERE workspace_id=? AND session_id=? AND parent_session_id=? AND root_lead_session_id=?",
      )
      .get(owner.workspaceId, recipient, operation.callerSessionId, owner.sessionId);
    const upward = ledger.db
      .prepare(
        "SELECT * FROM agent_tree WHERE workspace_id=? AND session_id=? AND parent_session_id=? AND root_lead_session_id=?",
      )
      .get(owner.workspaceId, operation.callerSessionId, recipient, owner.sessionId);
    if (!child && !upward) {
      return {
        code: "permission_denied",
        message: "Messages may target only your recorded parent or direct children.",
        agentId: recipient,
      };
    }
    const ready = ledger.db
      .prepare(
        "SELECT count(*) AS n FROM relationships WHERE workspace_id=? AND child_session_id=? AND parent_session_id=? AND stage='ready'",
      )
      .get(
        owner.workspaceId,
        child ? recipient : operation.callerSessionId,
        child ? operation.callerSessionId : recipient,
      );
    if (ready?.n !== 2) {
      return undefined;
    }
    if (operation.kind !== "message") {
      const assignment = ledger.db
        .prepare(
          "SELECT 1 FROM assignments WHERE workspace_id=? AND parent_session_id=? AND child_session_id=? AND assignment_id=? AND state='outstanding'",
        )
        .get(owner.workspaceId, recipient, operation.callerSessionId, operation.assignmentId);
      if (!upward || !assignment) {
        return {
          code: "precondition_failed",
          message: "No outstanding parent assignment.",
          agentId: recipient,
        };
      }
    }
    if (
      operation.kind === "unexpected_exit" &&
      ledger.db
        .prepare(
          "SELECT 1 FROM operations o WHERE workspace_id=? AND caller_session_id=? AND assignment_id=? AND kind IN ('report','automatic_report') AND state IN ('pending','in_progress','succeeded','uncertain') AND NOT (kind='automatic_report' AND EXISTS (SELECT 1 FROM completion_authorizations c WHERE c.workspace_id=o.workspace_id AND c.request_id=o.request_id AND c.state='cancelled') AND EXISTS (SELECT 1 FROM receipts r WHERE r.workspace_id=o.workspace_id AND r.report_id=o.request_id))",
        )
        .get(owner.workspaceId, operation.callerSessionId, operation.assignmentId)
    ) {
      return undefined;
    }
    const instance = ledger.db
      .prepare(
        "SELECT * FROM instances WHERE workspace_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(owner.workspaceId, recipient);
    if (!instance) {
      return undefined;
    }
    const presence = processPresence(rowProcess(instance));
    if (child) {
      const previousWork = ledger.db
        .prepare(
          "SELECT instance_id FROM assignments WHERE workspace_id=? AND child_session_id=? AND state IN ('prepared','outstanding')",
        )
        .get(owner.workspaceId, recipient);
      if (previousWork && previousWork.instance_id !== instance.instance_id) {
        return undefined;
      }
      const completing = ledger.db
        .prepare(
          "SELECT state FROM completion_authorizations WHERE workspace_id=? AND session_id=? AND instance_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(owner.workspaceId, recipient, instance.instance_id!);
      if (
        completing?.state === "authorized" ||
        (completing &&
          completing.state !== "cancelled" &&
          presence !== "exited" &&
          (completing.state === "closed" || (instance.auto_exit === 1 && instance.takeover === 0)))
      ) {
        return undefined;
      }
      if (presence === "exited") {
        const outstanding = ledger.db
          .prepare(
            "SELECT 1 FROM assignments WHERE workspace_id=? AND child_session_id=? AND state IN ('prepared','outstanding')",
          )
          .get(owner.workspaceId, recipient);
        if (outstanding) {
          return undefined;
        }
        const prepared = await prepareResume(lead, operation, signal);
        if (!prepared || "code" in prepared) {
          return prepared;
        }
        return {
          command: "resume",
          recipientInstanceId: null,
          async execute(executionSignal) {
            const resumed = await resumeChild(lead, operation, prepared, executionSignal);
            executionSignal.throwIfAborted();
            ledger.bindResumedMessage(
              owner,
              operation.requestId,
              resumed.instanceId,
              randomUUID(),
              Date.now() + 1000,
            );
            executionSignal.throwIfAborted();
            await promptAgent(
              resumed.paneId,
              `${DELIVERY_PREFIX}${operation.requestId}${DELIVERY_SUFFIX}`,
            );
            return { state: "succeeded" };
          },
        };
      }
    }
    if (presence !== "alive" || instance.status !== "running") {
      return undefined;
    }
    let reply;
    try {
      reply = await request(owner.workspaceId, recipient, { kind: "ping" }, signal);
    } catch (error) {
      if (error instanceof NotConnectedError || error instanceof UnresponsiveError) {
        return undefined;
      }
      throw error;
    }
    if (
      !reply.ok ||
      reply.info?.sessionId !== recipient ||
      reply.info.instanceId !== instance.instance_id ||
      !reply.info.paneId
    ) {
      return undefined;
    }
    const paneId = reply.info.paneId;
    return {
      command: "prompt",
      recipientInstanceId: String(instance.instance_id),
      async execute(executionSignal) {
        executionSignal.throwIfAborted();
        // Recheck Herdr's session identity immediately before writing terminal input.
        const observed = await herdr(["agent", "list"]);
        const agent = observed.agents.find(
          (entry: { pane_id: string }) => entry.pane_id === paneId,
        );
        const identity = agent?.agent_session;
        if (
          agent?.agent !== "pi" ||
          !(
            (identity?.kind === "id" && identity.value === recipient) ||
            (identity?.kind === "path" && identity.value === reply.info!.sessionFile)
          ) ||
          processPresence(rowProcess(instance)) !== "alive" ||
          (operation.kind === "automatic_report" &&
            (!ledger.completionCurrent(operation.requestId) ||
              (completion!.status !== "exited" &&
                !(await completionIdle(
                  ctx,
                  operation.callerSessionId,
                  String(completion!.instance_id),
                  executionSignal,
                  true,
                ))) ||
              !ledger.completionCurrent(operation.requestId)))
        ) {
          return {
            state: "failed",
            failure: {
              code: "execution_failed",
              message: "Crew execution unavailable.",
              agentId: recipient,
            },
          };
        }
        executionSignal.throwIfAborted();
        await promptAgent(paneId, `${DELIVERY_PREFIX}${operation.requestId}${DELIVERY_SUFFIX}`);
        return { state: "succeeded" };
      },
    };
  };
  for (const kind of ["message", "report", "automatic_report", "unexpected_exit"] as const) {
    coordinator.register(kind, planner);
  }
}