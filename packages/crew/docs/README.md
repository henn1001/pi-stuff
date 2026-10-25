# Crew rules

These documents contain the accepted requirements for Crew's next iteration. Draft contracts describe proposed behavior; implementation may differ.

| Document                                            | Scope                                                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [UX](ux-rules.md)                                   | Command, menu, widgets, conversation and tool rendering, panes, and notifications.                                                       |
| [Lifecycle](lifecycle-rules.md)                     | Interactive and non-interactive agents, assignment settlement, disruption, recovery, and delegation.                                     |
| [Session interaction](session-interaction-rules.md) | Exhaustive allowlist for Crew-owned execution activation and model-visible session context changes; no hidden wakeups or input channels. |
| [Communication](communication-rules.md)             | Messages and reports, turn activation, observable delivery guarantees, and communication scope.                                          |
| [Coordination](coordination-rules.md)               | Lead-hosted coordinator, durable submission acknowledgements, completion ordering, outages, and recovery.                                |
| [Tools](tool-rules.md)                              | Tool arguments, results, errors, model-facing guidance, listing scope, task names, target resolution, and retry semantics.               |
| [Tool activation](tool-activation-rules.md)         | Tool visibility by role, member configuration, and catalog refresh.                                                                      |
| [Agent frontmatter](agent-frontmatter-rules.md)     | Agent definition fields, discovery, parsing, and validation.                                                                             |