import type { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { captureProcess } from "./process-identity.ts";
import {
  assertOwnership,
  ensureDirectory,
  identityKey,
  lockFile,
  stateDirectory,
  type Ownership,
} from "./ownership.ts";
import { SCHEMA, SCHEMA_VERSION } from "./ledger-schema.ts";
import type { Role } from "./state.ts";
import type { ExecutionEvent, OperationFailure, OperationSubmission } from "./types.ts";

/** Identities are opaque full IDs, never aliases, pane IDs or cwd-derived keys. */
export interface LedgerIdentity {
  workspaceId: string;
  sessionId: string;
  instanceId: string;
}
/** Fence coordinator decisions to the original parent, assignment, and child process instance. */
export interface AssignmentFence {
  workspaceId: string;
  parentSessionId: string;
  childSessionId: string;
  assignmentId: string;
  childInstanceId: string;
}
/** Stable report identity scoped to its original assignment and process instance. */
export interface ReportIdentity extends AssignmentFence {
  reportId: string;
}
/** Persistable active role; dormant sessions hold no coordination authority. */
export type ActiveRole = Exclude<Role, { kind: "dormant" }>;

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Atomic durable metadata replacement. A failed write/rename/fsync is activation failure. */
function writeMetadata(path: string, value: unknown): void {
  const temporary = `${path}.pending`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function metadata(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || value.version !== 1) {
    throw new Error(`Unsupported Crew metadata: ${path}`);
  }
  return value;
}

/** SQLite authority for a single workspace's roles, operations, and lifecycle evidence. */
export class Ledger {
  readonly db: DatabaseSync;
  readonly workspaceId: string;

  constructor(db: DatabaseSync, workspaceId: string) {
    this.db = db;
    this.workspaceId = workspaceId;
  }

  /** Short synchronous write unit. No awaits, external effects or nested transactions.
   * Busy waits are bounded by the caller's deadline; failure grants no acceptance.
   * Callers must authorize as the owning endpoint before entering this boundary.
   */
  transaction<T>(deadline: number, operation: (db: DatabaseSync) => T): T {
    const remaining = Math.floor(deadline - Date.now());
    if (remaining <= 0) {
      throw new Error("Crew ledger operation deadline expired; no work accepted.");
    }
    if (this.db.isTransaction) {
      throw new Error("Crew does not permit nested transactions.");
    }
    this.db.exec(`PRAGMA busy_timeout=${Math.min(remaining, 2_147_483_647)}`);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = operation(this.db);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("Crew transactions must be synchronous.");
      }
      if (Date.now() >= deadline) {
        throw new Error("Crew transaction deadline expired; no work accepted.");
      }
      this.db.exec(
        `PRAGMA busy_timeout=${Math.min(Math.max(1, Math.floor(deadline - Date.now())), 2_147_483_647)}`,
      );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    } finally {
      this.db.exec("PRAGMA busy_timeout=0");
    }
  }

  /** Resolve a historical root-lead address to its current workspace successor. */
  currentSessionId(sessionId: string): string {
    const retired = this.db
      .prepare("SELECT 1 FROM retired_leads WHERE workspace_id=? AND session_id=?")
      .get(this.workspaceId, sessionId);
    return retired
      ? String(
          this.db
            .prepare("SELECT session_id FROM lead_ownership WHERE workspace_id=?")
            .get(this.workspaceId)!.session_id,
        )
      : sessionId;
  }

  /** Read session metadata, including historical leads; ownership checks authorize writes. */
  role(sessionId: string): ActiveRole | undefined {
    const row = this.db
      .prepare("SELECT role,role_json FROM sessions WHERE workspace_id=? AND session_id=?")
      .get(this.workspaceId, sessionId);
    if (!row) {
      return undefined;
    }
    const role = JSON.parse(String(row.role_json)) as ActiveRole;
    if (
      role.kind !== row.role ||
      role.workspaceId !== this.workspaceId ||
      role.sessionId !== sessionId
    ) {
      throw new Error("Crew role identity is corrupt; restore the original ledger.");
    }
    if (role.kind === "member" && role.caller) {
      role.caller = this.currentSessionId(role.caller);
    }
    return role;
  }

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

  /** Validate a live local writer; only the current lead may make coordinator decisions. */
  private writer(owner: Ownership, coordinator = false): void {
    assertOwnership(owner);
    const instance = this.db
      .prepare(
        "SELECT s.role FROM sessions s JOIN instances i USING(workspace_id,session_id) WHERE s.workspace_id=? AND s.session_id=? AND i.instance_id=? AND i.status='running'",
      )
      .get(this.workspaceId, owner.sessionId, owner.instanceId);
    if (
      owner.workspaceId !== this.workspaceId ||
      !instance ||
      (coordinator &&
        (instance.role !== "lead" ||
          owner.workspaceFd === undefined ||
          this.db
            .prepare("SELECT session_id FROM lead_ownership WHERE workspace_id=?")
            .get(this.workspaceId)?.session_id !== owner.sessionId))
    ) {
      throw new Error("Only the recorded lead coordinator may change this operation's state.");
    }
  }

  /** Verify the active recorded lead's OS capability before entering coordinator-owned work. */
  assertCoordinator(owner: Ownership): void {
    this.writer(owner, true);
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

  /** Check the selected result against all later local activity without altering retained operations. */
  completionCurrent(requestId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM completion_authorizations c JOIN execution_events e ON e.workspace_id=c.workspace_id AND e.event_id=c.event_id JOIN instances i ON i.workspace_id=c.workspace_id AND i.session_id=c.session_id AND i.instance_id=c.instance_id WHERE c.workspace_id=? AND c.request_id=? AND c.state IN ('authorized','settled') AND i.takeover=0 AND NOT EXISTS (SELECT 1 FROM execution_events t WHERE t.workspace_id=c.workspace_id AND t.session_id=c.session_id AND t.instance_id=c.instance_id AND t.event_order>e.event_order AND t.kind IN ('human_input','turn_started','turn_settled','disrupted'))",
      )
      .get(this.workspaceId, requestId);
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

  /** Read-only correlated result; timeouts and disconnected waiters never mutate it. */
  launchResult(requestId: string) {
    return this.db
      .prepare(
        "SELECT r.*,o.task_name FROM launch_results r JOIN operations o USING(workspace_id,request_id) WHERE r.workspace_id=? AND r.request_id=?",
      )
      .get(this.workspaceId, requestId);
  }

  /** Release this connection without deleting durable coordination state. */
  close(): void {
    this.db.close();
  }
}

/** Probe without creating authority. The global binding detects cross-workspace resumes
 * even if the target workspace has never activated Crew. Fork IDs have no binding.
 */
export function checkSessionBinding(workspaceId: string, sessionId: string): boolean {
  const path = join(stateDirectory(), "sessions", `${identityKey(sessionId)}.json`);
  if (!existsSync(path)) {
    return false;
  }
  const binding = metadata(path);
  if (binding.workspaceId !== workspaceId || binding.sessionId !== sessionId) {
    throw new Error(
      "Crew session belongs to another workspace. Resume in the original workspace; copying JSONL does not transfer authority.",
    );
  }
  return true;
}

export function hasWorkspaceLedger(workspaceId: string): boolean {
  const root = stateDirectory();
  const key = identityKey(workspaceId);
  return (
    existsSync(join(root, "workspaces", `${key}.json`)) || existsSync(join(root, "workspaces", key))
  );
}

/** Creation only on first activation. Preparing metadata commits BEFORE database creation;
 * ready metadata commits AFTER SQL/schema/checkpoint. Interrupted initialization always
 * fails closed, including a missing DB or marker. No repair/reset/migration is implicit.
 */
export async function openLedger(workspaceId: string, initialize: boolean): Promise<Ledger> {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error(
      "Crew requires Node 24+ with built-in node:sqlite; pi remains usable without Crew.",
    );
  }
  const { DatabaseSync } = await import("node:sqlite");
  const root = stateDirectory();
  ensureDirectory(root);
  // Fail closed on remote, volatile and unqualified filesystems (including overlay).
  // This is a support policy, not proof of physical media/fsync correctness.
  const localFilesystems = new Set([0xef53, 0x58465342, 0x9123683e, 0xf2f52010, 0x2fc12fc1]);
  if (!localFilesystems.has(statfsSync(root).type)) {
    throw new Error(
      "Crew requires a local ext4, XFS, Btrfs, F2FS or ZFS state directory with reliable fsync and flock.",
    );
  }
  for (const name of ["runtime", "workspaces", "sessions"]) {
    ensureDirectory(join(root, name));
  }
  syncDirectory(dirname(root));
  syncDirectory(root);
  const key = identityKey(workspaceId);
  const fd = lockFile(join(root, "runtime", `initialize-${key}.lock`));
  let db: DatabaseSync | undefined;
  const dir = join(root, "workspaces", key);
  const marker = join(root, "workspaces", `${key}.json`);
  const path = join(dir, "ledger.sqlite");
  try {
    const fresh = !existsSync(marker) && !existsSync(dir) && !existsSync(`${marker}.pending`);
    if (fresh && !initialize) {
      throw new Error("Crew ledger is missing.");
    }
    if (!fresh) {
      if (!existsSync(marker)) {
        throw new Error("Crew initialization metadata is missing or interrupted.");
      }
      const info = metadata(marker);
      if (info.workspaceId !== workspaceId || info.state !== "ready" || !existsSync(path)) {
        throw new Error("Crew ledger is missing or initialization was interrupted.");
      }
    } else {
      writeMetadata(marker, { version: 1, workspaceId, state: "preparing" });
      mkdirSync(dir, { mode: 0o700 });
      syncDirectory(dirname(dir));
    }
    if (!localFilesystems.has(statfsSync(dir).type)) {
      throw new Error("Crew ledger must reside on a supported local persistent filesystem.");
    }
    db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const mode = db.prepare("PRAGMA journal_mode=WAL").get();
    db.exec("PRAGMA synchronous=FULL");
    if (
      mode?.journal_mode !== "wal" ||
      db.prepare("PRAGMA synchronous").get()?.synchronous !== 2 ||
      db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1
    ) {
      throw new Error("Crew required SQLite durability settings are unavailable.");
    }
    const ledger = new Ledger(db, workspaceId);
    if (fresh) {
      ledger.transaction(Date.now() + 5_000, (connection) => {
        connection.exec(SCHEMA);
        connection.prepare("INSERT INTO workspace VALUES(?,?)").run(workspaceId, SCHEMA_VERSION);
        connection.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      });
      db.exec("PRAGMA wal_checkpoint(FULL)");
      syncDirectory(dir);
      writeMetadata(marker, { version: 1, workspaceId, state: "ready" });
    }
    const workspace = db.prepare("SELECT workspace_id,schema_version FROM workspace").get();
    if (
      db.prepare("PRAGMA user_version").get()?.user_version !== SCHEMA_VERSION ||
      workspace?.workspace_id !== workspaceId ||
      workspace.schema_version !== SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported Crew ledger schema or workspace identity (requires schema ${SCHEMA_VERSION}). Preserve the original ledger; an explicit transactional upgrade is required for older development ledgers. No automatic migration or empty replacement is supported.`,
      );
    }
    if (
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    ) {
      throw new Error("Crew ledger integrity check failed.");
    }
    db.exec("PRAGMA busy_timeout=0");
    return ledger;
  } catch (error) {
    db?.close();
    throw new Error(
      `Crew ledger unavailable at ${path}. Restore the original state directory/ledger; do not delete metadata or reconstruct from JSONL. ${String(error)}`,
      { cause: error },
    );
  } finally {
    closeSync(fd);
  }
}