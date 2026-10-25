import { randomUUID } from "node:crypto";
import type { InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { CrewContext } from "../runtime/context.ts";
import { receiveInput } from "../runtime/assignments.ts";

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