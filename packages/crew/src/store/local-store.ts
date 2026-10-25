import { existsSync } from "node:fs";
import { join } from "node:path";
import { captureProcess } from "./process-identity.ts";
import { assertOwnership, identityKey, stateDirectory, type Ownership } from "./ownership.ts";
import { Ledger, type ActiveRole } from "./base-store.ts";
import { metadata, writeMetadata } from "./metadata.ts";
import type { ExecutionEvent, OperationSubmission } from "../domain/operation.ts";

/** Write facade for work every Crew process performs without the lead, and the connection owner.
 *
 * Classification against coordination-rules ("Durable submission and local writes"):
 * - Local writers (any live instance of the session, `writer(owner)`): `submit` (durable
 *   inbox), `recordEvent` (local execution evidence), `recordInputTurn` (input turn record),
 *   `claimDelivery` and `receiveDelivery` (the receiving instance's own delivery evidence;
 *   the coordinator authorizes the input and reconciles, it does not write these rows).
 * - Session setup: `register` (OS ownership precedes role/instance registration; a lead
 *   registration transfers routing), `restore` (read snapshot), `close` (connection owner).
 * - Lead-hosted exception: `attachMember` records a joined member's parent on the lead's
 *   attachment handshake. It requires coordinator ownership (`writer(owner, true)`) but is part
 *   of attachment, which the local adapter runs in the lead process; it stays here and checks
 *   ownership itself. Reclassify when attachment moves behind the coordinator queue.
 * Shared reads (`role`, `currentSessionId`, `completionCurrent`, `launchResult`) live in `Ledger`.
 */
export class LocalStore extends Ledger {
  /** Session-wide snapshot, independent of the selected conversation branch. */
  restore(sessionId: string, instanceId: string) {
    const rows = (table: string, owner: string) =>
      this.db
        .prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND ${owner}=?`)
        .all(this.workspaceId, sessionId);
    const session = this.db
      .prepare("SELECT session_file FROM sessions WHERE workspace_id=? AND session_id=?")
      .get(this.workspaceId, sessionId);
    // Missing conversation is inspectable, never authority deletion or exit evidence.
    const recoveryErrors =
      session?.session_file && !existsSync(String(session.session_file))
        ? [
            `Conversation file unavailable: ${session.session_file}. Ledger responsibilities remain active (the file may not yet have been written).`,
          ]
        : [];
    return this.transaction(Date.now() + 5_000, () => ({
      recoveryErrors,
      role: this.role(sessionId),
      relationships: rows("relationships", "owner_session_id"),
      assignments: rows("assignments", "parent_session_id"),
      settlements: rows("settlements", "parent_session_id"),
      outbox: rows("outbox", "child_session_id"),
      receipts: rows("receipts", "parent_session_id"),
      tree: rows("agent_tree", "session_id"),
      operations: this.db
        .prepare(
          "SELECT * FROM operations WHERE workspace_id=? AND (caller_session_id=? OR recipient_session_id=?) ORDER BY submission_order",
        )
        .all(this.workspaceId, sessionId, sessionId),
      executionEvents: rows("execution_events", "session_id"),
      inputProcessing: rows("input_processing", "session_id"),
      completionAuthorizations: rows("completion_authorizations", "session_id"),
      pendingOutcomes: rows("pending_outcomes", "parent_session_id").filter(
        (row) => row.delivery_state !== "processed",
      ),
      instance: this.db
        .prepare("SELECT * FROM instances WHERE workspace_id=? AND session_id=? AND instance_id=?")
        .get(this.workspaceId, sessionId, instanceId),
    }));
  }

  /** OS ownership precedes durable role/instance registration and any advertising.
   * Reload reuses the holder instance; resume creates a new instance and resets takeover.
   * Old instances remain inspectable; replacement is not evidence of their exit.
   */
  register(
    owner: Ownership,
    role: ActiveRole,
    sessionFile: string | undefined,
    autoExit = false,
  ): void {
    if (
      owner.workspaceId !== this.workspaceId ||
      owner.sessionId !== role.sessionId ||
      role.workspaceId !== this.workspaceId ||
      (role.kind === "lead") !== (owner.workspaceFd !== undefined)
    ) {
      throw new Error("Crew registration requires matching OS ownership.");
    }
    assertOwnership(owner);
    const root = stateDirectory();
    const path = join(root, "sessions", `${identityKey(owner.sessionId)}.json`);
    if (existsSync(path)) {
      const binding = metadata(path);
      if (binding.workspaceId !== this.workspaceId || binding.sessionId !== owner.sessionId) {
        throw new Error(
          "Crew cross-workspace resume is not supported; use the original workspace and ledger.",
        );
      }
    } else {
      // Binding precedes SQL: interruption can refuse recovery, never silently move authority.
      writeMetadata(path, {
        version: 1,
        workspaceId: this.workspaceId,
        sessionId: owner.sessionId,
      });
    }
    const { processStart, bootId, hostId } = captureProcess();
    this.transaction(Date.now() + 5_000, (db) => {
      const existing = this.role(owner.sessionId);
      const effectiveRole =
        role.kind === "member" && role.caller
          ? { ...role, caller: this.currentSessionId(role.caller) }
          : role;
      if (existing && JSON.stringify(existing) !== JSON.stringify(effectiveRole)) {
        throw new Error(
          "Crew persisted role conflicts with activation; no role migration is supported.",
        );
      }
      db.prepare(
        "INSERT INTO sessions(workspace_id,session_id,role,role_json,session_file) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,session_id) DO UPDATE SET session_file=excluded.session_file",
      ).run(
        this.workspaceId,
        owner.sessionId,
        role.kind,
        JSON.stringify(role),
        sessionFile ?? null,
      );
      if (role.kind === "lead") {
        const previous = db
          .prepare("SELECT session_id FROM lead_ownership WHERE workspace_id=?")
          .get(this.workspaceId);
        db.prepare(
          "INSERT INTO lead_ownership VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET session_id=excluded.session_id",
        ).run(this.workspaceId, owner.sessionId);
        if (previous && previous.session_id !== owner.sessionId) {
          this.transferLead(String(previous.session_id), owner.sessionId);
        }
        db.prepare(
          "INSERT INTO agent_tree VALUES(?,?,?,NULL,NULL,NULL) ON CONFLICT DO NOTHING",
        ).run(this.workspaceId, owner.sessionId, owner.sessionId);
      }
      db.prepare(
        "UPDATE instances SET status='released' WHERE workspace_id=? AND session_id=? AND instance_id<>? AND status='running'",
      ).run(this.workspaceId, owner.sessionId, owner.instanceId);
      db.prepare(
        "INSERT INTO instances(workspace_id,session_id,instance_id,pid,process_start,host_id,boot_id,pane_id,auto_exit,status) VALUES(?,?,?,?,?,?,?,?,?,'running') ON CONFLICT DO NOTHING",
      ).run(
        this.workspaceId,
        owner.sessionId,
        owner.instanceId,
        process.pid,
        processStart,
        hostId,
        bootId,
        process.env.HERDR_PANE_ID ?? null,
        Number(autoExit),
      );
    });
  }

  /** Rebind routing under the workspace lock without replaying or replacing durable work.
   * Identity triggers are suspended only inside the registration transaction and restored
   * before commit. Deferred foreign keys validate the complete transferred graph.
   */
  private transferLead(previous: string, successor: string): void {
    const db = this.db;
    db.exec("PRAGMA defer_foreign_keys=ON");
    const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    for (const trigger of triggers) {
      db.exec(`DROP TRIGGER ${quote(String(trigger.name))}`);
    }
    // Process instances and execution evidence keep their original session identity.
    // Only root addresses and parent/caller/recipient routing move to the successor.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    for (const table of tables) {
      const name = String(table.name);
      if (name === "delivery_evidence") {
        continue;
      }
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
      const fields = columns
        .map((column) => String(column.name))
        .filter(
          (field) =>
            [
              "root_lead_session_id",
              "parent_session_id",
              "owner_session_id",
              "caller_session_id",
              "recipient_session_id",
            ].includes(field) ||
            (name === "agent_tree" && field === "session_id"),
        );
      if (fields.length) {
        db.prepare(
          `UPDATE ${quote(name)} SET ${fields.map((field) => `${quote(field)}=CASE WHEN ${quote(field)}=? THEN ? ELSE ${quote(field)} END`).join(",")} WHERE workspace_id=?`,
        ).run(...fields.flatMap(() => [previous, successor]), this.workspaceId);
      }
    }
    db.prepare(
      "INSERT INTO retired_leads VALUES(?,?,?) ON CONFLICT(workspace_id,session_id) DO UPDATE SET successor_session_id=excluded.successor_session_id",
    ).run(this.workspaceId, previous, successor);
    db.prepare(
      "UPDATE instances SET status='released' WHERE workspace_id=? AND session_id=? AND status='running'",
    ).run(this.workspaceId, previous);
    for (const trigger of triggers) {
      db.exec(String(trigger.sql));
    }
  }

  /** Record an independent member's immutable parent and root without starting an assignment. */
  attachMember(
    owner: Ownership,
    childSessionId: string,
    parentSessionId: string,
    deadline: number,
  ): void {
    this.transaction(deadline, (db) => {
      this.writer(owner, true);
      const parent = db
        .prepare(
          "SELECT root_lead_session_id FROM agent_tree WHERE workspace_id=? AND session_id=?",
        )
        .get(this.workspaceId, parentSessionId);
      const child = db
        .prepare("SELECT * FROM agent_tree WHERE workspace_id=? AND session_id=?")
        .get(this.workspaceId, childSessionId);
      if (child) {
        if (child.parent_session_id !== parentSessionId) {
          throw new Error("The recorded request identity does not match this submission.");
        }
        return;
      }
      if (!parent || parentSessionId !== owner.sessionId) {
        throw new Error("The recorded operation state does not permit this transition.");
      }
      const role = this.role(childSessionId);
      if (role?.kind !== "member") {
        throw new Error("The recorded operation state does not permit this transition.");
      }
      db.prepare("INSERT INTO agent_tree VALUES(?,?,?,?,?,NULL)").run(
        this.workspaceId,
        childSessionId,
        parent.root_lead_session_id!,
        parentSessionId,
        role.defaultDefinition ? null : role.agent,
      );
    });
  }

  /** Persist a stable request and its task-name reservation in one write transaction.
   * Synchronous adapter policy validation and recorded-relationship checks share this boundary.
   */
  submit(
    owner: Ownership,
    input: OperationSubmission,
    deadline: number,
    validate: () => void = () => {},
  ): void {
    this.transaction(deadline, (db) => {
      this.writer(owner);
      if (input.callerSessionId !== owner.sessionId) {
        throw new Error("The recorded request identity does not match this submission.");
      }
      const old = db
        .prepare("SELECT * FROM operations WHERE workspace_id=? AND request_id=?")
        .get(this.workspaceId, input.requestId);
      const values = [
        input.callerSessionId,
        input.recipientSessionId,
        input.kind,
        input.payload,
        input.definitionName,
        input.taskName,
        input.assignmentId,
        input.launchDirectory ?? null,
      ];
      if (old) {
        const keys = [
          "caller_session_id",
          "recipient_session_id",
          "kind",
          "payload",
          "definition_name",
          "task_name",
          "assignment_id",
          "launch_directory",
        ];
        if (keys.some((key, index) => old[key] !== values[index])) {
          throw new Error("The recorded request identity does not match this submission.");
        }
        return;
      }
      const validation: unknown = validate();
      if (validation && typeof (validation as { then?: unknown }).then === "function") {
        throw new Error("Crew transactions must be synchronous.");
      }
      if (input.kind === "report") {
        const assignment = db
          .prepare(
            "SELECT 1 FROM assignments a WHERE workspace_id=? AND parent_session_id=? AND child_session_id=? AND assignment_id=? AND (state='outstanding' OR (state='prepared' AND EXISTS (SELECT 1 FROM message_assignments m JOIN delivery_evidence d USING(workspace_id,request_id) WHERE m.workspace_id=a.workspace_id AND m.assignment_id=a.assignment_id AND m.child_session_id=a.child_session_id AND d.state='received')))",
          )
          .get(this.workspaceId, input.recipientSessionId, owner.sessionId, input.assignmentId);
        const mode = db
          .prepare(
            "SELECT auto_exit,takeover FROM instances WHERE workspace_id=? AND session_id=? AND instance_id=?",
          )
          .get(this.workspaceId, owner.sessionId, owner.instanceId);
        const blocked = db
          .prepare(
            "SELECT 1 FROM assignments WHERE workspace_id=? AND parent_session_id=? AND state IN ('prepared','outstanding') UNION ALL SELECT 1 FROM pending_outcomes WHERE workspace_id=? AND parent_session_id=? AND delivery_state<>'processed' LIMIT 1",
          )
          .get(this.workspaceId, owner.sessionId, this.workspaceId, owner.sessionId);
        if (mode?.auto_exit === 1 && mode.takeover !== 1) {
          throw Object.assign(
            new Error(
              "report_task failed: non-interactive agents complete automatically; explicit reporting requires interactive mode.",
            ),
            { code: "precondition_failed" },
          );
        }
        if (!assignment) {
          throw Object.assign(
            new Error("report_task failed: no outstanding parent assignment exists."),
            { code: "precondition_failed" },
          );
        }
        if (blocked) {
          throw Object.assign(
            new Error(
              "report_task failed: outstanding child assignments or unprocessed child outcomes remain.",
            ),
            { code: "precondition_failed" },
          );
        }
      }
      const related =
        input.kind === "spawn"
          ? db
              .prepare("SELECT 1 FROM agent_tree WHERE workspace_id=? AND session_id=?")
              .get(this.workspaceId, owner.sessionId)
          : db
              .prepare(
                "SELECT 1 FROM agent_tree WHERE workspace_id=? AND ((session_id=? AND parent_session_id=?) OR (session_id=? AND parent_session_id=?))",
              )
              .get(
                this.workspaceId,
                owner.sessionId,
                input.recipientSessionId,
                input.recipientSessionId,
                owner.sessionId,
              );
      const ready =
        input.kind === "spawn" ||
        db
          .prepare(
            "SELECT count(*) AS n FROM relationships WHERE workspace_id=? AND stage='ready' AND ((child_session_id=? AND parent_session_id=?) OR (child_session_id=? AND parent_session_id=?))",
          )
          .get(
            this.workspaceId,
            owner.sessionId,
            input.recipientSessionId,
            input.recipientSessionId,
            owner.sessionId,
          )?.n === 2;
      if (!related || !ready || (!input.payload.trim() && input.kind !== "spawn")) {
        const tool =
          input.kind === "report"
            ? "report_task"
            : input.kind === "message"
              ? "send_message"
              : "spawn_agent";
        throw Object.assign(
          new Error(`${tool} failed: attachment to the recorded parent is not ready.`),
          { code: "precondition_failed" },
        );
      }
      if (
        input.kind === "spawn" &&
        db
          .prepare(
            "SELECT 1 FROM completion_authorizations c JOIN instances i USING(workspace_id,session_id,instance_id) WHERE c.workspace_id=? AND c.session_id=? AND c.instance_id=? AND c.state IN ('authorized','settled','closed') AND i.auto_exit=1 AND i.takeover=0",
          )
          .get(this.workspaceId, owner.sessionId, owner.instanceId)
      ) {
        throw Object.assign(
          new Error("spawn_agent failed: the current Crew endpoint is unavailable."),
          { code: "precondition_failed" },
        );
      }
      if (
        input.taskName !== null &&
        db
          .prepare(
            "SELECT 1 FROM task_names WHERE workspace_id=? AND parent_session_id=? AND task_name=? UNION ALL SELECT 1 FROM agent_tree WHERE workspace_id=? AND parent_session_id=? AND task_name=?",
          )
          .get(
            this.workspaceId,
            owner.sessionId,
            input.taskName,
            this.workspaceId,
            owner.sessionId,
            input.taskName,
          )
      ) {
        throw Object.assign(new Error("Task name is already reserved or assigned to a child."), {
          code: "duplicate_task_name",
        });
      }
      db.prepare(
        "INSERT INTO operations(workspace_id,request_id,caller_session_id,recipient_session_id,kind,payload,definition_name,task_name,assignment_id,launch_directory) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(this.workspaceId, input.requestId, ...values);
    });
  }

  /** Persist local evidence without requiring coordinator availability. Duplicate IDs are immutable. */
  recordEvent(owner: Ownership, event: ExecutionEvent, deadline: number): void {
    this.transaction(deadline, (db) => {
      this.writer(owner);
      if (event.sessionId !== owner.sessionId || event.instanceId !== owner.instanceId) {
        throw new Error("The recorded request identity does not match this submission.");
      }
      const old = db
        .prepare("SELECT * FROM execution_events WHERE workspace_id=? AND event_id=?")
        .get(this.workspaceId, event.eventId);
      const values = [
        event.sessionId,
        event.instanceId,
        event.kind,
        event.turnId,
        event.outcome,
        event.resultText,
      ];
      if (old) {
        const keys = ["session_id", "instance_id", "kind", "turn_id", "outcome", "result_text"];
        if (keys.some((key, index) => old[key] !== values[index])) {
          throw new Error("The recorded request identity does not match this submission.");
        }
        return;
      }
      db.prepare(
        "INSERT INTO execution_events(workspace_id,event_id,session_id,instance_id,kind,turn_id,outcome,result_text) VALUES(?,?,?,?,?,?,?,?)",
      ).run(this.workspaceId, event.eventId, ...values);
      if (event.kind === "turn_settled" && event.outcome === "success") {
        db.prepare(
          "UPDATE input_processing SET processed=1 WHERE workspace_id=? AND session_id=? AND instance_id=? AND turn_id=? AND processed=0",
        ).run(this.workspaceId, event.sessionId, event.instanceId, event.turnId);
      }
      if (event.kind === "disrupted") {
        db.prepare(
          "UPDATE instances SET takeover=1 WHERE workspace_id=? AND session_id=? AND instance_id=?",
        ).run(this.workspaceId, event.sessionId, event.instanceId);
      }
    });
  }

  /** Associate received input with its actual local processing turn, not command acceptance.
   * Associate before recording the terminal event. Failed turns leave input unprocessed;
   * a later actual turn may take responsibility for it without redelivering the input.
   */
  recordInputTurn(owner: Ownership, requestId: string, turnId: string, deadline: number): void {
    this.transaction(deadline, (db) => {
      this.writer(owner);
      const started = db
        .prepare(
          "SELECT 1 FROM execution_events e WHERE workspace_id=? AND session_id=? AND instance_id=? AND turn_id=? AND kind='turn_started' AND NOT EXISTS (SELECT 1 FROM execution_events t WHERE t.workspace_id=e.workspace_id AND t.session_id=e.session_id AND t.turn_id=e.turn_id AND t.kind='turn_settled')",
        )
        .get(this.workspaceId, owner.sessionId, owner.instanceId, turnId);
      const existing = db
        .prepare("SELECT * FROM input_processing WHERE workspace_id=? AND request_id=?")
        .get(this.workspaceId, requestId);
      if (
        existing?.session_id === owner.sessionId &&
        existing.instance_id === owner.instanceId &&
        existing.turn_id === turnId
      ) {
        return;
      }
      if (!started || (existing && existing.session_id !== owner.sessionId)) {
        throw new Error("The recorded request identity does not match this submission.");
      }
      db.prepare(
        "INSERT INTO input_processing VALUES(?,?,?,?,?,0) ON CONFLICT(workspace_id,request_id) DO UPDATE SET instance_id=excluded.instance_id,turn_id=excluded.turn_id",
      ).run(this.workspaceId, requestId, owner.sessionId, owner.instanceId, turnId);
    });
  }

  /** Claim only this instance's coordinator-authorized input. A claimed input is never replayed. */
  claimDelivery(owner: Ownership, requestId: string, deadline: number) {
    return this.transaction(deadline, (db) => {
      this.writer(owner);
      const operation = db
        .prepare(
          "SELECT o.* FROM operations o JOIN execution_attempts a USING(workspace_id,request_id) WHERE o.workspace_id=? AND o.request_id=? AND o.recipient_session_id=? AND ((a.recipient_instance_id=? AND a.command='prompt') OR (a.command='resume' AND EXISTS (SELECT 1 FROM message_assignments m WHERE m.workspace_id=o.workspace_id AND m.request_id=o.request_id AND m.instance_id=?))) AND o.state IN ('in_progress','succeeded','uncertain') AND NOT EXISTS (SELECT 1 FROM delivery_evidence d WHERE d.workspace_id=o.workspace_id AND d.request_id=o.request_id)",
        )
        .get(this.workspaceId, requestId, owner.sessionId, owner.instanceId, owner.instanceId);
      if (!operation) {
        return undefined;
      }
      db.prepare("INSERT INTO delivery_evidence VALUES(?,?,?,?,'enqueued')").run(
        this.workspaceId,
        requestId,
        owner.sessionId,
        owner.instanceId,
      );
      return operation;
    });
  }

  /** Record actual local message ingestion. Model-request observation establishes processing separately. */
  receiveDelivery(owner: Ownership, requestId: string, turnId: string, deadline: number): void {
    this.transaction(deadline, (db) => {
      this.writer(owner);
      const delivery = db
        .prepare(
          "SELECT * FROM delivery_evidence WHERE workspace_id=? AND request_id=? AND recipient_session_id=? AND instance_id=?",
        )
        .get(this.workspaceId, requestId, owner.sessionId, owner.instanceId);
      const started = db
        .prepare(
          "SELECT 1 FROM execution_events WHERE workspace_id=? AND session_id=? AND instance_id=? AND turn_id=? AND kind='turn_started'",
        )
        .get(this.workspaceId, owner.sessionId, owner.instanceId, turnId);
      if (!delivery || !started) {
        throw new Error("The recorded request identity does not match this submission.");
      }
      if (delivery.state === "enqueued") {
        db.prepare(
          "UPDATE delivery_evidence SET state='received' WHERE workspace_id=? AND request_id=?",
        ).run(this.workspaceId, requestId);
      }
    });
  }

  /** Release this connection without deleting durable coordination state. */
  close(): void {
    this.db.close();
  }
}