import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CrewContext } from "../extension/context.ts";
import type { CoordinatorStore } from "../store/coordinator-store.ts";
import type { Ownership } from "../store/ownership.ts";
import { assertOwnership } from "../store/ownership.ts";
import type { OperationFailure } from "../domain/operation.ts";
import { request } from "../ipc/socket.ts";
import { completionIdle, reconcileLifecycle } from "./reconcile.ts";

/** Immutable durable input presented to a coordinator command planner. */
export interface CoordinatorOperation {
  readonly requestId: string;
  readonly callerSessionId: string;
  readonly recipientSessionId: string | null;
  readonly kind: "spawn" | "message" | "report" | "automatic_report" | "unexpected_exit" | "close";
  readonly payload: string;
  readonly definitionName: string | null;
  readonly taskName: string | null;
  readonly assignmentId: string | null;
  /** Caller-prepared configuration and selected conversation snapshot. */
  readonly launchDirectory: string | null;
}

/** A command's established result; thrown errors mean execution uncertainty, not confirmed failure. */
export type CommandOutcome =
  | {
      state: "succeeded";
      launch?: { sessionId: string; instanceId: string; assignmentId: string | null };
    }
  | { state: "failed" | "uncertain"; failure: OperationFailure };

/** One side effect, selected after checking current durable state and recipient availability.
 * execute must wait for command acceptance only, never model or assignment completion.
 * The coordinator records its result before planning or executing another command.
 */
export interface CommandPlan {
  command: "launch" | "resume" | "prompt" | "close";
  recipientInstanceId: string | null;
  execute(signal: AbortSignal): Promise<CommandOutcome>;
}

/** Planning issues no process commands or authoritative coordination mutations. Caller-side
 * configuration preparation may write private launch resources. Undefined leaves unavailable work
 * pending; explicit failures are retained without an attempt. Exceptions stop the queue.
 */
export type CommandPlanner = (
  operation: CoordinatorOperation,
  signal: AbortSignal,
) => Promise<CommandPlan | OperationFailure | undefined>;

/** Synchronous lifecycle decisions run inside the same queue and a short SQLite transaction.
 * They may consume durable evidence or authorize work, but cannot issue external commands.
 */
export type CoordinatorDecision = (db: DatabaseSync) => void;

/** Sole lead-hosted queue for command execution, evidence consumption, and lifecycle decisions. */
export class Coordinator {
  private readonly owner: Ownership;
  private readonly ledger: CoordinatorStore;
  private readonly epoch: number;
  private readonly abort = new AbortController();
  private readonly planners = new Map<CoordinatorOperation["kind"], CommandPlanner>();
  private readonly decisions = new Set<CoordinatorDecision>();
  private running?: Promise<void>;
  private dirty = false;
  private stopped = false;
  private readonly timer: ReturnType<typeof setInterval>;

  /** Bind the queue to this recorded lead instance before starting periodic recovery. */
  constructor(
    private readonly ctx: CrewContext,
    store: CoordinatorStore,
  ) {
    if (!ctx.ownership) {
      throw new Error("Only the recorded lead coordinator may change this operation's state.");
    }
    this.owner = ctx.ownership;
    this.ledger = store;
    this.epoch = ctx.epoch;
    this.current();
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref();
  }

  private current(): void {
    assertOwnership(this.owner);
    this.ledger.assertCoordinator(this.owner);
    if (
      this.stopped ||
      this.abort.signal.aborted ||
      this.ctx.epoch !== this.epoch ||
      this.ctx.ownership !== this.owner ||
      this.ctx.state.role.kind !== "lead" ||
      this.owner.workspaceFd === undefined ||
      this.ledger.role(this.owner.sessionId)?.kind !== "lead"
    ) {
      throw new Error("Only the recorded lead coordinator may change this operation's state.");
    }
  }

  /** Install one command implementation per durable operation kind; no endpoint executes it. */
  register(kind: CoordinatorOperation["kind"], planner: CommandPlanner): () => void {
    this.current();
    if (this.planners.has(kind)) {
      throw new Error("The recorded operation state does not permit this transition.");
    }
    this.planners.set(kind, planner);
    this.wake();
    return () => {
      if (this.planners.get(kind) === planner) {
        this.planners.delete(kind);
      }
    };
  }

  /** Register synchronous evidence/completion processing, ordered with all command outcomes. */
  registerDecision(decide: CoordinatorDecision): () => void {
    this.current();
    this.decisions.add(decide);
    this.wake();
    return () => {
      this.decisions.delete(decide);
    };
  }

  /** Startup, IPC, local/Herdr events, and periodic recovery coalesce into this single drain. */
  wake(): void {
    if (this.stopped) {
      return;
    }
    this.dirty = true;
    if (this.running) {
      return;
    }
    this.running = Promise.resolve()
      .then(() => this.drain())
      .catch((error) => {
        if (this.stopped) {
          return;
        }
        // Persistence failure must stop command execution, not allow another side effect.
        this.stopped = true;
        clearInterval(this.timer);
        this.abort.abort(error);
        if (this.ctx.epoch === this.epoch && this.ctx.ownership === this.owner) {
          this.ctx.sessionContext?.ui.notify(
            `Crew reconciliation failed: ${String(error)}`,
            "error",
          );
        }
      })
      .finally(() => {
        this.running = undefined;
        if (this.dirty && !this.stopped) {
          this.wake();
        }
      });
  }

  private async drain(): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      this.current();
      // A previous runtime may have died between issuing a command and recording its result.
      const interrupted = this.ledger.db
        .prepare(
          "SELECT o.request_id,o.recipient_session_id FROM operations o JOIN execution_attempts a USING(workspace_id,request_id) WHERE o.workspace_id=? AND o.state='in_progress'",
        )
        .all(this.owner.workspaceId);
      for (const row of interrupted) {
        this.ledger.failOperation(
          this.owner,
          String(row.request_id),
          "uncertain",
          {
            code: "outcome_unknown",
            message: "Crew execution unavailable.",
            agentId:
              row.recipient_session_id === null ? undefined : String(row.recipient_session_id),
          },
          Date.now() + 1000,
        );
      }
      await this.reconcileDeliveries();
      await reconcileLifecycle(
        { crew: this.ctx, coordinatorStore: this.ledger, coordinator: this },
        this.abort.signal,
      );
      this.current();
      for (const decide of this.decisions) {
        this.current();
        this.ledger.transaction(Date.now() + 1000, (db) => {
          this.current();
          return decide(db);
        });
      }
      const rows = this.ledger.db
        .prepare(
          "SELECT * FROM operations WHERE workspace_id=? AND state='pending' ORDER BY submission_order",
        )
        .all(this.owner.workspaceId);
      for (const row of rows) {
        this.current();
        const planner = this.planners.get(row.kind as CoordinatorOperation["kind"]);
        if (!planner) {
          continue;
        }
        // Unresolved commands fence their recipient; unrelated recipients remain runnable.
        const blocked =
          row.recipient_session_id !== null &&
          this.ledger.db
            .prepare(
              "SELECT 1 FROM operations WHERE workspace_id=? AND state IN ('in_progress','uncertain') AND (recipient_session_id=? OR resolved_agent_id=? OR (kind IN ('report','automatic_report','unexpected_exit') AND caller_session_id=?)) LIMIT 1",
            )
            .get(
              this.owner.workspaceId,
              row.recipient_session_id!,
              row.recipient_session_id!,
              row.recipient_session_id!,
            );
        if (blocked) {
          continue;
        }
        const operation: CoordinatorOperation = {
          requestId: String(row.request_id),
          callerSessionId: String(row.caller_session_id),
          recipientSessionId:
            row.recipient_session_id === null ? null : String(row.recipient_session_id),
          kind: row.kind as CoordinatorOperation["kind"],
          payload: String(row.payload),
          definitionName: row.definition_name === null ? null : String(row.definition_name),
          taskName: row.task_name === null ? null : String(row.task_name),
          assignmentId: row.assignment_id === null ? null : String(row.assignment_id),
          launchDirectory: row.launch_directory === null ? null : String(row.launch_directory),
        };
        const plan = await planner(operation, this.abort.signal);
        this.current();
        if (!plan) {
          continue;
        }
        if ("code" in plan) {
          this.ledger.failOperation(
            this.owner,
            operation.requestId,
            "failed",
            plan,
            Date.now() + 1000,
          );
          await this.notifyLaunch(operation);
          continue;
        }
        if (
          !this.ledger.beginAttempt(
            this.owner,
            operation.requestId,
            randomUUID(),
            plan.command,
            plan.recipientInstanceId,
            Date.now() + 1000,
          )
        ) {
          continue;
        }
        let outcome: CommandOutcome;
        try {
          outcome = await plan.execute(this.abort.signal);
        } catch (error) {
          outcome = {
            state: "uncertain",
            failure: { code: "outcome_unknown", message: String(error) },
          };
        }
        this.current();
        try {
          if (outcome.state !== "succeeded") {
            this.ledger.failOperation(
              this.owner,
              operation.requestId,
              outcome.state,
              outcome.failure,
              Date.now() + 1000,
            );
          } else if (operation.kind === "spawn") {
            if (!outcome.launch) {
              throw new Error("Child reported an invalid pi identity.");
            }
            this.ledger.recordLaunch(
              this.owner,
              operation.requestId,
              outcome.launch.sessionId,
              outcome.launch.instanceId,
              outcome.launch.assignmentId,
              Date.now() + 1000,
            );
          } else {
            this.ledger.completeOperation(this.owner, operation.requestId, Date.now() + 1000);
          }
        } catch (error) {
          // Command success followed by a failed SQL commit is execution uncertainty.
          this.ledger.failOperation(
            this.owner,
            operation.requestId,
            "uncertain",
            {
              code: "outcome_unknown",
              message: String(error),
              agentId:
                outcome.state === "succeeded" ? outcome.launch?.sessionId : outcome.failure.agentId,
            },
            Date.now() + 1000,
          );
        }
        await this.reconcileDeliveries();
        await this.notifyLaunch(operation);
      }
    }
  }

  private async reconcileDeliveries(): Promise<void> {
    this.current();
    // Actual recipient ingestion establishes an uncertain prompt's outcome without re-execution.
    const received = this.ledger.db
      .prepare(
        "SELECT o.request_id FROM operations o JOIN delivery_evidence d USING(workspace_id,request_id) WHERE o.workspace_id=? AND o.state='uncertain' AND d.state='received'",
      )
      .all(this.owner.workspaceId);
    for (const row of received) {
      this.ledger.completeOperation(this.owner, String(row.request_id), Date.now() + 1000);
    }
    const deferred = new Set<string>();
    const automatic = this.ledger.db
      .prepare(
        "SELECT c.request_id,c.session_id,c.instance_id,i.status FROM completion_authorizations c JOIN instances i USING(workspace_id,session_id,instance_id) JOIN delivery_evidence d USING(workspace_id,request_id) WHERE c.workspace_id=? AND c.state='authorized' AND d.state='received'",
      )
      .all(this.owner.workspaceId);
    await Promise.all(
      automatic.map(async (row) => {
        if (
          this.ledger.completionCurrent(String(row.request_id)) &&
          row.status !== "exited" &&
          !(await completionIdle(
            this.ctx,
            String(row.session_id),
            String(row.instance_id),
            this.abort.signal,
          ))
        ) {
          deferred.add(String(row.request_id));
        }
      }),
    );
    this.current();
    this.ledger.reconcileDeliveries(this.owner, Date.now() + 1000, deferred);
  }

  private async notifyLaunch(operation: CoordinatorOperation): Promise<void> {
    if (operation.kind === "spawn") {
      // Advisory reply only: periodic SQLite reads recover every missed notification.
      await request(
        this.owner.workspaceId,
        operation.callerSessionId,
        { kind: "launch-result", requestId: operation.requestId },
        this.abort.signal,
      ).catch(() => {});
    }
  }

  /** False once the queue is stopped or aborted, e.g. by teardown or a persistence failure. */
  get active(): boolean {
    return !this.stopped && !this.abort.signal.aborted;
  }

  /** Cancel planning/execution and join the in-flight drain before its ledger can be closed. */
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    await this.running;
    this.planners.clear();
    this.decisions.clear();
  }
}