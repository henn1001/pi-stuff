# pi-stuff

A Git-installable Pi package containing these extensions:

- `ask-user` — lets the model ask a multiple-choice question.
- `profiles` — session-bound profiles for startup settings and prompt instructions.
- `skill-manager` — browse skills and control automatic model invocation.

Install from Pi with:

```sh
pi install git:github.com/henn1001/pi-stuff@main
```

The repository root is one Pi package. Run `pi config` to choose which of its extensions load. No npm publication is needed; the root and extension package manifests use npm workspaces to keep runtime dependencies with their owning extension.