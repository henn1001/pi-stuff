import { randomUUID } from "node:crypto";
import type { CrewContext } from "../context.ts";

/** Record local turn activation; no coordinator availability or permission gates human execution. */
export function onBeforeAgentStart(ctx: CrewContext) {
  return (): void => {
    const turnId = randomUUID();
    ctx.run = { turnId, settled: false };
    const owner = ctx.ownership;
    if (!owner || !ctx.execution) {
      return;
    }
    ctx.execution.record({
      eventId: `start:${turnId}`,
      sessionId: owner.sessionId,
      instanceId: owner.instanceId,
      kind: "turn_started",
      turnId,
      outcome: null,
      resultText: null,
    });
  };
}