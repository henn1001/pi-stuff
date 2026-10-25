import { herdr } from "./cli.ts";

/** Geometry and provenance from one Herdr snapshot, not inferred from pane titles. */
export interface HerdrPane {
  id: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  tabTitle: string;
  title: string;
  cols: number;
  rows: number;
  x: number;
  y: number;
  zoomed: boolean;
  tokens: Record<string, string>;
  /** Herdr-observed occupant identity from the same topology snapshot. */
  agent?: string;
  agentSession?: { agent: string; kind: string; value: string };
}

/** Read and cross-check live pane membership, geometry, and occupant identity. */
export async function listPanes(workspaceId: string): Promise<HerdrPane[]> {
  const result = await herdr(["api", "snapshot"]);
  const snap = result.snapshot;

  if (!Array.isArray(snap?.panes) || !Array.isArray(snap?.tabs) || !Array.isArray(snap?.layouts)) {
    throw new Error("Herdr snapshot lacks panes, tabs, or layouts.");
  }

  const panes = snap.panes.filter((p: any) => p?.workspace_id === workspaceId);

  if (new Set(panes.map((p: any) => p.pane_id)).size !== panes.length) {
    throw new Error("Herdr snapshot contains duplicate pane identities.");
  }

  return panes.map((p: any) => {
    const tab = snap.tabs.find((t: any) => t.tab_id === p.tab_id && t.workspace_id === workspaceId);

    const layout = snap.layouts.find(
      (l: any) => l.tab_id === p.tab_id && l.workspace_id === workspaceId,
    );
    const geometry = layout?.panes?.find((g: any) => g.pane_id === p.pane_id)?.rect;

    const liveIds = snap.panes
      .filter((q: any) => q.tab_id === p.tab_id)
      .map((q: any) => q.pane_id)
      .sort();
    const layoutIds = layout?.panes?.map((g: any) => g.pane_id).sort();

    // Herdr reports topology in separate arrays; verify they agree before trusting pane data.
    const tabAndLayoutAreUnique =
      snap.tabs.filter((t: any) => t.tab_id === p.tab_id).length === 1 &&
      snap.layouts.filter((l: any) => l.tab_id === p.tab_id).length === 1;
    const paneMembershipMatchesLayout =
      JSON.stringify(liveIds) === JSON.stringify(layoutIds) && tab?.pane_count === liveIds.length;
    const geometryIsValid =
      Boolean(geometry) &&
      typeof layout?.zoomed === "boolean" &&
      [geometry.width, geometry.height, geometry.x, geometry.y].every(Number.isInteger) &&
      geometry.width > 0 &&
      geometry.height > 0;
    const paneIdentityIsValid = typeof p.pane_id === "string" && typeof p.terminal_id === "string";
    const labelsAreValid =
      (p.label == null || typeof p.label === "string") &&
      (tab?.label == null || typeof tab.label === "string");
    const tokensAreValid =
      p.tokens === undefined ||
      (typeof p.tokens === "object" &&
        p.tokens !== null &&
        !Array.isArray(p.tokens) &&
        Object.values(p.tokens).every((value) => typeof value === "string"));

    if (
      !tab ||
      !tabAndLayoutAreUnique ||
      !paneMembershipMatchesLayout ||
      !geometryIsValid ||
      !paneIdentityIsValid ||
      !labelsAreValid ||
      !tokensAreValid
    ) {
      throw new Error(`Inconsistent Herdr topology for pane ${p.pane_id}.`);
    }

    return {
      id: p.pane_id,
      terminalId: p.terminal_id,
      workspaceId,
      tabId: p.tab_id,
      tabTitle: tab.label ?? "",
      title: p.label ?? p.title ?? "",
      cols: geometry.width,
      rows: geometry.height,
      x: geometry.x,
      y: geometry.y,
      zoomed: layout.zoomed,
      tokens: p.tokens ?? {},
      agent: p.agent ?? undefined,
      agentSession: p.agent_session ?? undefined,
    };
  });
}

export async function isShellIdle(paneId: string): Promise<boolean> {
  const result = await herdr(["pane", "process-info", "--pane", paneId]);
  const info = result.process_info;
  if (
    !info ||
    typeof info !== "object" ||
    Array.isArray(info) ||
    (info.shell_pid != null && !Number.isInteger(info.shell_pid)) ||
    (info.foreground_processes !== undefined && !Array.isArray(info.foreground_processes))
  ) {
    throw new Error("Herdr returned invalid process information.");
  }

  // Herdr may not have observed the new shell yet; created() keeps waiting in that case.
  if (info.shell_pid == null || info.foreground_processes === undefined) {
    return false;
  }

  return (
    info.foreground_process_group_id === info.shell_pid &&
    info.foreground_processes.length === 1 &&
    info.foreground_processes[0].pid === info.shell_pid
  );
}