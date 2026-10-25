/** Shared domain types. Wire types live in protocol.ts. */

/** Durable operation lifecycle; terminal failures and uncertainty are never replayable. */
export type OperationState = "pending" | "in_progress" | "succeeded" | "failed" | "uncertain";

/** Tool/menu submission identity and immutable input, never exposed as a public tool result. */
export interface OperationSubmission {
  requestId: string;
  callerSessionId: string;
  recipientSessionId: string | null;
  kind: "spawn" | "message" | "report";
  payload: string;
  definitionName: string | null;
  taskName: string | null;
  assignmentId: string | null;
  /** Private prepared launch snapshot; persisted with the name reservation. */
  launchDirectory?: string;
}

/** Local execution evidence. Result text is only the selected terminal assistant text. */
export interface ExecutionEvent {
  eventId: string;
  sessionId: string;
  instanceId: string;
  kind: "human_input" | "turn_started" | "turn_settled" | "disrupted" | "process_exit";
  turnId: string | null;
  outcome: "success" | "failure" | "abort" | null;
  resultText: string | null;
}

/** Durable failure details retained after submission acknowledgement or caller timeout. */
export interface OperationFailure {
  code: string;
  message: string;
  /** Observed full Pi session ID, even if atomic child recording did not succeed. */
  agentId?: string;
}

/** Thinking levels accepted by Crew agent definitions. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Pi model thinking levels accepted in Crew agent definitions. */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Who started an agent. `tool`: a model called `spawn_agent` with a task. `menu`: the user, idle, no task. */
export type Origin = "tool" | "menu";

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

/** Saved child identity and conversation location used for explicit resume. */
export interface SpawnRecord {
  /** Pi session ID; preserved on resume. */
  sessionId: string;
  agent: string;
  origin: Origin;
  /** Original caller's pi session ID. */
  caller: string;
  sessionFile: string;
}

/** Launcher-provided member identity, bound to the actual Pi session before registration. */
export interface MemberMetadata {
  version: 1;
  /** Pi session ID; prevents a fork from adopting its source member's relationship. */
  sessionId: string;
  agent: string;
  origin: Origin;
  /** Original caller's full pi session ID. */
  caller: string;
  /** Project cwd inherited from the workspace lead, used as the nested catalog anchor. */
  projectCwd: string;
}

/** Custom conversation message type; conversation entries never confer Crew authority. */
export const MESSAGE_TYPE = "crew";

/** Startup handoff fields set by the launcher; the actual identity always comes from pi. */
export const ENV_CREW_AGENT = "PI_CREW_AGENT";
export const ENV_CREW_ORIGIN = "PI_CREW_ORIGIN";
export const ENV_CREW_CALLER = "PI_CREW_CALLER";
export const ENV_CREW_PROJECT_CWD = "PI_CREW_PROJECT_CWD";
/** Set by the running member after startup to reject stale inherited member markers on forks. */
export const ENV_CREW_SESSION_ID = "PI_CREW_SESSION_ID";

/** Member marker set on spawned processes; identity comes from pi, not this env var. */
export const ENV_SUBAGENT_ID = "PI_SUBAGENT_ID";