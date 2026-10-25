import { assertOwnership } from "../store/ownership.ts";
import type { CrewContext } from "../extension/context.ts";
import type { AgentInfo, Reply, Request } from "../ipc/protocol.ts";
import type { LaunchHost } from "../launch/launch.ts";
import { prepareResumeReply } from "./resume-preparation.ts";

/** Bind incoming requests to one runtime; disposed endpoints cannot serve a replacement session. */
export function createInboundHandler(
  endpoint: CrewContext,
  describe: () => AgentInfo,
  isCurrent: () => boolean,
  launchHost: () => LaunchHost | undefined,
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
        prepared = prepareResumeReply(endpoint, req.requestId, launchHost());
        preparations.set(req.requestId, prepared);
      }
      return prepared;
    }
    if (req.kind === "launch-result") {
      endpoint.execution?.resultRecorded(req.requestId);
      return { ok: true };
    }
    if (req.kind === "wake" && endpoint.wakeCoordinator) {
      endpoint.wakeCoordinator();
      return { ok: true };
    }
    return { ok: false, error: "Durable Crew endpoint unavailable." };
  };
}