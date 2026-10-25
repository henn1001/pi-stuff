import { readFileSync } from "node:fs";
import { hostname } from "node:os";

/** Same-host Linux process identity; PID alone is never an instance identity. */
export interface ProcessIdentity {
  pid: number;
  processStart: string;
  hostId: string;
  bootId: string;
}
/** Exact OS presence, independent of adapter reachability or assignment state. */
export type ProcessPresence = "alive" | "exited" | "unknown";

function hostIdentity() {
  if (process.platform !== "linux") {
    throw new Error("Crew exact-process supervision requires same-host Linux procfs.");
  }
  const machine = readFileSync("/etc/machine-id", "utf8").trim();
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!machine || !bootId) {
    throw new Error("Crew host/boot identity is unavailable.");
  }
  return { hostId: `${hostname()}:${machine}`, bootId };
}

function processStat(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Invalid process PID.");
  }
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(")");
  if (end < 0 || !stat.startsWith(`${pid} (`)) {
    throw new Error("Crew cannot read reliable process start identity.");
  }
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (!fields[0] || !/^\d+$/.test(fields[19] ?? "")) {
    throw new Error("Crew cannot read reliable process start identity.");
  }
  return { state: fields[0], processStart: fields[19]! };
}

/** Capture a live same-host identity; failure must prevent readiness. */
export function captureProcess(pid = process.pid): ProcessIdentity {
  const host = hostIdentity();
  const stat = processStat(pid);
  if (["Z", "X", "x"].includes(stat.state)) {
    throw new Error("Crew process already exited.");
  }
  return { pid, processStart: stat.processStart, ...host };
}

/** Read/permission errors are unknown. Different hosts cannot establish exit.
 * A changed boot on the same host, missing PID, reused PID or zombie proves exit.
 */
export function processPresence(identity: ProcessIdentity): ProcessPresence {
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    !/^\d+$/.test(identity.processStart) ||
    !identity.hostId ||
    identity.hostId === "undefined" ||
    !/^[0-9a-f-]{36}$/i.test(identity.bootId)
  ) {
    return "unknown";
  }
  try {
    const host = hostIdentity();
    if (host.hostId !== identity.hostId) {
      return "unknown";
    }
    if (host.bootId !== identity.bootId) {
      return "exited";
    }
    try {
      const stat = processStat(identity.pid);
      return stat.processStart !== identity.processStart || ["Z", "X", "x"].includes(stat.state)
        ? "exited"
        : "alive";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "exited" : "unknown";
    }
  } catch {
    return "unknown";
  }
}

/** Decode the immutable identity recorded for one durable instance. */
export function rowProcess(row: Record<string, unknown>): ProcessIdentity {
  return {
    pid: Number(row.pid),
    processStart: String(row.process_start),
    hostId: String(row.host_id),
    bootId: String(row.boot_id),
  };
}