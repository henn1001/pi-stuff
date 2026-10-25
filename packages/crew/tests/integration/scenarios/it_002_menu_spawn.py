"""Exercise lead menu spawning and the interactive member lifecycle."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from runtime import Runtime
from scenarios.common import (
    activate_crew,
    close_spawn_picker,
    prepare_workspace,
    requests_for_agent,
    spawn_menu_agent,
    wait_for_agent_start,
    wait_for_agent_text,
    wait_for_context_object,
    wait_for_settled,
)

DEFINITION = "it-menu-worker"
DESCRIPTION = "Interactive menu-spawn integration worker"


def _listing_has_child(value: dict[str, Any], session_id: str) -> bool:
    return any(
        isinstance(row, dict) and row.get("agent_id") == session_id
        for row in value.get("agents", [])
    )


def run(runtime: Runtime) -> None:
    """Verify menu launch has no first turn and ignores the definition's auto-exit flag."""
    run_id, lead_name = prepare_workspace(runtime, "it002")
    runtime.write_definition(DEFINITION, description=DESCRIPTION, auto_exit=True)
    runtime.write_plan([{"text": f"MENU_MEMBER_REPLY_{run_id}"}], agent=DEFINITION)
    runtime.start_lead(lead_name)
    activate_crew(runtime, lead_name)

    focused_before = {
        pane.get("pane_id")
        for pane in runtime.pane_list()
        if pane.get("focused") is True
    }
    pane_id = spawn_menu_agent(runtime, DEFINITION)
    member_start = wait_for_agent_start(runtime, DEFINITION)
    member_id = member_start["sessionId"]
    picker_output = wait_for_agent_text(runtime, lead_name, "Spawn agent ·")
    assert f"{DEFINITION} — {DESCRIPTION}" in picker_output
    panes_after_spawn = runtime.pane_list()
    member_pane = next(
        pane for pane in panes_after_spawn if pane.get("pane_id") == pane_id
    )
    focused_after = {
        pane.get("pane_id") for pane in panes_after_spawn if pane.get("focused") is True
    }
    assert member_pane.get("focused") is not True
    assert focused_after == focused_before
    assert not requests_for_agent(runtime, DEFINITION)

    child_event_offset = len(runtime.events())
    runtime.herdr(
        [
            "agent",
            "prompt",
            pane_id,
            f"Return MENU_MEMBER_REPLY_{run_id} as plain text.",
            "--wait",
            "--timeout",
            "90000",
        ],
        timeout=100,
    )
    wait_for_settled(runtime, member_id, start_at=child_event_offset)
    assert any(pane.get("pane_id") == pane_id for pane in runtime.pane_list())
    assert member_start.get("pid") and Path(f"/proc/{member_start['pid']}").exists()
    assert not any(
        event.get("event") == "message_end"
        and event.get("sessionId") == runtime.lead_session_id
        and event.get("payload", {}).get("role") == "custom"
        for event in runtime.events()
    )
    wait_for_agent_text(runtime, lead_name, "Spawn agent ·")
    close_spawn_picker(runtime)

    runtime.write_plan(
        [
            {"tool": "list_agents", "args": {}},
            {"text": "Menu child listing checked."},
        ]
    )
    lead_event_offset = len(runtime.events())
    runtime.herdr(
        [
            "agent",
            "prompt",
            lead_name,
            "List the agent I spawned from the menu.",
            "--wait",
            "--timeout",
            "90000",
        ],
        timeout=100,
    )
    wait_for_settled(runtime, runtime.lead_session_id or "", start_at=lead_event_offset)
    listing = wait_for_context_object(
        runtime,
        lambda value: _listing_has_child(value, member_id),
        "list_agents result containing the menu-spawned child",
    )
    member_row = next(
        row for row in listing["agents"] if row.get("agent_id") == member_id
    )
    assert member_row["relationship"] == "child"
    assert member_row["agent_type"] == DEFINITION
    assert member_row["task_name"] is None
    assert member_row["assignment_state"] == "none"
    assert len(requests_for_agent(runtime, DEFINITION)) == 1
    runtime.record(
        "menu-spawned-interactive-member",
        {
            "session_id": member_id,
            "pane_id": pane_id,
            "pid": member_start["pid"],
            "definition": DEFINITION,
            "assignment_state": member_row["assignment_state"],
        },
    )
