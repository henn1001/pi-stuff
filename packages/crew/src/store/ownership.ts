import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./agent-home.ts";

/** Stable Herdr IDs are opaque: hash for paths, retain the full identity in records. */
export function identityKey(id: string): string {
  if (!id || id.includes("\0")) {
    throw new Error("Crew requires a non-empty stable identity.");
  }
  return createHash("sha256").update(id).digest("hex");
}

/** Crew-owned durable state under Pi's resolved agent home. */
export function stateDirectory(): string {
  return join(agentDir(), "crew", "state");
}

/** Persist every newly created directory entry, including a previously absent agent home. */
export function ensureDirectory(path: string): void {
  if (existsSync(path)) {
    return;
  }
  ensureDirectory(dirname(path));
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Linux flock locks the inherited open-file description, retained by this process.
 * Never unlink these files; inode replacement would defeat exclusion. */
export function lockFile(path: string): number {
  if (process.platform !== "linux") {
    throw new Error("Crew ownership currently requires Linux and util-linux flock.");
  }
  const fd = openSync(path, "a", 0o600);
  const result = spawnSync("flock", ["--exclusive", "--nonblock", "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    closeSync(fd);
    throw new Error(
      `Crew cannot acquire ${path}: ${result.error?.message ?? result.stderr?.toString().trim() ?? "ownership conflict"}. Another runtime may own it; do not delete lock files.`,
    );
  }
  return fd;
}

/** Process-local capability backed by session and optional workspace OS locks. */
export interface Ownership {
  workspaceId: string;
  sessionId: string;
  instanceId: string;
  sessionFd: number;
  workspaceFd?: number;
  /** Safety latch across reload if a takeover commit fails; never enables behavior. */
  automaticDisabled?: boolean;
}

// Plain data/descriptors only: never retain extension contexts, callbacks or SQLite connections.
const holderKey = Symbol.for("pi-crew.ownership.v1");
const host = globalThis as typeof globalThis & { [holderKey]?: Ownership };

/** Session first, then workspace (lead only). Reload renews the capability while retaining locks. */
export function acquireOwnership(workspaceId: string, sessionId: string, lead: boolean): Ownership {
  const previous = host[holderKey];
  if (previous) {
    if (
      previous.workspaceId !== workspaceId ||
      previous.sessionId !== sessionId ||
      lead !== (previous.workspaceFd !== undefined)
    ) {
      throw new Error(
        "Crew retained ownership does not match the requested session/workspace/role.",
      );
    }
    return (host[holderKey] = { ...previous });
  }
  const dir = join(stateDirectory(), "runtime");
  ensureDirectory(dir);
  const sessionFd = lockFile(join(dir, `session-${identityKey(sessionId)}.lock`));
  try {
    const workspaceFd = lead
      ? lockFile(join(dir, `workspace-${identityKey(workspaceId)}.lock`))
      : undefined;
    return (host[holderKey] = {
      workspaceId,
      sessionId,
      instanceId: randomUUID(),
      sessionFd,
      workspaceFd,
    });
  } catch (error) {
    closeSync(sessionFd);
    throw error;
  }
}

/** Reject stale or fabricated endpoint capabilities, including after shutdown. */
export function assertOwnership(owner: Ownership): void {
  if (host[holderKey] !== owner) {
    throw new Error("Crew endpoint no longer owns this session.");
  }
}

/** Reload deliberately does not call this. Process death also releases all descriptors. */
export function releaseOwnership(expected: Ownership): void {
  const holder = host[holderKey];
  if (!holder || holder !== expected) {
    return;
  }
  delete host[holderKey];
  if (holder.workspaceFd !== undefined) {
    closeSync(holder.workspaceFd);
  }
  closeSync(holder.sessionFd);
}