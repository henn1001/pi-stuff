import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { CrewContext } from "./context.ts";
import type { AgentDefinition } from "./types.ts";

/** Independent startup never opts into automatic completion, even with an auto-exit definition. */
export function defaultMemberDefinition(): AgentDefinition {
  return {
    name: "crew-member",
    spawning: false,
    autoExit: false,
    disableModelInvocation: false,
    systemPrompt: "append",
    sessionMode: "standalone",
    body: "",
    source: "bundled",
    filePath: "",
  };
}

/** Apply an independently activated member's selected model, thinking, and delegation configuration. */
export async function configureIndependentDefinition(ctx: CrewContext): Promise<void> {
  const role = ctx.state.role;
  const context = ctx.sessionContext;
  if (role.kind !== "member" || !context) {
    throw new Error("Independent definition requires a member session.");
  }
  const epoch = ctx.epoch;
  const definition = role.defaultDefinition
    ? defaultMemberDefinition()
    : ctx.definitions.get(role.agent);
  if (!definition) {
    throw new Error(`Unknown Crew definition: ${role.agent}`);
  }
  if (ctx.epoch !== epoch || ctx.state.role !== role) {
    throw new Error("Crew definition endpoint changed.");
  }
  if (definition.model) {
    const slash = definition.model.indexOf("/");
    const model = context.modelRegistry.find(
      definition.model.slice(0, slash),
      definition.model.slice(slash + 1),
    );
    if (
      !model ||
      `${model.provider}/${model.id}` !== definition.model ||
      !(await ctx.pi.setModel(model))
    ) {
      throw new Error(`Crew model unavailable: ${definition.model}`);
    }
  }
  if (ctx.epoch !== epoch || ctx.state.role !== role) {
    throw new Error("Crew definition endpoint changed.");
  }
  if (definition.thinking) {
    const model = definition.model
      ? context.modelRegistry.find(
          definition.model.split("/")[0],
          definition.model.slice(definition.model.indexOf("/") + 1),
        )
      : context.model;
    if (!model || !getSupportedThinkingLevels(model).includes(definition.thinking)) {
      throw new Error("Crew definition thinking level is unsupported.");
    }
    ctx.pi.setThinkingLevel(definition.thinking);
  }
  ctx.memberDefinition = definition;
  ctx.state.memberSpawning = definition.spawning;
}