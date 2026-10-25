import { type CrewContext } from "../runtime/context.ts";
import { renamePane, requireHerdr } from "../transport/herdr.ts";
import { spawnAgent } from "../transport/messaging.ts";
import { claimAuthority, closeAuthority } from "../runtime/authority.ts";
import { syncActiveTools } from "../tools/access.ts";

const activations = new WeakMap<CrewContext, Promise<void>>();

/** Serialize explicit activation; durable role claims survive runtime setup failures. */
export async function enableCrew(crew: CrewContext): Promise<void> {
  const pending = activations.get(crew);

  if (pending) {
    return pending;
  }

  const activation = (async () => {
    if (crew.authorityError) {
      throw new Error(`Crew activation blocked by startup recovery error: ${crew.authorityError}`);
    }
    if (crew.state.role.kind === "member") {
      throw new Error("Members cannot enable crew");
    }

    const { workspaceId, paneId } = requireHerdr();

    if (crew.state.enabled && crew.state.role.kind === "lead" && crew.server && crew.ownership) {
      return;
    }

    const context = crew.sessionContext;

    if (!context || !crew.syncResources) {
      throw new Error("Crew session is not ready.");
    }

    const role = crew.state.role;
    const enabled = crew.state.enabled;
    const epoch = crew.epoch;

    // Awaited operations can outlive this activation, so reject stale continuations.
    const current = () => {
      if (crew.epoch !== epoch) {
        throw new Error("Crew session/branch changed during activation.");
      }
    };

    try {
      current();
      crew.state.role = {
        kind: "lead",
        workspaceId,
        sessionId: context.sessionManager.getSessionId(),
        projectCwd: context.sessionManager.getCwd(),
      };
      crew.state.enabled = true;

      await claimAuthority(crew);
      await renamePane(paneId, "lead");
      current();
      await crew.syncResources();
      current();

      await crew.poller!.refresh();
      current();

      syncActiveTools(crew);
    } catch (error) {
      if (crew.epoch === epoch) {
        const recorded = crew.ledger?.role(context.sessionManager.getSessionId());
        await crew.closeResources?.();
        closeAuthority(crew, false);
        crew.state.role = recorded ?? role;
        crew.state.enabled = recorded?.kind === "lead" || enabled;
        syncActiveTools(crew);
      }
      throw error;
    }
  })();

  activations.set(crew, activation);

  try {
    await activation;
  } finally {
    activations.delete(crew);
  }
}

/** Submit a taskless interactive launch from the lead's current definition catalog. */
export async function spawnFromMenu(crew: CrewContext, agentName: string): Promise<void> {
  const context = crew.sessionContext;
  if (!context) {
    throw new Error("Crew session is not ready.");
  }

  const result = await spawnAgent(crew, context, { agent: agentName }, "menu");
  context.ui.notify(`Spawned ${result.agent} in pane ${result.paneId}`, "info");

  if (crew.poller) {
    void crew.poller.refresh().catch(() => {});
  }
}