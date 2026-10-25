import type { CrewContext } from "./context.ts";
import { automaticMode } from "./tree-lifecycle.ts";
import type { AgentDefinition } from "./types.ts";

/** Single tree projection for routing, tool availability and presentation. Discovery is not authority. */
export function relationshipPolicy(ctx: CrewContext) {
  const { ledger, ownership: owner } = ctx;
  if (!ledger || !owner) {
    return { parent: undefined, children: [], unattached: [], depth: undefined, maySpawn: false };
  }
  const rows = ledger.db
    .prepare("SELECT * FROM relationships WHERE workspace_id=? AND owner_session_id=?")
    .all(owner.workspaceId, owner.sessionId);
  const parent = rows.find((row) => row.child_session_id === owner.sessionId);
  const children = rows.filter((row) => row.parent_session_id === owner.sessionId);
  let depth: number | undefined = 0;
  let session = owner.sessionId;
  const seen = new Set<string>();
  while (ledger.role(session)?.kind !== "lead") {
    if (seen.has(session)) {
      depth = undefined;
      break;
    }
    seen.add(session);
    const edge = ledger.db
      .prepare(
        "SELECT parent_session_id FROM relationships WHERE workspace_id=? AND owner_session_id=? AND child_session_id=?",
      )
      .get(owner.workspaceId, session, session);
    if (!edge) {
      depth = undefined;
      break;
    }
    session = String(edge.parent_session_id);
    depth++;
  }
  const unattached =
    ctx.state.role.kind === "lead"
      ? ledger.db
          .prepare(
            "SELECT session_id FROM sessions s WHERE workspace_id=? AND role='member' AND NOT EXISTS (SELECT 1 FROM relationships r WHERE r.workspace_id=s.workspace_id AND r.child_session_id=s.session_id)",
          )
          .all(owner.workspaceId)
          .map((row) => String(row.session_id))
      : [];
  const parentReady =
    !parent ||
    ledger.db
      .prepare(
        "SELECT count(*) AS n FROM relationships WHERE workspace_id=? AND child_session_id=? AND parent_session_id=? AND handshake_id=? AND stage='ready'",
      )
      .get(owner.workspaceId, owner.sessionId, parent.parent_session_id!, parent.handshake_id!)
      ?.n === 2;
  return {
    parent,
    children,
    unattached,
    depth,
    maySpawn:
      depth !== undefined &&
      depth < 2 &&
      (ctx.state.role.kind === "lead" || ctx.state.memberSpawning) &&
      parentReady,
  };
}

export function readyNeighbor(
  ctx: CrewContext,
  target: string,
  direction: "parent" | "child",
): boolean {
  const policy = relationshipPolicy(ctx);
  const edge =
    direction === "parent"
      ? policy.parent
      : policy.children.find((row) => row.child_session_id === target);
  if (
    !edge ||
    edge.stage !== "ready" ||
    (direction === "parent" && edge.parent_session_id !== target)
  ) {
    return false;
  }
  const rows = ctx
    .ledger!.db.prepare(
      "SELECT stage FROM relationships WHERE workspace_id=? AND child_session_id=? AND parent_session_id=? AND handshake_id=?",
    )
    .all(
      ctx.ownership!.workspaceId,
      edge.child_session_id!,
      edge.parent_session_id!,
      edge.handshake_id!,
    );
  return rows.length === 2 && rows.every((row) => row.stage === "ready");
}

/** Revalidate launch permission at submission; attachment is a precondition, not delegation authority. */
export function assertSpawnPolicy(ctx: CrewContext, definition?: AgentDefinition): void {
  const policy = relationshipPolicy(ctx);
  if (
    ctx.state.role.kind === "member" &&
    (!policy.parent || !readyNeighbor(ctx, String(policy.parent.parent_session_id), "parent"))
  ) {
    throw Object.assign(
      new Error("spawn_agent failed: attachment to the recorded parent is not ready."),
      { code: "precondition_failed" },
    );
  }
  if (!policy.maySpawn || (definition && automaticMode(ctx) && !definition.autoExit)) {
    throw Object.assign(
      new Error(
        "spawn_agent failed: role, delegation permission, tree depth, or lifecycle mode disallows this spawn.",
      ),
      { code: "permission_denied" },
    );
  }
}