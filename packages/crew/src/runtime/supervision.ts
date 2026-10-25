import type { CrewContext } from "./context.ts";
import { assertOwnership } from "./ownership.ts";
import { processPresence, rowProcess } from "./process-identity.ts";
import { watchHerdrEvents } from "../transport/herdr-events.ts";
import {
  discover,
  startPolling,
  type ConnectionSnapshot,
  type Poller,
} from "../transport/registry.ts";

/** Persist exact-instance observations only. Evidence never delivers input or settles work locally. */
function reconcileProcesses(ctx: CrewContext): void {
  const { ledger, ownership: owner } = ctx;
  if (!ledger || !owner) {
    return;
  }
  assertOwnership(owner);
  ctx.processes.clear();
  const rows = ledger.db
    .prepare("SELECT * FROM instances WHERE workspace_id=?")
    .all(owner.workspaceId);
  for (const instance of rows) {
    const presence =
      instance.status === "exited" ? "exited" : processPresence(rowProcess(instance));
    ctx.processes.set(String(instance.instance_id), presence);
    if (presence !== "exited" || instance.status === "exited") {
      continue;
    }
    ledger.transaction(Date.now() + 1000, (db) => {
      assertOwnership(owner);
      db.prepare(
        "UPDATE instances SET status='exited' WHERE workspace_id=? AND session_id=? AND instance_id=?",
      ).run(owner.workspaceId, instance.session_id!, instance.instance_id!);
      db.prepare(
        "INSERT INTO execution_events(workspace_id,event_id,session_id,instance_id,kind) VALUES(?,?,?,?,'process_exit') ON CONFLICT(workspace_id,event_id) DO NOTHING",
      ).run(
        owner.workspaceId,
        `exit:${instance.session_id}:${instance.instance_id}`,
        instance.session_id!,
        instance.instance_id!,
      );
    });
  }
}

/** Own discovery, exact-process evidence, event wakeups and one periodic reconciliation timer. */
export function startSupervision(
  ctx: CrewContext,
  onUpdate: (snapshot: ConnectionSnapshot) => void,
): Poller {
  let disposed = false;
  const epoch = ctx.epoch;
  const owner = ctx.ownership!;
  const ledger = ctx.ledger!;
  let events: ReturnType<typeof watchHerdrEvents> | undefined;
  const current = () =>
    !disposed && ctx.epoch === epoch && ctx.ownership === owner && ctx.ledger === ledger;
  const panes = () => {
    if (!current() || !owner || !ctx.ledger) {
      return [];
    }
    return ctx.ledger.db
      .prepare(
        "SELECT DISTINCT pane_id FROM instances WHERE workspace_id=? AND pane_id IS NOT NULL AND status<>'exited'",
      )
      .all(owner.workspaceId)
      .map((row) => String(row.pane_id));
  };
  const poller = startPolling(
    owner.sessionId,
    (snapshot) => {
      if (current()) {
        ctx.supervisionError = undefined;
        onUpdate(snapshot);
        ctx.execution?.notify();
      }
    },
    async (signal) => {
      signal.throwIfAborted();
      if (!current()) {
        throw new Error("Crew endpoint no longer owns this session.");
      }
      assertOwnership(owner);
      reconcileProcesses(ctx);
      const agents = await discover(owner.workspaceId, signal);
      signal.throwIfAborted();
      if (!current()) {
        throw new Error("Crew endpoint no longer owns this session.");
      }
      reconcileProcesses(ctx);
      events?.refresh(panes());
      return agents.filter((agent) => {
        const instance = ledger.db
          .prepare(
            "SELECT instance_id FROM instances WHERE workspace_id=? AND session_id=? AND status='running'",
          )
          .get(owner.workspaceId, agent.sessionId);
        return typeof agent.instanceId === "string" && instance?.instance_id === agent.instanceId;
      });
    },
  );
  const reconcile = () => {
    if (current()) {
      void poller.refresh().catch((error) => {
        if (current()) {
          ctx.supervisionError = String(error);
        }
      });
    }
  };
  try {
    events = watchHerdrEvents(reconcile, panes());
  } catch (error) {
    poller.stop();
    throw error;
  }
  ctx.refreshSupervision = reconcile;
  return {
    refresh: poller.refresh,
    latest: poller.latest,
    stop() {
      disposed = true;
      ctx.refreshSupervision = undefined;
      poller.stop();
      events?.stop();
    },
  };
}