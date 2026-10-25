/** Thinking levels accepted by Crew agent definitions. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Pi model thinking levels accepted in Crew agent definitions. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Parsed agent definition (docs/agent-frontmatter-rules.md). */
export interface AgentDefinition {
  name: string;
  description?: string;
  /** Exact `provider/model-id`; undefined = inherit from spawner. */
  model?: string;
  /** undefined = inherit (clamped). */
  thinking?: ThinkingLevel;
  /** undefined = pi defaults; [] = none; non-empty = allowlist. */
  tools?: string[];
  /** undefined = pi defaults; [] = none; non-empty = allowlist. */
  skills?: string[];
  systemPrompt: "append" | "replace";
  sessionMode: "standalone" | "fork";
  spawning: boolean;
  autoExit: boolean;
  disableModelInvocation: boolean;
  /** Markdown body after the frontmatter. */
  body: string;
  /** Where it was found, highest precedence wins. */
  source: "project" | "user" | "bundled";
  filePath: string;
}