import type { Ownership } from "./ownership.ts";
import { Ledger, type AssignmentFence } from "./base-store.ts";
import type { OperationFailure } from "../domain/operation.ts";

/** Write facade for lead-only decisions; every method requires coordinator ownership.
 *
 * Classification against coordination-rules ("Durable submission and local writes",
 * "Inbox and coordinator"): the coordinator owns delivery records, assignment transitions and
 * lifecycle decisions, and is the sole writer of command attempts and results.
 * - `assertCoordinator`: ownership boundary for coordinator work and Herdr layout.
 * - Operation attempts and results: `beginAttempt`, `completeOperation`, `failOperation`,
 *   `recordLaunch` (launch result, child promotion and initial assignment).
 * - Assignment transitions and delivery records: `bindResumedMessage`, `reconcileDeliveries`
 *   (receipts, settlements, pending outcomes).
 * - Completion authorization: `authorizeCompletion`.
 * It shares the `LocalStore` connection and never owns or closes it. Only `coordinator/` and the
 * composition root may import this class (architecture test).
 */
export class CoordinatorStore extends Ledger {
  /** Share the connection of the process's `LocalStore`; the caller keeps connection ownership. */
  static over(store: Ledger): CoordinatorStore {
    return new CoordinatorStore(store.db, store.workspaceId);
  }

  /** Verify the active recorded lead's OS capability before entering coordinator-owned work. */
  assertCoordinator(owner: Ownership): void {
    this.writer(owner, true);
  }

  /** Claim an unattempted operation before issuing a side effect. Existing attempts never replay.
   * Return false if local activity superseded an automatic report or close during planning.
   */
  beginAttempt(
    owner: Ownership,
    requestId: string,
    attemptId: string,
    command: "launch" | "resume" | "prompt" | "close",
    recipientInstanceId: string | null,
    deadline: number,
  ): boolean {
    return this.transaction(deadline, (db) => {
      this.writer(owner, true);
      const automatic = db
        .prepare(
          "SELECT o.kind,i.takeover FROM operations o JOIN completion_authorizations c ON c.workspace_id=o.workspace_id AND (c.request_id=o.request_id OR 'close:'||c.request_id=o.request_id) JOIN instances i USING(workspace_id,session_id,instance_id) WHERE o.workspace_id=? AND o.request_id=? AND o.kind IN ('automatic_report','close')",
        )
        .get(this.workspaceId, requestId);
      if (
        automatic &&
        (automatic.takeover === 1 ||
          !this.completionCurrent(command === "close" ? requestId.slice(6) : requestId))
      ) {
        return false;
      }
      const changed = db
        .prepare(
          "UPDATE operations SET state='in_progress' WHERE workspace_id=? AND request_id=? AND state='pending'",
        )
        .run(this.workspaceId, requestId);
      if (changed.changes !== 1) {
        throw new Error("The recorded operation state does not permit this transition.");
      }
      db.prepare("INSERT INTO execution_attempts VALUES(?,?,?,?,?,?,?,'in_progress')").run(
        this.workspaceId,
        requestId,
        attemptId,
        owner.sessionId,
        owner.instanceId,
        recipientInstanceId,
        command,
      );
      const operation = db
        .prepare("SELECT * FROM operations WHERE workspace_id=? AND request_id=?")
        .get(this.workspaceId, requestId)!;
      if (operation.kind === "message" && command === "prompt") {
        const child = db
          .prepare(
            "SELECT 1 FROM agent_tree WHERE workspace_id=? AND session_id=? AND parent_session_id=?",
          )
          .get(this.workspaceId, operation.recipient_session_id!, operation.caller_session_id!);
        if (child) {
          let assignment = db
            .prepare(
              "SELECT * FROM assignments WHERE workspace_id=? AND parent_session_id=? AND child_session_id=? AND state IN ('prepared','outstanding')",
            )
            .get(this.workspaceId, operation.caller_session_id!, operation.recipient_session_id!);
          if (!assignment) {
            db.prepare("INSERT INTO assignments VALUES(?,?,?,?,?,'prepared',?)").run(
              this.workspaceId,
              operation.caller_session_id!,
              operation.recipient_session_id!,
              requestId,
              recipientInstanceId,
              operation.payload!,
            );
            assignment = { assignment_id: requestId, instance_id: recipientInstanceId };
          }
          db.prepare("INSERT INTO message_assignments VALUES(?,?,?,?,?,?)").run(
            this.workspaceId,
            requestId,
            operation.caller_session_id!,
            operation.recipient_session_id!,
            assignment.assignment_id!,
            assignment.instance_id!,
          );
        }
      }
      if (["report", "automatic_report", "unexpected_exit"].includes(String(operation.kind))) {
        const assignment = db
          .prepare(
            "SELECT * FROM assignments WHERE workspace_id=? AND parent_session_id=? AND child_session_id=? AND assignment_id=? AND state='outstanding'",
          )
          .get(
            this.workspaceId,
            operation.recipient_session_id!,
            operation.caller_session_id!,
            operation.assignment_id!,
          );
        if (!assignment) {
          throw new Error("No outstanding parent assignment.");
        }
        db.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?,?,0)").run(
          this.workspaceId,
          operation.caller_session_id!,
          requestId,
          operation.recipient_session_id!,
          operation.assignment_id!,
          assignment.instance_id!,
          operation.payload!,
        );
      }
      return true;
    });
  }

  /** Record command acceptance without implying report receipt, processing, or assignment settlement. */
  completeOperation(owner: Ownership, requestId: string, deadline: number): void {
    this.transaction(deadline, (db) => {
      this.writer(owner, true);
      const row = db
        .prepare("SELECT kind,state FROM operations WHERE workspace_id=? AND request_id=?")
        .get(this.workspaceId, requestId);
      if (!row || row.kind === "spawn") {
        throw new Error("The recorded operation state does not permit this transition.");
      }
      if (row.state === "succeeded") {
        return;
      }
      if (row.state !== "in_progress" && row.state !== "uncertain") {
        throw new Error("The recorded operation state does not permit this transition.");
      }
      db.prepare(
        "UPDATE operations SET state='succeeded',error_code=NULL,error_message=NULL WHERE workspace_id=? AND request_id=?",
      ).run(this.workspaceId, requestId);
      db.prepare(
        "UPDATE execution_attempts SET state='succeeded' WHERE workspace_id=? AND request_id=?",
      ).run(this.workspaceId, requestId);
    });
  }

  /** Retain command failure or uncertainty; only confirmed launch failure releases an unused name. */
  failOperation(
    owner: Ownership,
    requestId: string,
    state: "failed" | "uncertain",
    failure: OperationFailure,
    deadline: number,
  ): void {
    this.transaction(deadline, (db) => {
      this.writer(owner, true);
      const row = db
        .prepare("SELECT * FROM operations WHERE workspace_id=? AND request_id=?")
        .get(this.workspaceId, requestId);
      if (
        row?.state === state &&
        row.error_code === failure.code &&
        row.error_message === failure.message &&
        row.resolved_agent_id ===
          (failure.agentId ?? row.resolved_agent_id ?? row.recipient_session_id)
      ) {
        return;
      }
      if (
        !row ||
        !["pending", "in_progress", "uncertain"].includes(String(row.state)) ||
        (row.state === "pending" && state === "uncertain")
      ) {
        throw new Error("The recorded operation state does not permit this transition.");
      }
      db.prepare(
        "UPDATE operations SET state=?,error_code=?,error_message=?,resolved_agent_id=? WHERE workspace_id=? AND request_id=?",
      ).run(
        state,
        failure.code,
        failure.message,
        failure.agentId ?? row.resolved_agent_id ?? row.recipient_session_id!,
        this.workspaceId,
        requestId,
      );
      db.prepare("UPDATE execution_attempts SET state=? WHERE workspace_id=? AND request_id=?").run(
        state,
        this.workspaceId,
        requestId,
      );
      if (state === "failed" && row.kind === "message") {
        db.prepare(
          "UPDATE assignments SET state='failed-start' WHERE workspace_id=? AND state='prepared' AND EXISTS (SELECT 1 FROM message_assignments m WHERE m.workspace_id=assignments.workspace_id AND m.request_id=? AND m.assignment_id=assignments.assignment_id AND m.parent_session_id=assignments.parent_session_id AND m.child_session_id=assignments.child_session_id) AND NOT EXISTS (SELECT 1 FROM message_assignments m WHERE m.workspace_id=assignments.workspace_id AND m.parent_session_id=assignments.parent_session_id AND m.assignment_id=assignments.assignment_id AND m.request_id<>?)",
        ).run(this.workspaceId, requestId, requestId);
      }
      if (row.kind === "spawn") {
        db.prepare(
          "INSERT INTO launch_results VALUES(?,?,?,NULL,NULL,?,?) ON CONFLICT(workspace_id,request_id) DO UPDATE SET state=excluded.state,error_code=excluded.error_code,error_message=excluded.error_message",
        ).run(this.workspaceId, requestId, state, failure.code, failure.message);
        if (state === "failed") {
          db.prepare(
            "DELETE FROM task_names WHERE workspace_id=? AND request_id=? AND child_session_id IS NULL",
          ).run(this.workspaceId, requestId);
        }
      }
    });
  }

  /** Atomically record a verified launched child, its initial assignment, and the caller's result.
   * Adapter registration supplies instance evidence, not a recorded child relationship.
   * Promotion into the tree and the launch result commit together; no Herdr calls occur here.
   */
  recordLaunch(
    owner: Ownership,
    requestId: string,
    childSessionId: string,
    childInstanceId: string,
    assignmentId: string | null,
    deadline: number,
  ): void {
    this.transaction(deadline, (db) => {
      this.writer(owner, true);
      const row = db
        .prepare("SELECT * FROM operations WHERE workspace_id=? AND request_id=? AND kind='spawn'")
        .get(this.workspaceId, requestId);
      if (row?.state === "succeeded") {
        const result = this.launchResult(requestId);
        if (result?.child_session_id === childSessionId && result.assignment_id === assignmentId) {
          return;
        }
        throw new Error("The recorded request identity does not match this submission.");
      }
      if (!row || !["in_progress", "uncertain"].includes(String(row.state))) {
        throw new Error("The recorded operation state does not permit this transition.");
      }
      const instance = db
        .prepare(
          "SELECT 1 FROM instances WHERE workspace_id=? AND session_id=? AND instance_id=? AND status='running'",
        )
        .get(this.workspaceId, childSessionId, childInstanceId);
      const ready = db
        .prepare(
          "SELECT count(*) AS n FROM relationships WHERE workspace_id=? AND child_session_id=? AND parent_session_id=? AND origin='spawned' AND stage='ready'",
        )
        .get(this.workspaceId, childSessionId, row.caller_session_id!);
      if (
        !instance ||
        ready?.n !== 2 ||
        String(row.payload).trim().length > 0 !== (assignmentId !== null)
      ) {
        throw new Error("The recorded operation state does not permit this transition.");
      }
      const parent = db
        .prepare(
          "SELECT root_lead_session_id FROM agent_tree WHERE workspace_id=? AND session_id=?",
        )
        .get(this.workspaceId, row.caller_session_id!);
      const childRole = this.role(childSessionId);
      if (
        (row.resolved_agent_id !== null && row.resolved_agent_id !== childSessionId) ||
        !parent ||
        childRole?.kind !== "member" ||
        childRole.caller !== row.caller_session_id ||
        childRole.agent !== row.definition_name
      ) {
        throw new Error("The recorded request identity does not match this submission.");
      }
      db.prepare("INSERT INTO agent_tree VALUES(?,?,?,?,?,?)").run(
        this.workspaceId,
        childSessionId,
        parent!.root_lead_session_id!,
        row.caller_session_id!,
        row.definition_name!,
        row.task_name!,
      );
      if (row.task_name !== null) {
        const bound = db
          .prepare(
            "UPDATE task_names SET child_session_id=? WHERE workspace_id=? AND request_id=? AND child_session_id IS NULL",
          )
          .run(childSessionId, this.workspaceId, requestId);
        if (bound.changes !== 1) {
          throw new Error("The recorded operation state does not permit this transition.");
        }
      }
      if (assignmentId !== null) {
        db.prepare("INSERT INTO assignments VALUES(?,?,?,?,?,'outstanding',?)").run(
          this.workspaceId,
          row.caller_session_id!,
          childSessionId,
          assignmentId,
          childInstanceId,
          row.payload!,
        );
      }
      db.prepare(
        "UPDATE operations SET state='succeeded',resolved_agent_id=?,error_code=NULL,error_message=NULL WHERE workspace_id=? AND request_id=?",
      ).run(childSessionId, this.workspaceId, requestId);
      db.prepare(
        "UPDATE execution_attempts SET state='succeeded' WHERE workspace_id=? AND request_id=?",
      ).run(this.workspaceId, requestId);
      db.prepare(
        "INSERT INTO launch_results VALUES(?,?,'succeeded',?,?,NULL,NULL) ON CONFLICT(workspace_id,request_id) DO UPDATE SET state='succeeded',child_session_id=excluded.child_session_id,assignment_id=excluded.assignment_id,error_code=NULL,error_message=NULL",
      ).run(this.workspaceId, requestId, childSessionId, assignmentId);
    });
  }

  /** Serialize completion authorization against all durable submissions and local execution evidence.
   * Return false when evidence has become ineligible. Human input remains best-effort and ungated.
   */
  authorizeCompletion(
    owner: Ownership,
    fence: AssignmentFence,
    eventId: string,
    requestId: string,
    deadline: number,
  ): boolean {
    return this.transaction(deadline, (db) => {
      this.writer(owner, true);
      const old = db
        .prepare(
          "SELECT * FROM completion_authorizations WHERE workspace_id=? AND session_id=? AND assignment_id=? AND state<>'cancelled'",
        )
        .get(this.workspaceId, fence.childSessionId, fence.assignmentId);
      if (old) {
        if (
          fence.workspaceId === this.workspaceId &&
          old.parent_session_id === fence.parentSessionId &&
          old.instance_id === fence.childInstanceId &&
          old.event_id === eventId &&
          old.request_id === requestId
        ) {
          return true;
        }
        throw new Error("The recorded request identity does not match this submission.");
      }
      const event = db
        .prepare(
          "SELECT * FROM execution_events WHERE workspace_id=? AND event_id=? AND session_id=? AND instance_id=? AND kind='turn_settled' AND outcome='success' AND length(trim(result_text))>0",
        )
        .get(this.workspaceId, eventId, fence.childSessionId, fence.childInstanceId);
      const assignment = db
        .prepare(
          "SELECT 1 FROM assignments WHERE workspace_id=? AND parent_session_id=? AND child_session_id=? AND assignment_id=? AND instance_id=? AND state='outstanding'",
        )
        .get(
          this.workspaceId,
          fence.parentSessionId,
          fence.childSessionId,
          fence.assignmentId,
          fence.childInstanceId,
        );
      const instance = db
        .prepare(
          "SELECT 1 FROM instances WHERE workspace_id=? AND session_id=? AND instance_id=? AND status='running' AND auto_exit=1 AND takeover=0",
        )
        .get(this.workspaceId, fence.childSessionId, fence.childInstanceId);
      const blocked = db
        .prepare(`
        SELECT 1 FROM operations o WHERE workspace_id=? AND recipient_session_id=? AND kind='message'
          AND (state IN ('pending','in_progress','uncertain') OR (state='succeeded' AND NOT EXISTS (
            SELECT 1 FROM input_processing p WHERE p.workspace_id=o.workspace_id AND p.request_id=o.request_id AND p.processed=1
          )))
        UNION ALL SELECT 1 FROM operations o WHERE workspace_id=? AND caller_session_id=? AND assignment_id=? AND kind IN ('report','automatic_report','unexpected_exit')
          AND NOT (kind='automatic_report' AND EXISTS (SELECT 1 FROM completion_authorizations c WHERE c.workspace_id=o.workspace_id AND c.request_id=o.request_id AND c.state='cancelled')
            AND (state='failed' OR EXISTS (SELECT 1 FROM receipts r WHERE r.workspace_id=o.workspace_id AND r.report_id=o.request_id)))
        UNION ALL SELECT 1 FROM assignments WHERE workspace_id=? AND parent_session_id=? AND state IN ('prepared','outstanding')
        UNION ALL SELECT 1 FROM pending_outcomes WHERE workspace_id=? AND parent_session_id=? AND delivery_state<>'processed'
        UNION ALL SELECT 1 FROM execution_events WHERE workspace_id=? AND session_id=? AND instance_id=? AND event_order>?
          AND kind IN ('human_input','turn_started','turn_settled','disrupted') LIMIT 1`)
        .get(
          this.workspaceId,
          fence.childSessionId,
          this.workspaceId,
          fence.childSessionId,
          fence.assignmentId,
          this.workspaceId,
          fence.childSessionId,
          this.workspaceId,
          fence.childSessionId,
          this.workspaceId,
          fence.childSessionId,
          fence.childInstanceId,
          event?.event_order ?? -1,
        );
      if (fence.workspaceId !== this.workspaceId || !event || !assignment || !instance || blocked) {
        return false;
      }
      db.prepare(
        "INSERT INTO operations(workspace_id,request_id,caller_session_id,recipient_session_id,kind,payload,assignment_id) VALUES(?,?,?,?,'automatic_report',?,?)",
      ).run(
        this.workspaceId,
        requestId,
        fence.childSessionId,
        fence.parentSessionId,
        event.result_text!,
        fence.assignmentId,
      );
      db.prepare("INSERT INTO completion_authorizations VALUES(?,?,?,?,?,?,?,'authorized')").run(
        this.workspaceId,
        fence.childSessionId,
        fence.assignmentId,
        fence.parentSessionId,
        fence.childInstanceId,
        eventId,
        requestId,
      );
      return true;
    });
  }

  /** Bind an idle resumed instance before delivering the original operation's input. */
  bindResumedMessage(
    owner: Ownership,
    requestId: string,
    instanceId: string,
    assignmentId: string,
    deadline: number,
  ): void {
    this.transaction(deadline, (db) => {
      this.writer(owner, true);
      const operation = db
        .prepare(
          "SELECT o.* FROM operations o JOIN execution_attempts e USING(workspace_id,request_id) WHERE o.workspace_id=? AND o.request_id=? AND o.kind='message' AND o.state='in_progress' AND e.command='resume'",
        )
        .get(this.workspaceId, requestId);
      const instance =
        operation &&
        db
          .prepare(
            "SELECT 1 FROM instances WHERE workspace_id=? AND session_id=? AND instance_id=? AND status='running'",
          )
          .get(this.workspaceId, operation.recipient_session_id!, instanceId);
      if (!operation || !instance) {
        throw new Error("The recorded operation state does not permit this transition.");
      }
      db.prepare("INSERT INTO assignments VALUES(?,?,?,?,?,'prepared',?)").run(
        this.workspaceId,
        operation.caller_session_id!,
        operation.recipient_session_id!,
        assignmentId,
        instanceId,
        operation.payload!,
      );
      db.prepare("INSERT INTO message_assignments VALUES(?,?,?,?,?,?)").run(
        this.workspaceId,
        requestId,
        operation.caller_session_id!,
        operation.recipient_session_id!,
        assignmentId,
        instanceId,
      );
    });
  }

  /** Consume receipt evidence, settle only its bound assignment, and retain processing protection.
   * Runs only on the lead queue; command acceptance alone never establishes parent receipt.
   */
  reconcileDeliveries(
    owner: Ownership,
    deadline: number,
    deferred: ReadonlySet<string> = new Set(),
  ): void {
    this.transaction(deadline, (db) => {
      this.writer(owner, true);
      const messages = db
        .prepare(
          "SELECT m.* FROM message_assignments m JOIN delivery_evidence d USING(workspace_id,request_id) WHERE m.workspace_id=? AND d.state='received'",
        )
        .all(this.workspaceId);
      for (const message of messages) {
        db.prepare(
          "UPDATE assignments SET state='outstanding' WHERE workspace_id=? AND parent_session_id=? AND assignment_id=? AND state='prepared'",
        ).run(this.workspaceId, message.parent_session_id!, message.assignment_id!);
      }
      const reports = db
        .prepare(
          "SELECT o.*,b.instance_id FROM operations o JOIN outbox b ON b.workspace_id=o.workspace_id AND b.report_id=o.request_id JOIN delivery_evidence d ON d.workspace_id=o.workspace_id AND d.request_id=o.request_id WHERE o.workspace_id=? AND o.kind IN ('report','automatic_report','unexpected_exit') AND o.state IN ('succeeded','uncertain') AND d.state='received' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.workspace_id=o.workspace_id AND r.parent_session_id=o.recipient_session_id AND r.report_id=o.request_id)",
        )
        .all(this.workspaceId);
      for (const report of reports) {
        if (deferred.has(String(report.request_id))) {
          continue;
        }
        const assignment = db
          .prepare(
            "SELECT state FROM assignments WHERE workspace_id=? AND parent_session_id=? AND child_session_id=? AND assignment_id=? AND instance_id=?",
          )
          .get(
            this.workspaceId,
            report.recipient_session_id!,
            report.caller_session_id!,
            report.assignment_id!,
            report.instance_id!,
          );
        const stale =
          report.kind === "automatic_report" && !this.completionCurrent(String(report.request_id));
        const late = assignment?.state !== "outstanding" || stale;
        db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?,?,? ,?)").run(
          this.workspaceId,
          report.recipient_session_id!,
          report.request_id!,
          report.caller_session_id!,
          report.assignment_id!,
          report.instance_id!,
          report.payload!,
          report.request_id!,
          Number(late),
        );
        db.prepare(
          "UPDATE outbox SET acknowledged=1 WHERE workspace_id=? AND child_session_id=? AND report_id=?",
        ).run(this.workspaceId, report.caller_session_id!, report.request_id!);
        if (stale) {
          db.prepare(
            "UPDATE completion_authorizations SET state='cancelled' WHERE workspace_id=? AND request_id=? AND state='authorized'",
          ).run(this.workspaceId, report.request_id!);
        }
        const reportId = report.kind === "unexpected_exit" ? null : report.request_id!;
        if (late) {
          if (reportId !== null && assignment?.state === "settled") {
            db.prepare("INSERT INTO pending_outcomes VALUES(?,?,?,?,?,?,'delivered',NULL)").run(
              this.workspaceId,
              report.recipient_session_id!,
              report.request_id!,
              report.assignment_id!,
              reportId,
              report.payload!,
            );
          }
          continue;
        }
        db.prepare("INSERT INTO settlements VALUES(?,?,?,?,?,?)").run(
          this.workspaceId,
          report.recipient_session_id!,
          report.assignment_id!,
          reportId === null ? "incomplete" : "report",
          reportId,
          report.payload!,
        );
        db.prepare(
          "UPDATE assignments SET state='settled' WHERE workspace_id=? AND parent_session_id=? AND assignment_id=? AND state='outstanding'",
        ).run(this.workspaceId, report.recipient_session_id!, report.assignment_id!);
        db.prepare("INSERT INTO pending_outcomes VALUES(?,?,?,?,?,?,'delivered',NULL)").run(
          this.workspaceId,
          report.recipient_session_id!,
          report.request_id!,
          report.assignment_id!,
          reportId,
          report.payload!,
        );
        db.prepare(
          "UPDATE completion_authorizations SET state='settled' WHERE workspace_id=? AND session_id=? AND assignment_id=? AND request_id=? AND state='authorized'",
        ).run(
          this.workspaceId,
          report.caller_session_id!,
          report.assignment_id!,
          report.request_id!,
        );
      }
      db.prepare(
        "UPDATE pending_outcomes SET delivery_state='processed',processing_turn_id=(SELECT p.turn_id FROM input_processing p WHERE p.workspace_id=pending_outcomes.workspace_id AND p.request_id=pending_outcomes.outcome_id) WHERE workspace_id=? AND delivery_state='delivered' AND EXISTS (SELECT 1 FROM input_processing p WHERE p.workspace_id=pending_outcomes.workspace_id AND p.request_id=pending_outcomes.outcome_id AND p.session_id=pending_outcomes.parent_session_id AND p.processed=1)",
      ).run(this.workspaceId);
    });
  }
}