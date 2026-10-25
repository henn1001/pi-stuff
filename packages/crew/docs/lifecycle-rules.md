# Crew lifecycle rules

Status: Accepted.

## Glossary

- **Interactive agent**: Reports assigned work explicitly and stays open until the user closes it.
- **Non-interactive agent**: Spawned through `spawn_agent` with `auto-exit: true`; automatically reports its final result and exits unless disrupted.
- **Parent / child**: A direct delegation relationship. Reports go up to the parent; prompts and resumptions go down to children.
- **Assignment**: Work delegated to a direct child. Each child has at most one outstanding assignment from its parent.
- **Settled assignment**: The parent has received a report or unexpected-exit notice and Crew has durably recorded the outcome. Questions and blocked outcomes also settle assignments.
- **Run**: A non-interactive agent's execution from an initial prompt or follow-up through automatic reporting and exit, unless disrupted.
- **Disruption**: Runtime-confirmed abortion of an executing turn, regardless of source while Pi cannot distinguish human interruption from programmatic abortion. Additional instructions alone are not disruption.
- **Pane lifetime**: The period during which an agent’s pane remains open.

## Goal

Define lifecycle modes, automatic completion, disruption, assignment settlement, and resumption. Message semantics follow [Crew communication rules](communication-rules.md); persistence, ordering, and recovery follow [Crew coordination rules](coordination-rules.md). Report and unexpected-exit delivery must obey [Crew session interaction rules](session-interaction-rules.md).

## Rules

### Lifecycle mode

- Independently started agents and agents with `auto-exit: false` are interactive.
- Agents spawned through `spawn_agent` with `auto-exit: true` start non-interactive. Menu-spawned agents are always interactive under [Crew agent frontmatter rules](agent-frontmatter-rules.md#menu-spawned-agents).
- Disruption makes a non-interactive agent interactive for the rest of its pane’s lifetime. A new pane lifetime reapplies the definition’s lifecycle setting.
- Lead or parent unavailability and report delivery failures do not change lifecycle mode.

### Non-interactive completion

1. The agent works until finished or blocked. Its final message states the result or asks the questions it needs answered.
2. The coordinator checks [completion eligibility](#automatic-completion-eligibility-and-result-selection), delivers the result to the parent, and durably records the outcome, settling the assignment.
3. The coordinator closes the child through Herdr. The parent may resume it with feedback or answers, starting a new run under the same lifecycle rules.

The child does not independently authorize reporting or exit, and this flow does not require `send_message`.

### Automatic completion eligibility and result selection

These rules govern automatic reports. Explicit `report_task` uses its submitted message under [Crew tool rules](tool-rules.md#report_task).

- Automatic completion requires a successful [settled turn](coordination-rules.md#completion-and-input-ordering), no disruption, no pending input, and no outstanding child assignments or unprocessed child outcomes.
- A failed or aborted turn produces no automatic report or exit, even if it contains assistant text. A failed turn is one Pi marks as terminally failed; a tool error alone does not establish turn failure.
- Select only the text of the latest assistant message in the successful settled turn. Deliver it unchanged. Tool-call arguments and results are not report text.
- If that message is missing or contains only whitespace, do not report or exit. Never fall back to earlier messages or turns.
- Failed, aborted, or blank-output turns leave an open member's assignment outstanding. Failed and blank-output turns preserve lifecycle mode; assess later successful turns against the same gates. Aborted turns cause [disruption](#disruption-while-the-agent-stays-open); later success does not restore automatic completion. Process exit follows [termination and parent notification](#termination-and-parent-notification).

### Lead or parent unavailability

- During a lead outage, members may continue local work and persist messages, reports, progress, and execution events. Coordinated delivery, spawning, resumption, settlement, and automatic exit wait for the lead-hosted coordinator.
- A finished member retains its pending result and may remain idle without further model turns. This does not make it interactive.
- Coordinator recovery continues pending completion; delivery to an unavailable parent waits for that recorded parent to reconnect. Failures and uncertain execution follow [Crew coordination rules](coordination-rules.md#delivery-and-execution-recovery).
- Human input, interruption, and manual closure remain possible during an outage under the rules below.

### Non-interactive follow-up input

- Parent instructions through `send_message` and additional human instructions preserve non-interactive mode. They supplement outstanding work under [Crew communication rules](communication-rules.md#messages-and-assignments).
- Human input steers a running turn at the next supported input boundary or starts another turn if idle, including during a coordinator outage.
- Parent input follows [completion ordering](coordination-rules.md#completion-and-input-ordering): process input accepted before authorization under the current assignment; input accepted during authorized completion waits for settlement, then starts a new assignment. Failed or pending reporting leaves the current assignment unsettled.
- Record local human input acceptance and turn activation for recovery. Before automatic reporting and settlement, check whether the agent is active or has pending input. If so, skip this completion attempt without blocking the coordinator; reconsider completion on the next settled-turn event. Use the latest successful settled turn's result, even if a follow-up turn started and finished before the check.
- This check is best-effort. Human input arriving after the check may race with completion and closure; no input gating or completion handshake is required.
- Input requiring resumption waits for confirmed process exit under [Resumption](#resumption); never prompt the exiting instance.
- Child results and unexpected-exit notices are outcomes of delegated work, not additional instructions. Receiving them preserves lifecycle mode.
- Parent-initiated cancellation is out of scope.

### Disruption while the agent stays open

- Runtime-confirmed abortion disables automatic reporting and exit for the remaining pane lifetime. While Pi cannot distinguish the interruption source, this applies to both human-initiated and programmatic abortion.
- Use runtime evidence to distinguish abortion from non-aborted settlement. Raw terminal input, including `Esc`, does not establish abortion.
- Successful completion, additional instructions, UI dismissal, tool failures, and runtime errors do not by themselves cause disruption. If the runtime confirms abortion, apply the abortion rule regardless of its source.
- The agent follows [interactive reporting](#interactive-work-and-reporting) and stays open after reporting. Lead or parent recovery and completion of child assignments do not undo disruption.

### Waiting for children

- Outstanding child assignments suspend a parent's automatic completion without making it interactive or preventing follow-up input.
- Crew automatically delivers child reports and unexpected-exit notices. After all child assignments settle, the parent must process their outcomes before automatic completion; delivery of the last outcome must not immediately close it.
- A child waiting for its own children still owes its parent an outcome. A disrupted child may keep its parent waiting until it explicitly reports or exits.

### Termination and parent notification

- Any child that exits with an outstanding parent assignment produces this automatic notice to its parent: “Agent exited before returning a result. Its task may be incomplete.”
- This applies to both lifecycle modes, including disrupted children. Pane closure, exiting Pi, and crashes must be detected without relying on the child to send a final message.
- Settled work must not also produce an unexpected-exit notice. Resumption requires the parent's decision.

### Resumption

- A parent may resume a recorded direct child only after [process supervision](coordination-rules.md#connection-observation-and-process-supervision) confirms its previous instance has exited. Disconnection or unresponsiveness is insufficient.
- Reopen the saved Pi session with its existing session ID and history; do not fork again or create a replacement session.
- Resolve the recorded definition name from the current catalog and apply its updated configuration under [Crew tool activation rules](tool-activation-rules.md#member-tool-visibility).
- A missing definition or missing or unreadable saved session produces the same cannot-resume error, with no fresh-session fallback.
- If an assignment was outstanding at exit, deliver and durably record its unexpected-exit outcome before queued input starts a new assignment.
- Manual Pi resume recovers the member role, parent, root lead, definition, task name, assignment state, and pending operations by session ID. Use the current Herdr pane; do not restore the old location.
- Manual resume starts idle. Opening history alone does not start work; pending input follows [Crew communication rules](communication-rules.md#turn-activation). Cross-workspace manual resume is outside this iteration.
- The triggering input remains one durable operation. Failed or uncertain launch and input execution follow [Crew coordination rules](coordination-rules.md#delivery-and-execution-recovery).

### Interactive work and reporting

- An interactive agent may start with a prompt or wait for human or parent input, ask questions, and delegate when permitted.
- It explicitly calls `report_task` for parent-assigned work. Plain assistant text is not delivered to the parent; work requested only by a human requires no parent report.
- A report may contain a result, questions, or a blocked outcome. Submission acknowledgement is not settlement; see [assignment tracking](#assignment-tracking-and-recovery) and [Crew tool rules](tool-rules.md#report_task). There is no `final` parameter or non-final progress-report mode.
- Reject reporting before attachment, without an outstanding parent assignment, or while child assignments or unprocessed child outcomes remain.
- After reporting, the agent stays open until the user closes it. Reporting does not grant permission to prompt or resume its parent.

### Idle interactive children

- Parents may find and prompt idle interactive children, including those with outstanding child assignments. Running or idle state and child-assignment counts do not establish availability or completion; see [`list_agents`](tool-rules.md#list_agents).
- The child decides whether to handle new work, defer it, or explain that it is occupied. Accepting input does not abandon outstanding work.

### Assignment tracking and recovery

- Parents track their direct children's assignments. Further prompts supplement outstanding work; a prompt after settlement starts a new assignment, including when answering reported questions.
- An assignment settles when the parent receives an automatic report, explicit report, or unexpected-exit notice and Crew durably records the outcome. Local conversation, idle state, human instructions, and interruption do not settle it.
- Assignments and settlement survive parent restart and resume. Old or duplicate reports must not settle newer assignments.
- Crew tells the agent which assignments remain outstanding and whether they prevent automatic completion.
- Durable acknowledgement, pending reports, and retry behavior follow [Crew coordination rules](coordination-rules.md#durable-submission-and-local-writes).
- Assignment state is session-wide across conversation branches. Forks are inactive; recovery reconnects only to the same recorded parent.

### Delegation and spawn permission

Spawn eligibility follows role and tree depth, regardless of lifecycle mode. Tool visibility follows [Crew tool activation rules](tool-activation-rules.md#tool-visibility-by-role).

- The lead may spawn interactive or non-interactive definitions regardless of their `spawning` setting.
- A direct member of the lead may spawn only when its definition has `spawning: true`. This also applies to independently started members attached directly to the lead.
- Children spawned by members cannot spawn, regardless of their definitions.
- An interactive parent with spawn permission may spawn either lifecycle mode. A non-interactive parent may spawn only definitions with `auto-exit: true`. Reject spawns that violate these restrictions.
- Disruption may make an existing child interactive; its non-interactive parent then waits for an explicit report or exit notice.
- Spawn restrictions govern creation only. Prompting or resuming a recorded child is separate.