import { claimAuthority } from "./authority.ts";
import { startSupervision } from "./supervision.ts";
import { automaticMode, registerClosePlanner } from "./tree-lifecycle.ts";
import type { CrewContext } from "./context.ts";
import { hasHerdrContext } from "./context.ts";
import { listen } from "../transport/socket.ts";
import { Coordinator } from "./coordinator.ts";
import { Attachment } from "./attachment.ts";
import { Execution } from "./execution.ts";
import { registerSpawnPlanner } from "./spawn.ts";
import { registerMessagingPlanners } from "./assignments.ts";
import { createInboundHandler } from "../transport/messaging.ts";
import { updateWidget } from "../ui/widgets.ts";

/** Owns the socket and poller for the current session identity. */
export function createResourceManager(ctx: CrewContext) {
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
    const coordinator = ctx.coordinator;
    ctx.execution = undefined;
    ctx.coordinator = undefined;
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

      const lead = snapshot.agents.find((agent) => agent.role === "lead");
      if (lead) {
        ctx.knownLeadId = lead.sessionId;
      }

      if (role.kind === "lead") {
        ctx.knownLeadId = role.sessionId;
      }

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
      ctx.coordinator = new Coordinator(ctx);
      registerSpawnPlanner(ctx);
      registerMessagingPlanners(ctx);
      registerClosePlanner(ctx);
    }
    ctx.coordinator?.wake();
    observe();
  };

  return { close: ctx.closeResources, sync: ctx.syncResources };
}