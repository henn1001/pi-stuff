# Crew agent frontmatter rules

Status: Accepted.

## Goal

Agent definitions are Markdown files containing YAML frontmatter and an instruction body. These rules define their configuration, discovery, and validation. Frontmatter is the only way to configure an agent; Crew tools take no configuration overrides. Application of configuration and inherited history must obey [Crew session interaction rules](session-interaction-rules.md).

```markdown
---
name: reviewer
description: Reviews changes for correctness and security
model: anthropic/claude-sonnet-4-6
thinking: medium
tools: read, bash, grep
skills: code-review
spawning: false
auto-exit: true
---

Review the requested changes. Report actionable findings with file and line references.
```

## Rules

### Discovery and refresh

Discover `.md` files with frontmatter in the following locations, highest precedence first:

1. `.pi/agents/` under the lead's project cwd.
2. `$PI_CODING_AGENT_DIR/agents/` (default `~/.pi/agent/agents/`).
3. Bundled `src/agents/bundled/` in this extension.

- When definitions share a `name`, the highest-precedence definition wins.
- Nested spawns use the same catalog roots. A member's cwd does not change the project catalog location.
- Catalog refresh and application of updated definitions follow the [tool activation rules](tool-activation-rules.md).

### Fields

All fields are optional. Defaults apply subject to the parsing rules below.

| Field                      | Default                           | Meaning                                                                                                                                                                                                                                  |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | Filename without `.md`            | Definition name selected through `spawn_agent`'s `agent_type`, and the base for display-only pane titles. Lowercase `[a-z0-9-]`.                                                                                                         |
| `description`              | None                              | Description shown in the model-visible agent catalog and Spawn picker.                                                                                                                                                                   |
| `model`                    | Immediate spawner's current model | Exact authenticated `provider/model-id`. Invalid or unauthenticated selections fail the launch.                                                                                                                                          |
| `thinking`                 | Immediate spawner's current level | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Explicit values must be supported by the model; inherited values are clamped.                                                                                              |
| `tools`                    | Pi default set                    | Omitted or `null`: Pi defaults. `[]`: no optional tools. Non-empty YAML string array or comma-separated string: allowlist. Crew tool visibility is governed separately; see below.                                                       |
| `skills`                   | Pi default set                    | Omitted or `null`: Pi defaults. `[]`: no skills. Non-empty YAML string array or comma-separated string: allowlist of skills loaded at launch.                                                                                            |
| `system-prompt`            | `append`                          | For a non-empty body, `append` appends it to Pi's system prompt and `replace` uses it as the system prompt. An empty body neither sets nor appends a system prompt, regardless of this field. Never prefix the body to the task.         |
| `session-mode`             | `standalone`                      | `standalone`: fresh session. `fork`: copy the immediate spawner's conversation on initial creation. Resumption reopens the saved session without forking again.                                                                          |
| `spawning`                 | `false`                           | Allows member delegation subject to the [lifecycle rules](lifecycle-rules.md#delegation-and-spawn-permission).                                                                                                                           |
| `auto-exit`                | `true`                            | `true`: tool-spawned agents start non-interactive. `false`: interactive. See [lifecycle rules](lifecycle-rules.md). Ignored for menu-spawned agents.                                                                                     |
| `disable-model-invocation` | `false`                           | `true`: hide from the model-visible catalog and reject tool-based spawning, even by explicit name. Only the lead's `/crew spawn` picker may spawn it. See [tool activation rules](tool-activation-rules.md#model-visible-agent-catalog). |

- New agents inherit the immediate spawning session's cwd.
- Definition names, task names, and agent IDs are distinct. Naming and target resolution follow the [tool rules](tool-rules.md#task-names-and-target-resolution).

### Tool configuration

- Pass configured tool names to Pi without checking whether they exist. Pi determines whether the coordinator's launch succeeds or fails.
- The `tools` allowlist cannot remove role-required Crew tools or grant permissions denied by Crew's [tool activation](tool-activation-rules.md) and [lifecycle rules](lifecycle-rules.md).

### Menu-spawned agents

- Only the lead can launch from `/crew` → Spawn agent…; members cannot use `/crew spawn`.
- `/crew` → Spawn agent… launches a definition with no task and no first model turn.
- Apply the definition's model, thinking, tools, skills, `session-mode`, `spawning`, and system-prompt settings. Inherit cwd from the spawning session.
- Ignore `auto-exit`: menu-spawned agents are interactive and stay open.
- Record the spawning session as the parent.
- Include definitions with `disable-model-invocation: true` in the picker.

### Bundled definitions

- Bundle `planner`, `reviewer`, `scout`, and `worker` definitions.
- Their prompts use only supported frontmatter fields and tool parameters, assume only available agents and tools, and impose no mandatory todo, plan, or commit workflow.
- They accept plain tasks. Report files are written only when requested.
- Tool permissions must support the instructions. Planner delegation must be explicit and consistent with spawn permissions.

### Parsing and validation

- Use `parseFrontmatter` from `@earendil-works/pi-coding-agent` for YAML decoding and body extraction.
- Reuse Pi's handling of quotes, comments, BOMs, and newline normalization rather than maintaining a custom parser or adding a direct `yaml` or `gray-matter` dependency.
- Use the returned body as instruction text; Pi trims its surrounding whitespace.
- An empty Markdown body, including a whitespace-only body, is valid. It neither sets nor appends a system prompt, even when `system-prompt: replace` is configured; Pi's default system prompt remains unchanged.
- Require an opening line exactly `---` and a closing line exactly `---` after BOM and newline normalization. Keep a small delimiter check because Pi's helper returns empty metadata for missing or unclosed frontmatter rather than rejecting it.
- Discovery skips Markdown files without an opening delimiter. An opened but unclosed block is an error.
- Validate decoded metadata as a mapping with TypeBox before applying defaults and normalizing into `AgentDefinition`. The generic type argument to `parseFrontmatter` is not runtime validation.
- Errors must identify the definition path and field.
- Ignore unknown frontmatter fields.
- Boolean fields accept YAML booleans only. Strings such as `yes`, `treu`, or quoted `"true"` are errors rather than silently becoming false. Apply boolean defaults only when the field is omitted.
- `session-mode`, `system-prompt`, and thinking values must match their supported values exactly.
- For `tools` and `skills`, omitted fields, blank YAML values, `null`, or blank strings normalize to `undefined`; `[]` remains an empty array.
- Accept non-empty YAML string arrays and comma-separated strings as allowlists. Other value types are errors.