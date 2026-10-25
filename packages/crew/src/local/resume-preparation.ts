import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildLaunch, ENV_CREW_TITLE, type LaunchHost } from "../launch/launch.ts";
import type { Reply } from "../ipc/protocol.ts";
import type { CrewContext } from "../extension/context.ts";
import { assertOwnership } from "../store/ownership.ts";
import { processPresence, rowProcess } from "../store/process-identity.ts";

/** Resolve the current definition and readable saved identity; `host` is the immediate parent's Pi context. */
export async function prepareResumeReply(
  ctx: CrewContext,
  requestId: string,
  host: LaunchHost | undefined,
): Promise<Reply> {
  const { ledger, ownership: owner, epoch } = ctx;
  if (!ledger || !owner || !host || ctx.state.role.kind === "dormant") {
    return { ok: false, error: "Crew execution unavailable." };
  }
  assertOwnership(owner);
  const operation = ledger.db
    .prepare(
      "SELECT o.*,t.definition_name AS saved_definition FROM operations o JOIN agent_tree t ON t.workspace_id=o.workspace_id AND t.session_id=o.recipient_session_id AND t.parent_session_id=o.caller_session_id WHERE o.workspace_id=? AND o.request_id=? AND o.caller_session_id=? AND o.kind='message' AND o.state='pending'",
    )
    .get(owner.workspaceId, requestId, owner.sessionId);
  if (!operation) {
    return { ok: false, error: "The recorded operation state does not permit this transition." };
  }
  const recipient = String(operation.recipient_session_id);
  const cannotResume = `Cannot resume agent ${recipient}: its current definition or readable saved session is unavailable.`;
  const role = ledger.role(recipient);
  const saved = ledger.db
    .prepare("SELECT session_file FROM sessions WHERE workspace_id=? AND session_id=?")
    .get(owner.workspaceId, recipient);
  const instance = ledger.db
    .prepare(
      "SELECT * FROM instances WHERE workspace_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(owner.workspaceId, recipient);
  if (role?.kind !== "member" || !instance || processPresence(rowProcess(instance)) !== "exited") {
    return { ok: false, error: "The recorded operation state does not permit this transition." };
  }
  const definition = ctx.definitions.get(String(operation.saved_definition));
  try {
    if (!definition || typeof saved?.session_file !== "string") {
      throw new Error(cannotResume);
    }
    accessSync(saved.session_file, constants.R_OK);
    const header = JSON.parse(readFileSync(saved.session_file, "utf8").split("\n", 1)[0]);
    if (header.type !== "session" || header.id !== recipient) {
      throw new Error(cannotResume);
    }
  } catch {
    return { ok: false, error: cannotResume, code: "cannot_resume" };
  }
  const built = await buildLaunch({
    host,
    definition: definition!,
    origin: role.origin,
    caller: owner.sessionId,
    projectCwd: role.projectCwd,
    workspaceId: owner.workspaceId,
    resume: {
      sessionId: recipient,
      agent: role.agent,
      caller: owner.sessionId,
      origin: role.origin,
      sessionFile: String(saved!.session_file),
    },
  });
  if (ctx.ledger !== ledger || ctx.ownership !== owner || ctx.epoch !== epoch) {
    built.cleanup();
    return { ok: false, error: "Durable Crew endpoint unavailable." };
  }
  assertOwnership(owner);
  built.env[ENV_CREW_TITLE] = role.title;
  writeFileSync(join(built.directory, "launch.json"), JSON.stringify(built), { mode: 0o600 });
  return { ok: true, directory: built.directory };
}