/** Model-visible message envelope; internal delivery identities remain in message details. */
export interface IncomingMessage {
  kind: "message" | "result";
  from: string;
  text: string;
}

/** Sender identity and payload only; routing policy belongs to the runtime. */
export function formatIncoming(req: IncomingMessage): string {
  if (req.kind === "result") {
    return `[${req.from} result] ${req.text}`;
  }

  return `[Message from ${req.from}]\n${req.text}`;
}

/** Custom-message content telling the spawner that a helper exited without a final result. */
export function formatExitedWithoutReporting(): string {
  return "Agent exited before returning a result. Its task may be incomplete.";
}