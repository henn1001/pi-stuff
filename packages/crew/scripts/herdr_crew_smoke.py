#!/usr/bin/env python3
"""Run the real-model Crew smoke scenario in a fresh Herdr workspace."""

from __future__ import annotations

import secrets
import sys
from datetime import UTC, datetime
from pathlib import Path

from herdr_scenario import HerdrScenario, ScenarioError

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "src" / "index.ts"


def run_scenario(scenario: HerdrScenario) -> None:
    """Exercise interactive messaging and one-shot task completion."""
    run_id = f"{datetime.now(UTC):%H%M%S}-{secrets.token_hex(3)}"
    run_key = run_id.replace("-", "_").upper()
    lead_name = f"crew-smoke-lead-{run_id}"
    worker_name = f"crew-smoke-worker-{run_id}"
    scout_name = f"crew-smoke-scout-{run_id}"
    once_name = f"crew-smoke-once-{run_id}"
    task_name = f"crew-smoke-task-{run_id}"
    worker_token = f"CREW_WORKER_POEM_{run_key}"
    scout_token = f"CREW_SCOUT_POEM_{run_key}"
    once_token = f"CREW_SCOUT_ONESHOT_OK_{run_key}"

    scenario.create_workspace(f"crew-smoke-{run_id}")
    scenario.write_definition(
        worker_name,
        description="Interactive worker for a live Crew smoke scenario",
        auto_exit=False,
        instructions=(
            "When the lead sends you a Crew message, write a four-line poem about being a worker. "
            f'Include "{worker_token}" verbatim. Use list_agents to find your parent\'s full agent_id, '
            "then send the complete poem to that parent with one send_message call. Repeat the same poem "
            "as ordinary assistant text. Do not call report_task. Stay connected."
        ),
    )
    scenario.write_definition(
        scout_name,
        description="Interactive scout for a live Crew smoke scenario",
        auto_exit=False,
        instructions=(
            "When the lead sends you a Crew message, write a four-line poem about being a scout. "
            f'Include "{scout_token}" verbatim. Use list_agents to find your parent\'s full agent_id, '
            "then send the complete poem to that parent with one send_message call. Repeat the same poem "
            "as ordinary assistant text. Do not call report_task. Stay connected."
        ),
    )
    scenario.write_definition(
        once_name,
        description="One-shot scout for a live Crew smoke scenario",
        auto_exit=True,
        instructions=f'Reply exactly "{once_token}" to the assigned task. Do not call tools.',
    )

    scenario.start_lead(lead_name, EXTENSION)
    scenario.activate_crew()
    worker_pane = scenario.spawn_menu_agent(worker_name)
    scout_pane = scenario.spawn_menu_agent(scout_name)

    lead_request = (
        "Use list_agents to find the connected direct children whose agent_type values are "
        f'"{worker_name}" and "{scout_name}". Send the worker a separate send_message asking for a '
        f'four-line worker poem that includes the exact marker "{worker_token}" and is sent back to you '
        f'with send_message. Ask the scout likewise for a four-line scout poem containing "{scout_token}". '
        "Do not message the one-shot scout or use other tools. Stop after sending both messages."
    )
    scenario.command(
        [
            "herdr",
            "agent",
            "prompt",
            lead_name,
            lead_request,
            "--wait",
            "--timeout",
            str(scenario.timeout_ms),
        ],
        timeout=scenario.timeout_seconds + 30,
    )
    scenario.wait_for_agent_text(
        worker_pane, worker_token, timeout=scenario.timeout_seconds
    )
    scenario.wait_for_agent_text(
        scout_pane, scout_token, timeout=scenario.timeout_seconds
    )
    scenario.require(
        scenario.agent_present(worker_pane),
        "Interactive worker exited; expected it to remain connected.",
    )
    scenario.require(
        scenario.agent_present(scout_pane),
        "Interactive scout exited; expected it to remain connected.",
    )
    print(
        "PASS: lead messaged both interactive agents; both returned poems and remain connected."
    )

    once_request = (
        f'Call spawn_agent exactly once with task_name "{task_name}", agent_type "{once_name}", '
        f'and a message asking for exactly "{once_token}". After the child completes and you receive its '
        "result, repeat that result exactly. Do not use other tools."
    )
    scenario.command(["herdr", "agent", "prompt", lead_name, once_request])
    scenario.wait_for_agent_text(
        lead_name, once_token, timeout=scenario.timeout_seconds, lines=200
    )
    once_pane = scenario.agent_pane(once_name)
    if once_pane:
        scenario.wait_for(
            "one-shot agent to exit after reporting",
            lambda: True if not scenario.agent_present(once_pane) else None,
            timeout=30,
        )
    print("PASS: one-shot scout reported its result and exited.")
    print(
        f"Herdr workspace left open: {scenario.workspace_id} "
        f"(tab {scenario.tab_id}; lead {lead_name}; worker {worker_pane}; scout {scout_pane})."
    )


def main() -> int:
    """Run the scenario and leave the Herdr workspace and artifacts in place."""
    scenario: HerdrScenario | None = None
    try:
        scenario = HerdrScenario(ROOT)
        run_scenario(scenario)
    except (ScenarioError, OSError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        if scenario and scenario.workspace_id:
            print(
                f"Herdr workspace left open: {scenario.workspace_id}; no cleanup was performed.",
                file=sys.stderr,
            )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
