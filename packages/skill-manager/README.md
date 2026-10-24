# Skill Manager

A focused local Pi extension for controlling whether the model can discover and invoke each loaded skill automatically. It edits the skill's own YAML frontmatter instead of changing Pi skill/package filters.

## Behavior

Pi interprets the frontmatter field as follows:

```yaml
disable-model-invocation: true # hidden from the model; /skill:name still works
disable-model-invocation: false # visible to the model
```

This extension always writes an explicit `true` or `false`. It preserves the rest of the Markdown source, including comments, body text, LF/CRLF style, and final-newline state. Writes to the same file are serialized and validated before and after mutation.

Only skills already loaded by Pi are shown. Project, global/user, package, and temporary `--skill` resources are supported. Pi settings and package filters are never modified.

## Commands

| Command                         | Action                                               |
| ------------------------------- | ---------------------------------------------------- |
| `/skill`                        | Open the TUI browser.                                |
| `/skill list`                   | List loaded skills with state, scope, and path.      |
| `/skill status <name-or-path>`  | Show one skill's model-invocation state.             |
| `/skill enable <name-or-path>`  | Write `disable-model-invocation: false`.             |
| `/skill disable <name-or-path>` | Write `disable-model-invocation: true`.              |
| `/skill:<name>`                 | Invoke a skill explicitly using Pi's native command. |

Names must be unique for `status`, `enable`, and `disable`. If multiple loaded skills have the same name, the command fails and reports their paths; rerun it with one exact path. No command mutates multiple matching skills.

`/skill` opens a full-terminal browser with a searchable skill list (~25%) and the selected skill's rendered frontmatter and Markdown (~75%). Details follow selection automatically. Below 100 columns, only the focused pane is shown; Tab switches panes. Pane widths and viewports adapt when the terminal is resized.

| Key                              | Action                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Type (list focused)              | Filter loaded skills.                                                                 |
| Up/Down                          | Select a skill in the list; scroll when detail is focused.                            |
| `-`/`=` or PageUp/PageDown       | Page through the focused pane.                                                        |
| Home/End (detail focused)        | Jump to the start/end of the skill content.                                           |
| Mouse wheel (Pi fullscreen mode) | Scroll detail or move list selection under the pointer, regardless of keyboard focus. |
| Tab                              | Switch keyboard focus between list and detail.                                        |
| Ctrl+X or Alt+X                  | Toggle the selected skill's model visibility from either pane.                        |
| Enter                            | Insert the native `/skill:<name>` command and close.                                  |
| Escape                           | Return from detail to list; clear a search in the list; otherwise close.              |

List badges use `V` for model-visible and `M` for manual-only, followed by the skill's scope. The manager intentionally has no create, edit, rename, or delete modes.

## RPC mode

Use Pi's standard RPC `prompt` command to invoke the slash-command arguments:

```jsonl
{"id":"skills-1","type":"prompt","message":"/skill list"}
{"id":"skills-2","type":"prompt","message":"/skill status init"}
{"id":"skills-3","type":"prompt","message":"/skill disable /absolute/path/to/SKILL.md"}
{"id":"skills-4","type":"prompt","message":"/skill enable init"}
```

Results are emitted through Pi's documented extension UI protocol as fire-and-forget notifications, followed by the normal successful `prompt` response. For example:

```jsonl
{"type":"extension_ui_request","id":"...","method":"notify","message":"init: manual-only (disable-model-invocation: true)\n/home/user/.pi/agent/skills/init/SKILL.md","notifyType":"info"}
{"id":"skills-2","type":"response","command":"prompt","success":true}
```

Bare `/skill` requires TUI mode because RPC does not support custom TUI components. RPC clients should use `list`, `status`, `enable`, or `disable`.

## Reloading

A toggle changes the file immediately, but the current session's system prompt was already built. Run `/reload` after toggling so Pi reloads skills and rebuilds current-session model visibility. Explicit `/skill:<name>` invocation remains available when the field is `true`.

## Writable package caveat

Package skills can be toggled only when their installed Markdown files and parent directories are writable. Package updates/reinstalls may overwrite local header changes. Read-only package stores (for example Nix/Guix stores) fail with a permission error and are left unchanged; copy or override the skill into a writable project/user location instead.

## Safety and limitations

- Existing non-boolean values, duplicate keys, malformed frontmatter, and unsupported quoted spellings are rejected rather than normalized.
- Mutations are minimal and use a same-directory temporary file plus atomic rename.
- The extension does not alter Pi's `skills`, `packages`, or `enableSkillCommands` settings.
- Native `/skill:<name>` command availability still depends on Pi's `enableSkillCommands` setting.