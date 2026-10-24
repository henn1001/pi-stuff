import type { ExtensionCommandContext, Skill } from "@earendil-works/pi-coding-agent";
import { showSkillDialog } from "./dialog.js";
import { setSkillModelInvocation } from "./document.js";
import {
  loadSkillRegistry,
  resolveSkillIdentifier,
  SkillIdentifierError,
  type SkillEntry,
  type SkillRegistry,
} from "./registry.js";

export type SkillCommand = {
  action: "browse" | "list" | "status" | "enable" | "disable";
  identifier?: string;
};

export function parseSkillCommand(raw: string): SkillCommand {
  const trimmed = raw.trim();
  if (!trimmed) {return { action: "browse" };}
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/)!;
  const action = match[1]!.toLowerCase();
  const identifier = match[2]?.trim();
  if (action === "list") {
    if (identifier) {throw new Error("Usage: /skill list");}
    return { action };
  }
  if (action === "status" || action === "enable" || action === "disable") {
    if (!identifier) {throw new Error(`Usage: /skill ${action} <name-or-path>`);}
    return { action, identifier };
  }
  throw new Error(
    "Usage: /skill [list | status <name-or-path> | enable <name-or-path> | disable <name-or-path>]",
  );
}

function message(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length > 2000 ? `${value.slice(0, 1999)}…` : value;
}

function runtimeSkills(ctx: ExtensionCommandContext): Skill[] | undefined {
  try {
    return ctx.getSystemPromptOptions().skills;
  } catch {
    return undefined;
  }
}

async function registryFor(ctx: ExtensionCommandContext): Promise<SkillRegistry> {
  return loadSkillRegistry(ctx.cwd, ctx.isProjectTrusted(), runtimeSkills(ctx));
}

function state(skill: SkillEntry): string {
  return skill.disableModelInvocation
    ? "manual-only (disable-model-invocation: true)"
    : "model-visible (disable-model-invocation: false/default)";
}

function listText(registry: SkillRegistry): string {
  if (!registry.skills.length) {return "No enabled skills were found.";}
  return registry.skills
    .map((skill) => `${skill.name}\t${state(skill)}\t${skill.scope}\t${skill.path}`)
    .join("\n");
}

export async function handleSkillCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let parsed: ReturnType<typeof parseSkillCommand>;
  try {
    parsed = parseSkillCommand(args);
  } catch (error) {
    ctx.ui.notify(message(error), "warning");
    return;
  }

  if (parsed.action === "browse" && ctx.mode !== "tui") {
    ctx.ui.notify(
      "Bare /skill requires TUI mode. In RPC mode use /skill list, status, enable, or disable.",
      "warning",
    );
    return;
  }

  let registry: SkillRegistry;
  try {
    registry = await registryFor(ctx);
  } catch (error) {
    ctx.ui.notify(`Failed to load skills: ${message(error)}`, "error");
    return;
  }

  if (parsed.action === "list") {
    ctx.ui.notify(listText(registry), "info");
    return;
  }
  if (parsed.action === "browse") {
    const selected = await showSkillDialog(ctx, registry, {
      onToggle: async (skill, enabled) => {
        await setSkillModelInvocation(skill.path, enabled);
      },
      onRefresh: async () => await registryFor(ctx),
    });
    if (selected) {ctx.ui.pasteToEditor(`/skill:${selected.name}\n`);}
    return;
  }

  try {
    const skill = resolveSkillIdentifier(registry, parsed.identifier!, ctx.cwd);
    if (parsed.action === "status") {
      ctx.ui.notify(`${skill.name}: ${state(skill)}\n${skill.path}`, "info");
      return;
    }
    const enabled = parsed.action === "enable";
    const result = await setSkillModelInvocation(skill.path, enabled);
    ctx.ui.notify(
      `${result.changed ? "Updated" : "Already set"}: ${skill.name} is ${enabled ? "model-visible" : "manual-only"}. Run /reload to apply it to the current session.\n${skill.path}`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(message(error), error instanceof SkillIdentifierError ? "warning" : "error");
  }
}