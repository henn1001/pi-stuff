# Crew UX rules

Status: Accepted.

## Goal

Define the user-facing command, menu, widgets, conversation rendering, tool rendering, panes, and notifications. Opening views and refreshing status do not run model turns. The boundary between human-only presentation and model-visible input follows [Crew session interaction rules](session-interaction-rules.md).

## Rules

### `/crew` command

- `/crew` is user-only, not callable by the model.
- In an independent Pi session with inactive Crew, `/crew` attempts to acquire lead ownership. On success, it enables Crew and returns; further calls open a role-scoped Crew menu. Member sessions are already Crew-active and do not use this acquisition path.
- Start Pi with `--crew-mode lead` or `--crew-mode member` to activate Crew in that role; startup does not open a Crew menu.
- `--crew-mode lead` uses the workspace ownership rules in [Crew coordination rules](coordination-rules.md#ownership-and-hosting). `--crew-mode member` starts an active member session. Tool visibility follows [Crew tool activation rules](tool-activation-rules.md).
- If another independent Pi session holds lead ownership, `/crew` shows one error notification and opens no menu; `--crew-mode lead` reports an activation error. Both leave the session inactive.
- After ownership is released, either activation path supports [lead succession](coordination-rules.md#ownership-and-hosting). Do not instruct users to delete locks, replace the ledger, or resume the previous lead.
- A previous lead session may activate again after the current lead releases ownership. Activation must acquire fresh ownership under the linked coordination rules; resuming the conversation does not restore released authority.
- `/crew spawn` opens the Spawn view for leads only. `/crew connected` opens the Connected agents view for both leads and members. Tab completion lists actions available to the current role.
- A direct action while Crew is inactive first attempts lead acquisition; on success, it enables Crew and opens that view. Closing the view returns to the role-scoped menu.
- Without Herdr (`HERDR_ENV`, `herdr` CLI), the command shows one error notification and no menu.
- An active member session's menu contains only `Connected agents…`. `/crew spawn` is not offered to members; a direct invocation is rejected and does not open the picker. Member tool-based delegation is separate and follows [Crew lifecycle rules](lifecycle-rules.md#delegation-and-spawn-permission).

```
Lead menu
 ▸ Spawn agent…
   Connected agents…

Member menu
 ▸ Connected agents…
```

- `Esc` in a view returns to the role-scoped menu. `Esc` in a menu closes it.
- Successful lead activation renames the current pane to `lead`.
- Activation shows `Crew enabled` without starting a model turn. Persistence and role-based tool visibility follow the activation rules; this view does not define an additional branch-local activation contract.

### Spawn agent view

- The lead-only picker lists agent definitions as `name — description` and supports type-to-filter.
- Spawning does not focus the new pane. Successful spawning shows a notification such as `Spawned scout in pane wA:p3`.
- After spawning, the picker stays open and focused, preserving selection and filter. Arrow keys and repeated `Enter` support spawning multiple agents, including duplicates.
- Spawn errors also leave the picker open. `Esc` returns to the Crew menu.
- Menu launches follow [Crew agent frontmatter rules](agent-frontmatter-rules.md#menu-spawned-agents). Member tool-based delegation follows [Crew lifecycle rules](lifecycle-rules.md#delegation-and-spawn-permission).

### Connected agents view

- The view is fullscreen and read-only, apart from focusing a live pane.
- It lists the same agent and launch rows as [`list_agents`](tool-rules.md#list_agents), under the same caller and relationship visibility constraints. The view adds display and pane details but does not broaden access.
- Agent rows expose the agent ID, display title, definition, activity, origin, and pane where available. Exited rows use the definition name when no live pane title exists.
- Launch rows show task name, requested definition, launch state, and recorded error where present, including failed launches. They have no agent ID or live pane; do not display invented activity, connectivity, assignment state, or counts.
- Label identities as agent IDs, using the full Pi session ID values defined in the [tool rules](tool-rules.md#glossary). Titles are display-only and never addresses.
- Activity, connectivity, resumability, and assignment state remain distinct, as required by [Crew tool rules](tool-rules.md#list_agents). Idle does not imply settled work.
- `Enter` focuses the selected live pane through Herdr. It is disabled on exited and launch rows. The view offers no kill, restart, or send action.
- Refresh on opening, relevant connection changes, and keypress. Background updates use shared connection polling rather than a separate view timer.
- Recovery data follows the coordination and lifecycle rules, not historical branch-local spawn records.

### Lead widget

- While Crew is active, show one status-line widget above the editor: `Crew ● 2 connected` or `Crew ○ 0 connected`.
- Count every live member in the Crew tree, including nested helpers, but not the lead.
- The label is bold and accented. The dot is green when members are connected and dim when none are.
- Show the widget even at zero connections so activation remains visible.
- Refresh immediately on activation and through shared connection polling. Do not add per-agent rows or per-tool activity.

### Member widget

- Show one status-line widget: `Crew ●` or `Crew ○`.
- The dot is green when the recorded root lead is reachable and red when it is not. A nested member's immediate parent is not its coordinator; see [coordinator ownership](coordination-rules.md#ownership-and-hosting).
- Probe on startup and resume, while idle, and while the lead is absent. Refresh on lead disconnect and each send attempt as well as periodic polling.
- Loss and recovery of lead reachability update the widget without user input or a model turn.
- Both widgets show latest-observed reachability, not instantaneous process state. They must not imply that an accepted submission has been delivered or an assignment settled.
- Widgets and views consume shared observations under [Crew coordination rules](coordination-rules.md#connection-observation-and-process-supervision), including their identity checks, refresh, and disposal requirements. Polling intervals and probe timeouts are implementation-defined.

### Conversation messages

- Incoming Crew messages use custom message type `crew`, with a coloured background.
- Collapsed rendering shows the sender and approximately the first three lines. `Ctrl+O` expands the message.
- Headers show `<from> → <to>` using display labels where available, with ` · result` for reports. Unexpected-exit notices render as a one-line row.
- Expanded messages expose the sender's and recipient's full agent IDs. Labels are never addresses. Historical messages remain renderable after lead succession and retain their original sender and recipient identities.
- Messages appear only on the receiving side; the sender's tool-call row is its record.
- Delivery starts or steers turns according to [Crew communication rules](communication-rules.md#turn-activation). Rendering itself does not start another turn.
- Model-facing text is outside this promotion. Any change to its existing format requires separate approval.

### Tool call rendering

- Render calls collapsed to one line, expandable for full text.
- Use the current tool names: `spawn_agent`, `send_message`, `report_task`, and `list_agents`. Their arguments and effects follow [Crew tool rules](tool-rules.md).
- Show the definition and a prompt preview for spawning, the target and a message preview for messaging, and a report preview for reporting.
- Expose full agent IDs in expanded details and launch results. Display labels and task names must not obscure the resolved identity.
- Presentation must distinguish successful launch from durable message or report submission. Acknowledgement is not delivery or settlement; see [submission acceptance](coordination-rules.md#durable-submission-and-local-writes).
- Result fields follow the [per-tool result contracts](tool-rules.md#spawn_agent). This document does not introduce replacement model-facing result strings.

### Panes

- Create panes without taking focus.
- Derive pane titles from the agent definition's display label, adding `-2`, `-3`, and so on for duplicates (for example, `worker`, `worker-2`). Titles are not routing keys.
- Add at most two member panes to the lead tab: place the first to the right of the lead, then split the first member pane downward for the second. Allocate further members in this order: reuse an unassigned root in an existing pool, split a safe existing pool, then create a new pool tab.
- Reuse a root only when current Herdr state identifies it as unassigned and no unrelated pane occupies it.
- Each pool tab holds at most four panes. Name pool tabs `pool`, `pool-2`, and so on, skipping names already in use.
- Pool panes default to a minimum of 48 columns by 10 rows. Split a pool only when each resulting pane meets both minimums, including the separator: 97 columns for a horizontal split or 21 rows for a vertical split.
- For each allocation, derive live pane identity, location, tab membership, zoom state, and dimensions from Herdr's current `pane list` and `layout`. Persisted layout is not authoritative. A pane is usable only when it maps to one live Crew session or Herdr identifies it as an unassigned pool root; treat unmatched panes and conflicting Crew-to-Herdr ownership records as unrelated.
- Never split a zoomed pool, a pool containing an unrelated pane, or a full pool. Skip unsafe pools and continue the allocation order. If no safe existing destination remains, create a new pool; if Herdr cannot create it, fail without changing unrelated panes or tabs.
- A member pane moved manually remains at its current Herdr location; do not move it back to a previous slot or pool. A closed pane is absent from allocation, regardless of stale pane records. Close a pool tab only when current Herdr layout confirms that no panes remain; retain an unassigned root for reuse.
- The lead-tab pane limit, pool pane limit, and pool minimum dimensions are defaults and must be configurable through a JSON file under Crew's [runtime storage directory](coordination-rules.md#runtime-storage).
- Herdr pane IDs serve layout and focus operations and may change on resume. Manual pane closure and its assignment outcome follow [Crew lifecycle rules](lifecycle-rules.md#termination-and-parent-notification).
- Resumption follows the recorded parent relationship and [Crew coordination rules](coordination-rules.md#delivery-and-execution-recovery).

### Notifications

- Show notifications only for user-initiated actions and errors, such as `Crew enabled`, `Spawned …`, and `Cannot spawn: …`.
- Agent-to-agent traffic does not raise notifications; it appears in the conversation.