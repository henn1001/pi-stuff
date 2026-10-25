## Implementation map

Each `src/` directory implements the rule documents listed here. The rules live in those documents, not in the code layout.

| Directory                      | Implements                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/`                  | Pure rules and the error code catalog: [Tools](docs/tool-rules.md), [Lifecycle](docs/lifecycle-rules.md), [Communication](docs/communication-rules.md).                                  |
| `src/catalog/`                 | [Agent frontmatter](docs/agent-frontmatter-rules.md), including bundled definitions.                                                                                                     |
| `src/store/`                   | Durable state, ownership, fencing and the shared listing read model: [Coordination](docs/coordination-rules.md), [Tools](docs/tool-rules.md) (`list_agents`), [UX](docs/ux-rules.md).    |
| `src/ipc/`                     | Wake-ups and spawn result notifications: [Coordination](docs/coordination-rules.md).                                                                                                     |
| `src/herdr/`                   | Herdr CLI, events, command issuing and pane allocation: [UX](docs/ux-rules.md), [Coordination](docs/coordination-rules.md).                                                              |
| `src/launch/`                  | Member launch arguments, environment and definition application: [Agent frontmatter](docs/agent-frontmatter-rules.md), [Tool activation](docs/tool-activation-rules.md).                 |
| `src/local/`                   | Code every Crew process runs: submissions, attachment, evidence, process observation, authority claim. [Coordination](docs/coordination-rules.md), [Lifecycle](docs/lifecycle-rules.md). |
| `src/coordinator/`             | Lead-only serialized queue, planners and reconciliation: [Coordination](docs/coordination-rules.md), [Lifecycle](docs/lifecycle-rules.md), [Communication](docs/communication-rules.md). |
| `src/extension/`               | pi glue: tools, `/crew` command, hooks, widgets, prompts, composition root. [Tools](docs/tool-rules.md), [UX](docs/ux-rules.md), [Tool activation](docs/tool-activation-rules.md).       |
| `src/extension/session-input/` | The only code that activates execution or changes model-visible context: [Session interaction](docs/session-interaction-rules.md).                                                       |

Boundary rules:

1. Only `coordinator/` issues Herdr commands and uses `CoordinatorStore`.
2. `local/` and `coordinator/` never import each other.
3. Only `extension/` and `catalog/` (for `parseFrontmatter`) import pi packages.
4. Only `extension/session-input/` calls session-changing pi APIs or registers `context`, `input` and `before_agent_start` hooks.

## Rules

- `docs/` contains the accepted requirements. Read the relevant rules before proposing or implementing changes.
- When modifying these rules, use the global no slop skill for writing guidance and follow their document style. Avoid duplication and link to related rule documents.
- Code comments for interfaces, types, classes and public classes are a must.
- Crew is still under development. Contracts are still allowed to change and migration of existing schemas is of no concern.