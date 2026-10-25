import { randomUUID } from "node:crypto";
import type { InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { formatIncoming } from "../prompts/messages.ts";
import { MESSAGE_TYPE } from "../message-type.ts";
import type { CrewContext } from "../context.ts";

/** Consume only durable, exact-instance delivery authorizations; invalid transport markers never reach the model. */
export function receiveInput(ctx: CrewContext, event: InputEvent): InputEventResult | undefined {
  const marker = /\[\[crew-delivery:([a-zA-Z0-9._:-]+)\]\]/g;
  const deliveries = [...event.text.matchAll(marker)];
  if (!deliveries.length) {
    return undefined;
  }
  // Terminal paste may meet an unsent editor draft. Preserve it as UI text, never as Crew input.
  const draft = event.text.replace(marker, "");
  if (draft) {
    ctx.sessionContext?.ui.setEditorText(draft);
  }
  const { ledger, ownership: owner } = ctx;
  if (!owner || !ledger || !ctx.execution) {
    return { action: "handled" };
  }
  for (const delivery of deliveries) {
    const requestId = delivery[1];
    const operation = ledger.claimDelivery(owner, requestId, Date.now() + 1000);
    if (!operation) {
      continue;
    }
    const kind =
      operation.kind === "message"
        ? "message"
        : operation.kind === "unexpected_exit"
          ? "disconnect"
          : "result";
    ctx.pi.sendMessage(
      {
        customType: MESSAGE_TYPE,
        content: formatIncoming({
          kind: kind === "message" ? "message" : "result",
          from: String(operation.caller_session_id),
          text: String(operation.payload),
        }),
        display: true,
        details: {
          from: String(operation.caller_session_id),
          to: owner.sessionId,
          kind,
          requestId,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }
  return { action: "handled" };
}

/** Consume authorized Crew deliveries; observe ordinary Pi-owned input without manufacturing more input. */
export function onInput(ctx: CrewContext) {
  return (event: InputEvent): InputEventResult | undefined => {
    const delivered = receiveInput(ctx, event);
    if (delivered) {
      return delivered;
    }
    const owner = ctx.ownership;
    if (!owner || !ctx.execution || event.source === "extension") {
      return;
    }
    ctx.execution.record({
      eventId: randomUUID(),
      sessionId: owner.sessionId,
      instanceId: owner.instanceId,
      kind: "human_input",
      turnId: null,
      outcome: null,
      resultText: null,
    });
  };
}