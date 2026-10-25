# Herdr scenarios

These scripts run manual end-to-end scenarios with Pi agents in fresh Herdr workspaces. They use the configured model provider and are separate from the deterministic integration suite.

## Scenarios

| Script                                                   | Coverage                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`herdr_crew_smoke.py`](herdr_crew_smoke.py)             | Menu-spawned interactive workers exchange messages with the lead; a one-shot child returns its result and exits.   |
| [`herdr_lead_succession.py`](herdr_lead_succession.py)   | A successor lead takes over the workspace and resumes messaging an existing worker.                                |
| [`herdr_delayed_delivery.py`](herdr_delayed_delivery.py) | A queued message resumes a closed worker; a worker's message sent during lead downtime reaches the successor lead. |

[`herdr_scenario.py`](herdr_scenario.py) contains shared Herdr setup, command, and wait helpers. It is not a standalone scenario.

## Run

Run one script from the repository root inside a Herdr-managed pane:

```sh
python3 scripts/herdr_crew_smoke.py
python3 scripts/herdr_lead_succession.py
python3 scripts/herdr_delayed_delivery.py
```

The scripts require `HERDR_ENV=1`, `herdr` and `pi` on `PATH`, and a working Pi model configuration. `CREW_SMOKE_TIMEOUT_MS` sets the model wait timeout in milliseconds; it defaults to `180000`.

Each run creates a uniquely named workspace and agent definitions under `.pi/agents/`. It leaves the workspace open and performs no cleanup, including on failure, so the printed workspace ID and pane state remain available for inspection.