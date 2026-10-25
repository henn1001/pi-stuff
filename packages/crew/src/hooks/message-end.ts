import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";
import type { CrewContext } from "../runtime/context.ts";
import { observeDelivery } from "../runtime/assignments.ts";

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