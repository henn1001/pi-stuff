import type { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, mkdirSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDirectory, identityKey, lockFile, stateDirectory } from "./ownership.ts";
import { SCHEMA, SCHEMA_VERSION } from "./ledger-schema.ts";
import { LocalStore } from "./local-store.ts";
import { metadata, syncDirectory, writeMetadata } from "./metadata.ts";

/** Probe without creating authority. The global binding detects cross-workspace resumes
 * even if the target workspace has never activated Crew. Fork IDs have no binding.
 */
export function checkSessionBinding(workspaceId: string, sessionId: string): boolean {
  const path = join(stateDirectory(), "sessions", `${identityKey(sessionId)}.json`);
  if (!existsSync(path)) {
    return false;
  }
  const binding = metadata(path);
  if (binding.workspaceId !== workspaceId || binding.sessionId !== sessionId) {
    throw new Error(
      "Crew session belongs to another workspace. Resume in the original workspace; copying JSONL does not transfer authority.",
    );
  }
  return true;
}

export function hasWorkspaceLedger(workspaceId: string): boolean {
  const root = stateDirectory();
  const key = identityKey(workspaceId);
  return (
    existsSync(join(root, "workspaces", `${key}.json`)) || existsSync(join(root, "workspaces", key))
  );
}

/** Creation only on first activation. Preparing metadata commits BEFORE database creation;
 * ready metadata commits AFTER SQL/schema/checkpoint. Interrupted initialization always
 * fails closed, including a missing DB or marker. No repair/reset/migration is implicit.
 */
export async function openLedger(workspaceId: string, initialize: boolean): Promise<LocalStore> {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error(
      "Crew requires Node 24+ with built-in node:sqlite; pi remains usable without Crew.",
    );
  }
  const { DatabaseSync } = await import("node:sqlite");
  const root = stateDirectory();
  ensureDirectory(root);
  // Fail closed on remote, volatile and unqualified filesystems (including overlay).
  // This is a support policy, not proof of physical media/fsync correctness.
  const localFilesystems = new Set([0xef53, 0x58465342, 0x9123683e, 0xf2f52010, 0x2fc12fc1]);
  if (!localFilesystems.has(statfsSync(root).type)) {
    throw new Error(
      "Crew requires a local ext4, XFS, Btrfs, F2FS or ZFS state directory with reliable fsync and flock.",
    );
  }
  for (const name of ["runtime", "workspaces", "sessions"]) {
    ensureDirectory(join(root, name));
  }
  syncDirectory(dirname(root));
  syncDirectory(root);
  const key = identityKey(workspaceId);
  const fd = lockFile(join(root, "runtime", `initialize-${key}.lock`));
  let db: DatabaseSync | undefined;
  const dir = join(root, "workspaces", key);
  const marker = join(root, "workspaces", `${key}.json`);
  const path = join(dir, "ledger.sqlite");
  try {
    const fresh = !existsSync(marker) && !existsSync(dir) && !existsSync(`${marker}.pending`);
    if (fresh && !initialize) {
      throw new Error("Crew ledger is missing.");
    }
    if (!fresh) {
      if (!existsSync(marker)) {
        throw new Error("Crew initialization metadata is missing or interrupted.");
      }
      const info = metadata(marker);
      if (info.workspaceId !== workspaceId || info.state !== "ready" || !existsSync(path)) {
        throw new Error("Crew ledger is missing or initialization was interrupted.");
      }
    } else {
      writeMetadata(marker, { version: 1, workspaceId, state: "preparing" });
      mkdirSync(dir, { mode: 0o700 });
      syncDirectory(dirname(dir));
    }
    if (!localFilesystems.has(statfsSync(dir).type)) {
      throw new Error("Crew ledger must reside on a supported local persistent filesystem.");
    }
    db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const mode = db.prepare("PRAGMA journal_mode=WAL").get();
    db.exec("PRAGMA synchronous=FULL");
    if (
      mode?.journal_mode !== "wal" ||
      db.prepare("PRAGMA synchronous").get()?.synchronous !== 2 ||
      db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1
    ) {
      throw new Error("Crew required SQLite durability settings are unavailable.");
    }
    const ledger = new LocalStore(db, workspaceId);
    if (fresh) {
      ledger.transaction(Date.now() + 5_000, (connection) => {
        connection.exec(SCHEMA);
        connection.prepare("INSERT INTO workspace VALUES(?,?)").run(workspaceId, SCHEMA_VERSION);
        connection.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      });
      db.exec("PRAGMA wal_checkpoint(FULL)");
      syncDirectory(dir);
      writeMetadata(marker, { version: 1, workspaceId, state: "ready" });
    }
    const workspace = db.prepare("SELECT workspace_id,schema_version FROM workspace").get();
    if (
      db.prepare("PRAGMA user_version").get()?.user_version !== SCHEMA_VERSION ||
      workspace?.workspace_id !== workspaceId ||
      workspace.schema_version !== SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported Crew ledger schema or workspace identity (requires schema ${SCHEMA_VERSION}). Preserve the original ledger; an explicit transactional upgrade is required for older development ledgers. No automatic migration or empty replacement is supported.`,
      );
    }
    if (
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    ) {
      throw new Error("Crew ledger integrity check failed.");
    }
    db.exec("PRAGMA busy_timeout=0");
    return ledger;
  } catch (error) {
    db?.close();
    throw new Error(
      `Crew ledger unavailable at ${path}. Restore the original state directory/ledger; do not delete metadata or reconstruct from JSONL. ${String(error)}`,
      { cause: error },
    );
  } finally {
    closeSync(fd);
  }
}