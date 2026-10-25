# Crew communication rules

Status: Accepted.

## Glossary

- **Message**: Input sent between agents. A parent-to-child message starts or supplements an assignment; a child-to-parent message does not create or settle one.
- **Prompt**: A parent-to-child message delivered through `send_message`.
- **Report**: A result, question, or blocked outcome that settles an assignment when the parent receives it.
- **Submission acceptance**: Crew has durably persisted a validated message or report. An acknowledgement confirms acceptance, not delivery, processing, an answer, or assignment settlement.
- **Delivery**: The coordinator has successfully submitted input through Herdr and recorded that success.

Interactive and non-interactive agents, assignments, and disruption are defined in [Crew lifecycle rules](lifecycle-rules.md). Delivery mechanisms, persistence, completion ordering, and recovery are defined in [Crew coordination rules](coordination-rules.md).

## Goal

Allow agents to exchange information during and between assignments. Allow parents to update running children without changing their lifecycle mode. Session input and turn activation are limited to the [session interaction allowlist](session-interaction-rules.md).

## Rules

### Messages and assignments

- An attached member may message its parent without an outstanding assignment.
- A parent may message a direct child with or without an outstanding assignment, including resuming an eligible closed child.
- A parent-to-child message supplements the outstanding assignment or starts a new one after settlement. This applies to all downward messages, including acknowledgements.
- A child-to-parent message does not create or settle an assignment. Messages in either direction do not settle or abandon outstanding work.
- Progress updates, warnings, and clarification questions may be sent as messages.
- A report containing questions or a blocked outcome still settles the assignment. A clarification message leaves it outstanding.
- The recipient's ordinary assistant response is local text. Sending an answer to another agent requires a message or report.

### Turn activation

- Delivering a message to an idle, connected recipient starts a turn.
- Delivering a message to a running recipient steers its current turn at the next supported input boundary.
- Message delivery does not interrupt an executing tool call.
- Accepting input does not guarantee an immediate answer. The recipient decides how to handle it alongside its current work.

### Parent-to-child messages

- A parent may prompt a running direct child, including a non-interactive child.
- A prompt received while an assignment is outstanding supplements that assignment. It does not create a second assignment or abandon unfinished work.
- A prompt received after settlement starts a new assignment.
- Parent prompts use `send_message`.
- Prompting a closed, resumable child follows the lifecycle rules for starting a new run.
- Input during completion or exit follows the [coordination ordering rules](coordination-rules.md#completion-and-input-ordering).

### Lifecycle effects

- Agent messages and parent prompts do not count as human steering or disruption.
- Communication does not switch an agent between interactive and non-interactive modes.
- Sending a message does not itself suppress automatic reporting or exit.
- Interactive agents continue to report assignments explicitly and stay open after reporting.
- Non-interactive agents continue to report automatically and exit when their assigned work is complete, subject to the lifecycle rules.
- Receiving an ordinary message from a child does not settle that child's assignment or release the parent's completion protection.

### Clarification and waiting

- Results are delivered automatically when coordination and the recipient are available.
- A non-interactive child that needs an answer before proceeding ends its turn with its questions in the final assistant message. Automatic reporting delivers this blocked outcome, settles the assignment, and closes the child under the [normal lifecycle rules](lifecycle-rules.md#automatic-completion-eligibility-and-result-selection). It does not call `report_task` or keep its turn running to wait for an answer.
- The parent answers through `send_message`, starting a new assignment and resuming the child if needed.
- Sending a clarification message alone does not suspend automatic reporting or exit. Ending a turn does not establish a waiting state; non-interactive clarification uses report-and-resume.

### Delivery and unavailable agents

- Parent-to-child messages may resume eligible closed children through the coordinator.
- Messages and reports to a recorded parent may be accepted while that parent is disconnected. Delivery waits for the parent to reconnect; a child cannot reopen its parent.
- Unknown or unauthorized recipients produce an error without redirecting input. Temporary lead or parent absence does not reject an otherwise valid submission.
- A message or report receives an acknowledgement once Crew durably persists the validated submission, whether or not the lead or recipient is connected. No separate queue status is required.
- Only the lead's coordinator delivers input. While the lead is absent, members may submit and persist messages and reports, but no recipient is prompted and no assignment settles.
- An acknowledgement does not guarantee delivery or an answer. Later execution failures are recorded durably without injecting conversation messages or activating turns. Failed and uncertain operations follow [execution recovery](coordination-rules.md#delivery-and-execution-recovery); exactly-once delivery is not guaranteed.
- Internal operation results and failures do not create an additional messaging channel. Spawn results return only through the waiting tool call; later launch outcomes are inspectable through [`list_agents`](tool-rules.md#list_agents). Explicit messages, assignment reports, and unexpected-exit notices retain their normal delivery and turn-activation behavior.
- Submission, delivery, retry policy, and recovery follow the [coordination rules](coordination-rules.md).

### Communication scope

- These rules cover communication between a parent and its direct children.
- Peer and cross-tree messaging are unsupported. Agents communicate only with their parent or direct children.
- Messaging permission does not grant permission to delegate work, resume a parent, or close another agent.