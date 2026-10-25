# Crew session interaction rules

Status: Accepted.

## Goal

Define every permitted Crew interaction with Pi session execution and model-visible context. These rules cover Crew-owned behavior, not human input, Pi itself, or other extensions.

## Rules

### Allowed interactions

Crew may activate execution or change model-visible session context only through the following interactions. This restriction applies whether input is visible, hidden, immediate, or queued, and whether it starts a turn, steers a running turn, or schedules a continuation.

| Interaction                                                                                                  | Contract                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial assignment from a successful task-bearing spawn                                                      | [Spawn request/reply](coordination-rules.md#synchronous-spawn-requestreply) and [`spawn_agent`](tool-rules.md#spawn_agent). Menu launches have no initial task or turn under [frontmatter rules](agent-frontmatter-rules.md#menu-spawned-agents).                                                                                              |
| Explicit `send_message` delivery                                                                             | [Communication and turn activation](communication-rules.md#turn-activation).                                                                                                                                                                                                                                                                   |
| Explicit or automatic assignment report                                                                      | [Lifecycle and settlement](lifecycle-rules.md#assignment-tracking-and-recovery).                                                                                                                                                                                                                                                               |
| Unexpected-exit notice for outstanding work                                                                  | [Termination and parent notification](lifecycle-rules.md#termination-and-parent-notification).                                                                                                                                                                                                                                                 |
| Result or error returned through its originating tool call                                                   | [Tool contracts](tool-rules.md). Returning a tool result does not authorize a separate message or additional turn.                                                                                                                                                                                                                             |
| Definition, model, thinking, tool, skill, and catalog configuration at its specified application points      | [Frontmatter](agent-frontmatter-rules.md) and [tool activation](tool-activation-rules.md). Configuration does not itself activate execution.                                                                                                                                                                                                   |
| Active Crew tool metadata: `description`, `promptSnippet`, `promptGuidelines`, and schema field descriptions | Native tool declarations and the active tool loadout under [tool rules](tool-rules.md#model-facing-tool-metadata) and [tool activation](tool-activation-rules.md). Pi includes `promptGuidelines` in its Guidelines section while the tool is active. This metadata describes tool use; it does not create a separate execution or input path. |
| Initial conversation inheritance and reopening saved member history                                          | [Frontmatter session mode](agent-frontmatter-rules.md#fields) and [resumption](lifecycle-rules.md#resumption). Opening history alone does not start work.                                                                                                                                                                                      |

Human input remains Pi-owned. Crew may observe and record it for [lifecycle decisions](lifecycle-rules.md#non-interactive-follow-up-input), but must not manufacture additional session input from it.

### Coordination does not authorize input

- Coordinator startup, recovery, polling, reconnection, adapter probes, and process observations do not independently authorize session input or execution.
- Tool timeouts, late operation completion, and post-acknowledgement failures do not inject messages, hidden context, or continuations. Results and failure visibility follow [Crew tool rules](tool-rules.md#common-contract).
- Opening or refreshing views changes no model context and starts no turns; see [Crew UX rules](ux-rules.md).
- Navigation and compaction follow [conversation navigation and compaction](coordination-rules.md#conversation-navigation-and-compaction). Neither authorizes replay or delivery.
- Normal coordinator processing may continue delivery of an already-authorized pending message or assignment outcome under [execution recovery](coordination-rules.md#delivery-and-execution-recovery). It must not invent a recovery message, resend settled work, or start an extra turn to announce coordination state.

### Model-context boundary

- Do not add generic Crew-wide coordination system prompts, hidden reminders, completion nudges, or synthetic continuation input. This does not prohibit tool-scoped `description`, `promptSnippet`, `promptGuidelines`, or schema field descriptions declared for active tools under [tool rules](tool-rules.md#model-facing-tool-metadata). Session metadata and context hooks must not become alternative input channels.
- Do not scan transcripts to reconstruct assignments or resurrect delivered outcomes. Durable authority and navigation isolation follow [Crew coordination rules](coordination-rules.md#conversation-navigation-and-compaction).
- Preserve each interaction's defined channel and payload. Do not copy instructions into another channel as a fallback; definition bodies are not task prefixes, and the agent catalog belongs in the tool description, not the system prompt.
- Configuration refresh follows the linked frontmatter and activation rules without activating execution. UI-only information stays outside model context under [Crew UX rules](ux-rules.md#conversation-messages).
- Changes to LLM-visible wording require prior approval under `AGENTS.md`. That approval does not authorize a new interaction outside this allowlist.

## Implementation verification

- Inventory every Crew call or hook capable of changing model-visible context or activating execution, including launch input, message delivery, tool returns, context hooks, prompt assembly, and queued continuations. Each must map to an allowed interaction and obey its linked contract.
- Verify timers, observers, recovery, timeout handling, late results, failures, and UI refresh produce no independent session input or execution.
- Verify recovery can deliver authorized pending work without extra announcements or replay of settled outcomes. Verify navigation and compaction do neither.
- Verify model-context configuration occurs only at its defined application points, human input is not duplicated, and UI-only information never enters model context.