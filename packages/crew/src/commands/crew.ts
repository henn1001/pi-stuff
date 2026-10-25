import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CrewContext } from "../runtime/context.ts";
import { requireHerdr } from "../transport/herdr.ts";
import { showConnectedAgents, showSpawnPicker } from "../ui/connected-view.ts";
import { enableCrew } from "./enable.ts";

const MENU_ACTIONS = [
  { value: "spawn", label: "Spawn agent…", description: "Open the agent picker" },
  { value: "connected", label: "Connected agents…", description: "View permitted tree neighbors" },
] as const;

/** Human-only menu action; never exposed as a model tool. */
type MenuAction = (typeof MENU_ACTIONS)[number]["value"];

/**
 * `/crew`: activates an inactive lead (TUI + Herdr required). Active endpoints
 * open their tree-scoped menu; members never convert roles.
 * Pass `spawn` or `connected` to open that menu directly.
 */
export function crewCommand(crew: CrewContext) {
  return {
    description: "Crew: enable, spawn agents, view connected agents",
    getArgumentCompletions: (prefix: string) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      const matches = MENU_ACTIONS.filter(
        (action) =>
          (action.value !== "spawn" || crew.state.role.kind !== "member") &&
          action.value.startsWith(normalizedPrefix),
      );
      return matches.length > 0
        ? matches.map(({ value, label, description }) => ({ value, label, description }))
        : null;
    },
    handler: (args: string, ctx: ExtensionCommandContext) => handleCrewCommand(crew, args, ctx),
  };
}

async function handleCrewCommand(
  crew: CrewContext,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const requestedAction = args.trim().toLowerCase();
  const action = MENU_ACTIONS.find((candidate) => candidate.value === requestedAction)?.value;

  try {
    requireHerdr();

    if (ctx.mode !== "tui") {
      throw new Error("/crew requires TUI mode");
    }

    if (requestedAction && !action) {
      ctx.ui.notify("Usage: /crew [spawn|connected]", "error");
      return;
    }

    if (crew.state.role.kind === "dormant") {
      await enableCrew(crew);
      ctx.ui.notify("Crew enabled", "info");
      if (!action) {
        return;
      }
    }

    if (action === "spawn" && crew.state.role.kind === "member") {
      ctx.ui.notify("Only the lead can open the Spawn view.", "error");
      return;
    }

    const epoch = crew.epoch;

    if (action) {
      await openMenuAction(action, ctx, crew);
      if (crew.epoch !== epoch || crew.state.role.kind === "dormant") {
        return;
      }
    }

    // Keep the menu open while this activation remains current.
    while (crew.epoch === epoch && crew.state.role.kind !== "dormant") {
      const choice = await ctx.ui.select(
        "Crew",
        MENU_ACTIONS.filter(
          (item) => item.value !== "spawn" || crew.state.role.kind === "lead",
        ).map((item) => item.label),
      );

      if (crew.epoch !== epoch) {
        return;
      }

      const selectedAction = MENU_ACTIONS.find((item) => item.label === choice)?.value;
      if (!selectedAction) {
        return;
      }

      await openMenuAction(selectedAction, ctx, crew);
    }
  } catch (error) {
    ctx.ui.notify(String(error instanceof Error ? error.message : error), "error");
  }
}

async function openMenuAction(
  action: MenuAction,
  ctx: ExtensionCommandContext,
  crew: CrewContext,
): Promise<void> {
  if (action === "spawn") {
    await showSpawnPicker(ctx, crew);
  } else {
    await showConnectedAgents(ctx, crew);
  }
}