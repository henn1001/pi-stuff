import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CrewContext } from "./context.ts";
import { assertOwnership } from "./ownership.ts";

/** One logical run, spanning low-level loops, retries, and queued continuations. */
export interface CompletionRun {
  turnId: string;
  latest?: AssistantMessage;
  outcome?: "completed" | "aborted" | "error";
  settled: boolean;
}

/** Select only the supplied current-run message; never search history. */
export function selectReport(message: AssistantMessage | undefined): string | undefined {
  const text = message?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text?.trim() ? text : undefined;
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