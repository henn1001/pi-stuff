import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Frontmatter controls startup settings; the Markdown body supplies prompt instructions.
export type ProfileThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type PromptConfig = {
  preamble?: string;
  docs?: boolean;
  tools?: boolean;
  rules?: boolean;
};
export type ProfileDefinition = {
  name?: string;
  description?: string;
  model?: string;
  thinkingLevel?: ProfileThinkingLevel;
  tools?: string[];
  skills?: string[];
  prompt?: PromptConfig;
  body: string;
};
// The complete definition is persisted so resume never depends on the source file.
export type StoredProfile = {
  name: string;
  definition: ProfileDefinition;
};
type ProfilePaths = {
  project: Map<string, string>;
  global: Map<string, string>;
  errors: string[];
};

export const PROFILE_CUSTOM_TYPE = "profiles:profile";

const ALLOWED_THINKING_LEVELS = new Set<ProfileThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const ALLOWED_FIELDS = new Set([
  "name",
  "description",
  "model",
  "thinkingLevel",
  "tools",
  "skills",
  "prompt",
]);

const ALLOWED_PROMPT_FIELDS = new Set(["preamble", "docs", "tools", "rules"]);

export function loadProfile(
  name: string,
  ctx: ExtensionContext,
): { sourcePath: string; definition: ProfileDefinition } | undefined {
  const paths = loadProfilePaths(ctx.cwd);
  const projectDir = join(ctx.cwd, CONFIG_DIR_NAME, "agents");
  const projectScanFailed = paths.errors.some((error) => error.startsWith(`${projectDir}:`));

  // Do not fall back to a global profile when an unreadable project directory could shadow it.
  if (!paths.project.has(name) && projectScanFailed) {
    ctx.ui.notify(
      `Cannot resolve profile "${name}" because project profiles could not be scanned: ${paths.errors.join("; ")}. No profile customization was applied.`,
      "warning",
    );
    return;
  }

  const sourcePath = paths.project.get(name) ?? paths.global.get(name);
  if (!sourcePath) {
    const available = [...new Set([...paths.project.keys(), ...paths.global.keys()])].sort();
    const scanError =
      paths.errors.length > 0
        ? ` Could not scan profile directories: ${paths.errors.join("; ")}.`
        : "";
    ctx.ui.notify(
      `Unknown profile "${name}". Available: ${available.join(", ") || "(none)"}.${scanError} No profile customization was applied; Pi's startup configuration is unchanged.`,
      "warning",
    );
    return;
  }

  try {
    const definition = parseProfileFile(sourcePath);
    return { sourcePath, definition };
  } catch (error) {
    ctx.ui.notify(
      `Profile "${name}" (${sourcePath}) is invalid: ${String(error)}. Skipping the entire profile and continuing with Pi's startup configuration.`,
      "warning",
    );
  }
}

export function readBranchProfile(ctx: ExtensionContext): StoredProfile | undefined {
  // Only the active branch owns this profile; abandoned branches must not affect it.
  const profileEntries = ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === PROFILE_CUSTOM_TYPE);
  if (profileEntries.length === 0) {
    return undefined;
  }

  const profiles: StoredProfile[] = [];
  try {
    for (const entry of profileEntries) {
      profiles.push(validateSnapshot("data" in entry ? entry.data : undefined));
    }
  } catch (error) {
    ctx.ui.notify(
      `Stored profile snapshot is invalid (${String(error)}); applying no profile customization and retaining Pi's restored runtime state.`,
      "warning",
    );
    return undefined;
  }

  const keys = new Set(profiles.map((profile) => canonicalJson({ schemaVersion: 1, ...profile })));
  if (keys.size > 1) {
    ctx.ui.notify(
      "Conflicting profile snapshots exist on the active branch; applying no profile customization and retaining Pi's restored runtime state.",
      "warning",
    );
    return undefined;
  }

  return profiles[0];
}

function validateSnapshot(data: unknown): StoredProfile {
  if (!isRecord(data)) {
    throw new Error("entry data must be a mapping");
  }

  assertAllowedKeys(data, new Set(["schemaVersion", "name", "definition"]), "snapshot");

  if (data.schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion ${String(data.schemaVersion)}`);
  }

  if (typeof data.name !== "string" || data.name.trim().length === 0) {
    throw new Error("snapshot name must be a nonempty string");
  }

  const definition = parseSnapshotDefinition(data.definition);

  return { name: data.name, definition };
}

function parseProfileFile(path: string): ProfileDefinition {
  const parsed = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf-8"));

  return validateDefinition(parsed.frontmatter, parsed.body);
}

function parseSnapshotDefinition(value: unknown): ProfileDefinition {
  if (!isRecord(value)) {
    throw new Error("definition must be a mapping");
  }

  const { body, ...config } = value;

  return validateDefinition(config, body, false);
}

function validateDefinition(
  config: unknown,
  body: unknown,
  requireField = true,
): ProfileDefinition {
  if (!isRecord(config)) {
    throw new Error("frontmatter must be a mapping");
  }

  assertAllowedKeys(config, ALLOWED_FIELDS, "frontmatter");

  if (requireField && Object.keys(config).length === 0) {
    throw new Error("frontmatter must contain at least one configuration field");
  }

  if (typeof body !== "string") {
    throw new Error("Markdown body must be a string");
  }

  const definition: ProfileDefinition = { body };

  if (config.name !== undefined) {
    if (typeof config.name !== "string" || config.name.trim().length === 0) {
      throw new Error('"name" must be a nonempty string');
    }

    definition.name = config.name;
  }

  if (config.description !== undefined) {
    if (typeof config.description !== "string") {
      throw new Error('"description" must be a string');
    }

    definition.description = config.description;
  }

  if (config.model !== undefined) {
    if (typeof config.model !== "string" || !/^[^\s/]+\/[^\s/]\S*$/.test(config.model)) {
      throw new Error('"model" must be in provider/model-id format');
    }

    definition.model = config.model;
  }

  if (config.thinkingLevel !== undefined) {
    if (
      typeof config.thinkingLevel !== "string" ||
      !ALLOWED_THINKING_LEVELS.has(config.thinkingLevel as ProfileThinkingLevel)
    ) {
      throw new Error(`unsupported thinkingLevel: ${String(config.thinkingLevel)}`);
    }

    definition.thinkingLevel = config.thinkingLevel as ProfileThinkingLevel;
  }

  if (config.tools != null) {
    definition.tools = validateStringList(config.tools, "tools");
  }

  if (config.skills != null) {
    definition.skills = validateStringList(config.skills, "skills");
  }

  if (config.prompt !== undefined) {
    definition.prompt = validatePromptConfig(config.prompt);
  }

  return definition;
}

function validatePromptConfig(value: unknown): PromptConfig {
  if (!isRecord(value)) {
    throw new Error('"prompt" must be a mapping');
  }

  assertAllowedKeys(value, ALLOWED_PROMPT_FIELDS, "prompt");

  const prompt: PromptConfig = {};

  if (value.preamble !== undefined) {
    if (typeof value.preamble !== "string" || value.preamble.trim().length === 0) {
      throw new Error('"prompt.preamble" must be a non-whitespace string');
    }

    prompt.preamble = value.preamble;
  }

  for (const key of ["docs", "tools", "rules"] as const) {
    const setting = value[key];

    if (setting === undefined) {
      continue;
    }

    if (typeof setting !== "boolean") {
      throw new Error(`"prompt.${key}" must be a boolean`);
    }

    prompt[key] = setting;
  }

  return prompt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));

  if (unknown.length > 0) {
    throw new Error(
      `unknown ${where} field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

function validateStringList(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`"${field}" must be an array of nonempty strings`);
  }

  return [...value];
}

function loadProfilePaths(cwd: string): ProfilePaths {
  const projectDir = join(cwd, CONFIG_DIR_NAME, "agents");
  const globalDir = join(getAgentDir(), "agents");
  const errors: string[] = [];
  let project = new Map<string, string>();
  let global = new Map<string, string>();
  try {
    project = listMarkdownProfiles(projectDir);
  } catch (error) {
    errors.push(`${projectDir}: ${String(error)}`);
  }

  try {
    global = listMarkdownProfiles(globalDir);
  } catch (error) {
    errors.push(`${globalDir}: ${String(error)}`);
  }

  return { project, global, errors };
}

function listMarkdownProfiles(directory: string): Map<string, string> {
  if (!existsSync(directory)) {
    return new Map();
  }

  const files = new Map<string, string>();

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.set(entry.name.slice(0, -3), join(directory, entry.name));
    }
  }

  return files;
}

// Compare snapshot contents independently of object key order.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}