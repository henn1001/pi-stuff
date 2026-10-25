import { hasHerdrContext, type CrewContext } from "../runtime/context.ts";
import { relationshipPolicy } from "../runtime/policy.ts";
import { assertOwnership } from "../runtime/ownership.ts";
import { ToolFailure } from "./result.ts";

/** The only registered Crew tools. Removed names are withdrawn on reload as well. */
export const CREW_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "report_task",
  "list_agents",
] as const;

/** Internal adapters require an active, owned endpoint. */
export function assertActive(crew: CrewContext): void {
  if (!hasHerdrContext() || !crew.ownership || !crew.ledger || crew.state.role.kind === "dormant") {
    throw new Error("Crew is inactive. Activate with --crew-mode lead|member or /crew.");
  }
  if (crew.state.role.kind === "member" && crew.state.role.metadataError) {
    throw new Error(crew.state.role.metadataError);
  }
}

/** Public permissions are independent of whether a tool happens to be visible. */
export function assertToolAccess(crew: CrewContext, tool: string): void {
  if (!hasHerdrContext() || crew.state.role.kind === "dormant") {
    throw new ToolFailure("permission_denied", `${tool} failed: Crew is inactive in this session.`);
  }
  const unavailableCode = tool === "list_agents" ? "permission_denied" : "precondition_failed";
  if (
    !crew.ownership ||
    !crew.ledger ||
    !crew.execution ||
    (crew.state.role.kind === "member" && crew.state.role.metadataError)
  ) {
    throw new ToolFailure(
      unavailableCode,
      `${tool} failed: the current Crew endpoint is unavailable.`,
    );
  }
  try {
    assertOwnership(crew.ownership);
  } catch {
    throw new ToolFailure(
      unavailableCode,
      `${tool} failed: the current Crew endpoint is unavailable.`,
    );
  }
}

/** Apply configured tools at initialization or explicit activation; handlers check live policy. */
export function syncActiveTools(crew: CrewContext): void {
  const configured = crew.state.role.kind === "member" ? crew.memberDefinition?.tools : undefined;
  const unrelated = (configured ?? crew.pi.getActiveTools()).filter(
    (name) => !(CREW_TOOL_NAMES as readonly string[]).includes(name),
  );
  const active: string[] = [];
  if (crew.ownership && crew.ledger && crew.state.role.kind !== "dormant") {
    // Launch identity establishes configured depth before the attachment handshake finishes.
    const depth =
      relationshipPolicy(crew).depth ??
      (crew.state.role.kind === "member" &&
      (!crew.state.role.caller || crew.ledger.role(crew.state.role.caller)?.kind === "lead")
        ? 1
        : undefined);
    active.push("send_message", "list_agents");
    if (crew.state.role.kind === "lead" || (crew.state.memberSpawning && depth === 1)) {
      active.push("spawn_agent");
    }
    if (crew.state.role.kind === "member") {
      active.push("report_task");
    }
  }
  crew.pi.setActiveTools([...unrelated, ...active]);
}