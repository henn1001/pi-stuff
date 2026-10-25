"""Exercise the lead's read-only direct-child listing."""

from __future__ import annotations

from typing import Any

from runtime import Runtime
from scenarios.common import (
    activate_crew,
    close_spawn_picker,
    prepare_workspace,
    requests_for_agent,
    spawn_menu_agent,
    wait_for_agent_start,
    wait_for_context_object,
    wait_for_settled,
)

DEFINITION = "it-list-worker"
DESCRIPTION = "Read-only listing integration worker"
REQUIRED_AGENT_FIELDS = {
    "entry_kind",
    "launch_state",
    "launch_error",
    "agent_id",
    "task_name",
    "agent_type",
    "relationship",
    "activity",
    "connectivity",
    "process_state",
    "resumability",
    "assignment_state",
    "outstanding_child_assignments",
    "unprocessed_child_outcomes",
}


def _contains_child(value: dict[str, Any], session_id: str) -> bool:
    return any(
        isinstance(row, dict) and row.get("agent_id") == session_id
        for row in value.get("agents", [])
    )


def run(runtime: Runtime) -> None:
    """Verify list_agents exposes the lead's child without changing Crew state or turns."""
    _, lead_name = prepare_workspace(runtime, "it003")
    runtime.write_definition(DEFINITION, description=DESCRIPTION, auto_exit=False)
    runtime.start_lead(lead_name)
    activate_crew(runtime, lead_name)
    pane_id = spawn_menu_agent(runtime, DEFINITION)
    member_start = wait_for_agent_start(runtime, DEFINITION)
    member_id = member_start["sessionId"]
    close_spawn_picker(runtime)

    runtime.write_plan(
        [
            {"tool": "list_agents", "args": {}},
            {"text": "Direct-child listing checked."},
        ]
    )
    request_count_before = len(runtime.requests())
    event_offset = len(runtime.events())
    runtime.herdr(
        [
            "agent",
            "prompt",
            lead_name,
            "List my direct agents.",
            "--wait",
            "--timeout",
            "90000",
        ],
        timeout=100,
    )
    wait_for_settled(runtime, runtime.lead_session_id or "", start_at=event_offset)

    listing = wait_for_context_object(
        runtime,
        lambda value: _contains_child(value, member_id),
        "list_agents result containing the menu-spawned child",
    )
    rows = listing["agents"]
    assert len(rows) == 1
    child = rows[0]
    assert REQUIRED_AGENT_FIELDS <= child.keys()
    assert child["entry_kind"] == "agent"
    assert child["agent_id"] == member_id
    assert child["relationship"] == "child"
    assert child["agent_type"] == DEFINITION
    assert child["task_name"] is None
    assert child["assignment_state"] == "none"
    assert child["outstanding_child_assignments"] == 0
    assert child["unprocessed_child_outcomes"] == 0
    assert child["activity"] in {"running", "idle", "unknown"}
    assert child["connectivity"] == "connected"
    assert child["process_state"] == "alive"
    assert child["resumability"] in {"eligible", "ineligible", "unknown"}
    assert not requests_for_agent(runtime, DEFINITION)
    assert len(runtime.requests()) - request_count_before == 2
    assert any(pane.get("pane_id") == pane_id for pane in runtime.pane_list())
    assert not any(
        event.get("event") == "message_end"
        and event.get("sessionId") == member_id
        and event.get("payload", {}).get("role") == "custom"
        for event in runtime.events()[event_offset:]
    )
    runtime.record(
        "read-only-direct-child-listing",
        {"agent": child, "lead_session_id": runtime.lead_session_id},
    )
