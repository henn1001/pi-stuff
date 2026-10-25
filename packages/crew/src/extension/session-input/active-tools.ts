import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Replace the active tool loadout. Names are computed by `../tool-activation.ts`. */
export function applyActiveTools(pi: ExtensionAPI, names: string[]): void {
  pi.setActiveTools(names);
}