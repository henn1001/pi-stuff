import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

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
/** Whether this process has the Herdr caller context required by Crew. */
export function hasHerdrContext(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    Boolean(process.env.HERDR_WORKSPACE_ID) &&
    Boolean(process.env.HERDR_PANE_ID)
  );
}