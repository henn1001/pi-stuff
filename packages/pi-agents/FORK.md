# pi-agents

Vendored fork of [`mavam/pi-agents`](https://github.com/mavam/pi-agents).

## Upstream tracking

- **Upstream:** `https://github.com/mavam/pi-agents.git`
- **Synced base:** `99d64403214c6b61797080e82cf7dc0c43e70f65` (`v0.40.1`)
- **Reference clone:** `.ref/pi-agents` (gitignored; clone on demand if missing from the repository root).

## Fork divergences

Preserve these invariants when porting upstream commits or modifying code unless the user explicitly changes them:

1. **Session-scoped opt-in activation (`src/pi/activation.ts`, `src/pi/commands.ts`, `src/index.ts`):**
   - Sessions start disabled unless previously activated or started with `--agents`: no `agent_*` tools or `pi-agents` system-prompt section are visible to the model until activated. Tool registration timing is an implementation detail.
   - Activate via `--agents`, `/agents enable`, or by confirming the prompt on `/agents` / `Ctrl+Q`. Confirmation only enables the extension; the next invocation opens the overview.
   - Persist activation for the session via custom entry `pi-agents-enabled` so reloads and resumed sessions restore enabled state automatically.
2. **Unified `/agents` command surface (`src/pi/commands.ts`):**
   - Expose one `/agents` command (`enable`, `attach <name>`, `messages`) instead of separate `/agent` and `/messages` top-level commands.
3. **Profile-only agent configuration & spawn permission (`src/agents/spawn-input.ts`, `src/pi/spawn.ts`, `src/pi/tools.ts`, `src/pi/prompt.ts`, `src/agents/spawning.ts`):**
   - `agent_spawn` accepts neither `model`, `thinking`, `tools`, `skills`, nor `spawn` arguments (top-level or nested); profiles own those settings, and `spawn: true` on the selected profile is the sole grant of child spawn permission (never inherited).
   - System prompts list only profile names and descriptions (`<agent_profiles>`), never a model catalog, and instruct omitting `profile` when none exist.
   - Optional string fields in `agent_spawn` treat `null`, `""`, and whitespace-only strings as omitted.
4. **Full-screen workspace UX (`src/ui/workspace.ts`, `src/ui/`, `src/pi/commands.ts`):**
   - `←` (in an empty editor), `Ctrl+Q`, and clicking the summary line open the full-screen `[Agents]  Messages` overview directly instead of focusing an inline panel.
   - `Tab` / `Shift+Tab` switches between full-screen Agents and Messages views while preserving session-scoped selection, scroll, detail expansion, text query, and agent-ID scope (`Ctrl+X` clears agent scope independently of text query).
   - Attach view renders full-screen (`Agents › <name>`) and detaches back to the overview with that agent selected (only when the draft editor is empty and no interrupt is in flight).

## Upstream update workflow

Start at the repository root with a clean worktree and record `HEAD`.
Revert the active Fork
commit, import a new vendor baseline, then reapply the adaptations in one new
Fork commit. Leave unrelated commits in place.

1. **Pick a target.** Clone the upstream into `.ref/pi-agents` if needed and run
   `git -C .ref/pi-agents fetch origin --tags`. Resolve a tag or branch tip with
   `git -C .ref/pi-agents rev-parse '<ref>^{commit}'`. Record the target SHA and
   review the net diff from **Synced base** to that SHA. Consult individual
   commits or their messages when the intent is unclear. Ask before changing
   a fork invariant or the extension's scope.
2. **Revert the Fork commit.** Find the active `feat(fork): pi-agents adaptations`
   commit and verify it contains all local package adaptations. If later commits
   changed the package, revise the sync plan before proceeding. Keep a copy of
   these instructions: `git revert <fork-sha>` removes this file. Record the
   revert SHA and verify the package matches the old vendor baseline.
3. **Import the baseline.** Check out the target SHA detached in the reference
   clone and sync `packages/pi-agents` to the full snapshot, including upstream
   deletions. Import source, tests, docs, README, LICENSE, and applicable dev
   config. Keep workspace integration, normalized package metadata,
   TypeScript/Bun/Biome config, and root extension registration. Omit upstream
   CI, demos, changelog, standalone lockfiles, `.gitignore`, lefthook config,
   and agent instructions unless the import requires them. Commit as
   `vendor(pi-agents): import <version-or-sha> as a replayable baseline` with
   `Upstream: https://github.com/mavam/pi-agents/commit/<target-sha>` in the body.
4. **Reapply the fork.** Run `git revert <revert-sha>`. Resolve conflicts against
   the invariants above and drop adaptations superseded by upstream. Review
   the reapplied code, tests, and docs. Update **Synced base** in this file and
   amend the reapplication commit as `feat(fork): pi-agents adaptations`, with
   a pointer to `packages/pi-agents/FORK.md` in the body.
5. **Verify.** Run `(cd packages/pi-agents && bun run check)`, `bun run typecheck`,
   and `git diff --check <pre-update-head> HEAD`. Confirm the worktree is clean
   and leave the reference clone at the imported SHA.

The revert stays in history. If it needs to be removed, rewrite on a private
sync branch and coordinate before replacing a shared branch.

The main fork integration points are:

- `src/pi/activation.ts`: opt-in state, concurrent activation, and its session marker.
  `src/index.ts` supplies startup and tool registration; it still owns shutdown.
- `src/pi/commands.ts`: command/shortcut routing, confirmation, and terminal guards.
- `src/ui/workspace.ts`: Agents/Messages rendering, transitions, and session view state.
- `src/agents/spawn-input.ts`: argument preparation shared by parent and child
  tools; optional-string normalization is also used by the profile resolver.
- `src/ui/frame.ts`: full-screen placement and shared frame padding. Attach,
  Agents, and Messages retain their own input handling and lifecycle.

Keep policy tests at these boundaries so an upstream refactor cannot silently
restore model-selected configuration or expose tools before activation.
