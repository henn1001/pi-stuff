import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildLaunch,
  STARTUP_TIMEOUT_MS,
  type LaunchSpec,
  type LaunchResult,
} from "../launch/launch.ts";
import { isTaskName } from "../domain/ids.ts";
import { resolveMessageTarget } from "./submission.ts";
import type { CrewContext } from "../extension/context.ts";
import { assertOwnership, type Ownership } from "../store/ownership.ts";
import type { LocalStore } from "../store/local-store.ts";
import { assertSpawnPolicy } from "./policy.ts";
import type { ExecutionEvent, OperationSubmission } from "../domain/operation.ts";
import { NotConnectedError, UnresponsiveError, request } from "../ipc/socket.ts";

/** Submission acceptance identifies the recorded recipient, not delivery or settlement. */
export interface SubmissionAcceptance {
  accepted: true;
  agent_id: string;
}

/** Local durable adapter. Lead and member calls use identical writes; IPC conveys no work payload. */
export class Execution {
  private readonly owner: Ownership | undefined;
  private readonly ledger: LocalStore | undefined;
  private readonly epoch: number;
  private readonly abort = new AbortController();
  private notification?: Promise<void>;
  private readonly resultWaiters = new Map<string, () => void>();

  /** Capture the local endpoint identity so stale tool continuations cannot submit for a replacement. */
  constructor(private readonly ctx: CrewContext) {
    this.owner = ctx.ownership;
    this.ledger = ctx.ledger;
    this.epoch = ctx.epoch;
    this.current();
  }

  private current() {
    const owner = this.owner;
    const ledger = this.ledger;
    if (
      !owner ||
      !ledger ||
      this.abort.signal.aborted ||
      this.ctx.epoch !== this.epoch ||
      this.ctx.ownership !== owner ||
      this.ctx.ledger !== ledger
    ) {
      throw new Error("Crew execution requires endpoint ownership.");
    }
    assertOwnership(owner);
    return { owner, ledger };
  }

  /** Dispose notifications before the session's ledger and OS ownership are released. */
  async close(): Promise<void> {
    this.abort.abort();
    await this.notification;
  }

  /** Best-effort wake after commit; notification failure cannot revoke durable acceptance. */
  notify(): void {
    if (
      this.abort.signal.aborted ||
      this.ctx.epoch !== this.epoch ||
      this.ctx.ownership !== this.owner ||
      this.ctx.ledger !== this.ledger
    ) {
      return;
    }
    if (this.ctx.wakeCoordinator) {
      this.ctx.wakeCoordinator();
      return;
    }
    if (this.notification) {
      return;
    }
    this.notification = Promise.resolve()
      .then(async () => {
        const { owner, ledger } = this.current();
        const root = ledger.db
          .prepare(
            "SELECT root_lead_session_id FROM agent_tree WHERE workspace_id=? AND session_id=?",
          )
          .get(owner.workspaceId, owner.sessionId);
        if (root) {
          await request(
            owner.workspaceId,
            String(root.root_lead_session_id),
            { kind: "wake" },
            this.abort.signal,
          );
        }
      })
      .catch((error) => {
        if (
          this.abort.signal.aborted ||
          error instanceof NotConnectedError ||
          error instanceof UnresponsiveError
        ) {
          return;
        }
        if (this.ctx.epoch === this.epoch && this.ctx.ownership === this.owner) {
          this.ctx.sessionContext?.ui.notify(
            `Crew reconciliation failed: ${String(error)}`,
            "error",
          );
        }
      })
      .finally(() => {
        this.notification = undefined;
      });
  }

  /** Wake only the originating durable-result reader; this never delivers model input. */
  resultRecorded(requestId: string): void {
    this.resultWaiters.get(requestId)?.();
  }

  /** Validate under the submission transaction; no external effect occurs before acknowledgement. */
  submit(input: OperationSubmission, validate: () => void = () => {}): void {
    const { owner, ledger } = this.current();
    ledger.submit(owner, input, Date.now() + 1000, () => {
      if (input.kind === "spawn") {
        const definition = this.ctx.definitions.get(input.definitionName!);
        if (!definition) {
          throw new Error(`Unknown agent: ${input.definitionName}`);
        }
        assertSpawnPolicy(this.ctx, definition);
        if (
          (input.payload.trim() && definition.disableModelInvocation) ||
          (!input.payload.trim() && this.ctx.state.role.kind !== "lead")
        ) {
          throw new Error("Tree launches require assignment input.");
        }
      }
      return validate();
    });
    this.notify();
  }

  /** Persist local evidence during outages; coordinator decisions never run in the adapter. */
  record(event: ExecutionEvent): void {
    const { owner, ledger } = this.current();
    ledger.recordEvent(owner, event, Date.now() + 1000);
    this.notify();
  }

  /** Persist an initial launch request, then read only its correlated durable result.
   * Cancelling or timing out the waiter does not cancel the operation or permit re-execution.
   */
  async launch(spec: LaunchSpec, signal?: AbortSignal): Promise<LaunchResult> {
    const requestId = randomUUID();
    const waitSignal = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    waitSignal.throwIfAborted();
    const { owner, ledger } = this.current();
    const epoch = this.ctx.epoch;
    if (spec.workspaceId !== owner.workspaceId || spec.caller !== owner.sessionId || spec.resume) {
      throw new Error("Launch endpoint mismatch.");
    }
    if (spec.origin === "tool" && !isTaskName(spec.taskName)) {
      throw Object.assign(
        new Error(
          "spawn_agent failed: arguments must match the documented schema and contain non-whitespace text.",
        ),
        { code: "invalid_arguments" },
      );
    }
    let built;
    try {
      built = await buildLaunch(spec);
    } catch (error) {
      if (error instanceof Error && !("code" in error)) {
        throw Object.assign(error, { code: "precondition_failed" });
      }
      throw error;
    }
    try {
      waitSignal.throwIfAborted();
      this.current();
      this.submit(
        {
          requestId,
          callerSessionId: owner.sessionId,
          recipientSessionId: null,
          kind: "spawn",
          payload: spec.prompt ?? "",
          definitionName: spec.definition.name,
          taskName: spec.taskName ?? null,
          assignmentId: null,
          launchDirectory: built.directory,
        },
        () => {
          if (
            spec.origin === "tool" &&
            (!spec.prompt?.trim() || spec.definition.disableModelInvocation)
          ) {
            throw new Error("Tree launches require assignment input.");
          }
        },
      );
    } catch (error) {
      built.cleanup();
      throw error;
    }
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    try {
      for (;;) {
        const notified = new Promise<void>((resolve) => this.resultWaiters.set(requestId, resolve));
        waitSignal.throwIfAborted();
        if (
          this.ctx.ownership !== owner ||
          this.ctx.ledger !== ledger ||
          this.ctx.epoch !== epoch
        ) {
          throw new Error("Crew launch endpoint changed.");
        }
        const result = ledger.launchResult(requestId);
        if (result?.state === "succeeded") {
          const sessionId = String(result.child_session_id);
          const role = ledger.role(sessionId);
          const session = ledger.db
            .prepare("SELECT session_file FROM sessions WHERE workspace_id=? AND session_id=?")
            .get(owner.workspaceId, sessionId);
          const instance = ledger.db
            .prepare(
              "SELECT * FROM instances WHERE workspace_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1",
            )
            .get(owner.workspaceId, sessionId);
          if (role?.kind !== "member" || !session?.session_file || !instance) {
            throw new Error("Child reported an invalid pi identity.");
          }
          return {
            sessionId,
            sessionFile: String(session.session_file),
            agent: role.agent,
            origin: role.origin,
            caller: owner.sessionId,
            paneId: String(instance.pane_id ?? ""),
            title: role.title,
            definition: spec.definition,
            instanceId: String(instance.instance_id),
            taskName: result.task_name === null ? null : String(result.task_name),
          };
        }
        if (result && result.state !== "succeeded") {
          throw Object.assign(new Error(String(result.error_message)), {
            code: String(result.error_code),
          });
        }
        // This read is also the final check at timeout, with no await between check and expiry.
        if (Date.now() >= deadline) {
          throw Object.assign(
            new Error(
              "Spawn result wait timed out; the request may still complete. Its task name remains reserved. Do not retry automatically.",
            ),
            { code: "timeout" },
          );
        }
        const polling = new AbortController();
        try {
          await Promise.race([
            notified,
            delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, {
              signal: AbortSignal.any([waitSignal, polling.signal]),
            }),
          ]);
        } finally {
          polling.abort();
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        [
          "invalid_arguments",
          "permission_denied",
          "duplicate_task_name",
          "unknown_agent_type",
          "precondition_failed",
          "persistence_failed",
          "launch_failed",
          "timeout",
          "outcome_unknown",
        ].includes(error.code)
      ) {
        throw error;
      }
      // The durable request may have executed even when its caller can no longer read the result.
      throw Object.assign(
        new Error("spawn_agent failed: the current Crew endpoint is unavailable."),
        { code: "outcome_unknown" },
      );
    } finally {
      this.resultWaiters.delete(requestId);
    }
  }

  /** Persist a direct-neighbor message without probing, prompting, or resuming the recipient. */
  async prompt(
    recipient: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<SubmissionAcceptance> {
    signal?.throwIfAborted();
    const { owner } = this.current();
    if (!message.trim()) {
      throw new Error("Assignment prompt is required.");
    }
    recipient = resolveMessageTarget(this.ctx, recipient);
    this.submit({
      requestId: randomUUID(),
      callerSessionId: owner.sessionId,
      recipientSessionId: recipient,
      kind: "message",
      payload: message,
      definitionName: null,
      taskName: null,
      assignmentId: null,
    });
    return { accepted: true, agent_id: recipient };
  }

  /** Persist an interactive report; local completion evidence uses record instead. */
  report(message: string): SubmissionAcceptance {
    const { owner, ledger } = this.current();
    const assignment = ledger.db
      .prepare(
        "SELECT * FROM assignments WHERE workspace_id=? AND child_session_id=? AND state IN ('prepared','outstanding')",
      )
      .get(owner.workspaceId, owner.sessionId);
    if (!assignment) {
      throw Object.assign(
        new Error("report_task failed: no outstanding parent assignment exists."),
        { code: "precondition_failed" },
      );
    }
    const parent = String(assignment.parent_session_id);
    this.submit({
      requestId: randomUUID(),
      callerSessionId: owner.sessionId,
      recipientSessionId: parent,
      kind: "report",
      payload: message,
      definitionName: null,
      taskName: null,
      assignmentId: String(assignment.assignment_id),
    });
    return { accepted: true, agent_id: parent };
  }
}