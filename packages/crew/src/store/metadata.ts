import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Atomic durable metadata replacement. A failed write/rename/fsync is activation failure. */
export function writeMetadata(path: string, value: unknown): void {
  const temporary = `${path}.pending`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

export function metadata(path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || value.version !== 1) {
    throw new Error(`Unsupported Crew metadata: ${path}`);
  }
  return value;
}