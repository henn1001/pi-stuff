import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { CrewContext } from "../context.ts";
import { MESSAGE_TYPE } from "../message-type.ts";

/** Message ingestion, not Herdr admission, proves recipient receipt and starts processing protection. */
export function observeDelivery(ctx: CrewContext, event: MessageEndEvent): void {
  const message = event.message;
  const run = ctx.run;
  if (
    message.role !== "custom" ||
    message.customType !== MESSAGE_TYPE ||
    !run ||
    run.settled ||
    !ctx.ledger ||
    !ctx.ownership
  ) {
    return;
  }
  const details = message.details as { requestId?: unknown } | undefined;
  if (typeof details?.requestId !== "string") {
    return;
  }
  ctx.ledger.receiveDelivery(ctx.ownership, details.requestId, run.turnId, Date.now() + 1000);
  ctx.execution?.notify();
}

/** Track only this run's latest assistant message, including blank and tool-only messages. */
export function onMessageEnd(ctx: CrewContext) {
  return (event: MessageEndEvent): void => {
    observeDelivery(ctx, event);
    const run = ctx.run;

    if (!run || event.message.role !== "assistant") {
      return;
    }

    run.latest = event.message;
  };
}