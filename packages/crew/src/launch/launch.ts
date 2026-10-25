import { CREW_TOOL_NAMES } from "../domain/tools.ts";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executablePath } from "../herdr/cli.ts";
import { socketDir } from "../ipc/socket.ts";
import { isSafeId } from "../domain/ids.ts";
import { type AgentDefinition } from "../domain/agent.ts";
import { type Origin, type SpawnRecord } from "../domain/member.ts";

/** Maximum wait for a newly launched member to establish its session identity. */
export const STARTUP_TIMEOUT_MS = 30_000;
/** Display-only member title inherited by the launched process. */
export const ENV_CREW_TITLE = "PI_CREW_TITLE";
/** Private launch snapshot retained for the member process and its reloads. */
export const ENV_CONFIG_DIR = "PI_CREW_CONFIG_DIR";

/**
 * pi-facing inputs to a launch, injected so `launch/` never imports pi. Created at the call site
 * from the spawner's current context (see `extension/launch-host.ts`).
 */
export interface LaunchHost {
  /** Pi agent directory handed to the child. */
  agentDir: string;
  /** Working directory of the spawning session. */
  cwd: string;
  /** Validate and resolve the exact model and thinking level; throws the launch precondition error. */
  resolveModel(def: AgentDefinition): { provider: string; id: string; thinking: string };
  /** Resolve skill names to file paths in the requested order; throws for unknown skills. */
  resolveSkills(names: string[]): Promise<string[]>;
  /** Session header and selected-branch entries for a fork snapshot. */
  forkEntries(): unknown[];
}

/** Capture the immediate spawner's current context at the call site, not in the extension factory. */
export interface LaunchSpec {
  host: LaunchHost;
  definition: AgentDefinition;
  origin: Origin;
  caller: string;
  projectCwd: string;
  workspaceId: string;
  prompt?: string;
  /** Parent-local durable alias; menu launches remain unnamed. */
  taskName?: string;
  /** Saved original identity/relationship; resume never applies the definition's fork mode. */
  resume?: SpawnRecord;
}

/** Prepared private launch resources; preparation itself never starts a process. */
export interface BuiltLaunch {
  argv: string[];
  executable: string;
  env: Record<string, string>;
  cwd: string;
  directory: string;
  cleanup(): void;
}

/** Successfully recorded launch identity and its observed running instance. */
export interface LaunchResult extends SpawnRecord {
  paneId: string;
  title: string;
  definition: AgentDefinition;
  instanceId?: string;
  /** Reserved name returned only after atomic child/result recording. */
  taskName: string | null;
}

/** Validate before allocating a pane; temporary resources are private and caller-owned. */
export async function buildLaunch(spec: LaunchSpec): Promise<BuiltLaunch> {
  const { definition: def, host } = spec;

  if (!isSafeId(spec.caller) || !isAbsolute(spec.projectCwd)) {
    throw new Error("Invalid Crew caller/catalog anchor.");
  }

  if (
    spec.resume &&
    (spec.resume.caller !== spec.caller ||
      spec.resume.agent !== def.name ||
      spec.resume.origin !== spec.origin)
  ) {
    throw new Error("Resume must preserve the saved caller, definition and origin.");
  }

  if (
    spec.resume &&
    (!isAbsolute(spec.resume.sessionFile) || !existsSync(spec.resume.sessionFile))
  ) {
    throw new Error("The saved member session file does not exist.");
  }

  if (spec.prompt !== undefined && typeof spec.prompt !== "string") {
    throw new Error("Crew task input must be text.");
  }

  if (spec.origin === "tool" && !spec.resume && spec.prompt === undefined) {
    throw new Error("A tool-origin launch requires task input.");
  }

  const { provider, id, thinking } = host.resolveModel(def);

  if (typeof process.execve !== "function") {
    throw new Error("Crew member launch requires Node's Unix execve API.");
  }

  const executable = executablePath("pi");
  const cwd = host.cwd;
  const agentDir = resolve(host.agentDir);
  const argv = [
    "pi",
    "--extension",
    fileURLToPath(new URL("../../index.ts", import.meta.url)),
    "--provider",
    provider,
    "--model",
    id,
    "--thinking",
    thinking,
  ];

  if (spec.resume) {
    argv.push("--session", spec.resume.sessionFile);
  }

  const required = [
    "send_message",
    "report_task",
    "list_agents",
    ...(def.spawning ? ["spawn_agent"] : []),
  ];

  if (def.tools !== undefined) {
    const optional = def.tools.filter((t) => !(CREW_TOOL_NAMES as readonly string[]).includes(t));
    argv.push("--tools", [...new Set([...optional, ...required])].join(","));
    // Pi retains MCP tools unless the allowlist contains an MCP name.
    if (!optional.some((name) => name.startsWith("mcp__"))) {
      argv.push("--exclude-tools", "mcp__*");
    }
  } else {
    argv.push("--tools", required.map((t) => `+${t}`).join(","));
  }

  if (def.skills !== undefined) {
    argv.push("--no-skills");
    if (def.skills.length) {
      // Keep the requested skill order in the child CLI arguments.
      for (const file of await host.resolveSkills(def.skills)) {
        argv.push("--skill", file);
      }
    }
  }

  // socketDir creation is normally done by the caller's socket; fail explicitly if inactive.
  const directory = mkdtempSync(join(socketDir(spec.workspaceId), ".launch-"));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });

  try {
    if (!spec.resume && def.sessionMode === "fork") {
      // --fork copies the file's last leaf, not the spawner's selected in-memory branch.
      const snapshot = join(directory, "fork.jsonl");
      writeFileSync(
        snapshot,
        host
          .forkEntries()
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
        { mode: 0o600 },
      );
      argv.push("--fork", snapshot);
    }

    if (def.body.trim()) {
      const promptFile = join(directory, "system.md");
      writeFileSync(promptFile, def.body, { mode: 0o600 });
      argv.push(
        def.systemPrompt === "replace" ? "--system-prompt" : "--append-system-prompt",
        promptFile,
      );
    }

    writeFileSync(
      join(directory, "input.json"),
      JSON.stringify({
        prompt: spec.prompt,
        definition: def,
        expected: { provider, model: id, thinking, cwd },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(directory, "exec.mjs"),
      [
        'import { readFileSync, unlinkSync } from "node:fs";',
        'import { fileURLToPath } from "node:url";',
        'const path = new URL("./launch.json", import.meta.url);',
        'const spec = JSON.parse(readFileSync(path, "utf8"));',
        "unlinkSync(path); unlinkSync(fileURLToPath(import.meta.url));",
        'const context = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("HERDR_")));',
        "process.execve(spec.executable, [spec.executable, ...spec.argv.slice(1)], { ...spec.env, ...context });",
      ].join("\n"),
      { mode: 0o600 },
    );

    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined &&
          !key.startsWith("HERDR_") &&
          !["PI_SESSION_ID", "PI_SESSION_FILE", "PI_CODING_AGENT"].includes(key),
      ),
    ) as Record<string, string>;

    if (spec.prompt !== undefined) {
      argv.push("--", spec.prompt);
    }
    const built: BuiltLaunch = {
      argv,
      executable,
      cwd,
      directory,
      cleanup,
      env: {
        ...inheritedEnv,
        PWD: cwd,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SUBAGENT_ID: "true",
        PI_CREW_SESSION_ID: "",
        PI_CREW_AGENT: def.name,
        PI_CREW_ORIGIN: spec.origin,
        PI_CREW_CALLER: spec.caller,
        PI_CREW_PROJECT_CWD: spec.projectCwd,
        [ENV_CONFIG_DIR]: directory,
      },
    };
    writeFileSync(join(directory, "launch.json"), JSON.stringify(built), { mode: 0o600 });
    return built;
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Private, volatile definition snapshot; edits apply to the next launch, not midway through startup. */
export function readLaunchDefinition(
  agent: string,
  sessionId: string,
): AgentDefinition | undefined {
  if (process.env.PI_CREW_SESSION_ID && process.env.PI_CREW_SESSION_ID !== sessionId) {
    delete process.env[ENV_CONFIG_DIR];
  }

  const directory = process.env[ENV_CONFIG_DIR];

  if (!directory) {
    return undefined;
  }

  const { definition } = JSON.parse(readFileSync(join(directory, "input.json"), "utf8"));

  if (!definition || definition.name !== agent || typeof definition.spawning !== "boolean") {
    throw new Error("Crew launch definition does not match member metadata.");
  }

  return definition;
}