import type { ReportSource } from "../domain/completion.ts";
import type { CrewContext } from "../extension/context.ts";
import { assertOwnership } from "../store/ownership.ts";

/** Read the current pane lifetime's durable mode independently of coordinator or parent availability. */
export function automaticMode(ctx: CrewContext): boolean {
  const { ownership: owner, ledger } = ctx;
  if (!owner || !ledger || ctx.state.role.kind !== "member" || ctx.state.takeover) {
    return false;
  }
  const instance = ledger.db
    .prepare(
      "SELECT auto_exit,takeover FROM instances WHERE workspace_id=? AND session_id=? AND instance_id=?",
    )
    .get(owner.workspaceId, owner.sessionId, owner.instanceId);
  return instance?.auto_exit === 1 && instance.takeover === 0;
}

/** One logical run, spanning low-level loops, retries, and queued continuations. */
export interface CompletionRun {
  turnId: string;
  latest?: ReportSource;
  outcome?: "completed" | "aborted" | "error";
  settled: boolean;
}

/** Release only the local instance. Process observers establish exit; notifications only wake readers. */
export async function sendShutdownDisconnect(ctx: CrewContext): Promise<void> {
  if (!ctx.ledger || !ctx.ownership) {
    return;
  }
  const owner = ctx.ownership;
  ctx.ledger.transaction(Date.now() + 1000, (db) => {
    assertOwnership(owner);
    db.prepare(
      "UPDATE instances SET status='released' WHERE workspace_id=? AND session_id=? AND instance_id=?",
    ).run(owner.workspaceId, owner.sessionId, owner.instanceId);
  });
  ctx.execution?.notify();
}