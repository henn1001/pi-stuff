import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readBranchProfile, type StoredProfile } from "./src/presets";
import {
  abandonPendingSelection,
  activateSelection,
  applyProfile,
  selectPreset,
  stageSelection,
  type PendingSelection,
} from "./src/runtime";

export default function presetExtension(pi: ExtensionAPI): void {
  let pendingSelection: PendingSelection | undefined;
  let activeProfile: StoredProfile | undefined;
  const warnedMissingSkills = new Set<string>();

  function updateIndicator(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") {
      return;
    }

    const name = activeProfile?.name;
    ctx.ui.setStatus("preset", name ? ctx.ui.theme.fg("accent", `preset:${name}`) : undefined);
  }

  pi.registerFlag("preset", {
    description: "Preset to use for new sessions",
    type: "string",
  });

  pi.on("session_start", (event, ctx) => {
    pendingSelection = undefined;
    activeProfile = readBranchProfile(ctx);
    warnedMissingSkills.clear();

    updateIndicator(ctx);

    // A branch snapshot takes precedence over the CLI flag and files on disk.
    if (activeProfile) {
      const requested = pi.getFlag("preset");
      if (
        event.reason === "startup" &&
        typeof requested === "string" &&
        requested &&
        requested !== activeProfile.name
      ) {
        ctx.ui.notify(
          `Requested preset "${requested}" is ignored on resume; restoring active-branch snapshot "${activeProfile.name}". The requested name remains the default for later /new sessions.`,
          "warning",
        );
      }

      return;
    }

    pendingSelection = selectPreset(pi, event.reason, ctx);
  });

  pi.on("resources_discover", async (event, ctx) => {
    if (!pendingSelection || event.reason !== "startup" || pendingSelection.stagingAttempted) {
      return;
    }

    const selection = pendingSelection;
    // Consume on success or rejection; startup must finish before the first input.
    pendingSelection = undefined;

    if (stageSelection(selection, ctx)) {
      activeProfile = await activateSelection(selection, ctx);
    }

    updateIndicator(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (activeProfile) {
      applyProfile(activeProfile, event.systemPromptOptions, ctx, warnedMissingSkills);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const selection = pendingSelection;
    pendingSelection = undefined;

    abandonPendingSelection(selection, ctx);

    activeProfile = undefined;
    updateIndicator(ctx);
  });

  pi.on("session_before_tree", (_event, ctx) => {
    const selection = pendingSelection;
    pendingSelection = undefined;

    abandonPendingSelection(selection, ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    activeProfile = readBranchProfile(ctx);
    warnedMissingSkills.clear();

    updateIndicator(ctx);
  });
}