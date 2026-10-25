import { randomUUID } from "node:crypto";
import type { CrewContext } from "../extension/context.ts";
import type { CoordinatorContext } from "../extension/coordinator-context.ts";
import { assertOwnership } from "../store/ownership.ts";
import { NotConnectedError, UnresponsiveError, request } from "../ipc/socket.ts";

/** Best-effort local activity check; probes cannot reserve input or authorize a continuation. */
export async function completionIdle(
  ctx: CrewContext,
  sessionId: string,
  instanceId: string,
  signal: AbortSignal,
  requireAutomatic = false,
): Promise<boolean> {
  let reply;
  try {
    reply = await request(ctx.ownership!.workspaceId, sessionId, { kind: "ping" }, signal);
  } catch (error) {
    if (error instanceof NotConnectedError || error instanceof UnresponsiveError) {
      return false;
    }
    throw error;
  }
  signal.throwIfAborted();
  return (
    reply.ok &&
    reply.info?.sessionId === sessionId &&
    reply.info.instanceId === instanceId &&
    reply.info.state === "idle" &&
    reply.info.pendingInput === false &&
    (!requireAutomatic || reply.info.lifecycle === "non-interactive")
  );
}

/** Consume exact-instance evidence on the lead queue; probes never gate human input or start turns. */
export async function reconcileLifecycle(
  lead: CoordinatorContext,
  signal: AbortSignal,
): Promise<void> {
  const { crew: ctx, coordinatorStore: ledger, coordinator } = lead;
  const owner = ctx.ownership;
  if (!owner) {
    throw new Error("Crew execution unavailable.");
  }
  const current = () => {
    signal.throwIfAborted();
    assertOwnership(owner);
    ledger.assertCoordinator(owner);
    if (!coordinator.active || ctx.ownership !== owner) {
      throw new Error("Crew execution unavailable.");
    }
  };
  current();
  ledger.transaction(Date.now() + 1000, (db) => {
    current();
    // Unattempted reports may be revoked; an attempted side effect is never replayed or erased.
    const disrupted = db
      .prepare(
        "SELECT c.* FROM completion_authorizations c JOIN instances i USING(workspace_id,session_id,instance_id) JOIN operations o USING(workspace_id,request_id) WHERE c.workspace_id=? AND c.state='authorized' AND ((i.takeover=1 AND o.state IN ('pending','failed')) OR (o.state='failed' AND EXISTS (SELECT 1 FROM assignments a WHERE a.workspace_id=c.workspace_id AND a.child_session_id=c.session_id AND a.assignment_id=c.assignment_id AND a.state='settled')))",
      )
      .all(owner.workspaceId);
    for (const row of disrupted) {
      db.prepare(
        "UPDATE operations SET state='failed',error_code='precondition_failed',error_message='Crew execution unavailable.' WHERE workspace_id=? AND request_id=? AND state='pending'",
      ).run(owner.workspaceId, row.request_id!);
      db.prepare(
        "UPDATE completion_authorizations SET state='cancelled' WHERE workspace_id=? AND request_id=?",
      ).run(owner.workspaceId, row.request_id!);
    }
    const pending = db
      .prepare(
        "SELECT c.request_id,o.state FROM completion_authorizations c JOIN operations o USING(workspace_id,request_id) WHERE c.workspace_id=? AND c.state='authorized' AND o.state IN ('pending','failed')",
      )
      .all(owner.workspaceId);
    for (const row of pending) {
      if (ledger.completionCurrent(String(row.request_id))) {
        continue;
      }
      if (row.state === "pending") {
        db.prepare(
          "UPDATE operations SET state='failed',error_code='precondition_failed',error_message='Crew execution unavailable.' WHERE workspace_id=? AND request_id=? AND state='pending'",
        ).run(owner.workspaceId, row.request_id!);
      }
      db.prepare(
        "UPDATE completion_authorizations SET state='cancelled' WHERE workspace_id=? AND request_id=? AND state='authorized'",
      ).run(owner.workspaceId, row.request_id!);
    }
    const exited = db
      .prepare(
        "SELECT a.* FROM assignments a JOIN instances i ON i.workspace_id=a.workspace_id AND i.session_id=a.child_session_id AND i.instance_id=a.instance_id WHERE a.workspace_id=? AND a.state='outstanding' AND i.status='exited' AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.workspace_id=a.workspace_id AND o.caller_session_id=a.child_session_id AND o.assignment_id=a.assignment_id AND o.kind IN ('report','automatic_report','unexpected_exit') AND o.state<>'failed' AND NOT (o.kind='automatic_report' AND EXISTS (SELECT 1 FROM completion_authorizations c WHERE c.workspace_id=o.workspace_id AND c.request_id=o.request_id AND c.state='cancelled') AND EXISTS (SELECT 1 FROM receipts r WHERE r.workspace_id=o.workspace_id AND r.report_id=o.request_id))) AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.workspace_id=a.workspace_id AND o.caller_session_id=a.child_session_id AND o.assignment_id=a.assignment_id AND o.kind='unexpected_exit')",
      )
      .all(owner.workspaceId);
    for (const row of exited) {
      db.prepare(
        "INSERT INTO operations(workspace_id,request_id,caller_session_id,recipient_session_id,kind,payload,assignment_id) VALUES(?,?,?,?,'unexpected_exit',?,?)",
      ).run(
        owner.workspaceId,
        randomUUID(),
        row.child_session_id!,
        row.parent_session_id!,
        "Agent exited before returning a result. Its task may be incomplete.",
        row.assignment_id!,
      );
    }
    // Confirmed exit establishes the close outcome without repeating an uncertain Herdr command.
    const closed = db
      .prepare(
        "SELECT o.request_id FROM operations o JOIN execution_attempts a USING(workspace_id,request_id) JOIN instances i ON i.workspace_id=o.workspace_id AND i.session_id=o.recipient_session_id AND i.instance_id=a.recipient_instance_id WHERE o.workspace_id=? AND o.kind='close' AND o.state='uncertain' AND i.status='exited'",
      )
      .all(owner.workspaceId);
    for (const row of closed) {
      db.prepare(
        "UPDATE operations SET state='succeeded',error_code=NULL,error_message=NULL WHERE workspace_id=? AND request_id=?",
      ).run(owner.workspaceId, row.request_id!);
      db.prepare(
        "UPDATE execution_attempts SET state='succeeded' WHERE workspace_id=? AND request_id=?",
      ).run(owner.workspaceId, row.request_id!);
    }
    db.prepare(
      "UPDATE completion_authorizations SET state='closed' WHERE workspace_id=? AND state='settled' AND (EXISTS (SELECT 1 FROM instances i WHERE i.workspace_id=completion_authorizations.workspace_id AND i.session_id=completion_authorizations.session_id AND i.instance_id=completion_authorizations.instance_id AND i.status='exited') OR EXISTS (SELECT 1 FROM operations o WHERE o.workspace_id=completion_authorizations.workspace_id AND o.request_id='close:'||completion_authorizations.request_id AND o.state='succeeded'))",
    ).run(owner.workspaceId);
    const closures = db
      .prepare(
        "SELECT c.* FROM completion_authorizations c JOIN instances i USING(workspace_id,session_id,instance_id) WHERE c.workspace_id=? AND c.state='settled' AND i.status='running' AND i.auto_exit=1 AND i.takeover=0 AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.workspace_id=c.workspace_id AND o.request_id='close:'||c.request_id)",
      )
      .all(owner.workspaceId);
    for (const row of closures) {
      db.prepare(
        "INSERT INTO operations(workspace_id,request_id,caller_session_id,recipient_session_id,kind,payload,assignment_id) VALUES(?,?,?,?,'close',?,?)",
      ).run(
        owner.workspaceId,
        `close:${row.request_id}`,
        owner.sessionId,
        row.session_id!,
        row.instance_id!,
        row.assignment_id!,
      );
    }
  });
  const candidates = ledger.db
    .prepare(
      "SELECT a.*,e.event_id FROM assignments a JOIN instances i ON i.workspace_id=a.workspace_id AND i.session_id=a.child_session_id AND i.instance_id=a.instance_id JOIN execution_events e ON e.workspace_id=i.workspace_id AND e.session_id=i.session_id AND e.instance_id=i.instance_id WHERE a.workspace_id=? AND a.state='outstanding' AND i.status='running' AND i.auto_exit=1 AND i.takeover=0 AND e.kind='turn_settled' AND e.outcome='success' AND length(trim(e.result_text))>0 AND e.event_order=(SELECT max(t.event_order) FROM execution_events t WHERE t.workspace_id=e.workspace_id AND t.session_id=e.session_id AND t.instance_id=e.instance_id AND t.kind='turn_settled') AND NOT EXISTS (SELECT 1 FROM completion_authorizations c WHERE c.workspace_id=a.workspace_id AND c.session_id=a.child_session_id AND c.assignment_id=a.assignment_id AND c.state<>'cancelled')",
    )
    .all(owner.workspaceId);
  // Independent probes are bounded by the socket timeout; an unavailable member blocks only itself.
  await Promise.all(
    candidates.map(async (row) => {
      if (
        !(await completionIdle(
          ctx,
          String(row.child_session_id),
          String(row.instance_id),
          signal,
          true,
        ))
      ) {
        return;
      }
      current();
      ledger.authorizeCompletion(
        owner,
        {
          workspaceId: owner.workspaceId,
          parentSessionId: String(row.parent_session_id),
          childSessionId: String(row.child_session_id),
          assignmentId: String(row.assignment_id),
          childInstanceId: String(row.instance_id),
        },
        String(row.event_id),
        randomUUID(),
        Date.now() + 1000,
      );
    }),
  );
}