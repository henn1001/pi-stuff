import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { STARTUP_TIMEOUT_MS, ENV_CREW_TITLE, type BuiltLaunch } from "../../launch/launch.ts";
import { allocate } from "../../herdr/layout.ts";
import { layoutOccupancy } from "../../store/layout-occupancy.ts";
import { herdr } from "../../herdr/cli.ts";
import { runPane } from "../../herdr/command.ts";
import { NotConnectedError, UnresponsiveError, request } from "../../ipc/socket.ts";
import type { CoordinatorContext } from "../../extension/coordinator-context.ts";
import { processPresence, rowProcess } from "../../store/process-identity.ts";

/** Install the lead-only launch consumer; prepared caller snapshots never confer execution authority. */
export function registerSpawnPlanner(lead: CoordinatorContext): void {
  const { crew, coordinatorStore: ledger, coordinator } = lead;
  const owner = crew.ownership;
  if (!owner) {
    throw new Error("Crew execution unavailable.");
  }
  coordinator.register("spawn", async (operation, signal) => {
    const parent = ledger.db
      .prepare("SELECT * FROM agent_tree WHERE workspace_id=? AND session_id=?")
      .get(owner.workspaceId, operation.callerSessionId);
    if (!parent || parent.root_lead_session_id !== owner.sessionId) {
      return {
        code: "permission_denied",
        message: "Spawning is disabled by definition, attachment or tree depth.",
      };
    }
    let caller;
    try {
      caller = await request(
        owner.workspaceId,
        operation.callerSessionId,
        { kind: "ping" },
        signal,
      );
    } catch (error) {
      if (error instanceof NotConnectedError || error instanceof UnresponsiveError) {
        return undefined;
      }
      throw error;
    }
    if (
      !caller.ok ||
      caller.info?.sessionId !== operation.callerSessionId ||
      !caller.info.instanceId
    ) {
      return undefined;
    }
    const instance = ledger.db
      .prepare(
        "SELECT * FROM instances WHERE workspace_id=? AND session_id=? AND instance_id=? AND status='running'",
      )
      .get(owner.workspaceId, operation.callerSessionId, caller.info.instanceId);
    if (!instance || processPresence(rowProcess(instance)) !== "alive") {
      return undefined;
    }
    const ready = ledger.db
      .prepare(
        "SELECT count(*) AS n FROM relationships WHERE workspace_id=? AND child_session_id=? AND parent_session_id=? AND stage='ready'",
      )
      .get(owner.workspaceId, operation.callerSessionId, parent.parent_session_id!);
    if (
      parent.parent_session_id !== null &&
      (parent.parent_session_id !== owner.sessionId || !caller.info.spawning || ready?.n !== 2)
    ) {
      return {
        code: "permission_denied",
        message: "Spawning is disabled by definition, attachment or tree depth.",
      };
    }
    let built: Omit<BuiltLaunch, "cleanup">;
    try {
      if (!operation.launchDirectory) {
        throw new Error("Crew execution unavailable.");
      }
      built = JSON.parse(readFileSync(join(operation.launchDirectory, "launch.json"), "utf8"));
      const input = JSON.parse(readFileSync(join(operation.launchDirectory, "input.json"), "utf8"));
      if (
        built.directory !== operation.launchDirectory ||
        ledger.currentSessionId(built.env.PI_CREW_CALLER) !== operation.callerSessionId ||
        built.env.PI_CREW_AGENT !== operation.definitionName ||
        input.definition.name !== operation.definitionName ||
        (input.prompt ?? "") !== operation.payload ||
        (built.env.PI_CREW_ORIGIN !== "tool" && built.env.PI_CREW_ORIGIN !== "menu")
      ) {
        throw new Error("Launch endpoint mismatch.");
      }
      if (
        built.env.PI_CREW_ORIGIN === "menu" &&
        (operation.callerSessionId !== owner.sessionId ||
          operation.payload !== "" ||
          operation.taskName !== null)
      ) {
        throw new Error("Tree launches require assignment input.");
      }
      if (
        built.env.PI_CREW_ORIGIN === "tool" &&
        (!operation.payload.trim() ||
          !operation.taskName ||
          input.definition.disableModelInvocation)
      ) {
        throw new Error("Tree launches require assignment input.");
      }
      if (caller.info.lifecycle === "non-interactive" && !input.definition.autoExit) {
        return {
          code: "permission_denied",
          message: "A non-interactive parent may spawn only non-interactive children.",
        };
      }
    } catch (error) {
      return { code: "launch_failed", message: `Agent launch failed: ${String(error)}` };
    }
    return {
      command: "launch",
      recipientInstanceId: null,
      async execute(executionSignal) {
        let issued = false;
        let observedSessionId: string | undefined;
        try {
          let launch:
            | { sessionId: string; instanceId: string; assignmentId: string | null }
            | undefined;
          await allocate(
            layoutOccupancy(ledger, owner),
            operation.definitionName!,
            async (placement, verifyTopology) => {
              executionSignal.throwIfAborted();
              await verifyTopology();
              built.env.PI_CREW_CALLER = operation.callerSessionId;
              built.env[ENV_CREW_TITLE] = placement.title;
              writeFileSync(join(built.directory, "launch.json"), JSON.stringify(built), {
                mode: 0o600,
              });
              // From command admission onward, failure cannot establish that no process started.
              issued = true;
              await runPane(
                placement.pane.id,
                [process.execPath, join(built.directory, "exec.mjs")],
                built.cwd,
              );
              const deadline = Date.now() + STARTUP_TIMEOUT_MS;
              for (;;) {
                executionSignal.throwIfAborted();
                const observed = await herdr(["agent", "list"]);
                const agent = observed.agents.find(
                  (entry: { pane_id: string }) => entry.pane_id === placement.pane.id,
                );
                const rows = ledger.db
                  .prepare(
                    "SELECT i.*,s.session_file FROM instances i JOIN sessions s USING(workspace_id,session_id) WHERE i.workspace_id=? AND i.pane_id=? AND i.status='running'",
                  )
                  .all(owner.workspaceId, placement.pane.id);
                for (const row of rows) {
                  const role = ledger.role(String(row.session_id));
                  const identity = agent?.agent_session;
                  if (
                    agent?.agent !== "pi" ||
                    agent.terminal_id !== placement.pane.terminalId ||
                    identity?.agent !== "pi" ||
                    !(
                      (identity.kind === "path" && identity.value === row.session_file) ||
                      (identity.kind === "id" && identity.value === row.session_id)
                    ) ||
                    role?.kind !== "member" ||
                    role.caller !== operation.callerSessionId ||
                    role.agent !== operation.definitionName ||
                    role.origin !== built.env.PI_CREW_ORIGIN ||
                    processPresence(rowProcess(row)) !== "alive"
                  ) {
                    continue;
                  }
                  let reply;
                  try {
                    reply = await request(
                      owner.workspaceId,
                      String(row.session_id),
                      { kind: "ping" },
                      executionSignal,
                    );
                  } catch (error) {
                    if (error instanceof NotConnectedError || error instanceof UnresponsiveError) {
                      continue;
                    }
                    throw error;
                  }
                  if (
                    !reply.ok ||
                    reply.info?.sessionId !== row.session_id ||
                    reply.info.instanceId !== row.instance_id ||
                    reply.info.paneId !== placement.pane.id
                  ) {
                    continue;
                  }
                  observedSessionId = String(row.session_id);
                  const attached = ledger.db
                    .prepare(
                      "SELECT count(*) AS n FROM relationships WHERE workspace_id=? AND child_session_id=? AND parent_session_id=? AND stage='ready' AND origin='spawned'",
                    )
                    .get(owner.workspaceId, row.session_id!, operation.callerSessionId);
                  if (attached?.n !== 2) {
                    continue;
                  }
                  await verifyTopology();
                  launch = {
                    sessionId: String(row.session_id),
                    instanceId: String(row.instance_id),
                    assignmentId: operation.payload.trim() ? randomUUID() : null,
                  };
                  return;
                }
                if (Date.now() >= deadline) {
                  throw new Error("Child reported an invalid pi identity.");
                }
                await delay(Math.min(100, deadline - Date.now()), undefined, {
                  signal: executionSignal,
                });
              }
            },
            built.cwd,
            executionSignal,
          );
          if (!launch) {
            throw new Error("Child reported an invalid pi identity.");
          }
          return { state: "succeeded", launch };
        } catch (error) {
          return {
            state: issued ? "uncertain" : "failed",
            failure: {
              code: issued ? "outcome_unknown" : "launch_failed",
              agentId: observedSessionId,
              message: issued
                ? `Agent launch outcome is unknown: ${String(error)}. Do not retry automatically.`
                : `Agent launch failed: ${String(error)}`,
            },
          };
        }
      },
    };
  });
}