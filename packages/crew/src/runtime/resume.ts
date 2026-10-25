import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildLaunch,
  ENV_CREW_TITLE,
  STARTUP_TIMEOUT_MS,
  type BuiltLaunch,
} from "../agents/launch.ts";
import { allocate } from "../transport/layout.ts";
import { herdr, runPane } from "../transport/herdr.ts";
import { NotConnectedError, UnresponsiveError, request } from "../transport/socket.ts";
import type { Reply } from "../transport/protocol.ts";
import type { CrewContext } from "./context.ts";
import type { CoordinatorOperation } from "./coordinator.ts";
import type { OperationFailure } from "./types.ts";
import { assertOwnership } from "./ownership.ts";
import { processPresence, rowProcess } from "./process-identity.ts";

/** Private launch configuration prepared by the immediate parent; no process has been started. */
export interface PreparedResume {
  built: Omit<BuiltLaunch, "cleanup">;
  previousInstanceId: string;
}

/** Resolve the current definition and readable saved identity in the immediate parent's Pi context. */
export async function prepareResumeReply(ctx: CrewContext, requestId: string): Promise<Reply> {
  const { ledger, ownership: owner, sessionContext: context, epoch } = ctx;
  if (!ledger || !owner || !context || ctx.state.role.kind === "dormant") {
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
    context,
    pi: ctx.pi,
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

/** Obtain only configuration from the parent adapter; a child can never prepare its parent's resume. */
export async function prepareResume(
  ctx: CrewContext,
  operation: CoordinatorOperation,
  signal: AbortSignal,
): Promise<PreparedResume | OperationFailure | undefined> {
  const { ledger, ownership: owner } = ctx;
  if (!ledger || !owner) {
    throw new Error("Crew execution unavailable.");
  }
  const recipient = operation.recipientSessionId!;
  const instance = ledger.db
    .prepare(
      "SELECT * FROM instances WHERE workspace_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(owner.workspaceId, recipient);
  if (!instance || processPresence(rowProcess(instance)) !== "exited") {
    return undefined;
  }
  let reply;
  try {
    reply = await request(
      owner.workspaceId,
      operation.callerSessionId,
      { kind: "prepare-resume", requestId: operation.requestId },
      signal,
    );
  } catch (error) {
    if (error instanceof NotConnectedError || error instanceof UnresponsiveError) {
      return undefined;
    }
    throw error;
  }
  if (!reply.ok) {
    return {
      code: reply.code ?? "execution_failed",
      agentId: recipient,
      message: reply.error,
    };
  }
  if (!reply.directory) {
    throw new Error("Crew execution unavailable.");
  }
  const built = JSON.parse(readFileSync(join(reply.directory, "launch.json"), "utf8")) as Omit<
    BuiltLaunch,
    "cleanup"
  >;
  const role = ledger.role(recipient);
  const session = ledger.db
    .prepare("SELECT session_file FROM sessions WHERE workspace_id=? AND session_id=?")
    .get(owner.workspaceId, recipient);
  if (
    role?.kind !== "member" ||
    built.directory !== reply.directory ||
    built.env.PI_CREW_CALLER !== operation.callerSessionId ||
    built.env.PI_CREW_AGENT !== role.agent ||
    built.env.PI_CREW_ORIGIN !== role.origin ||
    !built.argv.includes("--session") ||
    built.argv[built.argv.indexOf("--session") + 1] !== session?.session_file
  ) {
    throw new Error("Launch endpoint mismatch.");
  }
  return { built, previousInstanceId: String(instance.instance_id) };
}

/** Resume only after exact exit, then verify the original full session ID before any follow-up input. */
export async function resumeChild(
  ctx: CrewContext,
  operation: CoordinatorOperation,
  prepared: PreparedResume,
  signal: AbortSignal,
): Promise<{ instanceId: string; paneId: string }> {
  const { ledger, ownership: owner } = ctx;
  if (!ledger || !owner) {
    throw new Error("Crew execution unavailable.");
  }
  ledger.assertCoordinator(owner);
  const recipient = operation.recipientSessionId!;
  const { built } = prepared;
  let result: { instanceId: string; paneId: string } | undefined;
  await allocate(
    owner,
    ledger,
    String(built.env.PI_CREW_AGENT),
    async (placement, verifyTopology) => {
      signal.throwIfAborted();
      const previous = ledger.db
        .prepare(
          "SELECT * FROM instances WHERE workspace_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(owner.workspaceId, recipient);
      if (
        !previous ||
        previous.instance_id !== prepared.previousInstanceId ||
        processPresence(rowProcess(previous)) !== "exited"
      ) {
        throw new Error("The recorded operation state does not permit this transition.");
      }
      await verifyTopology();
      built.env[ENV_CREW_TITLE] = placement.title;
      writeFileSync(join(built.directory, "launch.json"), JSON.stringify(built), { mode: 0o600 });
      await runPane(
        placement.pane.id,
        [process.execPath, join(built.directory, "exec.mjs")],
        built.cwd,
      );
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      for (;;) {
        signal.throwIfAborted();
        const instance = ledger.db
          .prepare(
            "SELECT i.*,s.session_file FROM instances i JOIN sessions s USING(workspace_id,session_id) WHERE i.workspace_id=? AND i.session_id=? AND i.status='running' AND i.instance_id<>? AND i.pane_id=?",
          )
          .get(owner.workspaceId, recipient, prepared.previousInstanceId, placement.pane.id);
        const observed = await herdr(["agent", "list"]);
        const agent = observed.agents.find(
          (entry: { pane_id: string }) => entry.pane_id === placement.pane.id,
        );
        const identity = agent?.agent_session;
        if (
          instance &&
          processPresence(rowProcess(instance)) === "alive" &&
          agent?.agent === "pi" &&
          agent.terminal_id === placement.pane.terminalId &&
          ((identity?.kind === "id" && identity.value === recipient) ||
            (identity?.kind === "path" && identity.value === instance.session_file))
        ) {
          let reply;
          try {
            reply = await request(owner.workspaceId, recipient, { kind: "ping" }, signal);
          } catch (error) {
            if (!(error instanceof NotConnectedError || error instanceof UnresponsiveError)) {
              throw error;
            }
          }
          if (
            reply?.ok &&
            reply.info?.sessionId === recipient &&
            reply.info.instanceId === instance.instance_id &&
            reply.info.paneId === placement.pane.id
          ) {
            await verifyTopology();
            result = { instanceId: String(instance.instance_id), paneId: placement.pane.id };
            return;
          }
        }
        if (Date.now() >= deadline) {
          throw new Error("Child reported an invalid pi identity.");
        }
        await delay(100, undefined, { signal });
      }
    },
    built.cwd,
    signal,
  );
  if (!result) {
    throw new Error("Child reported an invalid pi identity.");
  }
  return result;
}