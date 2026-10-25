# Crew tool activation rules

Status: Accepted.

## Glossary

- **Crew tools**: Tools provided by the Crew extension.
- **Pi native tools**: Tools provided by Pi itself.
- **Crew active / inactive**: Whether Crew mode is enabled for a session. Once active, Crew mode stays active for the rest of that session.
- **Agent catalog**: Agent definitions loaded from frontmatter configuration. Each definition includes the tools allowed for that agent.
- **Member configuration**: The selected agent’s frontmatter configuration, including its allowed tools.
- **Tool activation**: Applying a set of visible tools through `pi.setActiveTools()`.

## Goal

Define tool visibility at two levels:

- Which Crew tools are visible in the current session.
- Which tools are visible to members launched by the coordinator.

Crew may call `pi.setActiveTools()` on startup, `/reload`, session replacement (`/new`, `/resume`, `/fork`), or activation through `/crew`.

Configuration changes must obey [Crew session interaction rules](session-interaction-rules.md); they do not authorize session input or execution.

## Rules

### Crew tool visibility

- Crew tools register with `defaultActive: false`.
- Crew mode becomes active through `/crew`, startup with `--crew-mode`, or starting a member session through Crew.
- Once activated, Crew mode remains active for the rest of the session, including after `/reload`.
- A session’s Crew role does not change.
- Crew applies tool activation on startup, `/reload`, and session replacement. Running `/crew` activates Crew tools in the current session.

### Tool visibility by role

These rules apply while Crew is active.

| Tool           | Lead      | Member                                                             |
| -------------- | --------- | ------------------------------------------------------------------ |
| `spawn_agent`  | Available | Available only when the definition and tree depth permit spawning. |
| `send_message` | Available | Available regardless of spawn permission.                          |
| `report_task`  | Hidden    | Available in either lifecycle mode.                                |
| `list_agents`  | Available | Available.                                                         |

- Spawn permission controls creation only. Messaging a parent or prompting or resuming an eligible recorded direct child is independent of spawn permission.
- Relationship and runtime checks still apply. Tool visibility does not grant access to unrelated agents.
- `report_task` remains visible to non-interactive members because disruption may make them interactive. Visibility does not permit reporting in non-interactive mode; its handler enforces the lifecycle and assignment preconditions in [Crew tool rules](tool-rules.md#report_task).
- Assignment state and lifecycle disruption do not trigger tool reconfiguration.

### Member tool visibility

These rules apply to interactive and non-interactive members launched by Crew.

- Whenever the coordinator launches a new member Pi process, it applies the selected definition from the agent catalog, including its allowed tools.
- This happens when starting fresh or resuming an existing child through `send_message`. Resume eligibility and saved-session handling follow [Crew lifecycle rules](lifecycle-rules.md#resumption); unavailability alone does not permit resumption.
- Reloading a lead or parent refreshes its agent catalog. Updated definitions apply on the next member Pi process launch. Running member instances are unchanged.

### Catalog refresh and runtime behavior

- Crew refreshes the agent catalog on startup, `/reload`, and session replacement.
- Starting another model turn in an existing Pi process does not refresh the agent catalog or reapply active tools. Launching a new member Pi process applies the selected definition as specified in [Member tool visibility](#member-tool-visibility).
- Supervision, attachment readiness, and lead or parent availability do not change configured tools or trigger tool reconfiguration.
- Tool handlers check runtime preconditions when called.

### Model-visible agent catalog

- Put the model-visible agent catalog in the `spawn_agent` tool description. Do not inject it into the system prompt.
- Include the catalog only while `spawn_agent` is available. Dormant sessions and members that cannot spawn receive no catalog.
- Include only definitions the caller may spawn under its role, tree depth, delegation permission, and lifecycle restrictions in [Crew lifecycle rules](lifecycle-rules.md#delegation-and-spawn-permission). Exclude definitions with `disable-model-invocation: true`.
- Do not filter a candidate definition by its own `spawning` value. That field controls whether the selected agent may delegate later; it does not control whether the caller may select it.
- Render one minimal line per eligible definition as `name: description`, or `name` when no description is set. Do not include definition bodies or workflow guidance. Omit the catalog when no definitions qualify.
- These minimal-line and no-workflow-guidance limits apply to agent catalog entries only. They do not prohibit usage guidance in a Crew tool's `description`, `promptSnippet`, `promptGuidelines`, or schema field descriptions; those follow [tool rules](tool-rules.md#model-facing-tool-metadata).
- Prepare the catalog for each model loadout from the currently loaded definitions and the caller's current spawn eligibility. Lifecycle or tree eligibility changes are reflected in the next loadout. Definition changes become visible only after the refresh events above; preparing a loadout does not rescan definition files.