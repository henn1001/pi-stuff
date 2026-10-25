# Crew

Crew is a private pi extension for coordinating helper sessions in herdr. Enable it in a lead session, then delegate work to agents running in separate panes or start idle agents yourself.

## Requirements

- pi with this extension loaded
- A herdr-managed workspace and the `herdr` CLI

The extension is registered from `src/index.ts`. It requires herdr for pane management and inter-session messaging.

## Quick start

1. Start pi in a herdr workspace and run `/crew` in the session you want to use as the lead.
2. Run `/crew` again for the menu, or use `/crew spawn` to open the agent picker and `/crew connected` to inspect connected agents directly. After `/crew `, press Tab to autocomplete these actions.
3. Agents started for delegated tasks send their results to the caller. Use `subagent_send` to message a connected agent; use `subagent_done` when a member should report and exit explicitly.

Crew activation is stored on the current session branch. Crew is dormant until enabled.

## Agents

Crew bundles four definitions: `planner`, `reviewer`, `scout`, and `worker`. Add project-specific definitions as Markdown files with YAML frontmatter under `.pi/agents/`:

```markdown
---
name: reviewer
description: Reviews changes for correctness and security
tools: read, bash, grep
spawning: false
---

Review the requested changes and report actionable findings.
```

Definitions are discovered in this order: project `.pi/agents/`, user `$PI_CODING_AGENT_DIR/agents/` (default `~/.pi/agent/agents/`), then the bundled definitions. A higher-priority definition with the same name wins. Model, thinking, tools, skills, and delegation behavior are configured in the definition, not as per-call overrides.

## Documentation

- [Crew rules](docs/README.md) — accepted requirements for Crew's next iteration

## Development

```sh
npm run lint
npm run format:check
```