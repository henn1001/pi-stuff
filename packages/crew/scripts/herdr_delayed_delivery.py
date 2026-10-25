#!/usr/bin/env python3
"""Exercise delayed messages across worker resumption and lead succession."""

from __future__ import annotations

import re
import secrets
import sys
from datetime import UTC, datetime
from pathlib import Path

from herdr_scenario import HerdrScenario, ScenarioError

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "index.ts"


def wait_for_generated_marker(
    scenario: HerdrScenario,
    target: str,
    prefix: str,
    *,
    timeout: float,
) -> str:
    """Wait for a poem's generated marker, not just its requested prefix."""
    marker_pattern = re.compile(rf"{re.escape(prefix)}[A-Z]{{8}}")

    def find_marker() -> str | None:
        try:
            output = scenario.agent_output(target, lines=200)
        except ScenarioError as error:
            if "agent_not_idle" in str(error):
                return None
            raise
        match = marker_pattern.search(output)
        return match.group(0) if match else None

    return scenario.wait_for(
        f"{target} to generate a poem marker matching {prefix} plus eight letters",
        find_marker,
        timeout=timeout,
    )


def run_scenario(scenario: HerdrScenario) -> None:
    """Verify queued delivery to a closed worker and from a worker to a successor lead."""
    run_id = f"{datetime.now(UTC):%H%M%S}-{secrets.token_hex(3)}"
    first_lead = f"delay-lead-{run_id}"
    successor = f"delay-next-{run_id}"
    worker = f"delay-worker-{run_id}"
    first_prefix = "DELAYED_FIRST_POEM_"
    second_prefix = "DELAYED_SECOND_POEM_"

    scenario.create_workspace(f"test-delivery-{run_id}")
    scenario.write_definition(
        worker,
        description="Interactive worker for delayed Crew message delivery",
        auto_exit=False,
        instructions=(
            "For the first Crew message asking for a poem, write a four-line poem about being a worker. "
            f"Invent a unique marker beginning with {first_prefix} and followed by exactly eight uppercase "
            "letters. Find your parent's full agent_id with list_agents, then send the complete poem to that "
            "parent with one send_message call. After it returns accepted: true, repeat the complete poem as "
            "ordinary assistant text. Do not call report_task. Stay connected.\n\n"
            "For a later Crew message asking for another poem, write a different four-line worker poem. "
            f"Invent a unique marker beginning with {second_prefix} and followed by exactly eight uppercase "
            "letters. Repeat the complete poem as ordinary assistant text, but do not send it to your parent "
            "yet. Stay connected.\n\n"
            "If a user later asks you to return that second poem, use list_agents to find your recorded parent's "
            "full agent_id and send the complete second poem to that parent with one send_message call. After "
            "the tool returns accepted: true, output DELAYED_UPWARD_ACCEPTED_ followed by the eight-letter "
            "suffix of the second poem marker. Do not call report_task. Stay connected."
        ),
    )

    scenario.start_lead(first_lead, EXTENSION)
    scenario.activate_crew()
    worker_pane = scenario.spawn_menu_agent(worker)

    first_request = (
        "Use list_agents to find the connected direct child whose agent_type is "
        f'"{worker}". Send it a separate send_message asking for a four-line poem about being a worker. '
        f"Ask it to invent a unique marker beginning with {first_prefix} and followed by exactly eight "
        "uppercase letters, then send the complete poem back to you with send_message. Stop after sending "
        "the request; do not use other tools."
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
    first_marker = wait_for_generated_marker(scenario, worker_pane, first_prefix, timeout=scenario.timeout_seconds)
    scenario.wait_for_agent_text(first_lead, first_marker, timeout=scenario.timeout_seconds, lines=200)
    print("PASS: the worker generated and returned its first poem to the lead.")

    scenario.command(["herdr", "agent", "send-keys", worker_pane, "ctrl+c", "ctrl+c"])
    scenario.wait_for(
        "the worker process to exit",
        lambda: True if not scenario.agent_present(worker_pane) else None,
        timeout=30,
    )

    second_request = (
        "Use list_agents to find the recorded direct child whose agent_type is "
        f'"{worker}". Send it a separate send_message asking for a different four-line worker poem. '
        f"Ask it to invent a unique marker beginning with {second_prefix} and followed by exactly eight "
        "uppercase letters. It should display the poem as ordinary assistant text and remain connected; do "
        "not ask it to message you back yet. Stop after sending the request; do not use other tools."
    )
    scenario.command(
        [
            "herdr",
            "agent",
            "prompt",
            first_lead,
            second_request,
            "--wait",
            "--timeout",
            str(scenario.timeout_ms),
        ],
        timeout=scenario.timeout_seconds + 30,
    )
    resumed_worker_pane = scenario.wait_for_agent_pane(worker, timeout=scenario.timeout_seconds)
    second_marker = wait_for_generated_marker(
        scenario, resumed_worker_pane, second_prefix, timeout=scenario.timeout_seconds
    )
    scenario.require(
        scenario.agent_present(resumed_worker_pane),
        "The worker did not remain connected after receiving its queued poem request.",
    )
    print("PASS: the queued request resumed the worker and was delivered after it connected.")

    if not scenario.lead_pane_id or not scenario.workspace_id:
        raise ScenarioError("The lead workspace is missing its pane or workspace ID.")

    scenario.command(["herdr", "agent", "send-keys", first_lead, "ctrl+c", "ctrl+c"])
    scenario.wait_for(
        "the first lead process to exit",
        lambda: True if not scenario.agent_present(scenario.lead_pane_id) else None,
        timeout=30,
    )
    scenario.require(
        scenario.agent_present(resumed_worker_pane),
        "The worker exited when the first lead closed.",
    )

    suffix = second_marker.rsplit("_", 1)[1]
    accepted_marker = f"DELAYED_UPWARD_ACCEPTED_{suffix}"
    return_request = (
        "Use list_agents to find your recorded parent's full agent_id. Send that parent the complete second "
        f"poem you just generated, including the exact marker {second_marker}, with one send_message call. "
        f"After the tool returns accepted: true, output {accepted_marker} as ordinary assistant text."
    )
    scenario.command(
        [
            "herdr",
            "agent",
            "prompt",
            resumed_worker_pane,
            return_request,
            "--wait",
            "--timeout",
            str(scenario.timeout_ms),
        ],
        timeout=scenario.timeout_seconds + 30,
    )
    scenario.wait_for_agent_text(
        resumed_worker_pane,
        accepted_marker,
        timeout=scenario.timeout_seconds,
        lines=200,
    )
    print("PASS: the worker accepted its upward message while the lead was offline.")

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
        "the successor to claim the workspace as lead",
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
    scenario.wait_for_agent_text(successor, second_marker, timeout=scenario.timeout_seconds, lines=240)
    print("PASS: the successor lead received the worker's message queued during the outage.")
    print(
        f"Herdr workspace left open: {scenario.workspace_id} "
        f"(tab {scenario.tab_id}; first lead {first_lead}; successor {successor}; "
        f"worker pane {resumed_worker_pane})."
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
