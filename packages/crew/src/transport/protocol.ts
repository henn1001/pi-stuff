/** Wire protocol. One connection per request, newline-delimited JSON.
 * `from` and `caller` contain full pi session IDs, never pane titles or aliases.
 */

/** Notifications carry no operations or execution authority; SQLite is the only inbox. */
export type Request =
  | { kind: "wake" }
  | { kind: "launch-result"; requestId: string }
  | { kind: "prepare-resume"; requestId: string }
  | { kind: "attach-child"; from: string }
  | { kind: "attach"; from: string; handshakeId: string; phase: "accept" | "ready" }
  | { kind: "ping" };

/** An IPC reply acknowledges the notification or probe, never durable operation delivery. */
export type Reply =
  | { ok: true; info?: AgentInfo; directory?: string }
  | { ok: false; error: string; code?: string };

/** Agent metadata returned to `ping`; each agent is the source of truth about itself. */
export interface AgentInfo {
  sessionId: string;
  instanceId?: string;
  lifecycle?: "interactive" | "non-interactive";
  /** Current instance configuration, not permission granted by the observer. */
  spawning?: boolean;
  role: "lead" | "member";
  /** Display-only pane title. */
  title: string;
  agent?: string;
  origin?: "tool" | "menu";
  caller?: string;
  state: "working" | "idle";
  /** Pi-owned queued input; used only for best-effort completion checks. */
  pendingInput: boolean;
  paneId: string;
  sessionFile: string;
}

/** Invalid JSON framing or protocol data, never evidence of a stale socket. */
export class ProtocolError extends Error {}

export function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value) &&
    value !== "lead" &&
    value !== "caller"
  );
}

/** Full Pi session identity; prefixes and trailing line terminators are not identities. */
export function isAgentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/i.test(value)
  );
}

/** Parent-local aliases exclude canonical UUID session identities and reject surrounding whitespace. */
export function isTaskName(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}(?![\s\S])/.test(value) && !isAgentId(value)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeRequest(value: unknown): Request {
  if (record(value)) {
    if ((value.kind === "ping" || value.kind === "wake") && Object.keys(value).length === 1) {
      return { kind: value.kind };
    }

    if (
      (value.kind === "launch-result" || value.kind === "prepare-resume") &&
      isSafeId(value.requestId) &&
      Object.keys(value).length === 2
    ) {
      return { kind: value.kind, requestId: value.requestId };
    }
    if (isSafeId(value.from)) {
      if (value.kind === "attach-child") {
        return { kind: "attach-child", from: value.from };
      }
      if (
        value.kind === "attach" &&
        isSafeId(value.handshakeId) &&
        (value.phase === "accept" || value.phase === "ready")
      ) {
        return {
          kind: "attach",
          from: value.from,
          handshakeId: value.handshakeId,
          phase: value.phase,
        };
      }
    }
  }

  throw new ProtocolError("Invalid Crew request.");
}

export function decodeReply(value: unknown): Reply {
  if (record(value)) {
    if (value.ok === false && typeof value.error === "string") {
      if (value.code !== undefined && typeof value.code !== "string") {
        throw new ProtocolError("Invalid Crew reply.");
      }
      return {
        ok: false,
        error: value.error,
        ...(value.code === undefined ? {} : { code: value.code }),
      };
    }

    if (value.ok === true) {
      if (value.info === undefined) {
        if (
          value.directory !== undefined &&
          (typeof value.directory !== "string" || !value.directory.startsWith("/"))
        ) {
          throw new ProtocolError("Invalid Crew reply.");
        }
        return {
          ok: true,
          ...(value.directory === undefined ? {} : { directory: value.directory }),
        };
      }

      const info = value.info;
      if (
        record(info) &&
        isSafeId(info.sessionId) &&
        (info.instanceId === undefined || isSafeId(info.instanceId)) &&
        (info.lifecycle === undefined ||
          info.lifecycle === "interactive" ||
          info.lifecycle === "non-interactive") &&
        (info.role === "lead" || info.role === "member") &&
        (info.spawning === undefined || typeof info.spawning === "boolean") &&
        typeof info.pendingInput === "boolean" &&
        typeof info.title === "string" &&
        (info.state === "working" || info.state === "idle") &&
        typeof info.paneId === "string" &&
        typeof info.sessionFile === "string" &&
        (info.role === "lead"
          ? info.agent === undefined && info.origin === undefined && info.caller === undefined
          : typeof info.agent === "string" &&
            /^[a-z0-9-]+$/.test(info.agent) &&
            (info.origin === "tool" || info.origin === "menu") &&
            (info.caller === "" || isSafeId(info.caller)))
      ) {
        return { ok: true, info: info as unknown as AgentInfo };
      }
    }
  }

  throw new ProtocolError("Invalid Crew reply.");
}

/** Handler for inbound requests, supplied by the extension. */
export type RequestHandler = (req: Request) => Promise<Reply>;