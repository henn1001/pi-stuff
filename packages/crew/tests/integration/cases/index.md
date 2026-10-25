# Crew integration cases

This catalog defines the initial behavioral cases for the real-extension integration suite. Each case maps to a focused runner scenario; the combined [`smoke` scenario](../scenarios/smoke.py) remains available as a broader end-to-end workflow. See the [integration README](../README.md) for execution, isolation, and evidence conventions.

The initial cases cover basic happy paths. Recovery, failures, permission boundaries, and race behavior are intentionally out of scope here.

| ID     | Scenario | Case                                                 | Requirement sources                                                                                                                                                                                                                                                          |
| ------ | -------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IT-001 | `it-001` | Activate Crew and open the lead menu                 | [UX: `/crew`](../../../docs/ux-rules.md#crew-command), [session interaction](../../../docs/session-interaction-rules.md)                                                                                                                                                     |
| IT-002 | `it-002` | Menu-spawn an interactive member                     | [UX: spawn view](../../../docs/ux-rules.md#spawn-agent-view), [frontmatter: menu-spawned agents](../../../docs/agent-frontmatter-rules.md#menu-spawned-agents)                                                                                                               |
| IT-003 | `it-003` | List the lead's direct child                         | [Tools: `list_agents`](../../../docs/tool-rules.md#list_agents), [session interaction](../../../docs/session-interaction-rules.md)                                                                                                                                           |
| IT-004 | `it-004` | Deliver messages in both directions                  | [Communication](../../../docs/communication-rules.md), [Tools: `send_message`](../../../docs/tool-rules.md#send_message)                                                                                                                                                     |
| IT-005 | `it-005` | Spawn a non-interactive child and receive its result | [Coordination: synchronous spawn](../../../docs/coordination-rules.md#synchronous-spawn-requestreply), [Lifecycle: non-interactive completion](../../../docs/lifecycle-rules.md#non-interactive-completion), [Tools: `spawn_agent`](../../../docs/tool-rules.md#spawn_agent) |

## IT-001 — Activate Crew and open the lead menu

**Setup:** Start an independent Pi session in a fresh Herdr workspace with Crew inactive.

**Steps:**

1. Run `/crew` once.
2. Inspect the pane, notification, model-request evidence, and visible UI.
3. Run `/crew` again and inspect the menu.

**Expected:**

- The first invocation acquires lead ownership, labels the pane `lead`, and reports `Crew enabled`; it does not open the menu.
- The lead status widget appears.
- The second invocation opens the lead menu with `Spawn agent…` and `Connected agents…`.
- Activation and menu presentation start no model turn and add no model-visible context.

## IT-002 — Menu-spawn an interactive member

**Setup:** Activate a lead and add a project agent definition with a description and `auto-exit: true`.

**Steps:**

1. Open the lead's Spawn view and select the definition.
2. Confirm the member's pane and Pi session are recognized.
3. Before sending it any input, inspect provider requests and lifecycle events.
4. Send the member a human prompt and let the deterministic provider return plain assistant text.

**Expected:**

- The picker shows the definition name and description. After spawning, it remains open with its selection; the new pane does not take focus.
- The member is recorded as a child of the lead and appears under the definition's display title.
- Menu launch starts no initial model turn, despite `auto-exit: true`.
- The later human-prompted turn does not cause an automatic report or close: menu-spawned members are interactive and stay open.

## IT-003 — List the lead's direct child

**Setup:** Use IT-002 to create one menu-spawned child.

**Steps:**

1. Have the lead call `list_agents` with no arguments.
2. Inspect the returned tool result and observer evidence for the child.

**Expected:**

- The result contains the child, identified by its full Pi session ID, with `relationship: "child"`, the definition name, and `task_name: null`.
- It contains no parent row for the lead and no launch row for the successfully recorded menu launch.
- The listing leaves assignment state unchanged and starts no turn beyond the lead turn that invoked it; it sends no message and starts no child turn.

## IT-004 — Deliver messages in both directions

**Setup:** Use a menu-spawned interactive child and deterministic lead/member provider plans.

**Steps:**

1. Have the lead call `send_message` to the child's full agent ID.
2. Wait for the child's Crew message event and its provider request; have the child call `send_message` to the lead's full agent ID.
3. Wait for the lead's Crew message event and its provider request.

**Expected:**

- Each tool call acknowledges the resolved recipient with `accepted: true`; the acknowledgement is distinct from delivery.
- Each message arrives as a Crew custom message on the exact recipient session, with its submitted text available in model context.
- The message to the idle child starts its turn; the reply is delivered to the lead without a separate notification.
- The child's reply does not settle the assignment created by the lead's downward message. The interactive child remains open.

## IT-005 — Spawn a non-interactive child and receive its result

**Setup:** Give the lead a definition with `auto-exit: true` and configure the deterministic provider to return a unique result from the child.

**Steps:**

1. Have the lead call `spawn_agent` with a valid task name, definition, and initial message.
2. Capture the tool result and the child's startup and model-context evidence.
3. Wait for the child to finish and for the lead to receive its result; have the lead call `list_agents` and inspect the child's process and assignment state.

**Expected:**

- `spawn_agent` returns the launched child's full agent ID and the submitted task name only after the launch is recorded.
- The initial message reaches the child as its assignment and starts its first turn.
- After a successful settled turn, Crew delivers the latest assistant message unchanged to the lead, records the assignment as settled, and closes the non-interactive child.
- Automatic completion does not require the child to call `send_message` or `report_task`.