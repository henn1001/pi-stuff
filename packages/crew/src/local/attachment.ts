import { randomUUID } from "node:crypto";
import type { CrewContext } from "../extension/context.ts";
import { assertOwnership } from "../store/ownership.ts";
import { processPresence, rowProcess } from "../store/process-identity.ts";
import { request } from "../ipc/socket.ts";
import type { Request, Reply } from "../ipc/protocol.ts";
import { relationshipPolicy } from "./policy.ts";

/** Each endpoint writes only its own durable handshake row. Network calls never span transactions. */
export class Attachment {
  /** Coalesced handshake for this runtime only. */
  pending?: Promise<void>;
  private readonly epoch: number;
  private readonly ledger: CrewContext["ledger"];
  private readonly owner: CrewContext["ownership"];

  /** Capture the endpoint capability before starting any handshake. */
  constructor(readonly ctx: CrewContext) {
    this.epoch = ctx.epoch;
    this.ledger = ctx.ledger;
    this.owner = ctx.ownership;
  }

  private endpoint() {
    const { ledger, owner } = this;
    if (
      this.ctx.attachment !== this ||
      this.ctx.epoch !== this.epoch ||
      this.ctx.ledger !== ledger ||
      this.ctx.ownership !== owner
    ) {
      throw new Error("Attachment endpoint changed.");
    }
    if (!ledger || !owner) {
      throw new Error("Attachment requires Crew ownership.");
    }
    assertOwnership(owner);
    return { ledger, owner };
  }

  private watch(session: string, instanceId?: string): void {
    const { ledger, owner } = this.endpoint();
    const row = ledger.db
      .prepare("SELECT * FROM instances WHERE workspace_id=? AND session_id=? AND status='running'")
      .get(owner.workspaceId, session);
    if (
      !row ||
      (instanceId !== undefined && row.instance_id !== instanceId) ||
      processPresence(rowProcess(row)) !== "alive"
    ) {
      throw new Error(
        "Attachment requires reliable live exact-process identity on both endpoints.",
      );
    }
    this.ctx.processes.set(String(row.instance_id), "alive");
    this.ctx.refreshSupervision?.();
  }

  private save(
    child: string,
    parent: string,
    handshake: string,
    origin: string,
    stage: string,
  ): void {
    const { ledger, owner } = this.endpoint();
    ledger.transaction(Date.now() + 1000, (db) => {
      assertOwnership(owner);
      const tree = db
        .prepare("SELECT parent_session_id FROM agent_tree WHERE workspace_id=? AND session_id=?")
        .get(owner.workspaceId, child);
      if (tree && tree.parent_session_id !== parent) {
        throw new Error(
          "Attachment conflicts with the recorded parent/handshake. Reparenting is not supported.",
        );
      }
      const existing = db
        .prepare(
          "SELECT parent_session_id,handshake_id,origin FROM relationships WHERE workspace_id=? AND child_session_id=?",
        )
        .all(owner.workspaceId, child);
      if (
        existing.some(
          (row) =>
            row.parent_session_id !== parent ||
            row.handshake_id !== handshake ||
            row.origin !== origin,
        )
      ) {
        throw new Error(
          "Attachment conflicts with the recorded parent/handshake. Reparenting is not supported.",
        );
      }
      db.prepare(
        "INSERT INTO relationships VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,owner_session_id,child_session_id) DO UPDATE SET stage=CASE WHEN relationships.stage IN ('ready','orphaned') AND excluded.stage<>'ready' THEN relationships.stage ELSE excluded.stage END",
      ).run(owner.workspaceId, owner.sessionId, child, parent, handshake, stage, origin);
    });
  }

  /** Validate and retain the recorded handshake without selecting a replacement parent. */
  async receive(req: Extract<Request, { kind: "attach" | "attach-child" }>): Promise<Reply> {
    const { ledger, owner } = this.endpoint();
    if (req.kind === "attach-child") {
      const role = this.ctx.state.role;
      if (
        role.kind !== "member" ||
        (ledger.currentSessionId(role.caller) !== req.from &&
          relationshipPolicy(this.ctx).parent?.parent_session_id !== req.from)
      ) {
        throw new Error("Not the recorded spawning parent.");
      }
      await this.join(req.from);
      return { ok: true };
    }
    const childRole = ledger.role(req.from);
    const proposal = ledger.db
      .prepare(
        "SELECT * FROM relationships WHERE workspace_id=? AND owner_session_id=? AND child_session_id=?",
      )
      .get(owner.workspaceId, req.from, req.from);
    if (
      childRole?.kind !== "member" ||
      !proposal ||
      proposal.parent_session_id !== owner.sessionId ||
      proposal.handshake_id !== req.handshakeId
    ) {
      throw new Error("Unauthorized attachment proposal.");
    }
    if (proposal.origin === "joined" && this.ctx.state.role.kind !== "lead") {
      throw new Error("Joined members attach only to their recorded lead.");
    }
    if (
      proposal.origin === "spawned" &&
      ledger.currentSessionId(childRole.caller) !== owner.sessionId
    ) {
      throw new Error("Spawning parent mismatch.");
    }
    if (
      relationshipPolicy(this.ctx).depth === undefined ||
      relationshipPolicy(this.ctx).depth! >= 2
    ) {
      throw new Error("Attachment exceeds tree depth.");
    }
    this.watch(req.from);
    if (
      req.phase === "ready" &&
      !["confirmed", "ready", "orphaned"].includes(String(proposal.stage))
    ) {
      throw new Error("Member confirmation missing.");
    }
    this.ctx.refreshSupervision?.();
    this.save(
      req.from,
      owner.sessionId,
      req.handshakeId,
      String(proposal.origin),
      req.phase === "accept" ? "accepted" : "ready",
    );
    if (req.phase === "ready" && proposal.origin === "joined") {
      ledger.attachMember(owner, req.from, owner.sessionId, Date.now() + 1000);
    }
    this.ctx.refreshSupervision?.();
    return { ok: true };
  }

  /** Coalesce attachment to the immutable parent for this runtime. */
  join(parent: string): Promise<void> {
    if (this.pending) {
      return this.pending;
    }
    const task = this.performJoin(parent);
    this.pending = task;
    void task
      .finally(() => {
        if (this.pending === task) {
          this.pending = undefined;
        }
      })
      .catch(() => {});
    return task;
  }

  private async performJoin(parent: string): Promise<void> {
    const { ledger, owner } = this.endpoint();
    const epoch = this.ctx.epoch;
    const role = this.ctx.state.role;
    if (
      role.kind !== "member" ||
      (role.caller && ledger.currentSessionId(role.caller) !== parent)
    ) {
      throw new Error("Conflicting member parent.");
    }
    const current = () => {
      this.endpoint();
      if (this.ctx.ownership !== owner || this.ctx.ledger !== ledger || this.ctx.epoch !== epoch) {
        throw new Error("Attachment endpoint changed.");
      }
    };
    const previous = relationshipPolicy(this.ctx).parent;
    if (previous && previous.parent_session_id !== parent) {
      throw new Error("Member already has a recorded parent.");
    }
    const handshake = previous ? String(previous.handshake_id) : randomUUID();
    const origin = previous ? String(previous.origin) : role.caller ? "spawned" : "joined";
    // Persist the proposal before any network operation; discovery never chooses again afterward.
    if (!previous) {
      this.save(owner.sessionId, parent, handshake, origin, "proposed");
    }
    const ping = await request(owner.workspaceId, parent, { kind: "ping" });
    current();
    if (!ping.ok || ping.info?.sessionId !== parent || !ping.info.instanceId) {
      throw new Error("Recorded parent is unavailable; attachment retained.");
    }
    this.watch(parent, ping.info.instanceId);
    for (const phase of ["accept", "ready"] as const) {
      if (phase === "ready") {
        this.save(owner.sessionId, parent, handshake, origin, "confirmed");
      }
      const reply = await request(owner.workspaceId, parent, {
        kind: "attach",
        from: owner.sessionId,
        handshakeId: handshake,
        phase,
      });
      current();
      if (!reply.ok) {
        throw new Error(reply.error);
      }
    }
    this.watch(parent, ping.info.instanceId);
    this.save(owner.sessionId, parent, handshake, origin, "ready");
    this.ctx.refreshSupervision?.();
    this.ctx.sessionContext?.ui.setStatus("crew-attachment", undefined);
  }

  /** Poll/reload recovery retries only the recorded edge, never a replacement lead or a report. */
  async reconcile(): Promise<void> {
    const role = this.ctx.state.role;
    if (role.kind !== "member") {
      return;
    }
    const { ledger, owner } = this.endpoint();
    const edge = relationshipPolicy(this.ctx).parent;
    const tree = ledger.db
      .prepare("SELECT parent_session_id FROM agent_tree WHERE workspace_id=? AND session_id=?")
      .get(owner.workspaceId, owner.sessionId);
    const lead = ledger.db
      .prepare("SELECT session_id FROM lead_ownership WHERE workspace_id=?")
      .get(owner.workspaceId);
    const parent = edge
      ? String(edge.parent_session_id)
      : tree?.parent_session_id
        ? String(tree.parent_session_id)
        : role.caller
          ? ledger.currentSessionId(role.caller)
          : lead
            ? String(lead.session_id)
            : undefined;
    if (!parent) {
      this.ctx.sessionContext?.ui.setStatus("crew-attachment", "Crew: waiting for lead");
      return;
    }
    if (edge?.stage === "ready") {
      const other = this.ctx
        .ledger!.db.prepare(
          "SELECT stage FROM relationships WHERE workspace_id=? AND owner_session_id=? AND child_session_id=? AND handshake_id=?",
        )
        .get(role.workspaceId, parent, role.sessionId, edge.handshake_id!);
      if (other?.stage === "ready") {
        return;
      }
    }
    await this.join(parent);
  }
}