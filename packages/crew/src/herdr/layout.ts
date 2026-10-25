import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createTab, markPane, splitPane } from "./command.ts";
import { renamePane } from "./pane-ui.ts";
import { herdr } from "./cli.ts";
import { isShellIdle, listPanes, type HerdrPane } from "./observe.ts";
import { loadLayoutConfig } from "./layout-config.ts";
import { socketDir } from "../ipc/socket.ts";

/** Display-only title and current Herdr destination, never a routing identity. */
export interface Placement {
  title: string;
  pane: HerdrPane;
}

/** One running Crew instance, as the store reports it for pane ownership checks. */
export interface RunningInstance {
  sessionId: string;
  instanceId: string;
  sessionFile: string;
  rootLeadSessionId: string;
  pid: number;
  /** Exact-identity OS check; evaluated only for candidates. */
  alive(): boolean;
}

/** Store facts allocation needs; implemented by the store so herdr/ never imports it. */
export interface LayoutOccupancy {
  workspaceId: string;
  /** Session and instance of the lead that owns the allocation. */
  leadSessionId: string;
  leadInstanceId: string;
  /** Throws unless the lead still holds coordinator ownership. */
  assertCoordinator(): void;
  /** Running instances of this workspace. */
  runningInstances(): RunningInstance[];
  /** Whether a running instance is recorded in the pane. */
  paneInUse(paneId: string): boolean;
}

/** OS lock held by flock while stdin is open; caller death closes the pipe. Never unlink the lock file. */
export async function withAllocationLock<T>(
  workspaceId: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();

  const dir = socketDir(workspaceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, "allocation.lock");
  closeSync(openSync(path, "a", 0o600));
  const child = spawn(
    "flock",
    ["-x", "-w", "30", path, "/bin/sh", "-c", "printf locked; cat >/dev/null"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  // A spawn error must also be observed while waiting for the readiness byte.
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Crew allocation lock failed (${code}).`)));
  });

  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });

  try {
    try {
      await ready;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }

    signal?.throwIfAborted();
    return await action();
  } finally {
    signal?.removeEventListener("abort", abort);
    child.stdin.end();
    await exited;
  }
}

/** Coordinator-only allocation and launch admission share one workspace critical section.
 * Current Herdr identities determine ownership; saved pane locations never select targets. */
export async function allocate(
  occupancy: LayoutOccupancy,
  baseTitle: string,
  start: (placement: Placement, verifyTopology: () => Promise<void>) => Promise<void>,
  cwd: string,
  signal?: AbortSignal,
): Promise<Placement> {
  if (!/^[a-z0-9-]+$/.test(baseTitle)) {
    throw new Error("Invalid Crew display title base.");
  }
  const workspaceId = occupancy.workspaceId;
  occupancy.assertCoordinator();

  return withAllocationLock(
    workspaceId,
    async () => {
      signal?.throwIfAborted();
      occupancy.assertCoordinator();
      const config = loadLayoutConfig();

      // Match both exact OS instance and Herdr's session identity, including manually moved panes.
      const snapshot = async () => {
        signal?.throwIfAborted();
        occupancy.assertCoordinator();
        const panes = await listPanes(workspaceId);
        const rows = occupancy.runningInstances();
        const owned = new Map<string, string>();
        for (const pane of panes) {
          const identity = pane.agentSession;
          if (pane.agent !== "pi" || identity?.agent !== "pi") {
            continue;
          }
          const matches = rows.filter(
            (row) =>
              row.rootLeadSessionId === occupancy.leadSessionId &&
              ((identity.kind === "id" && identity.value === row.sessionId) ||
                (identity.kind === "path" && identity.value === row.sessionFile)) &&
              row.alive(),
          );
          if (matches.length !== 1) {
            continue;
          }
          const row = matches[0];
          if (
            rows.filter((r) => r.sessionId === row.sessionId).length !== 1 ||
            panes.filter(
              (p) =>
                p.agent === "pi" &&
                p.agentSession?.agent === "pi" &&
                ((p.agentSession.kind === "id" && p.agentSession.value === row.sessionId) ||
                  (p.agentSession.kind === "path" && p.agentSession.value === row.sessionFile)),
            ).length !== 1 ||
            (pane.tokens["crew-terminal"] && pane.tokens["crew-terminal"] !== pane.terminalId)
          ) {
            continue;
          }
          const processInfo = (await herdr(["pane", "process-info", "--pane", pane.id]))
            .process_info;
          if (
            !Array.isArray(processInfo?.foreground_processes) ||
            !processInfo.foreground_processes.some((p: { pid: number }) => p.pid === row.pid)
          ) {
            continue;
          }
          owned.set(pane.id, String(row.sessionId));
        }
        const lead = panes.find((p) => owned.get(p.id) === occupancy.leadSessionId);
        if (
          !lead ||
          !rows.some(
            (r) =>
              r.sessionId === occupancy.leadSessionId && r.instanceId === occupancy.leadInstanceId,
          )
        ) {
          throw new Error("Crew pane ownership conflicts with current Herdr identity.");
        }
        return { panes, owned, lead };
      };

      const { panes, owned, lead } = await snapshot();
      const titles = new Set(panes.map((p) => p.title));
      let title = baseTitle;
      for (let n = 2; titles.has(title); n++) {
        title = `${baseTitle}-${n}`;
      }

      const fits = (p: HerdrPane) => p.cols >= config.poolMinCols && p.rows >= config.poolMinRows;
      const direction = (p: HerdrPane): "right" | "down" | undefined => {
        if (p.cols >= 2 * config.poolMinCols + 1 && p.rows >= config.poolMinRows) {
          return "right";
        }
        if (p.rows >= 2 * config.poolMinRows + 1 && p.cols >= config.poolMinCols) {
          return "down";
        }
        return undefined;
      };
      const rootIsUnassigned = async (p: HerdrPane) =>
        !p.agent &&
        !p.agentSession &&
        !owned.has(p.id) &&
        p.tokens["crew-pool"] === p.tabId &&
        p.tokens["crew-terminal"] === p.terminalId &&
        p.tokens["crew-root"] === p.terminalId &&
        p.tokens["crew-assigned"] === "no" &&
        !occupancy.paneInUse(p.id) &&
        (await isShellIdle(p.id));
      const pools = [
        ...new Set(panes.filter((p) => p.tokens["crew-pool"] === p.tabId).map((p) => p.tabId)),
      ];
      const safePools: HerdrPane[][] = [];
      const roots = new Set<string>();
      for (const tabId of pools) {
        if (tabId === lead.tabId) {
          continue;
        }
        const group = panes.filter((p) => p.tabId === tabId);
        if (
          !group.length ||
          group.length > config.poolPaneLimit ||
          group.some(
            (p) =>
              p.zoomed ||
              !fits(p) ||
              p.tokens["crew-pool"] !== tabId ||
              p.tokens["crew-terminal"] !== p.terminalId,
          )
        ) {
          continue;
        }
        let safe = true;
        for (const p of group) {
          if (owned.has(p.id)) {
            continue;
          }
          if (await rootIsUnassigned(p)) {
            roots.add(p.id);
          } else {
            safe = false;
          }
        }
        if (safe) {
          safePools.push(group);
        }
      }

      let pane: HerdrPane | undefined;
      let pool = false;
      // Refresh the complete target tab immediately before each layout mutation.
      const split = async (target: HerdrPane, way: "right" | "down") => {
        const current = await snapshot();
        const before = panes.filter((p) => p.tabId === target.tabId);
        const now = current.panes.filter((p) => p.tabId === target.tabId);
        if (
          JSON.stringify(before) !== JSON.stringify(now) ||
          before.some((p) => owned.has(p.id) && current.owned.get(p.id) !== owned.get(p.id))
        ) {
          throw new Error("Crew pane ownership conflicts with current Herdr identity.");
        }
        for (const p of before) {
          if (roots.has(p.id) && !(await rootIsUnassigned(p))) {
            throw new Error("Crew pane ownership conflicts with current Herdr identity.");
          }
        }
        signal?.throwIfAborted();
        occupancy.assertCoordinator();
        return splitPane(target.id, way, [], cwd);
      };
      try {
        const inLead = panes.filter((p) => p.tabId === lead.tabId);
        if (
          !lead.zoomed &&
          config.leadTabMemberLimit > 0 &&
          inLead.length === 1 &&
          lead.cols >= 2 * config.poolMinCols + 1 &&
          lead.rows >= config.poolMinRows
        ) {
          pane = await split(lead, "right");
        } else if (!lead.zoomed && config.leadTabMemberLimit > 1 && inLead.length === 2) {
          const first = inLead.find((p) => p.id !== lead.id)!;
          if (
            owned.has(first.id) &&
            first.x > lead.x &&
            first.y === lead.y &&
            first.rows === lead.rows &&
            first.cols >= config.poolMinCols &&
            first.rows >= 2 * config.poolMinRows + 1
          ) {
            pane = await split(first, "down");
          }
        }
        for (const group of safePools) {
          if (pane) {
            break;
          }
          const root = group.find((p) => roots.has(p.id));
          if (root) {
            const current = await snapshot();
            const now = current.panes.filter((p) => p.tabId === root.tabId);
            if (
              JSON.stringify(now) !== JSON.stringify(group) ||
              group.some((p) => owned.has(p.id) && current.owned.get(p.id) !== owned.get(p.id)) ||
              !(await rootIsUnassigned(root))
            ) {
              throw new Error("Crew pane ownership conflicts with current Herdr identity.");
            }
            pane = root;
            pool = true;
          }
        }
        for (const group of safePools) {
          if (pane) {
            break;
          }
          if (group.length >= config.poolPaneLimit) {
            continue;
          }
          for (const target of group) {
            const way = direction(target);
            if (!way) {
              continue;
            }
            pane = await split(target, way);
            pool = true;
            break;
          }
        }
        if (!pane) {
          const labels = new Set((await listPanes(workspaceId)).map((p) => p.tabTitle));
          let label = "pool";
          for (let n = 2; labels.has(label); n++) {
            label = `pool-${n}`;
          }
          signal?.throwIfAborted();
          occupancy.assertCoordinator();
          pane = await createTab(workspaceId, label, [], cwd);
          pool = true;
          signal?.throwIfAborted();
          occupancy.assertCoordinator();
          await markPane(pane.id, {
            "crew-pool": pane.tabId,
            "crew-terminal": pane.terminalId,
            "crew-root": pane.terminalId,
            "crew-assigned": "no",
          });
        }
        if (pool && !fits(pane)) {
          throw new Error("No safe Crew pane destination is available.");
        }
        signal?.throwIfAborted();
        occupancy.assertCoordinator();
        await renamePane(pane.id, title);
        signal?.throwIfAborted();
        occupancy.assertCoordinator();
        await markPane(pane.id, {
          "crew-assigned": "yes",
          "crew-terminal": pane.terminalId,
          ...(pool ? { "crew-pool": pane.tabId } : {}),
        });

        const placement = { title, pane };
        let verified = false;
        await start(placement, async () => {
          signal?.throwIfAborted();
          occupancy.assertCoordinator();
          const current = (await listPanes(workspaceId)).find(
            (p) => p.terminalId === placement.pane.terminalId,
          );
          if (
            !current ||
            current.id !== placement.pane.id ||
            current.tabId !== placement.pane.tabId
          ) {
            throw new Error("Crew pane moved or closed during startup.");
          }
          placement.pane = current;
          verified = true;
        });
        if (!verified) {
          throw new Error("The launcher did not verify pane topology before releasing work.");
        }
        // Retain idle pool roots. No nonempty tab is ever closed by allocation.
        signal?.throwIfAborted();
        return placement;
      } catch (error) {
        throw new Error(
          `Crew start failed in pane ${pane?.id ?? "unknown"} (tab ${pane?.tabId ?? "unknown"}, title ${title}); any created pane was left untouched for recovery. ${String(error)}`,
          { cause: error },
        );
      }
    },
    signal,
  );
}