import type { CrewContext } from "../extension/context.ts";
import { openLedger } from "../store/ledger.ts";
import type { LocalStore } from "../store/local-store.ts";
import { acquireOwnership, releaseOwnership, type Ownership } from "../store/ownership.ts";

/** Reconcile before advertising. Failure leaves no runtime claim or connection. */
export async function claimAuthority(
  ctx: CrewContext,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const role = ctx.state.role;
  if (role.kind === "dormant") {
    return;
  }
  const epoch = ctx.epoch;
  let owner: Ownership | undefined;
  let ledger: LocalStore | undefined;
  try {
    ledger = ctx.ledger ?? (await openLedger(role.workspaceId, true));
    if (ctx.epoch !== epoch || ctx.state.role !== role || !isCurrent()) {
      throw new Error("Crew session changed while opening authority.");
    }
    owner = acquireOwnership(role.workspaceId, role.sessionId, role.kind === "lead");
    ctx.ledger = ledger;
    ctx.ledger.register(
      owner,
      role,
      ctx.sessionContext?.sessionManager.getSessionFile(),
      role.kind === "member" && role.origin === "tool" && ctx.memberDefinition?.autoExit === true,
    );
    ctx.ownership = owner;
    if (ctx.state.takeover || owner.automaticDisabled) {
      owner.automaticDisabled = true;
      ledger.transaction(Date.now() + 1000, (db) => {
        db.prepare(
          "UPDATE instances SET takeover=1 WHERE workspace_id=? AND session_id=? AND instance_id=?",
        ).run(owner!.workspaceId, owner!.sessionId, owner!.instanceId);
      });
    }
    restoreAuthority(ctx);
  } catch (error) {
    if (ledger && ledger !== ctx.ledger) {
      ledger.close();
    }
    if (ctx.epoch === epoch && isCurrent()) {
      closeAuthority(ctx, true);
    }
    if (owner) {
      releaseOwnership(owner);
    }
    throw error;
  }
}

/** Project session-wide pending work from SQLite without inspecting conversation history. */
export function restoreAuthority(ctx: CrewContext): void {
  if (!ctx.ledger || !ctx.ownership) {
    return;
  }
  const snapshot = ctx.ledger.restore(ctx.ownership.sessionId, ctx.ownership.instanceId);
  ctx.state.outstanding = new Set(
    snapshot.assignments
      .filter((row) => row.state === "outstanding")
      .map((row) => String(row.child_session_id)),
  );
  ctx.state.takeover =
    snapshot.instance?.takeover === 1 || ctx.ownership.automaticDisabled === true;
}

/** Close this runtime's database; reload retains only the plain-data OS lock holder. */
export function closeAuthority(ctx: CrewContext, reload: boolean): void {
  const owner = ctx.ownership;
  try {
    ctx.ledger?.close();
  } finally {
    ctx.ledger = undefined;
    ctx.ownership = undefined;
    if (!reload && owner) {
      releaseOwnership(owner);
    }
  }
}