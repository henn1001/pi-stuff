import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../store/agent-home.ts";

/** Layout allocation limits loaded from Crew's runtime configuration. */
export interface LayoutConfig {
  /** Maximum number of member panes in the lead tab; an integer from 0 through 2. */
  leadTabMemberLimit: number;
  /** Maximum number of panes in a pool; a positive safe integer. */
  poolPaneLimit: number;
  /** Minimum pool pane width in columns; a positive safe integer. */
  poolMinCols: number;
  /** Minimum pool pane height in rows; a positive safe integer. */
  poolMinRows: number;
}

const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  leadTabMemberLimit: 2,
  poolPaneLimit: 4,
  poolMinCols: 48,
  poolMinRows: 10,
};

/** Read Crew's layout.json, applying defaults and rejecting invalid configuration. */
export function loadLayoutConfig(): LayoutConfig {
  const path = join(agentDir(), "crew", "layout.json");
  let contents: string;

  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_LAYOUT_CONFIG };
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Invalid Crew layout configuration.");
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Crew layout configuration.");
  }

  const config = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "leadTabMemberLimit",
    "poolPaneLimit",
    "poolMinCols",
    "poolMinRows",
  ]);
  if (Object.keys(config).some((key) => !allowedKeys.has(key))) {
    throw new Error("Invalid Crew layout configuration.");
  }

  const leadTabMemberLimit = Object.hasOwn(config, "leadTabMemberLimit")
    ? config.leadTabMemberLimit
    : DEFAULT_LAYOUT_CONFIG.leadTabMemberLimit;
  const poolPaneLimit = Object.hasOwn(config, "poolPaneLimit")
    ? config.poolPaneLimit
    : DEFAULT_LAYOUT_CONFIG.poolPaneLimit;
  const poolMinCols = Object.hasOwn(config, "poolMinCols")
    ? config.poolMinCols
    : DEFAULT_LAYOUT_CONFIG.poolMinCols;
  const poolMinRows = Object.hasOwn(config, "poolMinRows")
    ? config.poolMinRows
    : DEFAULT_LAYOUT_CONFIG.poolMinRows;

  if (
    typeof leadTabMemberLimit !== "number" ||
    !Number.isInteger(leadTabMemberLimit) ||
    leadTabMemberLimit < 0 ||
    leadTabMemberLimit > 2 ||
    typeof poolPaneLimit !== "number" ||
    !Number.isSafeInteger(poolPaneLimit) ||
    poolPaneLimit <= 0 ||
    typeof poolMinCols !== "number" ||
    !Number.isSafeInteger(poolMinCols) ||
    poolMinCols <= 0 ||
    typeof poolMinRows !== "number" ||
    !Number.isSafeInteger(poolMinRows) ||
    poolMinRows <= 0
  ) {
    throw new Error("Invalid Crew layout configuration.");
  }

  return { leadTabMemberLimit, poolPaneLimit, poolMinCols, poolMinRows };
}