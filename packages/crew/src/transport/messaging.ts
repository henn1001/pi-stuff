import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertOwnership } from "../runtime/ownership.ts";
import { assertSpawnPolicy } from "../runtime/policy.ts";
import type { CrewContext } from "../runtime/context.ts";
import { assertActive } from "../tools/access.ts";
import type { AgentInfo, Reply, Request } from "./protocol.ts";
import type { Origin } from "../runtime/types.ts";
import { prepareResumeReply } from "../runtime/resume.ts";

/** Durable routing identity; labels are presentation only. */
export interface CrewMessageDetails {
  from: string;
  to: string;
  fromLabel?: string;
  toLabel?: string;
  kind: "message" | "result" | "disconnect";
  /** Private durable delivery correlation, excluded from model-visible content. */
  requestId?: string;
}

/** Bind incoming requests to one runtime; disposed endpoints cannot serve a replacement session. */
export function createInboundHandler(
  endpoint: CrewContext,
  describe: () => AgentInfo,
  isCurrent: () => boolean,
): (req: Request) => Promise<Reply> {
  const { epoch, ledger, ownership } = endpoint;
  const preparations = new Map<string, Promise<Reply>>();
  return async (req) => {
    if (
      !isCurrent() ||
      !ledger ||
      !ownership ||
      endpoint.epoch !== epoch ||
      endpoint.ledger !== ledger ||
      endpoint.ownership !== ownership
    ) {
      return { ok: false, error: "Durable Crew endpoint unavailable." };
    }
    assertOwnership(ownership);
    if (req.kind === "ping") {
      return { ok: true, info: describe() };
    }
    if (req.kind === "attach" || req.kind === "attach-child") {
      if (!endpoint.attachment) {
        return { ok: false, error: "Attachment endpoint unavailable." };
      }
      return endpoint.attachment.receive(req);
    }
    if (req.kind === "prepare-resume") {
      let prepared = preparations.get(req.requestId);
      if (!prepared) {
        prepared = prepareResumeReply(endpoint, req.requestId);
        preparations.set(req.requestId, prepared);
      }
      return prepared;
    }
    if (req.kind === "launch-result") {
      endpoint.execution?.resultRecorded(req.requestId);
      return { ok: true };
    }
    if (req.kind === "wake" && endpoint.coordinator) {
      endpoint.coordinator.wake();
      return { ok: true };
    }
    return { ok: false, error: "Durable Crew endpoint unavailable." };
  };
}

/** Shared tool/menu creation path. Menu launches are idle and assign no work. */
export async function spawnAgent(
  ctx: CrewContext,
  context: ExtensionContext,
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
      context,
      pi: ctx.pi,
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