# Markdown profiles

A Pi extension for session-bound profiles: Markdown defines startup settings and prompt instructions; a branch-local snapshot preserves the accepted profile. There is no runtime profile switch.

## Usage

Create `~/.pi/agent/agents/plan.md` (global) or `.pi/agents/plan.md` (project-local):

```markdown
---
name: Planning
description: Investigate without editing files
model: openai/gpt-5
thinkingLevel: high
tools: [read, bash]
skills: []
prompt:
  preamble: |
    You are a technical planning assistant operating inside pi.
    Investigate the codebase and produce actionable implementation plans.
  docs: true
  tools: true
  rules: true
---

Investigate the codebase and propose an implementation plan. Do not modify files.
```

This template includes every supported option. Set `model` to a provider/model pair available in your Pi configuration with usable authentication. `skills: []` advertises no skills; replace it with installed skill names or omit it to retain normal visibility. The custom preamble requires a stable loadout during each run (see the limitation below).

Load the extension and select the filename without `.md`:

```bash
pi --extension /path/to/profiles/index.ts --profile plan
```

If the extension is already installed in Pi's extensions directory, use `pi --profile plan`. A project profile replaces a same-named global profile entirely. Only direct `.md` children of the `agents` directories are loaded.

- Model, thinking level, and tools are applied during startup, before the first message; the accepted profile is snapshotted immediately. Invalid runtime selections warn and are skipped, with best-effort rollback of staged tools—not atomic application.
- An active profile displays `profile:Planning` at the bottom left in Pi's footer status row, using its `name` when supplied or the filename otherwise. It follows the active branch on resume, `/reload`, and `/tree`, and disappears for unprofiled sessions.
- `/new` uses the CLI profile name and rereads its current file. Resume and `/reload` restore the recorded snapshot, not the source file; initial model, thinking, and tool settings are not reapplied. Existing unprofiled sessions cannot acquire a profile retroactively.

## Frontmatter reference

Each profile requires a YAML frontmatter mapping containing at least one supported field. All fields are individually optional; body-only files and empty frontmatter are invalid. Unknown top-level or nested `prompt` keys are rejected. The filename identifies the profile for selection and precedence; `name` is an optional display label.

| Field           | Type / accepted values                                    | Behavior when supplied                                                                                                                                                                                                                      | When omitted                                                                                                                      |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | Nonempty string                                           | Display label in the footer; does not change filename-based selection.                                                                                                                                                                      | Uses the filename.                                                                                                                |
| `description`   | String                                                    | Human-readable metadata; not prompt instructions.                                                                                                                                                                                           | No description.                                                                                                                   |
| `model`         | `provider/model-id`                                       | Initial model. The provider and model ID must resolve to an available model; the model ID may contain slashes.                                                                                                                              | No model change.                                                                                                                  |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Sets the initial thinking level. Must be supported by the target model (or current model when no model change is requested). Unsupported explicit levels are rejected, not clamped.                                                         | No explicit change; a model switch follows Pi's native defaults and capability clamping, otherwise the startup level is retained. |
| `tools`         | `null` or array of nonempty tool-name strings             | Replaces the initial active loadout. `[]` activates no tools. Names must be registered and eligible at startup staging; unknown or hidden tools, or a partially accepted loadout, reject the selection.                                     | Leaves the startup loadout unchanged.                                                                                             |
| `skills`        | `null` or array of nonempty skill-name strings            | Limits advertising to matching skills, respecting each skill's `disable-model-invocation`. `[]` advertises none. Does not unload skills or remove slash commands. Missing names warn once per profile and are omitted when composing a run. | Retains normal skill visibility.                                                                                                  |
| `prompt`        | Mapping with only the keys below                          | Customizes base-prompt presentation.                                                                                                                                                                                                        | Retains Pi's normal base-prompt composition.                                                                                      |

For `tools` and `skills`, `null` (including a YAML key without a value) is equivalent to omission. Nonempty lists may use either flow syntax (`[read, bash]`) or block syntax (`- read` on separate lines).

Model selection requires usable authentication. The switch occurs during startup resource discovery, before Pi validates the model for the first run; failures before extension startup are still outside the profile's control.

### `prompt` settings

| Key        | Type                  | Behavior when supplied                                                                                                      | When omitted                   |
| ---------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `preamble` | Non-whitespace string | Replaces the opening identity/task description; the body remains in Pi's separate Appended Prompt.                          | Retains Pi's default preamble. |
| `docs`     | Boolean               | `false` omits Pi documentation guidance; `true` retains normal generation.                                                  | Same as `true`.                |
| `tools`    | Boolean               | `false` omits the textual tool summary; `true` retains normal generation. Tool declarations and availability are unchanged. | Same as `true`.                |
| `rules`    | Boolean               | `false` omits all generated rules, including tool-specific and general guidelines; `true` retains normal generation.        | Same as `true`.                |

For example, add this nested mapping to a profile's frontmatter:

```yaml
prompt:
  preamble: |
    You are a technical planning assistant operating inside pi.
    Investigate the codebase and produce actionable implementation plans.
  docs: false
  tools: true
  rules: false
```

The boolean switches do not accept replacement text. The Markdown body supplies Pi's Appended Prompt (`appendSystemPrompt` / `addendum`). When nonempty, it replaces configured appended text, including global or project `APPEND_SYSTEM.md` content and the combined `--append-system-prompt` text. An empty body leaves Pi's configured appended text unchanged. Headings are ordinary Markdown, not reserved section overrides. `prompt.sectioned`, `prompt.disable`, and arbitrary section names are not supported.

Setting a preamble or any switch to `false` takes ownership of base-prompt composition and introduces the stable-loadout restriction below. An existing `customPrompt` conflicts with such a profile; `forceSystemPrompt` conflicts with every profile. Conflicts warn and skip profile prompt customization for that run rather than implicitly merging prompts. Startup model/thinking/tools and the recorded snapshot remain in effect; prompt conflicts do not roll them back.

Model, thinking, and tool fields are **startup defaults**, not persistent constraints. On resume, Pi owns their restored runtime state; the snapshot restores prompt policy, body instructions, and skill selection without reapplying those initial runtime fields.

## Known limitations

### Profile diagnostics are unavailable in print/JSON mode

Profile diagnostics use `ctx.ui.notify()`. Pi 1.2.0 displays these notifications in interactive mode and forwards them to RPC clients, but treats them as no-ops in print/JSON mode. Invalid selections still fall back as documented, but their warnings—and selection, activation, and restoration notifications—are not emitted in print/JSON mode. No stderr or JSON-event fallback is provided.

### Mid-run tool guidance can drift

**Profiles that own base-prompt composition require a stable tool loadout and declaration-hiding policy throughout each run.** Do not combine them with extensions that activate/deactivate tools or change which declarations are shown mid-run. Later handlers that change tools during `before_agent_start` are also outside this supported contract.

A profile owns base-prompt composition when it sets **any** of:

- `prompt.preamble`;
- `prompt.docs: false`;
- `prompt.tools: false`;
- `prompt.rules: false`.

Even changing only the preamble or disabling documentation takes ownership: the extension must then generate the enabled tools/rules sections itself.

#### Why drift occurs

The extension rebuilds those sections in `before_agent_start`, using that run's supplied prompt options. If another extension changes the loadout after that boundary, Pi updates actual tool declarations before the next model request, but carries the extension's existing custom section strings forward.

Consequently, **tool availability can be current while the textual tool summary and tool-specific rules are stale**. Newly activated tools may lack corresponding guidance; deactivated or newly hidden tools may still be mentioned. The whole system prompt is not frozen, and an already-running model response is not changed retroactively.

Pi records declaration changes as `toolsAdded` / `toolsRemoved` and prompt changes as section patches. Providers without mid-conversation system-message support receive the replayed current state as a leading system message instead, potentially invalidating the cached prefix. Neither mechanism regenerates the extension-owned guidance.

#### Supported usage and workaround

- Keep tools and declaration hiding stable from successful startup staging through first-run composition, and throughout each subsequent run. Static loadout hooks that hide declarations are supported.
- Change tools **between runs**. The next `before_agent_start` rebuilds enabled guidance from the current options, including for extension-triggered runs; this boundary does not specifically require a user message.
- If dynamic mid-run activation is required, use a profile that retains Pi's default base-prompt composition: leave `prompt.preamble` unset and omit the boolean prompt switches or set them to `true`. Pi then retains native tools/rules refresh behavior while the Markdown body replaces configured appended-prompt text, if any.

This restriction is not enforced as a tool permission boundary. Neither the `tools` list nor an instruction such as “do not modify files” prevents another extension from activating tools or executing writes.

#### What would close the gap

A public Pi hook **after loadout resolution and before structured prompt rendering, before every model request**, would let the extension regenerate guidance from authoritative options. Until such a hook exists and parity is verified, synchronized mid-run guidance is unsupported. Transcript rewriting, rendered-prompt parsing, and private APIs are not used as workarounds.

The integration targets Pi **1.2.0** and is version-sensitive. See [PLAN.md, section 5](PLAN.md#5-stable-loadout-support-and-future-refresh-hook) for the full limitation and proposed integration point, and [Verification criteria](PLAN.md#verification-criteria) for the required checks.

## Prompt parity check

Run the parity test after changing prompt composition or updating Pi:

```bash
bun test src/runtime.prompt-parity.test.ts
```

The test compares this extension's generated preamble, tools, rules, and docs sections with the system-prompt builder in the installed Pi release. It reads the active version from `PI_MANAGED_INSTALL_ROOT/current-version`, or from `~/.pi/agent/install/current-version` when that environment variable is unset. The installed release must include Pi's internal `dist/core/system-prompt.js` module; a changed path or prompt output fails the test so parity can be reviewed.