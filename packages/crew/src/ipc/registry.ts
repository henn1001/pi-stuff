import type { AgentInfo } from "./protocol.ts";
import { listSocketIds, request } from "./socket.ts";

export const POLL_INTERVAL_MS = 3_000;

/** Latest workspace-wide observations, excluding self; never proof of current liveness. */
export interface ConnectionSnapshot {
  agents: AgentInfo[];
  leadConnected: boolean;
}

/** Shared, cancellable runtime observation passes. */
export interface Poller {
  stop(): void;
  /** Concurrent callers join the same discovery pass. Rejects after stop. */
  refresh(): Promise<ConnectionSnapshot>;
  latest(): ConnectionSnapshot;
}

/** Schedule one observation pass at a time; manual refreshes join the active pass. */
export function startPolling(
  selfSessionId: string,
  onUpdate: (snap: ConnectionSnapshot) => void,
  probe: (signal: AbortSignal) => Promise<AgentInfo[]>,
): Poller {
  const controller = new AbortController();
  let snapshot: ConnectionSnapshot = { agents: [], leadConnected: false };
  let inFlight: Promise<ConnectionSnapshot> | undefined;

  const copy = (): ConnectionSnapshot => ({
    ...snapshot,
    agents: snapshot.agents.map((agent) => ({ ...agent })),
  });

  const refresh = (): Promise<ConnectionSnapshot> => {
    if (controller.signal.aborted) {
      return Promise.reject(controller.signal.reason);
    }

    return (inFlight ??= probe(controller.signal)
      .then((all) => {
        controller.signal.throwIfAborted();
        const agents = all.filter((agent) => agent.sessionId !== selfSessionId);
        snapshot = { agents, leadConnected: agents.some((agent) => agent.role === "lead") };
        onUpdate(copy());
        return copy();
      })
      .finally(() => {
        inFlight = undefined;
      }));
  };

  // Automatic refresh errors are observable to manual refresh callers; keep the timer alive.
  const tick = () => {
    void refresh().catch(() => {});
  };
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
      controller.abort(new Error("Crew polling stopped."));
    },
    refresh,
    latest: copy,
  };
}

/** Probe independent identities concurrently; only request() prunes verified refusals. */
export async function discover(workspaceId: string, signal?: AbortSignal): Promise<AgentInfo[]> {
  signal?.throwIfAborted();

  const ids = await listSocketIds(workspaceId);
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const reply = await request(workspaceId, id, { kind: "ping" }, signal);
      return reply.ok && reply.info?.sessionId === id ? reply.info : undefined;
    }),
  );

  signal?.throwIfAborted();

  return results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
}