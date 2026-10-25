import type { AgentDefinition } from "../runtime/types.ts";

/**
 * Tool-description catalog listing agents the model may spawn, one
 * `name: description` line per definition. Empty string when there are none.
 */
export function buildCatalogDescription(defs: AgentDefinition[]): string {
  if (defs.length === 0) {
    return "";
  }

  return defs
    .map(({ name, description }) => `${name}${description ? `: ${description}` : ""}`)
    .join("\n");
}