import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { MESSAGE_TYPE } from "../message-type.ts";
import type { CrewContext } from "../context.ts";

/** Observe actual model input without changing it. Rebind only durable, received, unprocessed
 * deliveries present in this request; navigation and recovery never replay missing outcomes.
 */
export function observeProcessing(ctx: CrewContext, event: ContextEvent): void {
  const { ledger, ownership: owner, run } = ctx;
  if (!ledger || !owner || !run || run.settled) {
    return;
  }
  for (const message of event.messages) {
    if (message.role !== "custom" || message.customType !== MESSAGE_TYPE) {
      continue;
    }
    const details = message.details as { requestId?: unknown } | undefined;
    if (typeof details?.requestId !== "string") {
      continue;
    }
    const received = ledger.db
      .prepare(
        "SELECT 1 FROM delivery_evidence d LEFT JOIN input_processing p USING(workspace_id,request_id) WHERE d.workspace_id=? AND d.request_id=? AND d.recipient_session_id=? AND d.state='received' AND (p.processed IS NULL OR p.processed=0)",
      )
      .get(owner.workspaceId, details.requestId, owner.sessionId);
    if (received) {
      ledger.recordInputTurn(owner, details.requestId, run.turnId, Date.now() + 1000);
    }
  }
}