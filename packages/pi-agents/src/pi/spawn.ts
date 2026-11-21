/**
 * Resolve a spawn request from the parent into a `SpawnSpec`: profile,
 * model, thinking level, tools, skills, and working directory. Settings
 * resolve from the profile, then the parent session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeSpawnRequest } from "../agents/spawn-input.js";
import {
  AgentError,
  type HelperDefaults,
  type HelperRequest,
  isThinkingLevel,
  type ModelRef,
  type SpawnSpec,
  type ThinkingLevel,
} from "../agents/types.js";
import { resolveModelPattern } from "../catalog/models.js";
import {
  discoverProfiles,
  findProfile,
  type Profile,
} from "../catalog/profiles.js";
import {
  type Chooser,
  inlineSkills,
  type SkillSource,
} from "../catalog/skills.js";
import { AGENT_TOOL_NAMES } from "../host/tools.js";

export interface SpawnRequest {
  job: string;
  name?: string | null;
  profile?: string | null;
  cwd?: string | null;
}

/** What a spawn draws on besides its request. */
export interface SpawnSources {
  /** The skills of a directory; the session's shared catalog. */
  skills: SkillSource;
  /** Thinking level without one in the profile. */
  thinking?: string;
  /** Tools without any in the profile. */
  tools?: string[];
  /** Working directory and model instead of the parent session's, for
   * helpers that inherit their agent's. */
  cwd?: string;
  model?: ModelRef;
}

/** Whether the session trusts its project, which gates project profiles,
 * skills, and context files. */
/**
 * The parent's active tools that agents can run, in Pi's order, so agents
 * inherit the parent's tools; undefined when it has none of them, and
 * agents get Pi's default tools.
 */
export function inheritedTools(
  active: readonly string[],
): string[] | undefined {
  const tools = AGENT_TOOL_NAMES.filter((name) => active.includes(name));
  return tools.length > 0 ? tools : undefined;
}

export function isTrusted(ctx: ExtensionContext): boolean {
  return typeof ctx.isProjectTrusted === "function"
    ? ctx.isProjectTrusted()
    : true;
}

function resolveModel(
  pattern: string | undefined,
  ctx: ExtensionContext,
  fallback?: ModelRef,
): ModelRef | undefined {
  if (pattern === undefined) {
    if (fallback) return fallback;
    const model = ctx.model;
    return model ? { provider: model.provider, modelId: model.id } : undefined;
  }
  const resolved = resolveModelPattern(
    pattern,
    ctx.modelRegistry.getAvailable(),
  );
  if (!resolved.ok) throw new AgentError(resolved.message);
  return { provider: resolved.provider, modelId: resolved.modelId };
}

function resolveCwd(base: string, requested: string | undefined): string {
  const cwd = path.resolve(base, requested ?? ".");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new AgentError(`Working directory not found: ${cwd}`);
  }
  if (!stat.isDirectory()) throw new AgentError(`Not a directory: ${cwd}`);
  return cwd;
}

function resolveProfile(
  name: string | undefined,
  cwd: string,
  trusted: boolean,
): Profile | undefined {
  if (name === undefined) return undefined;
  const { profiles } = discoverProfiles(cwd, trusted);
  const profile = findProfile(profiles, name);
  if (!profile) {
    const available = profiles.map((entry) => entry.name).join(", ") || "none";
    throw new AgentError(
      `Unknown profile "${name}". Available profiles: ${available}`,
    );
  }
  return profile;
}

/** Inline the named skills, or say which are missing. */
async function skillsPrompt(
  names: readonly string[],
  chooser: Chooser,
  cwd: string,
  trusted: boolean,
  source: SkillSource,
): Promise<{ prompt: string; missing: string[] }> {
  if (names.length === 0) return { prompt: "", missing: [] };
  return inlineSkills(names, await source(cwd, trusted), chooser);
}

/** The profile body plus its inlined skills, replacing the ambient catalog. */
async function instructionsOf(
  profile: Profile | undefined,
  cwd: string,
  trusted: boolean,
  source: SkillSource,
): Promise<{ instructions?: string; ambientSkills: boolean }> {
  const parts = [profile?.instructions ?? ""];
  const names = profile?.skills;
  if (names !== undefined) {
    const { prompt, missing } = await skillsPrompt(
      names,
      "user",
      cwd,
      trusted,
      source,
    );
    if (missing.length > 0)
      throw new AgentError(
        `Profile ${profile?.name} requests unavailable skills: ${missing.join(", ")}`,
      );
    parts.push(prompt);
  }
  const instructions = parts.filter((part) => part.trim()).join("\n\n");
  return {
    ...(instructions ? { instructions } : {}),
    ambientSkills: names === undefined,
  };
}

/**
 * Why a profile cannot spawn agents, if it cannot: an unknown model or a
 * skill that does not resolve.
 */
export async function profileProblem(
  profile: Profile,
  cwd: string,
  trusted: boolean,
  models: readonly Model<Api>[],
  source: SkillSource,
): Promise<string | undefined> {
  if (profile.model && !resolveModelPattern(profile.model, models).ok)
    return `no available model matches ${profile.model}`;
  try {
    const { missing } = await skillsPrompt(
      profile.skills ?? [],
      "user",
      cwd,
      trusted,
      source,
    );
    if (missing.length > 0) return `unavailable skills: ${missing.join(", ")}`;
  } catch (error) {
    return `skills don't load: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

/** Resolve a spawn. */
export async function resolveSpawn(
  request: SpawnRequest,
  ctx: ExtensionContext,
  sources: SpawnSources,
): Promise<SpawnSpec> {
  request = normalizeSpawnRequest(request);
  const trusted = isTrusted(ctx);
  const cwd = resolveCwd(sources.cwd ?? ctx.cwd, request.cwd ?? undefined);
  const profile = resolveProfile(request.profile ?? undefined, cwd, trusted);
  const model = resolveModel(profile?.model, ctx, sources.model);
  const thinking = profile?.thinking ?? sources.thinking;
  if (thinking !== undefined && !isThinkingLevel(thinking))
    throw new AgentError(`Invalid thinking level: ${thinking}`);
  const tools = profile?.tools ?? sources.tools;
  const { instructions, ambientSkills } = await instructionsOf(
    profile,
    cwd,
    trusted,
    sources.skills,
  );
  const spawn = profile?.spawn;
  return {
    job: request.job,
    cwd,
    ambientSkills,
    ...(spawn ? { spawn: true } : {}),
    ...(request.name ? { name: request.name } : {}),
    ...(profile ? { profile: profile.name } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking: thinking as ThinkingLevel } : {}),
    ...(tools ? { tools } : {}),
    ...(instructions ? { instructions } : {}),
    ...(profile?.maxTurns !== undefined ? { maxTurns: profile.maxTurns } : {}),
  };
}

/**
 * The settings of an agent that an agent spawns: resolved like the
 * parent's spawns, with the spawning agent's working directory, model, and
 * thinking level as defaults. Only its profile grants permission to spawn;
 * the spawning tool checks the depth.
 */
export async function resolveHelper(
  request: HelperRequest,
  ctx: ExtensionContext,
  defaults: HelperDefaults,
  skills: SkillSource,
): Promise<SpawnSpec> {
  return resolveSpawn(
    {
      job: request.job,
      ...(request.profile ? { profile: request.profile } : {}),
    },
    ctx,
    {
      skills,
      cwd: defaults.cwd,
      ...(defaults.thinking ? { thinking: defaults.thinking } : {}),
      ...(defaults.model ? { model: defaults.model } : {}),
    },
  );
}
