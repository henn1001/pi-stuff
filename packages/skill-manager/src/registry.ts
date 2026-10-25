import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DefaultPackageManager,
  getAgentDir,
  parseFrontmatter,
  SettingsManager,
  stripFrontmatter,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { extractFrontmatterText } from "./document.js";
export type SkillScope = "user" | "project" | "temporary";
export type SkillOrigin = "package" | "top-level";

export interface SkillEntry {
  name: string;
  description: string;
  path: string;
  baseDir?: string;
  scope: SkillScope;
  origin: SkillOrigin;
  source: string;
  content: string;
  frontmatterText: string;
  disableModelInvocation: boolean;
}

export interface SkillRegistry {
  skills: SkillEntry[];
  byPath: Map<string, SkillEntry>;
  byName: Map<string, SkillEntry[]>;
}

function compareSkills(a: SkillEntry, b: SkillEntry): number {
  const rank = (scope: SkillScope) => (scope === "project" ? 0 : scope === "user" ? 1 : 2);
  return (
    rank(a.scope) - rank(b.scope) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  );
}

function parseEntry(
  path: string,
  metadata: { scope: string; origin: string; source: string; baseDir?: string },
): SkillEntry | null {
  try {
    const raw = readFileSync(path, "utf8");
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(raw);
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
    if (!name || !description) {
      return null;
    }
    return {
      name,
      description,
      path: resolve(path),
      baseDir: metadata.baseDir,
      scope: metadata.scope as SkillScope,
      origin: metadata.origin as SkillOrigin,
      source: metadata.source,
      content: stripFrontmatter(raw).trim(),
      frontmatterText: extractFrontmatterText(raw).trimEnd(),
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    };
  } catch {
    return null;
  }
}

export async function loadSkillRegistry(
  cwd: string,
  projectTrusted: boolean,
  runtimeSkills?: Skill[],
): Promise<SkillRegistry> {
  let candidates: Array<{
    path: string;
    metadata: {
      scope: string;
      origin: string;
      source: string;
      baseDir?: string;
    };
  }>;
  if (runtimeSkills !== undefined) {
    // The command context's pre-loaded skills are the exact enabled set, including
    // temporary --skill inputs. Reading their files below keeps toggle state fresh.
    candidates = runtimeSkills.map((skill) => ({
      path: skill.filePath,
      metadata: skill.sourceInfo,
    }));
  } else {
    // Public-API fallback for callers without a command context.
    const settingsManager = SettingsManager.create(cwd, getAgentDir(), {
      projectTrusted,
    });
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
    });
    const resolved = await packageManager.resolve();
    candidates = resolved.skills
      .filter((resource) => resource.enabled)
      .map((resource) => ({
        path: resource.path,
        metadata: resource.metadata,
      }));
  }

  const entries = candidates.map(({ path, metadata }) => parseEntry(path, metadata));
  const byPath = new Map<string, SkillEntry>();
  for (const entry of entries) {
    if (entry) {
      byPath.set(entry.path, entry);
    }
  }
  const skills = [...byPath.values()].sort(compareSkills);
  const byName = new Map<string, SkillEntry[]>();
  for (const skill of skills) {
    byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill]);
  }
  return { skills, byPath, byName };
}

export class SkillIdentifierError extends Error {}

export function resolveSkillIdentifier(
  registry: SkillRegistry,
  identifier: string,
  cwd: string,
): SkillEntry {
  const value = identifier.trim();
  if (!value) {
    throw new SkillIdentifierError("A skill name or path is required.");
  }
  const exactPath = registry.byPath.get(resolve(cwd, value)) ?? registry.byPath.get(resolve(value));
  if (exactPath) {
    return exactPath;
  }
  const named = registry.byName.get(value) ?? [];
  if (named.length === 1) {
    return named[0]!;
  }
  if (named.length > 1) {
    throw new SkillIdentifierError(
      `Skill name '${value}' is ambiguous. Use one of these paths:\n${named.map((skill) => `- ${skill.path}`).join("\n")}`,
    );
  }
  throw new SkillIdentifierError(
    `No enabled skill matches '${value}'. Run /skill list to see available skills.`,
  );
}