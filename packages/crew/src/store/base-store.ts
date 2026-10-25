import type { DatabaseSync } from "node:sqlite";
import { assertOwnership, type Ownership } from "./ownership.ts";
import type { Role } from "../domain/role.ts";

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

/** Shared connection, transaction and read surface of the SQLite ledger.
 * One `Ledger` base per connection; `LocalStore` owns it and `CoordinatorStore` shares it.
 * Write facades add their own methods; reads here carry no authority.
 */
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

  /** Check the selected result against all later local activity without altering retained operations. */
  completionCurrent(requestId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM completion_authorizations c JOIN execution_events e ON e.workspace_id=c.workspace_id AND e.event_id=c.event_id JOIN instances i ON i.workspace_id=c.workspace_id AND i.session_id=c.session_id AND i.instance_id=c.instance_id WHERE c.workspace_id=? AND c.request_id=? AND c.state IN ('authorized','settled') AND i.takeover=0 AND NOT EXISTS (SELECT 1 FROM execution_events t WHERE t.workspace_id=c.workspace_id AND t.session_id=c.session_id AND t.instance_id=c.instance_id AND t.event_order>e.event_order AND t.kind IN ('human_input','turn_started','turn_settled','disrupted'))",
      )
      .get(this.workspaceId, requestId);
  }

  /** Read-only correlated result; timeouts and disconnected waiters never mutate it. */
  launchResult(requestId: string) {
    return this.db
      .prepare(
        "SELECT r.*,o.task_name FROM launch_results r JOIN operations o USING(workspace_id,request_id) WHERE r.workspace_id=? AND r.request_id=?",
      )
      .get(this.workspaceId, requestId);
  }

  /** Validate a live local writer; only the current lead may make coordinator decisions. */
  protected writer(owner: Ownership, coordinator = false): void {
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
}