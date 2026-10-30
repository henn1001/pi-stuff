import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  type ExtensionAPI,
  type ExtensionContext,
  type NormalizedBuildSystemPromptOptions,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
  canonicalJson,
  loadProfile,
  PROFILE_CUSTOM_TYPE,
  type ProfileDefinition,
  type ProfileThinkingLevel,
  type StoredProfile,
} from "./profiles";

// A selection is temporary until startup applies its runtime settings and records a snapshot.
export type PendingSelection = {
  pi: ExtensionAPI;
  name: string;
  sourcePath: string;
  definition: ProfileDefinition;
  stagingAttempted: boolean;
  stagingComplete: boolean;
  stagedTools?: string[];
  rollbackTools?: string[];
};

// Copied from Pi 1.2.0's system-prompt.ts buildSystemPromptSections() default preamble.
// Keep in parity with the supported Pi version; there is no public default-preamble helper.
// `bun test src/runtime.prompt-parity.test.ts` compares the composed sections to Pi's builder.
const DEFAULT_PREAMBLE =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

export function selectProfile(
  pi: ExtensionAPI,
  reason: SessionStartEvent["reason"],
  ctx: ExtensionContext,
): PendingSelection | undefined {
  const profileFlag = pi.getFlag("profile");

  if (reason === "reload") {
    if (typeof profileFlag === "string" && profileFlag) {
      ctx.ui.notify(
        `Profile flag "${profileFlag}" is ignored on reload because the active branch has no valid profile snapshot; no profile customization was applied. Use /new or restart to select a profile.`,
        "warning",
      );
    }
    return;
  }

  if (typeof profileFlag !== "string" || !profileFlag) {
    return;
  }

  if (reason !== "startup" && reason !== "new") {
    return;
  }

  if (!branchCanSelectProfile(ctx)) {
    ctx.ui.notify(
      `Cannot attach profile "${profileFlag}" to this existing unprofiled session; no profile customization was applied. Use /new or start a new session with --profile.`,
      "warning",
    );
    return;
  }

  const profile = loadProfile(profileFlag, ctx);
  if (!profile) {
    return;
  }

  return {
    pi,
    name: profileFlag,
    ...profile,
    stagingAttempted: false,
    stagingComplete: false,
  };
}

// Stage tools during discovery, before Pi builds the first run's prompt.
export function stageSelection(selection: PendingSelection, ctx: ExtensionContext): boolean {
  selection.stagingAttempted = true;

  if (selection.definition.tools === undefined) {
    selection.stagingComplete = true;
    return true;
  }

  const allTools = selection.pi.getAllTools();
  const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
  const unavailable = [...new Set(selection.definition.tools)].filter((name) => {
    const tool = toolsByName.get(name);
    return !tool || tool.exposure === "hidden";
  });
  if (unavailable.length > 0) {
    ctx.ui.notify(
      `${sourceLabel(selection)}: unavailable or hidden tools: ${unavailable.join(", ")}; no tools were staged, the profile was skipped, and Pi's startup tool loadout remains unchanged.`,
      "warning",
    );
    return false;
  }

  selection.rollbackTools = selection.pi.getActiveTools();
  selection.pi.setActiveTools(selection.definition.tools);
  const actualTools = selection.pi.getActiveTools();
  selection.stagedTools = [...new Set(selection.definition.tools)];

  if (!sameNames(actualTools, selection.stagedTools)) {
    const restored = restoreStagedTools(selection) ?? actualTools;
    ctx.ui.notify(
      `${sourceLabel(selection)}: Pi did not accept the complete requested tool loadout (${selection.stagedTools.join(", ") || "none"}); the selection was consumed. ${describeToolFallback(selection, restored)}.`,
      "warning",
    );
    return false;
  }

  selection.stagingComplete = true;
  return true;
}

export async function activateSelection(
  selection: PendingSelection,
  ctx: ExtensionContext,
): Promise<StoredProfile | undefined> {
  if (!selection.stagingComplete) {
    return rejectSelection(selection, ctx, "startup tool staging did not complete");
  }

  let targetModel: Model<Api> | undefined;
  if (selection.definition.model) {
    const separator = selection.definition.model.indexOf("/");
    const provider = selection.definition.model.slice(0, separator);
    const model = selection.definition.model.slice(separator + 1);
    targetModel = ctx.modelRegistry.find(provider, model);
    if (!targetModel) {
      return rejectSelection(selection, ctx, `model ${selection.definition.model} was not found`);
    }
  } else {
    targetModel = ctx.model;
  }

  if (selection.definition.thinkingLevel !== undefined) {
    if (!targetModel) {
      return rejectSelection(
        selection,
        ctx,
        "an explicit thinking level cannot be validated because there is no target model",
      );
    }
    const supported = getSupportedThinkingLevels(targetModel) as ProfileThinkingLevel[];
    if (!supported.includes(selection.definition.thinkingLevel)) {
      return rejectSelection(
        selection,
        ctx,
        `thinking level "${selection.definition.thinkingLevel}" is unsupported by ${targetModel.provider}/${targetModel.id}`,
      );
    }
  }

  // Prompt options and extension-discovered skills are only authoritative at the run boundary.
  // Their per-run policy must not delay startup runtime configuration or snapshot persistence.
  if (selection.definition.model && targetModel) {
    let applied: boolean;
    try {
      applied = await selection.pi.setModel(targetModel);
    } catch (error) {
      return rejectSelection(selection, ctx, `model change threw: ${String(error)}`);
    }
    if (!applied) {
      return rejectSelection(
        selection,
        ctx,
        `model ${targetModel.provider}/${targetModel.id} could not be activated (authentication is unavailable)`,
      );
    }
  }

  if (selection.definition.thinkingLevel !== undefined) {
    selection.pi.setThinkingLevel(selection.definition.thinkingLevel);
  }

  const snapshot = {
    schemaVersion: 1,
    name: selection.name,
    definition: selection.definition,
  };
  selection.pi.appendEntry(PROFILE_CUSTOM_TYPE, snapshot);

  return { name: selection.name, definition: selection.definition };
}

// All runs only customize the prompt; runtime defaults were applied at startup or restored by Pi.
export function applyProfile(
  profile: StoredProfile,
  options: NormalizedBuildSystemPromptOptions,
  ctx: ExtensionContext,
  warned: Set<string>,
): void {
  const conflict = findPromptConflict(options, profile.definition);
  if (conflict) {
    ctx.ui.notify(
      `Profile snapshot "${profile.name}": ${conflict}; applying no profile customization for this run and retaining Pi's restored runtime state.`,
      "warning",
    );
    return;
  }

  warnMissingSkillsOnce(profile, options, ctx, warned);
  Object.assign(options, preparePromptOptions(options, profile.definition));
}

export function abandonPendingSelection(
  selection: PendingSelection | undefined,
  ctx: ExtensionContext,
): void {
  if (!selection) {
    return;
  }

  const actualTools = restoreStagedTools(selection);

  if (actualTools !== undefined && !sameNames(actualTools, selection.rollbackTools ?? [])) {
    ctx.ui.notify(
      `${sourceLabel(selection)}: pending selection was abandoned; best-effort rollback left active tools as (${actualTools.length ? actualTools.join(", ") : "none"}).`,
      "warning",
    );
  }
}

function rejectSelection(
  selection: PendingSelection,
  ctx: ExtensionContext,
  reason: string,
): undefined {
  const actualTools = restoreStagedTools(selection);

  ctx.ui.notify(
    `${sourceLabel(selection)}: ${reason}; ${describeToolFallback(selection, actualTools)}. Continuing without profile customization.`,
    "warning",
  );
}

function restoreStagedTools(selection: PendingSelection): string[] | undefined {
  if (selection.rollbackTools === undefined) {
    return undefined;
  }

  selection.pi.setActiveTools(selection.rollbackTools);
  return selection.pi.getActiveTools();
}

function describeToolFallback(selection: PendingSelection, actual: string[] | undefined): string {
  if (actual === undefined) {
    return "Pi's startup tool loadout is unchanged";
  }

  if (sameNames(actual, selection.rollbackTools ?? [])) {
    return `startup tools restored (${actual.length ? actual.join(", ") : "none"})`;
  }
  return `best-effort rollback left Pi's actual active tools as (${actual.length ? actual.join(", ") : "none"})`;
}

function sourceLabel(selection: PendingSelection): string {
  return `Profile "${selection.name}" (${selection.sourcePath})`;
}

function sameNames(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((name) => rightSet.has(name));
}

function branchCanSelectProfile(ctx: ExtensionContext): boolean {
  return ctx.sessionManager
    .getBranch()
    .every((entry) => entry.type === "model_change" || entry.type === "thinking_level_change");
}

function findPromptConflict(
  options: NormalizedBuildSystemPromptOptions,
  definition: ProfileDefinition,
): string | undefined {
  if (options.forceSystemPrompt !== undefined) {
    return "forceSystemPrompt conflicts with every profile";
  }

  if (ownsBasePrompt(definition) && options.customPrompt !== undefined) {
    return "customPrompt conflicts with a profile that owns base-prompt composition";
  }
  return undefined;
}

function ownsBasePrompt(definition: ProfileDefinition): boolean {
  // Explicit true values keep Pi's normal composition; overrides require rebuilding the base.
  const prompt = definition.prompt;
  return Boolean(
    prompt &&
    (prompt.preamble !== undefined ||
      prompt.docs === false ||
      prompt.tools === false ||
      prompt.rules === false),
  );
}

function preparePromptOptions(
  options: NormalizedBuildSystemPromptOptions,
  definition: ProfileDefinition,
): NormalizedBuildSystemPromptOptions {
  // Work on a copy so validation failures cannot partially alter this run's prompt.
  const prepared: NormalizedBuildSystemPromptOptions = {
    ...options,
    selectedTools: [...options.selectedTools],
    hiddenTools: [...options.hiddenTools],
    toolSnippets: { ...options.toolSnippets },
    toolGuidelines: Object.fromEntries(
      Object.entries(options.toolGuidelines).map(([name, rules]) => [name, [...rules]]),
    ),
    promptGuidelines: [...options.promptGuidelines],
    sections: { ...options.sections },
    contextFiles: options.contextFiles.map((file) => ({ ...file })),
    skills: options.skills.map((skill) => ({ ...skill })),
  };

  if (ownsBasePrompt(definition)) {
    // Generated tool guidance assumes the loadout and hidden declarations stay stable during the run.
    const prompt = definition.prompt ?? {};

    prepared.customPrompt = prompt.preamble ?? DEFAULT_PREAMBLE;

    if (prompt.tools === false) {
      delete prepared.sections.tools;
    } else {
      prepared.sections.tools = buildToolsSection(prepared);
    }

    if (prompt.rules === false) {
      delete prepared.sections.rules;
    } else {
      prepared.sections.rules = buildRulesSection(prepared);
    }

    if (prompt.docs === false) {
      delete prepared.sections.docs;
    } else if (!prepared.sections.docs) {
      prepared.sections.docs = buildDocsSection();
    }
  }

  if (definition.body) {
    prepared.appendSystemPrompt = definition.body;
  }
  if (definition.skills !== undefined) {
    const selectedSkills = new Set(definition.skills);

    prepared.skills = prepared.skills.filter((skill) => selectedSkills.has(skill.name));
  }

  return prepared;
}

function warnMissingSkillsOnce(
  profile: StoredProfile,
  options: NormalizedBuildSystemPromptOptions,
  ctx: ExtensionContext,
  warned: Set<string>,
): void {
  if (profile.definition.skills === undefined) {
    return;
  }

  const missing = profile.definition.skills.filter(
    (name) => !options.skills.some((skill) => skill.name === name),
  );
  if (missing.length === 0) {
    return;
  }

  const key = canonicalJson(profile);
  if (warned.has(key)) {
    return;
  }

  warned.add(key);
  ctx.ui.notify(
    `Profile snapshot "${profile.name}" references missing skills: ${missing.join(", ")}; they are omitted from advertising and the snapshot is unchanged.`,
    "warning",
  );
}

function buildToolsSection(options: NormalizedBuildSystemPromptOptions): string {
  const hidden = new Set(options.hiddenTools);
  const visibleTools = options.selectedTools.filter((name) => !hidden.has(name));

  const withSnippets = visibleTools.filter((name) => Boolean(options.toolSnippets[name]));
  const summary =
    withSnippets.length > 0
      ? withSnippets.map((name) => `- ${name}: ${options.toolSnippets[name]}`).join("\n")
      : "(none)";

  return `${summary}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
}

function buildRulesSection(options: NormalizedBuildSystemPromptOptions): string {
  const hidden = new Set(options.hiddenTools);
  const visibleTools = options.selectedTools.filter((name) => !hidden.has(name));

  const rules: string[] = [];
  const seen = new Set<string>();
  const addRule = (rule: string): void => {
    const normalized = rule.trim();

    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    rules.push(normalized);
  };
  const hasBash = visibleTools.includes("bash");
  const hasPowerShell = visibleTools.includes("powershell");
  const hasGrep = visibleTools.includes("grep");
  const hasFind = visibleTools.includes("find");
  const hasLs = visibleTools.includes("ls");

  if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
    if (hasBash && hasPowerShell) {
      addRule(
        "Use bash or PowerShell for file operations like listing, searching, and finding files",
      );
    } else if (hasPowerShell) {
      addRule("Use PowerShell for file operations like listing, searching, and finding files");
    } else {
      addRule("Use bash for file operations like ls, rg, find");
    }
  }

  for (const name of visibleTools) {
    for (const rule of options.toolGuidelines[name] ?? []) {
      addRule(rule);
    }
  }

  for (const rule of options.promptGuidelines) {
    addRule(rule);
  }

  addRule("Be concise in your responses");
  addRule("Show file paths clearly when working with files");

  return rules.map((rule) => `- ${rule}`).join("\n");
}

function buildDocsSection(): string {
  return `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
}