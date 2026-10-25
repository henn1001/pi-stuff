import { createLaunchHost } from "./launch-host.ts";
import { claimAuthority } from "../local/authority.ts";
import { startSupervision } from "../local/observation.ts";
import { automaticMode } from "../local/lifecycle.ts";
import { registerClosePlanner } from "../coordinator/planners/close.ts";
import type { CrewContext } from "./context.ts";
import type { CoordinatorContext } from "./coordinator-context.ts";
import { hasHerdrContext } from "../herdr/cli.ts";
import { listen } from "../ipc/socket.ts";
import { CoordinatorStore } from "../store/coordinator-store.ts";
import { Coordinator } from "../coordinator/coordinator.ts";
import { Attachment } from "../local/attachment.ts";
import { Execution } from "../local/execution.ts";
import { registerSpawnPlanner } from "../coordinator/planners/spawn.ts";
import { registerMessagingPlanners } from "../coordinator/planners/message.ts";
import { createInboundHandler } from "../local/inbound.ts";
import { updateWidget } from "./ui/widgets.ts";

/** Owns the socket and poller for the current session identity. */
export function createResourceManager(ctx: CrewContext) {
  // The lead-only part lives here, outside the context, so only coordinator code can reach it.
  let lead: CoordinatorContext | undefined;
  let resourceIdentity: string | undefined;
  let generation = 0;
  const observe = () => {
    if (ctx.sessionContext && ctx.state.role.kind !== "dormant") {
      updateWidget(ctx.sessionContext, ctx);
    }

    // Refresh open views from this shared discovery snapshot.
    for (const observer of ctx.connectionObservers) {
      observer();
    }
  };

  ctx.closeResources = async () => {
    generation++;
    // Dismiss session-bound dialogs before their resources and identity are replaced.
    for (const close of ctx.closeViews) {
      close();
    }

    if (ctx.sessionContext?.mode === "tui") {
      ctx.sessionContext.ui.setWidget("crew", undefined);
    }

    ctx.sessionContext?.ui.setStatus("crew-attachment", undefined);
    ctx.poller?.stop();
    ctx.poller = undefined;
    ctx.connections = undefined;
    ctx.processes.clear();
    ctx.attachment = undefined;
    const execution = ctx.execution;
    const coordinator = lead?.coordinator;
    ctx.execution = undefined;
    ctx.wakeCoordinator = undefined;
    lead = undefined;
    const server = ctx.server;
    ctx.server = undefined;
    resourceIdentity = undefined;

    // Invalidate references before waiting for the old listener to finish closing.
    try {
      await coordinator?.close();
    } finally {
      try {
        await execution?.close();
      } finally {
        await server?.close();
      }
    }
  };

  ctx.syncResources = async () => {
    const role = ctx.state.role;
    const epoch = ctx.epoch;

    const active =
      role.kind !== "dormant" &&
      hasHerdrContext() &&
      (role.kind === "lead" ? ctx.state.enabled : !role.metadataError);
    const identity = active ? `${role.workspaceId}/${role.sessionId}` : undefined;

    if (identity === resourceIdentity) {
      return;
    }

    const closing = ctx.closeResources!();
    const token = generation;
    await closing;

    if (!active || generation !== token || ctx.epoch !== epoch || ctx.state.role !== role) {
      return;
    }
    const current = () => generation === token && ctx.epoch === epoch && ctx.state.role === role;

    await claimAuthority(ctx, current);
    if (!current()) {
      return;
    }
    ctx.attachment = new Attachment(ctx);
    ctx.execution = new Execution(ctx);

    const server = await listen(
      role.workspaceId,
      role.sessionId,
      createInboundHandler(
        ctx,
        () => ({
          sessionId: role.sessionId,
          instanceId: ctx.ownership?.instanceId,
          lifecycle: automaticMode(ctx) ? "non-interactive" : "interactive",
          role: role.kind,
          spawning: role.kind === "lead" || ctx.state.memberSpawning,
          title: role.kind === "lead" ? "lead" : role.title,
          ...(role.kind === "member"
            ? { agent: role.agent, origin: role.origin, caller: role.caller }
            : {}),
          state: ctx.sessionContext && !ctx.sessionContext.isIdle() ? "working" : "idle",
          pendingInput: ctx.sessionContext?.hasPendingMessages() ?? true,
          paneId: process.env.HERDR_PANE_ID!,
          sessionFile: ctx.sessionContext?.sessionManager.getSessionFile() ?? "",
        }),
        current,
        () => (ctx.sessionContext ? createLaunchHost(ctx.pi, ctx.sessionContext) : undefined),
      ),
    );

    if (!current()) {
      await server.close();
      return;
    }
    ctx.server = server;
    ctx.poller = startSupervision(ctx, (snapshot) => {
      if (!current()) {
        return;
      }
      ctx.connections = snapshot;

      void ctx.attachment?.reconcile().catch((error) => {
        if (current()) {
          ctx.sessionContext?.ui.setStatus(
            "crew-attachment",
            `Crew attachment pending: ${String(error)}`,
          );
        }
      });
      observe();
    });
    await ctx.poller.refresh();
    if (!current()) {
      return;
    }
    resourceIdentity = identity;
    if (role.kind === "lead") {
      const coordinatorStore = CoordinatorStore.over(ctx.ledger!);
      const coordinator = new Coordinator(ctx, coordinatorStore);
      lead = { crew: ctx, coordinatorStore, coordinator };
      ctx.wakeCoordinator = () => coordinator.wake();
      registerSpawnPlanner(lead);
      registerMessagingPlanners(lead);
      registerClosePlanner(lead);
    }
    ctx.wakeCoordinator?.();
    observe();
  };

  return { close: ctx.closeResources, sync: ctx.syncResources };
}