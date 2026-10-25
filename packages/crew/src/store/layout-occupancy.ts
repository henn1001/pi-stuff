import type { CoordinatorStore } from "./coordinator-store.ts";
import type { Ownership } from "./ownership.ts";
import { processPresence, rowProcess } from "./process-identity.ts";

/** Store-backed occupancy facts for Herdr pane allocation; structurally matches `herdr/layout`'s `LayoutOccupancy`. */
export function layoutOccupancy(ledger: CoordinatorStore, owner: Ownership) {
  const workspaceId = owner.workspaceId;
  return {
    workspaceId,
    leadSessionId: owner.sessionId,
    leadInstanceId: owner.instanceId,
    assertCoordinator: () => ledger.assertCoordinator(owner),
    runningInstances: () =>
      ledger.db
        .prepare(
          "SELECT i.*,s.session_file,t.root_lead_session_id FROM instances i JOIN sessions s USING(workspace_id,session_id) JOIN agent_tree t USING(workspace_id,session_id) WHERE i.workspace_id=? AND i.status='running'",
        )
        .all(workspaceId)
        .map((row) => ({
          sessionId: String(row.session_id),
          instanceId: String(row.instance_id),
          sessionFile: String(row.session_file),
          rootLeadSessionId: String(row.root_lead_session_id),
          pid: row.pid as number,
          alive: () => processPresence(rowProcess(row)) === "alive",
        })),
    paneInUse: (paneId: string) =>
      !!ledger.db
        .prepare(
          "SELECT 1 FROM instances WHERE workspace_id=? AND pane_id=? AND status='running' LIMIT 1",
        )
        .get(workspaceId, paneId),
  };
}