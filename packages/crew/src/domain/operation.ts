/** Operation records and the error-code catalog. Wire types live in ipc/protocol.ts. */

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

/** Every public and durable error code from docs/tool-rules.md. */
export const ERROR_CODES = [
  "invalid_arguments",
  "permission_denied",
  "duplicate_task_name",
  "unknown_agent_type",
  "unknown_target",
  "precondition_failed",
  "persistence_failed",
  "launch_failed",
  "timeout",
  "outcome_unknown",
  "cannot_resume",
  "execution_failed",
] as const;

/** Error code from the catalog in docs/tool-rules.md. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Codes that `spawn_agent` and the other Crew tools surface to the model as coded errors. */
export const PUBLIC_ERROR_CODES: readonly string[] = [
  "invalid_arguments",
  "permission_denied",
  "duplicate_task_name",
  "unknown_agent_type",
  "unknown_target",
  "precondition_failed",
  "persistence_failed",
  "launch_failed",
  "timeout",
  "outcome_unknown",
];