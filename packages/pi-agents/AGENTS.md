# pi-agents

Vendored fork of [`mavam/pi-agents`](https://github.com/mavam/pi-agents) (`docs/design.md` documents core abstractions).

Before modifying this package or syncing upstream, read [FORK.md](FORK.md).
Preserve its fork invariants unless the user explicitly changes them.
It is the source of truth for upstream provenance and the sync procedure.

## Architecture & tests

- Only `src/host`, `src/agents`, and `src/ui/attach.ts` may import `@earendil-works/pi-durable`; everything else goes through `AgentService`.
- Keep user-facing docs under `docs/` in sync with behavior changes; keep `README.md` concise.
- Run `bun run check` from `packages/pi-agents` to validate (`tsc --noEmit`, `bun test`, Biome). Root `oxfmt`, `oxlint`, and `tsconfig.json` intentionally ignore `packages/pi-agents` to avoid formatting churn against upstream.
