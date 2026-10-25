import type {
  ExtensionContext,
  SessionStartEvent,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { hasHerdrContext, type CrewContext } from "./context.ts";
import { syncActiveTools } from "../tools/access.ts";
import { sendShutdownDisconnect } from "./lifecycle.ts";
import { loadDefinitions } from "../agents/definitions.ts";
import { readLaunchDefinition, ENV_CREW_TITLE, ENV_CONFIG_DIR } from "../agents/launch.ts";
import type { createResourceManager } from "./resources.ts";
import { createState } from "./state.ts";
import { checkSessionBinding, hasWorkspaceLedger, openLedger } from "./ledger.ts";
import { closeAuthority } from "./authority.ts";
import { enableCrew } from "../commands/enable.ts";
import { configureIndependentDefinition } from "./activation.ts";
import {
  ENV_CREW_AGENT,
  ENV_CREW_CALLER,
  ENV_CREW_ORIGIN,
  ENV_CREW_PROJECT_CWD,
  ENV_CREW_SESSION_ID,
  ENV_SUBAGENT_ID,
  type MemberMetadata,
  type Origin,
} from "./types.ts";

/** Restore session identity and reconcile its runtime resources. */
export function createSessionHandlers(
  ctx: CrewContext,
  resources: ReturnType<typeof createResourceManager>,
) {
  let shutdown: Promise<void> | undefined;
  return {
    async start(event: SessionStartEvent, sessionCtx: ExtensionContext): Promise<void> {
      const epoch = ++ctx.epoch;
      try {
        shutdown = undefined;
        ctx.authorityError = undefined;
        ctx.knownLeadId = undefined;
        await resources.close();
        if (ctx.epoch !== epoch) {
          return;
        }
        closeAuthority(ctx, event.reason === "reload");

        ctx.sessionContext = sessionCtx;
        ctx.working = false;
        ctx.processes.clear();
        ctx.supervisionError = undefined;
        ctx.run = undefined;
        ctx.memberDefinition = undefined;
        Object.assign(ctx.state, createState());

        const sessionId = sessionCtx.sessionManager.getSessionId();
        const workspaceId = process.env.HERDR_WORKSPACE_ID;
        let restoredRole;
        if (event.reason !== "fork") {
          const bound = checkSessionBinding(workspaceId ?? "", sessionId);
          if (workspaceId && (bound || hasWorkspaceLedger(workspaceId))) {
            const ledger = await openLedger(workspaceId, false);
            if (ctx.epoch !== epoch) {
              ledger.close();
              return;
            }
            ctx.ledger = ledger;
            restoredRole = ledger.role(sessionId);
            if (bound && !restoredRole) {
              throw new Error(
                "Crew session binding has no ledger role; initialization was interrupted. Restore the original ledger.",
              );
            }
          }
        }
        // Reload restores SQLite activation; it must not reapply a pre-fork CLI flag.
        const startup = event.reason === "startup";
        const mode = startup ? ctx.pi.getFlag("crew-mode") : undefined;
        const selected = startup ? ctx.pi.getFlag("crew-agent") : undefined;
        if (mode !== undefined && mode !== "lead" && mode !== "member") {
          throw new Error("--crew-mode must be lead or member.");
        }
        if (selected !== undefined && (typeof selected !== "string" || !selected.trim())) {
          throw new Error("--crew-agent requires a definition name.");
        }
        if (restoredRole && mode !== undefined && mode !== restoredRole.kind) {
          throw new Error("Explicit Crew role conflicts with persisted role.");
        }
        if (selected !== undefined && (restoredRole?.kind === "lead" || mode === "lead")) {
          throw new Error("--crew-agent is for members only.");
        }
        if (
          restoredRole?.kind === "member" &&
          selected !== undefined &&
          selected !== restoredRole.agent
        ) {
          throw new Error("Explicit definition conflicts with persisted member definition.");
        }
        const launchMetadata = readLaunchMetadata(sessionId, event.reason);
        const definitions = await loadDefinitions(
          restoredRole?.projectCwd ??
            launchMetadata?.projectCwd ??
            sessionCtx.sessionManager.getCwd(),
        );
        if (ctx.epoch !== epoch) {
          return;
        }
        ctx.definitions = definitions;
        if (
          launchMetadata &&
          ((mode !== undefined && mode !== "member") ||
            (selected !== undefined && selected !== launchMetadata.agent))
        ) {
          throw new Error("Crew launch role/definition flags conflict.");
        }
        if (restoredRole) {
          if (!hasHerdrContext()) {
            throw new Error(
              "Crew restoration requires a Herdr-managed pane in the original workspace.",
            );
          }
          ctx.state.role = restoredRole;
          ctx.state.enabled = restoredRole.kind === "lead";
          if (restoredRole.kind === "member") {
            ctx.memberDefinition =
              readLaunchDefinition(restoredRole.agent, sessionId) ??
              ctx.definitions.get(restoredRole.agent);
            ctx.state.memberSpawning = ctx.memberDefinition?.spawning ?? false;
            setMemberEnvironment({
              version: 1,
              sessionId,
              agent: restoredRole.agent,
              origin: restoredRole.origin,
              caller: restoredRole.caller,
              projectCwd: restoredRole.projectCwd,
            });
          }
          if (restoredRole.kind === "member" && !restoredRole.caller) {
            await configureIndependentDefinition(ctx);
          }
          await resources.sync();
          if (ctx.epoch !== epoch) {
            return;
          }
          syncActiveTools(ctx);
          return;
        }
        const memberMetadata = launchMetadata;

        if (memberMetadata) {
          ctx.state.role = memberRole(memberMetadata);
          ctx.state.enabled = false;

          ctx.memberDefinition =
            readLaunchDefinition(memberMetadata.agent, sessionId) ??
            ctx.definitions.get(memberMetadata.agent);

          setMemberEnvironment(memberMetadata);
          ctx.state.memberSpawning = ctx.memberDefinition?.spawning ?? false;

          await resources.sync();
          if (ctx.epoch !== epoch) {
            return;
          }
          syncActiveTools(ctx);
          return;
        }

        if (isCurrentMemberMarker(sessionId, event.reason)) {
          ctx.state.role = incompleteMemberRole(sessionId, sessionCtx.sessionManager.getCwd());
          syncActiveTools(ctx);
          return;
        }

        clearMemberEnvironment();
        if (mode === "lead") {
          await enableCrew(ctx);
          return;
        }
        if (mode === "member") {
          if (!hasHerdrContext()) {
            throw new Error("Crew requires a Herdr-managed pane.");
          }
          ctx.state.role = {
            kind: "member",
            workspaceId: workspaceId!,
            sessionId,
            title: typeof selected === "string" ? selected : "member",
            agent: typeof selected === "string" ? selected : "crew-member",
            origin: "menu",
            caller: "",
            projectCwd: sessionCtx.sessionManager.getCwd(),
            defaultDefinition: selected === undefined,
          };
          await configureIndependentDefinition(ctx);
        } else if (selected !== undefined) {
          throw new Error("--crew-agent requires --crew-mode member or a persisted member role.");
        }
        await resources.sync();
        if (ctx.epoch !== epoch) {
          return;
        }
        syncActiveTools(ctx);
      } catch (error) {
        if (ctx.epoch !== epoch) {
          return;
        }
        if (ctx.state.role.kind === "member") {
          ctx.state.role.metadataError = `Crew startup failed: ${String(error)}`;
        }

        await resources.close();
        if (ctx.epoch !== epoch) {
          return;
        }
        closeAuthority(ctx, false);
        ctx.state.role = { kind: "dormant" };
        ctx.state.enabled = false;
        syncActiveTools(ctx);
        ctx.authorityError = String(error);
        sessionCtx.ui.notify(
          `Crew inactive: ${ctx.authorityError}\nPreserve the original ledger; do not delete locks or initialize a replacement ledger. If another lead owns this workspace, wait for it to release ownership before activating a new session. A previous lead session must acquire fresh ownership before coordinating again. See docs/coordination-rules.md#lead-unavailability-and-recovery. pi remains usable.`,
          "error",
        );
      }
    },
    shutdown(event: SessionShutdownEvent): Promise<void> {
      return (shutdown ??= (async () => {
        ctx.epoch++;
        try {
          await resources.close();
        } finally {
          try {
            if (event.reason !== "reload") {
              await sendShutdownDisconnect(ctx);
            }
          } finally {
            closeAuthority(ctx, event.reason === "reload");
          }
        }

        ctx.run = undefined;
        ctx.sessionContext = undefined;
      })());
    },
  };
}

function readLaunchMetadata(
  sessionId: string,
  reason: "startup" | "reload" | "new" | "resume" | "fork",
): MemberMetadata | undefined {
  if (process.env[ENV_SUBAGENT_ID] === undefined || (reason !== "startup" && reason !== "reload")) {
    return undefined;
  }

  const inheritedSessionId = process.env[ENV_CREW_SESSION_ID];
  if (inheritedSessionId && inheritedSessionId !== sessionId) {
    return undefined;
  }

  const agent = process.env[ENV_CREW_AGENT];
  const origin = process.env[ENV_CREW_ORIGIN];
  const caller = process.env[ENV_CREW_CALLER];
  const projectCwd = process.env[ENV_CREW_PROJECT_CWD];
  if (
    !agent ||
    !/^[a-z0-9-]+$/.test(agent) ||
    (origin !== "tool" && origin !== "menu") ||
    !caller ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(caller) ||
    !projectCwd ||
    !isAbsolute(projectCwd)
  ) {
    return undefined;
  }

  return { version: 1, sessionId, agent, origin: origin as Origin, caller, projectCwd };
}

function isCurrentMemberMarker(
  sessionId: string,
  reason: "startup" | "reload" | "new" | "resume" | "fork",
): boolean {
  if (process.env[ENV_SUBAGENT_ID] === undefined) {
    return false;
  }

  const inheritedSessionId = process.env[ENV_CREW_SESSION_ID];
  return (
    (!inheritedSessionId || inheritedSessionId === sessionId) &&
    (reason === "startup" || reason === "reload")
  );
}

function memberRole(metadata: MemberMetadata) {
  return {
    kind: "member" as const,
    workspaceId: process.env.HERDR_WORKSPACE_ID ?? "",
    sessionId: metadata.sessionId,
    title: process.env[ENV_CREW_TITLE] || metadata.agent,
    agent: metadata.agent,
    origin: metadata.origin,
    caller: metadata.caller,
    projectCwd: metadata.projectCwd,
  };
}

function incompleteMemberRole(sessionId: string, cwd: string) {
  return {
    kind: "member" as const,
    workspaceId: process.env.HERDR_WORKSPACE_ID ?? "",
    sessionId,
    title: "member",
    agent: "unknown",
    origin: "tool" as const,
    caller: "",
    projectCwd: cwd,
    metadataError:
      "Crew member startup metadata is incomplete; refusing to infer the caller or definition.",
  };
}

function setMemberEnvironment(metadata: MemberMetadata): void {
  process.env[ENV_SUBAGENT_ID] = "true";
  process.env[ENV_CREW_AGENT] = metadata.agent;
  process.env[ENV_CREW_ORIGIN] = metadata.origin;
  process.env[ENV_CREW_CALLER] = metadata.caller;
  process.env[ENV_CREW_PROJECT_CWD] = metadata.projectCwd;
  process.env[ENV_CREW_SESSION_ID] = metadata.sessionId;
}

function clearMemberEnvironment(): void {
  delete process.env[ENV_CONFIG_DIR];
  delete process.env[ENV_CREW_TITLE];

  delete process.env[ENV_SUBAGENT_ID];
  delete process.env[ENV_CREW_AGENT];
  delete process.env[ENV_CREW_ORIGIN];
  delete process.env[ENV_CREW_CALLER];
  delete process.env[ENV_CREW_PROJECT_CWD];
  delete process.env[ENV_CREW_SESSION_ID];
}