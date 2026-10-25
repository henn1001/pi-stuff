/**
 * Crew's only gateway to pi session execution and model-visible context.
 *
 * Everything that calls `sendMessage`, `sendUserMessage`, `setModel`, `setThinkingLevel` or
 * `setActiveTools`, or registers a `context`, `input` or `before_agent_start` hook, lives in this
 * directory. Each row of the allowlist in
 * docs/session-interaction-rules.md that Crew implements through pi session APIs maps to:
 *
 * - "Explicit `send_message` delivery": `input.ts` turns an authorized delivery marker into a
 *   `sendMessage` custom message (`triggerTurn`, steer).
 * - "Explicit or automatic assignment report": `input.ts`, same path as above.
 * - "Unexpected-exit notice for outstanding work": `input.ts`, same path as above.
 * - "Definition, model, thinking, tool, skill, and catalog configuration at its specified
 *   application points": `member-configuration.ts` (`setModel`, `setThinkingLevel`) and
 *   `active-tools.ts` (`setActiveTools`).
 * - "Active Crew tool metadata": `active-tools.ts` selects the active Crew tools; the metadata
 *   itself is declared with the tools in `../tools/`.
 *
 * Rows not listed here (initial assignment, tool results, conversation inheritance and reopening)
 * use launch arguments or tool returns and never touch these APIs.
 *
 * The `input`, `context` and `before_agent_start` hooks registered here only record local
 * evidence. They never add input, hidden context or continuations.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CrewContext } from "../context.ts";
import { onBeforeAgentStart } from "./before-agent-start.ts";
import { observeProcessing } from "./context.ts";
import { onInput } from "./input.ts";

/** Register the session-facing hooks that observe input, turn start and model context. */
export function registerSessionInput(pi: ExtensionAPI, ctx: CrewContext): void {
  pi.on("input", onInput(ctx));
  pi.on("before_agent_start", onBeforeAgentStart(ctx));
  pi.on("context", (event) => observeProcessing(ctx, event));
}