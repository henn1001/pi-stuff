import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ENV_CREW_TITLE, STARTUP_TIMEOUT_MS, type BuiltLaunch } from "../../launch/launch.ts";
import { allocate } from "../../herdr/layout.ts";
import { layoutOccupancy } from "../../store/layout-occupancy.ts";
import { herdr } from "../../herdr/cli.ts";
import { runPane } from "../../herdr/command.ts";
import { NotConnectedError, UnresponsiveError, request } from "../../ipc/socket.ts";
import type { CoordinatorContext } from "../../extension/coordinator-context.ts";
import type { CoordinatorOperation } from "../coordinator.ts";
import type { OperationFailure } from "../../domain/operation.ts";
import { processPresence, rowProcess } from "../../store/process-identity.ts";

/** Private launch configuration prepared by the immediate parent; no process has been started. */
export interface PreparedResume {
  built: Omit<BuiltLaunch, "cleanup">;
  previousInstanceId: string;
}

/** Obtain only configuration from the parent adapter; a child can never prepare its parent's resume. */
export async function prepareResume(
  lead: CoordinatorContext,
  operation: CoordinatorOperation,
  signal: AbortSignal,
): Promise<PreparedResume | OperationFailure | undefined> {
  const { crew: ctx, coordinatorStore: ledger } = lead;
  const owner = ctx.ownership;
  if (!owner) {
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
  lead: CoordinatorContext,
  operation: CoordinatorOperation,
  prepared: PreparedResume,
  signal: AbortSignal,
): Promise<{ instanceId: string; paneId: string }> {
  const { crew: ctx, coordinatorStore: ledger } = lead;
  const owner = ctx.ownership;
  if (!owner) {
    throw new Error("Crew execution unavailable.");
  }
  ledger.assertCoordinator(owner);
  const recipient = operation.recipientSessionId!;
  const { built } = prepared;
  let result: { instanceId: string; paneId: string } | undefined;
  await allocate(
    layoutOccupancy(ledger, owner),
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