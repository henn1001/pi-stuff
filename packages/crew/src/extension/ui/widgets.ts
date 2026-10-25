import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { CrewContext } from "../context.ts";

/** Render tree reachability from the shared observer without probing or changing session input. */
export function updateWidget(ctx: ExtensionContext, crew: CrewContext): void {
  const owner = crew.ownership;
  if (ctx.mode !== "tui" || !owner || !crew.ledger || crew.state.role.kind === "dormant") {
    return;
  }
  const tree = crew.ledger.db
    .prepare("SELECT session_id,root_lead_session_id FROM agent_tree WHERE workspace_id=?")
    .all(owner.workspaceId);
  const root = tree.find((row) => row.session_id === owner.sessionId)?.root_lead_session_id;
  const members = new Set(
    tree
      .filter((row) => row.root_lead_session_id === root && row.session_id !== root)
      .map((row) => String(row.session_id)),
  );
  const observed = crew.connections?.agents ?? [];
  const count = observed.filter((agent) => members.has(agent.sessionId)).length;
  const lead = crew.state.role.kind === "lead";
  const connected = lead ? count > 0 : observed.some((agent) => agent.sessionId === root);
  ctx.ui.setWidget(
    "crew",
    (_tui, theme) => ({
      invalidate() {},
      render: (width: number) => [
        truncateToWidth(
          `${theme.fg("accent", theme.bold("Crew"))} ${theme.fg(
            connected ? "success" : lead ? "dim" : "error",
            connected ? "●" : "○",
          )}${lead ? ` ${count} connected` : ""}`,
          width,
        ),
      ],
    }),
    { placement: "aboveEditor" },
  );
}