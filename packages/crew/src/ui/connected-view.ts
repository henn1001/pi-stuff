import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { CrewContext } from "../runtime/context.ts";
import { spawnFromMenu } from "../commands/enable.ts";
import { focusPane, listPanes } from "../transport/herdr.ts";
import { agentListing, type ListedAgent, type ListedLaunch } from "../runtime/listing.ts";
import { assertSpawnPolicy } from "../runtime/policy.ts";

/** Human-only display enrichment of the exact public listing rows; keys are not routing aliases. */
type ConnectedRow = (ListedAgent | ListedLaunch) & {
  key: string;
  title?: string;
  origin?: string;
  paneId?: string;
};

/** Uses only the shared poller; observation callbacks never initiate another discovery pass. */
export async function showConnectedAgents(
  ctx: ExtensionCommandContext,
  crew: CrewContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    throw new Error("Connected agents requires TUI mode");
  }

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      let rows: ConnectedRow[] = [];
      const epoch = crew.epoch;
      let selected = 0;
      let horizontal = 0;
      let closed = false;
      let revision = 0;
      let status = "";

      const update = async () => {
        const version = ++revision;
        try {
          const panes = await listPanes(process.env.HERDR_WORKSPACE_ID!);
          if (closed || version !== revision || crew.epoch !== epoch) {
            return;
          }
          const next = agentListing(crew).agents.map((row, index): ConnectedRow => {
            if (row.entry_kind === "launch") {
              return { ...row, key: `launch:${row.task_name}:${index}` };
            }
            const live =
              row.connectivity === "connected"
                ? crew.connections?.agents.find((agent) => agent.sessionId === row.agent_id)
                : undefined;
            const matches = panes.filter(
              (pane) =>
                live &&
                pane.agent === "pi" &&
                pane.agentSession?.agent === "pi" &&
                ((pane.agentSession.kind === "id" && pane.agentSession.value === row.agent_id) ||
                  (pane.agentSession.kind === "path" &&
                    pane.agentSession.value === live.sessionFile)),
            );
            const pane = matches.length === 1 ? matches[0] : undefined;
            const role = crew.ledger!.role(row.agent_id);
            return {
              ...row,
              key: row.agent_id,
              title: pane?.title || row.agent_type || "lead",
              origin: role?.kind === "member" ? role.origin : undefined,
              paneId: pane?.id,
            };
          });
          const key = rows[selected]?.key;
          const index = next.findIndex((row) => row.key === key);
          selected = index >= 0 ? index : Math.max(0, Math.min(selected, next.length - 1));
          rows = next;
          status = "";
          tui.requestRender();
        } catch (error) {
          if (!closed && version === revision && crew.epoch === epoch) {
            status = String(error);
            tui.requestRender();
          }
        }
      };
      const close = () => {
        if (!closed) {
          dispose();
          done();
        }
      };

      const dispose = () => {
        closed = true;
        crew.connectionObservers.delete(observe);
        crew.closeViews.delete(close);
      };

      const observe = () => {
        void update();
      };

      crew.connectionObservers.add(observe);
      crew.closeViews.add(close);

      void crew.poller!.refresh().catch((error) => {
        if (!closed) {
          status = String(error);
          tui.requestRender();
        }
      });

      observe();
      return {
        dispose,
        invalidate() {},
        render(width: number) {
          const height = Math.max(0, tui.terminal.rows - 3);
          const lines = [
            truncateToWidth(
              theme.fg(
                "accent",
                `Crew · ${rows.filter((row) => row.connectivity === "connected").length} connected · workspace ${process.env.HERDR_WORKSPACE_ID}`,
              ),
              width,
            ),
          ];

          // Horizontal scrolling exposes full IDs/fields even on terminals too narrow for one ID.
          const rowLines = rows.map((row, i) =>
            row.entry_kind === "launch"
              ? [
                  `${i === selected ? "▸" : " "} LAUNCH ${row.task_name} · DEFINITION ${row.agent_type} · STATE ${row.launch_state}`,
                  `  ERROR ${row.launch_error ? `${row.launch_error.code}: ${row.launch_error.message}` : "—"}`,
                ]
              : [
                  `${i === selected ? "▸" : " "} AGENT ID ${row.agent_id}`,
                  `  TITLE ${row.title} · DEFINITION ${row.agent_type ?? "—"} · TASK ${row.task_name ?? "—"} · ACTIVITY ${row.activity} · RELATIONSHIP ${row.relationship} · CONNECTIVITY ${row.connectivity} · PROCESS ${row.process_state} · RESUMABILITY ${row.resumability} · ASSIGNMENT ${row.assignment_state} · CHILD WORK ${row.outstanding_child_assignments} · UNPROCESSED OUTCOMES ${row.unprocessed_child_outcomes} · ORIGIN ${row.origin ?? "—"} · PANE ${row.paneId ?? "—"}`,
                ],
          );

          const maxWidth = Math.max(width, ...rowLines.flat().map((line) => visibleWidth(line)));
          horizontal = Math.min(horizontal, Math.max(0, maxWidth - width));

          const offset = rowLines.slice(0, selected).reduce((n, row) => n + row.length, 0);
          lines.push(
            ...rowLines
              .flat()
              .slice(
                Math.max(0, offset - Math.floor(height / 3)),
                Math.max(0, offset - Math.floor(height / 3)) + height,
              )
              .map((line) => sliceByColumn(line, horizontal, width)),
          );

          if (!rows.length) {
            lines.push("No permitted neighbors.");
          }

          lines.push(status, "↑↓ select · ←→ scroll · enter focus pane · esc back");

          // Keep the footer anchored at the bottom of the terminal.
          while (lines.length < tui.terminal.rows) {
            lines.splice(lines.length - 2, 0, "");
          }

          return lines
            .slice(0, tui.terminal.rows)
            .map((line) => truncateToWidth(line, width, "...", true));
        },
        handleInput(data: string) {
          if (closed) {
            return;
          }

          if (matchesKey(data, "escape")) {
            close();
            return;
          }

          if (matchesKey(data, "left")) {
            horizontal = Math.max(0, horizontal - 8);
          } else if (matchesKey(data, "right")) {
            horizontal += 8;
          } else if (matchesKey(data, "up")) {
            selected = Math.max(0, selected - 1);
          } else if (matchesKey(data, "down")) {
            selected = Math.min(Math.max(0, rows.length - 1), selected + 1);
          } else if (matchesKey(data, "enter") && rows[selected]?.paneId) {
            const id = rows[selected].agent_id;
            void (async () => {
              try {
                const live = (await crew.poller!.refresh()).agents.find(
                  (agent) => agent.sessionId === id,
                );

                if (closed) {
                  return;
                }
                const panes = await listPanes(process.env.HERDR_WORKSPACE_ID!);
                if (closed || crew.epoch !== epoch) {
                  return;
                }
                const permitted = agentListing(crew).agents.some(
                  (row) =>
                    row.entry_kind === "agent" &&
                    row.agent_id === id &&
                    row.connectivity === "connected" &&
                    row.process_state !== "exited",
                );
                const matches = panes.filter(
                  (pane) =>
                    live &&
                    pane.agent === "pi" &&
                    pane.agentSession?.agent === "pi" &&
                    ((pane.agentSession.kind === "id" && pane.agentSession.value === id) ||
                      (pane.agentSession.kind === "path" &&
                        pane.agentSession.value === live.sessionFile)),
                );
                if (!permitted || matches.length !== 1) {
                  throw new Error("Selected pane is no longer connected.");
                }
                await focusPane(matches[0].id);
              } catch (error) {
                if (!closed) {
                  status = `Cannot focus: ${error}`;
                  tui.requestRender();
                }
              }
            })();
          }

          void crew.poller!.refresh().catch((error) => {
            if (!closed) {
              status = String(error);
              tui.requestRender();
            }
          });
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
    },
  );
}

/** Lead-only picker includes definitions hidden from model invocation and launches without tasks. */
export async function showSpawnPicker(
  ctx: ExtensionCommandContext,
  crew: CrewContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    throw new Error("Spawn picker requires TUI mode");
  }

  const role = crew.state.role;

  assertSpawnPolicy(crew);
  if (role.kind !== "lead") {
    throw new Error("Spawning is disabled by definition, attachment or tree depth.");
  }

  const definitions = [...crew.definitions.values()];

  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const input = new Input({ prompt: "Filter: " });
    let selected = 0;
    let top = 0;
    let pending = 0;
    let closed = false;
    const filtered = () =>
      definitions.filter((def) =>
        `${def.name} ${def.description ?? ""}`
          .toLowerCase()
          .includes(input.getValue().toLowerCase()),
      );

    const dispose = () => {
      closed = true;
      crew.closeViews.delete(close);
    };

    const close = () => {
      if (!closed) {
        dispose();
        done();
      }
    };

    crew.closeViews.add(close);

    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      dispose,
      invalidate() {
        input.invalidate();
      },
      render(width: number) {
        const items = filtered();
        const height = Math.max(1, Math.min(15, tui.terminal.rows - 5));

        if (selected < top) {
          top = selected;
        }

        if (selected >= top + height) {
          top = selected - height + 1;
        }

        return [
          theme.fg("accent", `Spawn agent · ${pending} launching`),
          ...input.render(width),
          ...items
            .slice(top, top + height)
            .map(
              (def, i) =>
                `${i + top === selected ? "▸" : " "} ${def.name} — ${def.description ?? ""}`,
            ),
          "↑↓ select · enter spawn (duplicates allowed) · esc back",
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (closed) {
          return;
        }

        if (matchesKey(data, "escape")) {
          close();
          return;
        }

        const items = filtered();
        if (matchesKey(data, "up")) {
          selected = Math.max(0, selected - 1);
        } else if (matchesKey(data, "down")) {
          selected = Math.min(Math.max(0, items.length - 1), selected + 1);
        } else if (matchesKey(data, "enter")) {
          const name = items[selected]?.name;
          if (name) {
            // Every Enter captures its selection immediately. Shared allocation serializes launches;
            // closing this view never cancels accepted launches or their record persistence.
            pending++;
            void spawnFromMenu(crew, name)
              .catch((error) => {
                ctx.ui.notify(
                  `Cannot spawn: ${error instanceof Error ? error.message : error}`,
                  "error",
                );
              })
              .finally(() => {
                pending--;
                if (!closed) {
                  tui.requestRender();
                }
              });
          }
        } else {
          input.handleInput(data);
          selected = 0;
          top = 0;
        }

        tui.requestRender();
      },
    };
  });
}