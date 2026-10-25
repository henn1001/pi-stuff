# Crew tool rules

Status: Accepted.

## Glossary

- **Crew tools**: `spawn_agent`, `send_message`, `report_task`, and `list_agents`.
- **Agent ID**: Crew's canonical public identity: the full Pi session ID, stable across closure, resumption, and follow-up assignments. Distinct from process, pane, and assignment IDs.
- **Task name**: A parent-local name chosen by the spawner to describe a child's work, such as `refactoring_xyz`. An alias for the child's agent ID, distinct from its definition and assignment ID.
- **Direct child**: An agent whose recorded parent is the caller.

## Goal

Define Crew's tool arguments, results, effects, and model-facing usage metadata. Retain Codex tool and argument names where behavior overlaps; omit unsupported tools and arguments rather than renaming them.

## Rules

### Model-facing tool metadata

- Use the native tool definition fields for model-facing guidance: `description` for the operation and its important effects, `promptSnippet` for a concise Available tools entry, `promptGuidelines` for tool-specific usage guidance, and TypeBox/JSON Schema field descriptions for argument meaning and constraints.
- Keep guidance specific to the tool's current contract. Preserve useful usage guidance when tools or schemas are renamed, split, or replaced; revise it when behavior changes rather than dropping it because the API changed.
- Pi shows `promptGuidelines` while the tool is active. Tool metadata and schema descriptions explain the available invocation; they do not grant permissions or change effects, and they never replace handler validation.
- Keep usage guidance in these native tool fields; do not duplicate it through a generic Crew-wide system prompt, hidden context, or synthetic messages. Model-context boundaries and tool visibility follow [session interaction rules](session-interaction-rules.md) and [tool activation rules](tool-activation-rules.md).

### Common contract

- Accept only documented arguments. All arguments are strings; reject empty or whitespace-only text. Preserve validated message text unchanged.
- Use `agent_id` in public schemas and agent-ID terminology in results and the UI. Use Pi session IDs directly, with no separate Crew ID or ID mapping. `target` accepts an agent ID or task name.
- Handlers validate permissions and persist requests. Only the lead-hosted coordinator issues Crew's Herdr launch, resume, prompt, and automatic close commands for the tree; see [coordination rules](coordination-rules.md).
- `accepted: true` acknowledges durable persistence of a validated message or report, even while the lead or parent is absent. It does not imply delivery, settlement, or an answer. No separate queue status is required; see [communication rules](communication-rules.md#delivery-and-unavailable-agents).
- Return the JSON result defined for each tool. Do not expose internal request IDs, assignment IDs, transport records, or recovery records. `list_agents` exposes only the launch summary defined below.
- Failures return `{ "error": { "code": string, "message": string } }`, marked as tool errors. Describe the operation and cause in `message`; callers use `code` rather than parsing text. Never silently replace an agent or redirect input.
- Failure does not establish that retrying is safe. Execution uncertainty takes precedence over a known-failure code. Later execution failures are recorded durably without replacing the acknowledgement, injecting conversation messages, or starting turns; see [execution recovery](coordination-rules.md#delivery-and-execution-recovery). Launch outcomes are inspectable through `list_agents`; this contract provides no operation-history API for later `send_message` or `report_task` failures.
- Tool results, errors, and delivery must obey [Crew session interaction rules](session-interaction-rules.md); internal outcomes do not authorize additional session input or execution.
- Visibility follows [tool activation rules](tool-activation-rules.md); lifecycle and assignment settlement follow [lifecycle rules](lifecycle-rules.md).

### Submission identity and retries

- No public idempotency key is accepted. Each invocation creates a new request, even with identical arguments. Recovery or retry of an existing durable record retains its identity under [coordination rules](coordination-rules.md#durable-submission-and-local-writes).
- A lost result does not establish failure. Repeating `send_message` or `report_task` may duplicate input or outcomes; assignment checks do not deduplicate caller invocations.
- Never automatically repeat a spawn after a lost result or uncertain launch. Reserve its task name until reconciliation establishes the outcome. Release it after confirmed failure only if no child was recorded; recorded children retain their names permanently.
- A duplicate-name error does not prove launch success. Inspect the agent and launch rows in [`list_agents`](#list_agents); a launch row is not a completed child. Follow [execution recovery](coordination-rules.md#delivery-and-execution-recovery).

### Task names and target resolution

- Task names match `[a-z][a-z0-9_-]{0,63}`: 1–64 ASCII characters, case-sensitive, with surrounding whitespace rejected rather than trimmed. Reject names matching Pi's full session-ID syntax.
- Names are unique among a parent's recorded children in the workspace, including closed or resumable children. Enforce this in SQL on workspace, parent session ID, and task name; duplicates fail explicitly. Different parents may reuse names.
- The name-to-agent-ID mapping survives closure, resumption, and follow-up assignments.
- Resolve agent-ID-shaped targets as full agent IDs, subject to relationship and permission checks; no prefixes or fallback to name lookup. Other targets must satisfy task-name syntax and resolve only among the caller's direct children. Do not search ancestors or interpret paths. Messaging the parent requires its agent ID.

### `spawn_agent`

Creates a direct child with an initial assignment.

| Argument     | Required | Meaning                                    |
| ------------ | -------- | ------------------------------------------ |
| `task_name`  | Yes      | Child's name, retained across assignments. |
| `message`    | Yes      | Initial instructions.                      |
| `agent_type` | Yes      | Crew definition name.                      |

- Apply the selected definition and [delegation restrictions](lifecycle-rules.md#delegation-and-spawn-permission).
- Reject `disable-model-invocation: true` definitions even when explicitly named. Only the lead's menu may spawn them; see [frontmatter rules](agent-frontmatter-rules.md#menu-spawned-agents).
- Failed starts create no outstanding assignment. Pending or uncertain launches are not completed starts.
- Submit a durable request and wait asynchronously for the coordinator's recorded launch result under the [spawn request/reply rules](coordination-rules.md#synchronous-spawn-requestreply). An implementation-defined timeout bounds the wait; it does not cancel the request or release the task name. Results return only through the waiting tool call. After timeout or caller disconnection, the eventual outcome is recorded without a conversation message or turn activation and is inspectable through [`list_agents`](#list_agents).

#### Output

`{ "agent_id": string, "task_name": string }`

Return only after successful launch and SQL recording; persistence of the request alone is insufficient.

#### Errors

| Code                  | Meaning                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `invalid_arguments`   | Missing, unknown, mistyped, or invalid arguments.                               |
| `permission_denied`   | Relationship, role, depth, or definition disallows spawning.                    |
| `duplicate_task_name` | A recorded child or pending/uncertain launch holds the name.                    |
| `unknown_agent_type`  | Definition absent from the current catalog.                                     |
| `precondition_failed` | Attachment, lifecycle, assignment, or completion-protection requirements unmet. |
| `persistence_failed`  | Operation or outcome could not be durably recorded.                             |
| `launch_failed`       | Initial launch is known to have failed.                                         |
| `timeout`             | Waiting for the coordinator's result expired; the request may still complete.   |
| `outcome_unknown`     | Execution may have occurred; its outcome cannot be established.                 |

A launch followed by a failed SQL update is `outcome_unknown`, not `launch_failed`.

### `send_message`

Sends input to a parent or direct child, with or without an outstanding assignment.

| Argument  | Required | Meaning                                                       |
| --------- | -------- | ------------------------------------------------------------- |
| `target`  | Yes      | Parent's agent ID, or a direct child's agent ID or task name. |
| `message` | Yes      | Message text.                                                 |

- Delivery starts an idle recipient's turn or steers a running turn under [communication rules](communication-rules.md#turn-activation).
- Downward messages supplement outstanding work or start a new assignment after settlement—even acknowledgements. They may resume eligible closed children through the coordinator.
- Upward messages create no assignment. A disconnected parent's input waits for that recorded parent to reconnect; children cannot reopen parents.
- Messages never settle work, even if they contain results or declare completion. Calling this tool does not suppress automatic reporting or exit.
- Input accepted before automatic-completion authorization continues the current assignment. Input accepted during authorized completion stays queued until settlement, then starts a new assignment and waits for the previous instance to exit before resumption; see [completion ordering](coordination-rules.md#completion-and-input-ordering).
- Lead absence delays delivery, not acknowledgement. No recipient is prompted without the coordinator.

#### Output

`{ "accepted": true, "agent_id": string }`

`agent_id` is the resolved recipient. Delivery and any reply occur separately.

#### Errors

| Code                  | Meaning                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `invalid_arguments`   | Missing, unknown, mistyped, or invalid arguments.                               |
| `unknown_target`      | No recorded agent matches the target.                                           |
| `permission_denied`   | Relationship, role, depth, or definition disallows the operation.               |
| `precondition_failed` | Attachment, lifecycle, assignment, or completion-protection requirements unmet. |
| `persistence_failed`  | Operation or outcome could not be durably recorded.                             |

Later execution failures are recorded durably, not returned through the completed tool call or delivered as messages:

| Code               | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `cannot_resume`    | Recorded definition or saved session missing or unreadable.     |
| `execution_failed` | Command is known to have failed.                                |
| `outcome_unknown`  | Execution may have occurred; its outcome cannot be established. |

### `report_task`

Submits an interactive agent's result, question, or blocked outcome to its recorded parent. Uses the same coordinator settlement path as automatic non-interactive completion, but keeps the reporting session open.

| Argument  | Required | Meaning                               |
| --------- | -------- | ------------------------------------- |
| `message` | Yes      | Result, question, or blocked outcome. |

- Require attachment, interactive mode (including after disruption), an outstanding parent assignment, and no outstanding child assignments or unprocessed child outcomes. The assignment requirement also applies to retained-report retries.
- Reject non-interactive calls without submitting, settling, or suppressing automatic completion. Non-interactive agents finish with assistant text under [automatic completion rules](lifecycle-rules.md#automatic-completion-eligibility-and-result-selection).
- Settle only when the parent receives the report and Crew durably records it; Herdr command acceptance is insufficient. Plain assistant text and `send_message` cannot replace interactive reporting.
- Keep automatic exit disabled after disruption. Only automatic non-interactive completion closes the agent after settlement.
- Pending reports continue automatically when the coordinator or parent reconnects. Command failures and uncertain outcomes follow [execution recovery](coordination-rules.md#delivery-and-execution-recovery).

#### Output

`{ "accepted": true, "agent_id": string }`

`agent_id` is the recorded parent. Return without waiting for parent receipt, settlement, or a response.

#### Errors

| Code                  | Meaning                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `invalid_arguments`   | Missing, unknown, mistyped, or invalid arguments.                               |
| `permission_denied`   | Relationship, role, depth, or definition disallows the operation.               |
| `precondition_failed` | Attachment, lifecycle, assignment, or completion-protection requirements unmet. |
| `persistence_failed`  | Operation or outcome could not be durably recorded.                             |

Later execution failures are recorded durably, not returned through the completed tool call or delivered as messages:

| Code               | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `execution_failed` | Command is known to have failed.                                |
| `outcome_unknown`  | Execution may have occurred; its outcome cannot be established. |

### `list_agents`

Takes no arguments. Lists the caller's recorded parent, all direct children, and the caller's pending, in-progress, uncertain, and failed launch requests in the workspace. Includes disconnected parents and closed, unavailable, or unnamed menu-spawned children. Excludes self, siblings, grandchildren, unrelated agents, and other callers' launch requests. Leads have no parent row.

#### Output

`{ "agents": (Agent | Launch)[] }`

Return agent rows first: parent, then children in ascending lexical `agent_id` order. Append launch rows ordered by `task_name`, then durable submission order for repeated names. Return `{ "agents": [] }` when empty. All fields are required; use `null` only where specified.

Agent rows:

| Field                           | Type / values                       | Meaning                                                                                                                                                                              |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `entry_kind`                    | `agent`                             | Recorded agent row.                                                                                                                                                                  |
| `launch_state`                  | `null`                              | Launch details appear only on launch rows.                                                                                                                                           |
| `launch_error`                  | `null`                              | Launch details appear only on launch rows.                                                                                                                                           |
| `agent_id`                      | string                              | Full agent ID.                                                                                                                                                                       |
| `task_name`                     | string or `null`                    | Recorded name, or `null` if unassigned. A parent's name belongs to its parent's namespace and is not a usable alias for the caller.                                                  |
| `agent_type`                    | string or `null`                    | Recorded definition; `null` for a lead or attached agent without one.                                                                                                                |
| `relationship`                  | `parent`, `child`                   | Relationship to caller.                                                                                                                                                              |
| `activity`                      | `running`, `idle`, `unknown`        | Latest turn activity; `unknown` when not established, including after confirmed exit.                                                                                                |
| `connectivity`                  | `connected`, `unreachable`          | Latest adapter observation, subject to coordination identity checks.                                                                                                                 |
| `process_state`                 | `alive`, `exited`, `unknown`        | Latest exact-instance observation. Disconnection does not prove exit.                                                                                                                |
| `resumability`                  | `eligible`, `ineligible`, `unknown` | Caller may resume the agent. Parents are always `ineligible`; children require confirmed exit and successful definition and saved-session checks. Unresolved checks yield `unknown`. |
| `assignment_state`              | `none`, `outstanding`, `settled`    | Assignment on the caller–agent relationship; `none` means none created. Parent rows describe the caller's assignment from that parent.                                               |
| `outstanding_child_assignments` | non-negative integer                | Outstanding assignments this agent delegated to its direct children.                                                                                                                 |
| `unprocessed_child_outcomes`    | non-negative integer                | Delivered child outcomes this agent has not processed under the lifecycle rules.                                                                                                     |

Launch rows:

| Field                                                                           | Type / values                                     | Meaning                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry_kind`                                                                    | `launch`                                          | Durable launch request, not a recorded agent.                                                                                                                                            |
| `agent_id`                                                                      | `null`                                            | No successfully recorded child yet.                                                                                                                                                      |
| `task_name`                                                                     | string                                            | Requested task name; reserved while pending, in progress, or uncertain. A failed launch no longer reserves it if no child was recorded.                                                  |
| `agent_type`                                                                    | string                                            | Requested definition.                                                                                                                                                                    |
| `launch_state`                                                                  | `pending`, `in_progress`, `uncertain`, `failed`   | Awaiting execution, command in progress, outcome unknown, or confirmed failure.                                                                                                          |
| `launch_error`                                                                  | `{ "code": string, "message": string }` or `null` | Recorded launch error and cause under the `spawn_agent` error contract; `null` when no error is recorded. A wait timeout alone does not change launch state or establish a launch error. |
| `relationship`                                                                  | `null`                                            | No recorded parent–child relationship yet; visible only to the submitting caller.                                                                                                        |
| `activity`, `connectivity`, `process_state`, `resumability`, `assignment_state` | `null`                                            | No agent observations or assignment state are inferred from a launch request.                                                                                                            |
| `outstanding_child_assignments`, `unprocessed_child_outcomes`                   | `null`                                            | No agent counts exist for a launch request.                                                                                                                                              |

- Retain failed launch rows even after releasing their task names; a new request with the same name is a separate row. Successful child/result recording atomically replaces that request's launch row with its agent row, without duplicate entries for the same launch.
- Launch rows create no outstanding assignment, do not contribute to assignment counts, and cannot be messaged, resumed, or focused. A reserved task name is not a messaging target until a child is successfully recorded.
- Assignment fields and counts use durable records. Counts explain completion protection without exposing inaccessible descendants or their identities. Idle does not mean settled; zero counts do not satisfy the other [completion gates](lifecycle-rules.md#automatic-completion-eligibility-and-result-selection).
- Resumability describes recipient eligibility, not coordinator availability. Eligible children may still await coordinator recovery or prior assignment settlement.
- Listing is read-only: it starts no turns, resumes no agents, settles no assignments, and changes no permissions. Results are a snapshot of durable records and latest observations, not a guarantee that later operations will succeed.

#### Errors

| Code                 | Meaning                                                    |
| -------------------- | ---------------------------------------------------------- |
| `invalid_arguments`  | Arguments supplied; none accepted.                         |
| `permission_denied`  | Caller may not use Crew tools.                             |
| `persistence_failed` | Durable records needed for the snapshot could not be read. |

### Tools outside this contract

- `send_message` also handles follow-up instructions; `followup_task` is omitted.
- No explicit completion-and-close tool: interactive agents report and stay open; non-interactive agents complete automatically.
- Assignment reports are delivered automatically. Internal operation results and failures do not create another messaging channel; see [communication rules](communication-rules.md#delivery-and-unavailable-agents). Non-interactive clarification uses report-and-resume in this iteration.
- Cross-tree control tools are unsupported.