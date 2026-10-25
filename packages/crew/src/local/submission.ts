import type { LaunchHost } from "../launch/launch.ts";
import { assertSpawnPolicy } from "./policy.ts";
import type { CrewContext } from "../extension/context.ts";
import { assertActive } from "./policy.ts";
import { isAgentId, isTaskName } from "../domain/ids.ts";
import { assertOwnership } from "../store/ownership.ts";
import type { Origin } from "../domain/member.ts";

/** Shared tool/menu creation path. Menu launches are idle and assign no work. */
export async function spawnAgent(
  ctx: CrewContext,
  host: LaunchHost,
  params: { agent?: string; prompt?: string; task_name?: string },
  origin: Origin = "tool",
  signal?: AbortSignal,
) {
  assertActive(ctx);
  assertSpawnPolicy(ctx);
  if (origin === "menu" && ctx.state.role.kind !== "lead") {
    throw new Error("Spawning is disabled by definition, attachment or tree depth.");
  }
  const role = ctx.state.role;
  if (role.kind === "dormant" || !ctx.execution) {
    throw new Error("Crew execution unavailable.");
  }
  if (!params.agent || (origin === "tool" && !params.prompt?.trim())) {
    throw new Error("agent and prompt are required.");
  }
  const definition = ctx.definitions.get(params.agent);
  if (!definition) {
    throw new Error(`Unknown agent: ${params.agent}`);
  }
  assertSpawnPolicy(ctx, definition);
  return ctx.execution.launch(
    {
      host,
      definition,
      origin,
      caller: role.sessionId,
      projectCwd: role.projectCwd,
      workspaceId: role.workspaceId,
      prompt: origin === "menu" ? undefined : params.prompt,
      taskName: origin === "menu" ? undefined : params.task_name,
    },
    signal,
  );
}

/** Resolve full Pi identities without prefix/fallback lookup, or aliases in this parent's namespace. */
export function resolveMessageTarget(ctx: CrewContext, target: string): string {
  const { ledger, ownership: owner } = ctx;
  if (!ledger || !owner) {
    throw new Error("Crew execution unavailable.");
  }
  assertOwnership(owner);
  const idShaped = isAgentId(target);
  const exact = ledger.db
    .prepare(
      "SELECT session_id,parent_session_id FROM agent_tree WHERE workspace_id=? AND session_id=?",
    )
    .get(owner.workspaceId, target);
  const row =
    exact ??
    (!idShaped && isTaskName(target)
      ? ledger.db
          .prepare(
            "SELECT session_id,parent_session_id FROM agent_tree WHERE workspace_id=? AND parent_session_id=? AND task_name=?",
          )
          .get(owner.workspaceId, owner.sessionId, target)
      : undefined);
  if (!row) {
    throw Object.assign(new Error(`No recorded agent matches target "${target}".`), {
      code: "unknown_target",
    });
  }
  const self = ledger.db
    .prepare("SELECT parent_session_id FROM agent_tree WHERE workspace_id=? AND session_id=?")
    .get(owner.workspaceId, owner.sessionId);
  if (row.parent_session_id !== owner.sessionId && self?.parent_session_id !== row.session_id) {
    throw Object.assign(
      new Error("Messages may target only your recorded parent or direct children."),
      { code: "permission_denied" },
    );
  }
  return String(row.session_id);
}