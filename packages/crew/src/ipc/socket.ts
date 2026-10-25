import { agentDir } from "../store/agent-home.ts";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import {
  decodeReply,
  decodeRequest,
  ProtocolError,
  type Reply,
  type Request,
  type RequestHandler,
} from "./protocol.ts";
import { isSafeId } from "../domain/ids.ts";

export const PROBE_TIMEOUT_MS = 5_000;
export const MAX_SOCKET_PATH_BYTES = 100;

/** Resolved Pi agent directory, with no alternate runtime location. */
export function socketDir(workspaceId: string): string {
  if (!isSafeId(workspaceId)) {
    throw new Error(`Unsupported workspace ID: ${workspaceId}`);
  }

  return join(agentDir(), "crew", "sockets", workspaceId);
}

export function socketPath(workspaceId: string, sessionId: string): string {
  if (!isSafeId(sessionId)) {
    throw new Error(`Unsupported session ID: ${sessionId}`);
  }

  const path = join(socketDir(workspaceId), `${sessionId}.sock`);
  if (Buffer.byteLength(path, "utf8") > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`Crew socket path exceeds ${MAX_SOCKET_PATH_BYTES} UTF-8 bytes: ${path}`);
  }

  return path;
}

export interface SocketServer {
  close(): Promise<void>;
}

function stat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Synchronous identity check/unlink avoids yielding between observation and cleanup. */
function unlinkOwned(path: string, owner: Stats | undefined): void {
  const current = stat(path);

  if (
    owner?.isSocket() &&
    current?.isSocket() &&
    owner.dev === current.dev &&
    owner.ino === current.ino
  ) {
    unlinkSync(path);
  }
}

/** Buffer bytes until newline; fatal decoding rejects invalid or truncated UTF-8. */
function readFrame(
  socket: Socket,
  accept: (value: unknown) => void,
  fail: (error: Error) => void,
): void {
  let pending = Buffer.alloc(0);
  let complete = false;
  socket.on("data", (chunk: Buffer) => {
    if (complete) {
      return;
    }

    pending = Buffer.concat([pending, chunk]);

    const newline = pending.indexOf(10);
    if (newline < 0) {
      return;
    }

    complete = true;
    try {
      if (newline !== pending.length - 1) {
        throw new ProtocolError("Expected one Crew JSON line.");
      }
      const line = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline));
      accept(JSON.parse(line));
    } catch (error) {
      fail(
        error instanceof ProtocolError
          ? error
          : new ProtocolError(`Invalid Crew JSON frame: ${String(error)}`),
      );
    }
  });

  socket.on("end", () => {
    if (!complete) {
      fail(new ProtocolError("Truncated Crew frame."));
    }
  });
}

export async function listen(
  workspaceId: string,
  sessionId: string,
  handler: RequestHandler,
): Promise<SocketServer> {
  const path = socketPath(workspaceId, sessionId);
  const dir = socketDir(workspaceId);

  // Never chmod the agent directory itself.
  for (const privateDir of [join(agentDir(), "crew"), join(agentDir(), "crew", "sockets"), dir]) {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(privateDir).isDirectory()) {
      throw new Error(`Not a Crew directory: ${privateDir}`);
    }
    chmodSync(privateDir, 0o700);
  }

  if (stat(path)) {
    try {
      await request(workspaceId, sessionId, { kind: "ping" });
    } catch (error) {
      if (!(error instanceof NotConnectedError)) {
        throw error;
      }
    }

    if (stat(path)) {
      throw new Error(`Crew endpoint already exists: ${path}`);
    }
  }

  const connections = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket);

    const timer = setTimeout(() => socket.destroy(), PROBE_TIMEOUT_MS);
    socket.on("close", () => {
      clearTimeout(timer);
      connections.delete(socket);
    });
    socket.on("error", () => socket.destroy());

    let replied = false;
    const reply = (value: Reply) => {
      if (replied || socket.destroyed) {
        return;
      }
      replied = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    const fail = (error: unknown) =>
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });

    readFrame(
      socket,
      (value) => {
        let req: Request;
        try {
          req = decodeRequest(value);
        } catch (error) {
          fail(error);
          return;
        }

        Promise.resolve()
          .then(() => handler(req))
          .then((value) => reply(decodeReply(value)))
          .catch(fail);
      },
      fail,
    );
  });

  // libuv unconditionally unlinks its bind name on close. Publish via a no-clobber
  // hard link so that libuv never owns the public address or a replacement there.
  // This private name is no longer than the validated public filename.
  const bindPath = join(dir, randomBytes(3).toString("hex"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bindPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch((error) => {
    server.close();
    throw error;
  });

  try {
    linkSync(bindPath, path);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  const owner = stat(path);
  let closing: Promise<void> | undefined;

  return {
    close() {
      return (closing ??= new Promise<void>((resolve, reject) => {
        // Force active clients to finish before removing this server's owned endpoint.
        for (const socket of connections) {
          socket.destroy();
        }

        server.close((error) => {
          try {
            unlinkOwned(path, owner);
          } catch (cleanupError) {
            reject(cleanupError);
            return;
          }
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }));
    },
  };
}

/** No retries: timeout means delivery is unconfirmed, not that the endpoint is stale. */
export async function request(
  workspaceId: string,
  to: string,
  req: Request,
  signal?: AbortSignal,
): Promise<Reply> {
  const path = socketPath(workspaceId, to);
  const payload = decodeRequest(req);
  signal?.throwIfAborted();

  const owner = stat(path);

  return new Promise<Reply>((resolve, reject) => {
    const socket = createConnection(path);
    let finished = false;

    const finish = (error?: unknown, reply?: Reply) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(reply!);
      }
    };

    const abort = () => finish(signal?.reason ?? new Error("Crew request aborted."));
    const timer = setTimeout(
      () => finish(new UnresponsiveError(`Agent "${to}" unresponsive; delivery unconfirmed.`)),
      PROBE_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", abort, { once: true });

    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));

    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        try {
          if (error.code === "ECONNREFUSED") {
            unlinkOwned(path, owner);
          }
        } catch (cleanupError) {
          finish(cleanupError);
          return;
        }

        finish(new NotConnectedError(`Agent "${to}" is not connected.`));
      } else {
        finish(error);
      }
    });

    readFrame(
      socket,
      (value) => {
        try {
          finish(undefined, decodeReply(value));
        } catch (error) {
          finish(error);
        }
      },
      finish,
    );

    socket.on("close", () => {
      if (!finished) {
        finish(new Error("Crew connection closed before acknowledgement."));
      }
    });
  });
}

export class NotConnectedError extends Error {}
export class UnresponsiveError extends Error {}

export async function listSocketIds(workspaceId: string): Promise<string[]> {
  try {
    return readdirSync(socketDir(workspaceId), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isSocket() && entry.name.endsWith(".sock") && isSafeId(entry.name.slice(0, -5)),
      )
      .map((entry) => entry.name.slice(0, -5));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}