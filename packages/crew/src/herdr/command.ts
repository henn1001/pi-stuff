import { setTimeout as delay } from "node:timers/promises";
import { herdr } from "./cli.ts";
import { isShellIdle, listPanes, type HerdrPane } from "./observe.ts";

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

/** Write a Crew delivery prompt into an agent pane; coordinator-only. */
export async function promptAgent(paneId: string, text: string): Promise<void> {
  await herdr(["agent", "prompt", paneId, text]);
}

/** Close a pane for automatic lifecycle closure; coordinator-only. */
export async function closePane(paneId: string): Promise<void> {
  await herdr(["pane", "close", paneId]);
}