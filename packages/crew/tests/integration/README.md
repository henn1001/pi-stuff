# Crew integration scenarios

These scenarios run the real Crew extension in Pi inside disposable Herdr workspaces. The model provider is deterministic and local; tests do not call a remote model. Omitting `--scenario` runs every registered scenario sequentially; pass `--scenario <name>` to run just one.

## Requirements

- Run inside a Herdr-managed pane (`HERDR_ENV=1`).
- `herdr`, `pi`, `flock`, and `stat` must be available on `PATH`; the runner requires Linux/procfs.
- Herdr's Pi integration must be installed (`herdr integration status`). The runner loads its installed session reporter into the isolated Pi home so Crew can verify exact Herdr/Pi identity.
- The checkout's Node dependencies must be installed so Pi can load the test provider and Crew extension.
- Each scenario needs a new output directory; the harness rejects an existing directory. If `--output` is omitted, the runner creates `tests_tmp/YYYYMMDD_HHMMSS_<scenario>` in the repository root. One timestamp is generated per invocation and shared across all scenario directories. With one selected scenario, `--output` names its directory; when running all scenarios, `--output` names their parent directory. Explicit output paths must be under the repository's `tests_tmp/` or the system temporary directory.
- The runner creates a separate short Pi agent home on a supported local filesystem and checks Crew's Unix socket path limit there.

## Run

```sh
python3 tests/integration/run.py --list
python3 tests/integration/run.py
python3 tests/integration/run.py --scenario smoke
python3 tests/integration/run.py \
  --scenario it-001 \
  --output "/tmp/crew-it-001-$(date +%s)-$$"
python3 tests/integration/run.py \
  --scenario smoke \
  --output "/tmp/crew-it-smoke-$(date +%s)-$$"
```

The runner's default-all and single-scenario modes are also available through the npm script:

```sh
npm run test:runtime
npm run test:runtime -- --scenario smoke
```

By default, the runner closes only its own workspace on success or failure. It keeps the output directory and evidence either way. To leave the failed workspace, panes, Pi processes, temporary definitions, and isolated runtime state available for manual inspection, pass `--keep-on-failure`:

```sh
python3 tests/integration/run.py \
  --scenario smoke \
  --output /tmp/crew-it-smoke-debug \
  --keep-on-failure
```

The runner prints the retained workspace, tab, lead pane, and output IDs. Inspect the pane output with Herdr, then close only that workspace with `herdr workspace close <workspace-id>` when done. The run never stops or restarts the Herdr server and never reuses an existing workspace.

## Scenario and evidence model

The initial case specifications live in [`cases/index.md`](cases/index.md) and map to the `it-001` through `it-005` scenarios. Add scenarios as Python modules under `scenarios/` and register them in `run.py`. A scenario is a `run(runtime)` function: it drives Herdr/Pi through the shared runtime, waits on bounded observable conditions, and asserts behavior. Keep the scenario explicit and focused; do not use another scenario as implicit setup. Selected scenarios run serially and share one output timestamp.

`runtime.py` owns workspace creation, an isolated `PI_CODING_AGENT_DIR`, test definitions, event/request capture, diagnostics, and cleanup. The isolated Pi agent home is a short temporary directory under the user's home so Crew's SQLite and `flock` state uses the local persistent filesystem required by the runtime; the runner checks the filesystem before creating a workspace. `fixtures/observer.ts` records Pi lifecycle evidence without changing Crew authority or session input. `fixtures/provider.ts` supplies planned responses and records the actual model request context; it does not access the network.

Evidence is retained under the output directory:

- `results.json`: completed scenario checkpoints.
- `events.jsonl`: observed Pi lifecycle and message events.
- `requests.jsonl`: deterministic provider requests, including the received model context.
- `failure.json`: exception, traceback, latest owned workspace snapshot, events, and provider requests on failure.
- `project/`: isolated project and temporary agent definitions.
- The temporary Pi agent home, including Crew state, settings, and saved sessions, is printed and included in `failure.json`; it is removed after normal cleanup and retained with `--keep-on-failure`.

The focused cases verify basic activation, menu spawning, listing, messaging, and automatic completion independently. The smoke scenario retains the combined workflow: it verifies actual menu-spawned interactive agents, parent-to-child and child-to-parent `send_message` delivery, their continued presence, and a `spawn_agent` non-interactive child whose result reaches the lead before its pane and Pi process exit. Unique run markers correlate assertions to provider requests and observed live runs.