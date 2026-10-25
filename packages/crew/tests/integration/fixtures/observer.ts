// Test-only Pi event observer; it records evidence and never changes Crew authority or input.
import { appendFileSync } from "node:fs";

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function textOf(message: any): string | undefined {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return undefined;
  }
  const text = message.content
    .map((part: any) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "toolCall") {
        return `${part.name} ${JSON.stringify(part.arguments)}`;
      }
      if (part.type === "toolResult") {
        return JSON.stringify(part.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

export default function (pi: any) {
  const path = process.env.CREW_RUNTIME_EVENTS;
  if (!path) {
    throw new Error("CREW_RUNTIME_EVENTS is required");
  }

  const record = (name: string, ctx: any, extra: Record<string, unknown> = {}) => {
    appendFileSync(
      path,
      `${JSON.stringify({
        event: name,
        pid: process.pid,
        sessionId: ctx.sessionManager.getSessionId(),
        agent: process.env.PI_CREW_AGENT ?? "lead",
        role: process.env.PI_CREW_ORIGIN ?? "lead",
        tools: pi.getActiveTools(),
        ...extra,
      })}\n`,
    );
  };

  pi.on("session_start", (event: any, ctx: any) => record("start", ctx, { reason: event.reason }));
  pi.on("session_shutdown", (event: any, ctx: any) =>
    record("shutdown", ctx, { reason: event.reason }),
  );

  for (const name of [
    "input",
    "context",
    "turn_end",
    "agent_before_settle",
    "agent_settled",
    "tool_result",
    "message_end",
  ]) {
    pi.on(name, (event: any, ctx: any) => {
      let payload: Record<string, unknown>;
      if (name === "context") {
        payload = {
          messages: jsonSafe(event.messages ?? event.context?.messages ?? []),
          systemPrompt: event.systemPrompt,
        };
      } else if (name === "turn_end") {
        payload = {
          outcome: event.outcome,
          turnIndex: event.turnIndex,
          text: textOf(event.message),
        };
      } else if (name === "agent_before_settle") {
        payload = { outcome: event.outcome, continue: event.continue };
      } else if (name === "agent_settled") {
        payload = { outcome: event.outcome, turnIndex: event.turnIndex };
      } else if (name === "message_end") {
        payload = {
          role: event.message?.role,
          messageType: event.message?.customType,
          text: textOf(event.message),
          toolsAdded: event.message?.toolsAdded?.map((tool: any) => tool.name),
        };
      } else if (name === "input") {
        payload = { text: event.text ?? event.input?.text };
      } else {
        payload = { result: jsonSafe(event) as unknown };
      }
      record(name, ctx, { payload });
    });
  }
}