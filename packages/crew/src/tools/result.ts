import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/** Public tool failure; only the contract code and approved message cross the model boundary. */
export class ToolFailure extends Error {
  /** Bind a contract code to its model-visible cause without exposing transport metadata. */
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Validate exact public arguments, including calls made outside Pi's model argument validator. */
export function validateArguments(tool: string, schema: TSchema, params: unknown): void {
  if (!Value.Check(schema, params)) {
    throw new ToolFailure(
      "invalid_arguments",
      `${tool} failed: arguments must match the documented schema and contain non-whitespace text.`,
    );
  }
}

/** Pi validates before execute; encode schema failures through that originating error result too. */
export function prepareArguments<T extends TSchema>(
  tool: string,
  schema: T,
  params: unknown,
): Static<T> {
  try {
    validateArguments(tool, schema, params);
  } catch (error) {
    throw new Error(toolError(tool, error).content[0].text);
  }
  return params as Static<T>;
}

/** JSON-only tool result; uncoded storage errors never expose internal records or database text. */
export function toolError(tool: string, error: unknown) {
  const coded =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    [
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
    ].includes(error.code);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: {
            code: coded ? error.code : "persistence_failed",
            message: coded
              ? error.message
              : `${tool} failed: required durable records could not be read or written.`,
          },
        }),
      },
    ],
    details: undefined,
    isError: true,
  };
}