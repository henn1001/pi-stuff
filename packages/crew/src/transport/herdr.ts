import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/** Geometry and provenance from one Herdr snapshot, not inferred from pane titles. */
export interface HerdrPane {
  id: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  tabTitle: string;
  title: string;
  cols: number;
  rows: number;
  x: number;
  y: number;
  zoomed: boolean;
  tokens: Record<string, string>;
  /** Herdr-observed occupant identity from the same topology snapshot. */
  agent?: string;
  agentSession?: { agent: string; kind: string; value: string };
}

/** Inherited caller location; never a substitute for live layout evidence. */
export interface HerdrEnv {
  workspaceId: string;
  paneId: string;
}

export function requireHerdr(): HerdrEnv {
  const { HERDR_ENV, HERDR_WORKSPACE_ID, HERDR_PANE_ID } = process.env;
  if (HERDR_ENV !== "1" || !HERDR_WORKSPACE_ID || !HERDR_PANE_ID) {
    throw new Error("Crew requires a Herdr-managed pane.");
  }

  executablePath("herdr");
  return { workspaceId: HERDR_WORKSPACE_ID, paneId: HERDR_PANE_ID };
}

/** Resolve against the immediate process environment, not a newly created shell's PATH. */
export function executablePath(name: string): string {
  // Use the immediate environment's first executable match, like normal PATH lookup.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = resolve(join(dir, name));
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) {
        return path;
      }
    } catch {
      /* Try the next PATH entry. */
    }
  }

  throw new Error(`Crew requires the ${name} executable in PATH.`);
}

/** CLI errors omit argv: command text and environment may contain private data. */
export async function herdr(args: string[], json = true): Promise<any> {
  requireHerdr();
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "herdr",
      args,
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Herdr ${args[0]} ${args[1]} failed (${error.code ?? "unknown"}). ${stderr.trim()}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });

  if (!json) {
    return undefined;
  }

  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Herdr returned invalid JSON.");
  }

  if (!value?.result || typeof value.result !== "object") {
    throw new Error("Herdr returned no result.");
  }

  return value.result;
}

/** Read and cross-check live pane membership, geometry, and occupant identity. */
export async function listPanes(workspaceId: string): Promise<HerdrPane[]> {
  const result = await herdr(["api", "snapshot"]);
  const snap = result.snapshot;

  if (!Array.isArray(snap?.panes) || !Array.isArray(snap?.tabs) || !Array.isArray(snap?.layouts)) {
    throw new Error("Herdr snapshot lacks panes, tabs, or layouts.");
  }

  const panes = snap.panes.filter((p: any) => p?.workspace_id === workspaceId);

  if (new Set(panes.map((p: any) => p.pane_id)).size !== panes.length) {
    throw new Error("Herdr snapshot contains duplicate pane identities.");
  }

  return panes.map((p: any) => {
    const tab = snap.tabs.find((t: any) => t.tab_id === p.tab_id && t.workspace_id === workspaceId);

    const layout = snap.layouts.find(
      (l: any) => l.tab_id === p.tab_id && l.workspace_id === workspaceId,
    );
    const geometry = layout?.panes?.find((g: any) => g.pane_id === p.pane_id)?.rect;

    const liveIds = snap.panes
      .filter((q: any) => q.tab_id === p.tab_id)
      .map((q: any) => q.pane_id)
      .sort();
    const layoutIds = layout?.panes?.map((g: any) => g.pane_id).sort();

    // Herdr reports topology in separate arrays; verify they agree before trusting pane data.
    const tabAndLayoutAreUnique =
      snap.tabs.filter((t: any) => t.tab_id === p.tab_id).length === 1 &&
      snap.layouts.filter((l: any) => l.tab_id === p.tab_id).length === 1;
    const paneMembershipMatchesLayout =
      JSON.stringify(liveIds) === JSON.stringify(layoutIds) && tab?.pane_count === liveIds.length;
    const geometryIsValid =
      Boolean(geometry) &&
      typeof layout?.zoomed === "boolean" &&
      [geometry.width, geometry.height, geometry.x, geometry.y].every(Number.isInteger) &&
      geometry.width > 0 &&
      geometry.height > 0;
    const paneIdentityIsValid = typeof p.pane_id === "string" && typeof p.terminal_id === "string";
    const labelsAreValid =
      (p.label == null || typeof p.label === "string") &&
      (tab?.label == null || typeof tab.label === "string");
    const tokensAreValid =
      p.tokens === undefined ||
      (typeof p.tokens === "object" &&
        p.tokens !== null &&
        !Array.isArray(p.tokens) &&
        Object.values(p.tokens).every((value) => typeof value === "string"));

    if (
      !tab ||
      !tabAndLayoutAreUnique ||
      !paneMembershipMatchesLayout ||
      !geometryIsValid ||
      !paneIdentityIsValid ||
      !labelsAreValid ||
      !tokensAreValid
    ) {
      throw new Error(`Inconsistent Herdr topology for pane ${p.pane_id}.`);
    }

    return {
      id: p.pane_id,
      terminalId: p.terminal_id,
      workspaceId,
      tabId: p.tab_id,
      tabTitle: tab.label ?? "",
      title: p.label ?? p.title ?? "",
      cols: geometry.width,
      rows: geometry.height,
      x: geometry.x,
      y: geometry.y,
      zoomed: layout.zoomed,
      tokens: p.tokens ?? {},
      agent: p.agent ?? undefined,
      agentSession: p.agent_session ?? undefined,
    };
  });
}

async function created(result: any, key: string): Promise<HerdrPane> {
  const raw = result[key];
  if (typeof raw?.pane_id !== "string" || typeof raw?.workspace_id !== "string") {
    throw new Error("Herdr creation response lacks pane identity.");
  }
  const pane = (await listPanes(raw.workspace_id)).find((p) => p.id === raw.pane_id);
  if (!pane) {
    throw new Error(`Created pane ${raw.pane_id} is no longer present.`);
  }

  const deadline = Date.now() + 5_000;
  let idleSince = Date.now();
  // Shell initialization can briefly return foreground ownership between startup subprocesses.
  while (Date.now() - idleSince < 300) {
    if (!(await isShellIdle(pane.id))) {
      idleSince = Date.now();
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Created pane ${pane.id} shell did not become ready within 5 seconds; pane left untouched.`,
      );
    }
    await delay(50);
  }

  return pane;
}

export async function splitPane(
  target: string,
  direction: "right" | "down",
  command: string[],
  cwd: string,
): Promise<HerdrPane> {
  const pane = await created(
    await herdr(["pane", "split", target, "--direction", direction, "--cwd", cwd, "--no-focus"]),
    "pane",
  );

  if (command.length) {
    await runPane(pane.id, command, cwd);
  }

  return pane;
}

export async function createTab(
  workspaceId: string,
  title: string,
  command: string[],
  cwd: string,
): Promise<HerdrPane> {
  const pane = await created(
    await herdr([
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--label",
      title,
      "--cwd",
      cwd,
      "--no-focus",
    ]),
    "root_pane",
  );

  if (command.length) {
    await runPane(pane.id, command, cwd);
  }

  return pane;
}

/** POSIX shell literals, verified with the managed zsh. Never interpolate executable input. */
export function shellQuote(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Shell arguments cannot contain NUL.");
  }

  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function isShellIdle(paneId: string): Promise<boolean> {
  const result = await herdr(["pane", "process-info", "--pane", paneId]);
  const info = result.process_info;
  if (
    !info ||
    typeof info !== "object" ||
    Array.isArray(info) ||
    (info.shell_pid != null && !Number.isInteger(info.shell_pid)) ||
    (info.foreground_processes !== undefined && !Array.isArray(info.foreground_processes))
  ) {
    throw new Error("Herdr returned invalid process information.");
  }

  // Herdr may not have observed the new shell yet; created() keeps waiting in that case.
  if (info.shell_pid == null || info.foreground_processes === undefined) {
    return false;
  }

  return (
    info.foreground_process_group_id === info.shell_pid &&
    info.foreground_processes.length === 1 &&
    info.foreground_processes[0].pid === info.shell_pid
  );
}

export async function runPane(
  paneId: string,
  argv: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  if (!argv.length) {
    throw new Error("Cannot start an empty command.");
  }

  if (!(await isShellIdle(paneId))) {
    throw new Error(`Pane ${paneId} is not an unused foreground shell.`);
  }

  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error("Invalid environment key.");
    }

    return `${key}=${value}`;
  });

  const text = `cd -- ${shellQuote(cwd)} && exec ${["env", ...assignments, ...argv].map(shellQuote).join(" ")}`;
  await herdr(["pane", "run", paneId, text], false);
}

export async function markPane(paneId: string, tokens: Record<string, string>): Promise<void> {
  await herdr(
    [
      "pane",
      "report-metadata",
      paneId,
      "--source",
      "crew",
      ...Object.entries(tokens).flatMap(([k, v]) => ["--token", `${k}=${v}`]),
    ],
    false,
  );
}

export async function renamePane(paneId: string, title: string): Promise<void> {
  await herdr(["pane", "rename", paneId, title], false);
}

/** The CLI exposes directional focus only; use the documented direct socket method. */
export async function focusPane(paneId: string): Promise<void> {
  requireHerdr();

  const path = process.env.HERDR_SOCKET_PATH;
  if (!path) {
    throw new Error("Herdr socket path is unavailable for direct pane focus.");
  }

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    let pending = "";
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.setTimeout(5_000, () => finish(new Error("Herdr pane focus timed out.")));
    socket.on("error", finish);

    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ id: "crew:focus", method: "pane.focus", params: { pane_id: paneId } })}\n`,
      ),
    );

    socket.on("data", (chunk) => {
      pending += chunk.toString();
      if (!pending.includes("\n")) {
        return;
      }

      try {
        const reply = JSON.parse(pending.slice(0, pending.indexOf("\n")));
        if (reply.error || !reply.result) {
          throw new Error(reply.error?.message ?? "Invalid Herdr focus reply.");
        }
        finish();
      } catch (error) {
        finish(error as Error);
      }
    });

    socket.on("end", () => finish(new Error("Herdr closed before focus acknowledgement.")));
  });
}