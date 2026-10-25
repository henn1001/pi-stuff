#!/usr/bin/env python3
"""Exercise lead succession while an interactive worker remains connected."""

from __future__ import annotations

import secrets
import sys
from datetime import UTC, datetime
from pathlib import Path

from herdr_scenario import HerdrScenario, ScenarioError

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "index.ts"


def run_scenario(scenario: HerdrScenario) -> None:
    """Verify a new independent lead can recover and message an existing worker."""
    run_id = f"{datetime.now(UTC):%H%M%S}-{secrets.token_hex(3)}"
    run_key = run_id.replace("-", "_").upper()
    first_lead = f"test-lead-{run_id}"
    successor = f"test-successor-{run_id}"
    worker = f"test-worker-{run_id}"
    first_token = f"CREW_SUCCESSION_FIRST_POEM_{run_key}"
    successor_token = f"CREW_SUCCESSION_SUCCESSOR_POEM_{run_key}"

    scenario.create_workspace(f"test-{run_id}")
    scenario.write_definition(
        worker,
        description="Interactive worker for a lead-succession scenario",
        auto_exit=False,
        instructions=(
            "When your parent sends a Crew message asking for a poem, write a four-line poem about being an "
            "interactive worker and include the exact marker requested in that message. Use list_agents to "
            "find your current parent's full agent_id, then send the complete poem to that parent with one "
            "send_message call. Repeat the same poem as ordinary assistant text. Do not call report_task. "
            "Stay connected."
        ),
    )

    scenario.start_lead(first_lead, EXTENSION)
    scenario.activate_crew()
    worker_pane = scenario.spawn_menu_agent(worker)

    first_request = (
        "Use list_agents to find the connected direct child whose agent_type is "
        f'"{worker}". Send it a separate send_message asking for a four-line poem about being an '
        f'interactive worker that includes the exact marker "{first_token}". Stop after sending the message; '
        "do not use other tools."
    )
    scenario.command(
        [
            "herdr",
            "agent",
            "prompt",
            first_lead,
            first_request,
            "--wait",
            "--timeout",
            str(scenario.timeout_ms),
        ],
        timeout=scenario.timeout_seconds + 30,
    )
    scenario.wait_for_agent_text(worker_pane, first_token, timeout=scenario.timeout_seconds)
    scenario.wait_for_agent_text(first_lead, first_token, timeout=scenario.timeout_seconds)
    scenario.require(
        scenario.agent_present(worker_pane),
        "Interactive worker exited before lead succession.",
    )
    print("PASS: the interactive worker received the request and returned its poem to the first lead.")

    if not scenario.lead_pane_id or not scenario.workspace_id:
        raise ScenarioError("The first lead workspace is missing its pane or workspace ID.")

    scenario.command(["herdr", "agent", "send-keys", first_lead, "ctrl+c", "ctrl+c"])
    scenario.wait_for(
        "the first lead process to exit",
        lambda: True if not scenario.agent_present(scenario.lead_pane_id) else None,
        timeout=30,
    )

    scenario.command(["herdr", "pane", "rename", scenario.lead_pane_id, f"crew-pending-{successor}"])
    scenario.command(
        [
            "herdr",
            "agent",
            "start",
            successor,
            "--kind",
            "pi",
            "--pane",
            scenario.lead_pane_id,
            "--timeout",
            "60000",
            "--",
            "--thinking",
            "low",
            "--crew-mode",
            "lead",
        ],
        timeout=90,
    )
    scenario.wait_for(
        "the successor to claim the existing workspace as lead",
        lambda: next(
            (
                pane
                for pane in scenario.pane_list()
                if pane.get("pane_id") == scenario.lead_pane_id and pane.get("label") == "lead"
            ),
            None,
        ),
        timeout=30,
    )
    scenario.lead_name = successor

    successor_request = (
        "Use list_agents to find the connected direct child whose agent_type is "
        f'"{worker}". Send it a separate send_message asking for a four-line poem about being an '
        f'interactive worker that includes the exact marker "{successor_token}". Stop after sending the message; '
        "do not use other tools."
    )
    scenario.command(
        [
            "herdr",
            "agent",
            "prompt",
            successor,
            successor_request,
            "--wait",
            "--timeout",
            str(scenario.timeout_ms),
        ],
        timeout=scenario.timeout_seconds + 30,
    )
    scenario.wait_for_agent_text(worker_pane, successor_token, timeout=scenario.timeout_seconds)
    scenario.wait_for_agent_text(successor, successor_token, timeout=scenario.timeout_seconds)
    scenario.require(
        scenario.agent_present(worker_pane),
        "Interactive worker exited during lead succession.",
    )
    print("PASS: a fresh Pi lead recovered the existing worker and received its follow-up poem.")
    print(
        f"Herdr workspace left open: {scenario.workspace_id} "
        f"(tab {scenario.tab_id}; first lead {first_lead}; successor {successor}; worker {worker_pane})."
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
