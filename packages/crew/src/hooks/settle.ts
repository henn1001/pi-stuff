import type { AgentBeforeSettleEvent, AgentSettledEvent } from "@earendil-works/pi-coding-agent";
import type { CrewContext } from "../runtime/context.ts";
import { selectReport } from "../runtime/lifecycle.ts";

/** Retain the runtime's terminal outcome; this intermediate boundary authorizes no completion. */
export function onBeforeSettle(ctx: CrewContext) {
  return (event: AgentBeforeSettleEvent): void => {
    if (ctx.run) {
      ctx.run.outcome = event.outcome;
    }
  };
}

/** Persist settled-turn evidence locally. Only the lead coordinator may decide reporting or closure. */
export function onSettled(ctx: CrewContext) {
  return (event: AgentSettledEvent): void => {
    ctx.working = false;
    const run = ctx.run;
    const owner = ctx.ownership;
    if (!run || run.settled || !owner || !ctx.execution) {
      return;
    }
    const outcome =
      event.aborted || run.outcome === "aborted"
        ? "abort"
        : run.outcome === "completed"
          ? "success"
          : "failure";
    if (outcome === "abort") {
      owner.automaticDisabled = true;
      ctx.state.takeover = true;
      ctx.execution.record({
        eventId: `disrupted:${run.turnId}`,
        sessionId: owner.sessionId,
        instanceId: owner.instanceId,
        kind: "disrupted",
        turnId: run.turnId,
        outcome: null,
        resultText: null,
      });
    }
    ctx.execution.record({
      eventId: `settled:${run.turnId}`,
      sessionId: owner.sessionId,
      instanceId: owner.instanceId,
      kind: "turn_settled",
      turnId: run.turnId,
      outcome,
      resultText: selectReport(run.latest) ?? null,
    });
    run.settled = true;
  };
}