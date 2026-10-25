import { accessSync, constants, readFileSync } from "node:fs";
import type { Ledger } from "../base-store.ts";
import type { Ownership } from "../ownership.ts";
import type { ProcessPresence } from "../process-identity.ts";
import type { Poller } from "../../ipc/registry.ts";
import { assertOwnership } from "../ownership.ts";

/** Public observations and assignment counts for a recorded direct neighbor. */
export interface ListedAgent {
  entry_kind: "agent";
  launch_state: null;
  launch_error: null;
  agent_id: string;
  task_name: string | null;
  agent_type: string | null;
  relationship: "parent" | "child";
  activity: "running" | "idle" | "unknown";
  connectivity: "connected" | "unreachable";
  process_state: "alive" | "exited" | "unknown";
  resumability: "eligible" | "ineligible" | "unknown";
  assignment_state: "none" | "outstanding" | "settled";
  outstanding_child_assignments: number;
  unprocessed_child_outcomes: number;
}

/** Unsuccessful launch summary; no internal operation identity or inferred agent state. */
export interface ListedLaunch {
  entry_kind: "launch";
  launch_state: "pending" | "in_progress" | "uncertain" | "failed";
  launch_error: { code: string; message: string } | null;
  agent_id: null;
  task_name: string;
  agent_type: string;
  relationship: null;
  activity: null;
  connectivity: null;
  process_state: null;
  resumability: null;
  assignment_state: null;
  outstanding_child_assignments: null;
  unprocessed_child_outcomes: null;
}

/** Caller-scoped public listing. All fields are required; ordering follows the tool contract. */
export interface AgentListing {
  agents: (ListedAgent | ListedLaunch)[];
}

/** What the agent read model needs; satisfied structurally by the extension's runtime context. */
export interface ListingSource {
  ledger?: Ledger;
  ownership?: Ownership;
  poller?: Poller;
  processes: Map<string, ProcessPresence>;
  definitions: Map<string, unknown>;
}

/** Read one durable snapshot and cached observations without probing, reconciling, or starting work. */
export function agentListing(ctx: ListingSource): AgentListing {
  const ledger = ctx.ledger!;
  const owner = ctx.ownership!;
  assertOwnership(owner);
  const observed = ctx.poller?.latest().agents ?? [];
  return ledger.transaction(Date.now() + 1000, (db) => {
    const self = db
      .prepare("SELECT parent_session_id FROM agent_tree WHERE workspace_id=? AND session_id=?")
      .get(owner.workspaceId, owner.sessionId);
    const neighbors = db
      .prepare(
        "SELECT t.*,s.session_file FROM agent_tree t JOIN sessions s USING(workspace_id,session_id) WHERE t.workspace_id=? AND (t.session_id=? OR t.parent_session_id=?) ORDER BY CASE WHEN t.session_id=? THEN 0 ELSE 1 END,t.session_id",
      )
      .all(
        owner.workspaceId,
        self?.parent_session_id ?? null,
        owner.sessionId,
        self?.parent_session_id ?? null,
      );
    const agents: (ListedAgent | ListedLaunch)[] = neighbors.map((row): ListedAgent => {
      const id = String(row.session_id);
      const parent = id === self?.parent_session_id;
      const instance = db
        .prepare(
          "SELECT * FROM instances WHERE workspace_id=? AND session_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(owner.workspaceId, id);
      const presence =
        instance?.status === "exited"
          ? "exited"
          : instance
            ? (ctx.processes.get(String(instance.instance_id)) ?? "unknown")
            : "unknown";
      const live =
        presence === "exited"
          ? undefined
          : observed.find(
              (agent) => agent.sessionId === id && agent.instanceId === instance?.instance_id,
            );
      let resumability: ListedAgent["resumability"] = parent ? "ineligible" : "unknown";
      if (!parent && presence === "alive") {
        resumability = "ineligible";
      } else if (!parent && presence === "exited") {
        resumability = "ineligible";
        if (
          ctx.definitions.has(String(row.definition_name)) &&
          typeof row.session_file === "string"
        ) {
          try {
            accessSync(row.session_file, constants.R_OK);
            const header = JSON.parse(readFileSync(row.session_file, "utf8").split("\n", 1)[0]);
            if (header.type === "session" && header.id === id) {
              resumability = "eligible";
            }
          } catch {
            // An unreadable or invalid saved identity cannot be resumed; never create a replacement.
          }
        }
      }
      const assignment = db
        .prepare(
          "SELECT state FROM assignments WHERE workspace_id=? AND parent_session_id=? AND child_session_id=? AND state<>'failed-start' ORDER BY rowid DESC LIMIT 1",
        )
        .get(owner.workspaceId, parent ? id : owner.sessionId, parent ? owner.sessionId : id);
      return {
        entry_kind: "agent",
        launch_state: null,
        launch_error: null,
        agent_id: id,
        task_name: row.task_name === null ? null : String(row.task_name),
        agent_type: row.definition_name === null ? null : String(row.definition_name),
        relationship: parent ? "parent" : "child",
        activity:
          live?.state === "working" ? "running" : live?.state === "idle" ? "idle" : "unknown",
        connectivity: live ? "connected" : "unreachable",
        process_state: presence,
        resumability,
        assignment_state:
          assignment?.state === "settled" ? "settled" : assignment ? "outstanding" : "none",
        outstanding_child_assignments: Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM assignments WHERE workspace_id=? AND parent_session_id=? AND state IN ('prepared','outstanding')",
            )
            .get(owner.workspaceId, id)?.n ?? 0,
        ),
        unprocessed_child_outcomes: Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM pending_outcomes WHERE workspace_id=? AND parent_session_id=? AND delivery_state='delivered'",
            )
            .get(owner.workspaceId, id)?.n ?? 0,
        ),
      };
    });
    const launches = db
      .prepare(
        "SELECT task_name,definition_name,state,error_code,error_message FROM operations WHERE workspace_id=? AND caller_session_id=? AND kind='spawn' AND task_name IS NOT NULL AND state<>'succeeded' ORDER BY task_name,submission_order",
      )
      .all(owner.workspaceId, owner.sessionId);
    agents.push(
      ...launches.map((row): ListedLaunch => ({
        entry_kind: "launch",
        launch_state: row.state as ListedLaunch["launch_state"],
        launch_error:
          row.error_code === null
            ? null
            : { code: String(row.error_code), message: String(row.error_message) },
        agent_id: null,
        task_name: String(row.task_name),
        agent_type: String(row.definition_name),
        relationship: null,
        activity: null,
        connectivity: null,
        process_state: null,
        resumability: null,
        assignment_state: null,
        outstanding_child_assignments: null,
        unprocessed_child_outcomes: null,
      })),
    );
    return { agents };
  });
}