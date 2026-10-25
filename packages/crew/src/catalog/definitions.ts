import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { THINKING_LEVELS, type AgentDefinition } from "../domain/agent.ts";

/** Bundled definitions shipped with this extension (`src/catalog/bundled/`). */
export const BUNDLED_AGENTS_DIR = fileURLToPath(new URL("./bundled/", import.meta.url));

const NAME_PATTERN = /^[a-z0-9-]+(?![\s\S])/;
const NAME_LIST = Type.Union([
  Type.Null(),
  Type.String(),
  Type.Array(Type.String({ pattern: "\\S" })),
]);

/** Decoded YAML fields; unknown fields are ignored before normalization. */
const FRONTMATTER = Type.Object({
  name: Type.Optional(Type.String({ pattern: NAME_PATTERN.source })),
  description: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
  tools: Type.Optional(NAME_LIST),
  skills: Type.Optional(NAME_LIST),
  "system-prompt": Type.Optional(Type.Union([Type.Literal("append"), Type.Literal("replace")])),
  "session-mode": Type.Optional(Type.Union([Type.Literal("standalone"), Type.Literal("fork")])),
  spawning: Type.Optional(Type.Boolean()),
  "auto-exit": Type.Optional(Type.Boolean()),
  "disable-model-invocation": Type.Optional(Type.Boolean()),
});

/** Definition visibility; lifecycle restrictions are supplied by the runtime. */
export function catalogFor(defs: Iterable<AgentDefinition>, automatic: boolean): AgentDefinition[] {
  return [...defs]
    .filter(
      (definition) => !definition.disableModelInvocation && (!automatic || definition.autoExit),
    )
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** Discover project > user > bundled definitions. Reads files on each call. */
export async function loadDefinitions(
  leadProjectCwd: string,
): Promise<Map<string, AgentDefinition>> {
  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;

  const userAgentDir = configuredAgentDir
    ? resolve(expandTilde(configuredAgentDir))
    : join(homedir(), ".pi", "agent");

  const sources: Array<{ source: AgentDefinition["source"]; directory: string }> = [
    { source: "project", directory: join(leadProjectCwd, ".pi", "agents") },
    { source: "user", directory: join(userAgentDir, "agents") },
    { source: "bundled", directory: BUNDLED_AGENTS_DIR },
  ];

  const definitions = new Map<string, AgentDefinition>();

  // Earlier sources win while duplicates within one source remain errors.
  for (const { source, directory } of sources) {
    const namesAtSource = new Set<string>();

    // Reject local duplicates without blocking higher-precedence overrides.
    for (const definition of await loadSource(directory, source)) {
      if (namesAtSource.has(definition.name)) {
        throw new Error(
          `Duplicate agent definition ${JSON.stringify(definition.name)} at the same precedence in ${directory}.`,
        );
      }
      namesAtSource.add(definition.name);

      if (!definitions.has(definition.name)) {
        definitions.set(definition.name, definition);
      }
    }
  }

  return definitions;
}

/** Parse and validate one YAML-frontmatter definition (docs/agent-frontmatter-rules.md#parsing-and-validation). */
function parseDefinition(
  filePath: string,
  source: AgentDefinition["source"],
  text: string,
): AgentDefinition {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    invalid(filePath, "frontmatter", "the first line must be ---.");
  }

  // Pi's extractor accepts delimiter prefixes; guard its first closing candidate exactly.
  const closingIndex = normalized.indexOf("\n---", 3);
  if (closingIndex < 0) {
    invalid(filePath, "frontmatter", "missing closing --- delimiter.");
  }
  if (normalized.slice(closingIndex + 1).split("\n", 1)[0] !== "---") {
    invalid(filePath, "frontmatter", "the closing delimiter must be exactly ---.");
  }

  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(normalized);
  } catch (error) {
    invalid(filePath, "frontmatter", errorMessage(error));
  }

  const { frontmatter: fields, body } = parsed;

  if (!Value.Check(FRONTMATTER, fields)) {
    const error = Value.Errors(FRONTMATTER, fields)[0];
    invalid(filePath, error.instancePath.slice(1) || "frontmatter", error.message);
  }

  const name = fields.name ?? basename(filePath).replace(/\.md$/i, "");
  if (!NAME_PATTERN.test(name)) {
    invalid(
      filePath,
      "name",
      `expected lowercase letters, digits, or hyphens; received ${JSON.stringify(name)}.`,
    );
  }

  return {
    name,
    description: optionalText(fields.description),
    model: optionalText(fields.model),
    thinking: fields.thinking,
    tools: parseNameList(filePath, "tools", fields.tools),
    skills: parseNameList(filePath, "skills", fields.skills),
    systemPrompt: fields["system-prompt"] ?? "append",
    sessionMode: fields["session-mode"] ?? "standalone",
    spawning: fields.spawning ?? false,
    autoExit: fields["auto-exit"] ?? true,
    disableModelInvocation: fields["disable-model-invocation"] ?? false,
    body,
    source,
    filePath,
  };
}

async function loadSource(
  directory: string,
  source: AgentDefinition["source"],
): Promise<AgentDefinition[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw new Error(`Cannot read agent directory ${directory}: ${errorMessage(error)}`);
  }

  const definitions: AgentDefinition[] = [];
  // Stable ordering makes duplicate and precedence behavior reproducible.
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = join(directory, entry.name);
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      throw new Error(`Cannot read agent definition ${filePath}: ${errorMessage(error)}`);
    }

    if (!hasFrontmatter(text)) {
      continue;
    }

    definitions.push(parseDefinition(filePath, source, text));
  }

  return definitions;
}

function hasFrontmatter(text: string): boolean {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r\n?|\n/, 1)[0];
  return firstLine === "---";
}

function parseNameList(
  filePath: string,
  field: "tools" | "skills",
  value: string[] | string | null | undefined,
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((name) => name.trim());
  }

  if (value.trim() === "") {
    return undefined;
  }

  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (names.length === 0) {
    invalid(filePath, field, "expected [] or a nonempty list of names.");
  }

  return names;
}

function optionalText(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function expandTilde(path: string): string {
  if (path === "~") {
    return homedir();
  }
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function invalid(filePath: string, field: string, reason: string): never {
  throw new Error(`${filePath}: invalid ${field}: ${reason}`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}