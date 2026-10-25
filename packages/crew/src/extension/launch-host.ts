import {
  DefaultResourceLoader,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import type { LaunchHost } from "../launch/launch.ts";

/** Bind a launch to the spawner's current pi context; call it at the call site, not at startup. */
export function createLaunchHost(pi: ExtensionAPI, ctx: ExtensionContext): LaunchHost {
  const agentDir = resolve(getAgentDir());
  return {
    agentDir,
    cwd: ctx.cwd,
    resolveModel(def) {
      const inherited = ctx.model;
      let model = inherited;
      if (def.model !== undefined) {
        const slash = def.model.indexOf("/");
        if (slash < 1) {
          throw new Error("Agent model must be an exact provider/model-id.");
        }

        model = ctx.modelRegistry.find(def.model.slice(0, slash), def.model.slice(slash + 1));
        if (!model || `${model.provider}/${model.id}` !== def.model) {
          throw new Error(`Unknown exact agent model: ${def.model}`);
        }
      }

      if (!model) {
        throw new Error("The spawning session has no selected model.");
      }

      if (
        !ctx.modelRegistry
          .getAvailable()
          .some((m) => m.provider === model!.provider && m.id === model!.id)
      ) {
        throw new Error(`No authentication available for ${model.provider}/${model.id}.`);
      }

      const supported = getSupportedThinkingLevels(model);
      if (def.thinking !== undefined && !supported.includes(def.thinking)) {
        throw new Error(
          `Thinking ${def.thinking} is unsupported by ${model.provider}/${model.id}.`,
        );
      }

      const thinking = def.thinking ?? clampThinkingLevel(model, pi.getThinkingLevel());
      return { provider: model.provider, id: model.id, thinking };
    },
    async resolveSkills(names) {
      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir,
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const skills = loader.getSkills().skills;
      return names.map((name) => {
        const skill = skills.find((s) => s.name === name);
        if (!skill) {
          throw new Error(`Unknown agent skill: ${name}`);
        }
        return skill.filePath;
      });
    },
    forkEntries() {
      const header = ctx.sessionManager.getHeader();
      if (!header) {
        throw new Error("The spawning session has no session header.");
      }
      return [header, ...ctx.sessionManager.getBranch()];
    },
  };
}