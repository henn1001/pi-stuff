"""Exercise parent-to-child and child-to-parent send_message delivery."""

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
    wait_for_crew_message,
    wait_for_settled,
)

DEFINITION = "it-message-worker"
DESCRIPTION = "Interactive messaging integration worker"


def _has_assignment_for(value: dict[str, Any], session_id: str) -> bool:
    return any(
        isinstance(row, dict)
        and row.get("agent_id") == session_id
        and row.get("assignment_state") == "outstanding"
        for row in value.get("agents", [])
    )


def run(runtime: Runtime) -> None:
    """Verify message acceptance, exact-session delivery, and non-settlement of work."""
    run_id, lead_name = prepare_workspace(runtime, "it004")
    runtime.write_definition(DEFINITION, description=DESCRIPTION, auto_exit=False)
    runtime.start_lead(lead_name)
    activate_crew(runtime, lead_name)
    assert runtime.lead_session_id
    pane_id = spawn_menu_agent(runtime, DEFINITION)
    member_start = wait_for_agent_start(runtime, DEFINITION)
    member_id = member_start["sessionId"]
    child_reply = f"CHILD_MESSAGE_REPLY_{run_id}"
    parent_message = f"PARENT_MESSAGE_{run_id}"
    child_release = f"release-message-{run_id.lower()}"

    runtime.write_plan(
        [
            {
                "waitForFile": str(runtime.output / child_release),
                "tool": "send_message",
                "args": {"target": runtime.lead_session_id, "message": child_reply},
            },
            {"text": "Child message submitted."},
        ],
        agent=DEFINITION,
    )
    runtime.write_plan(
        [
            {
                "tool": "send_message",
                "args": {"target": member_id, "message": parent_message},
            },
            {"text": "Parent message accepted."},
            {"text": "Child reply processed."},
            {"tool": "list_agents", "args": {}},
            {"text": "Assignment state checked."},
        ]
    )
    close_spawn_picker(runtime)

    lead_message_offset = len(runtime.events())
    runtime.herdr(
        [
            "agent",
            "prompt",
            lead_name,
            "Send the child its integration message.",
            "--wait",
            "--timeout",
            "90000",
        ],
        timeout=100,
    )
    wait_for_settled(runtime, runtime.lead_session_id, start_at=lead_message_offset)
    child_message = wait_for_crew_message(
        runtime,
        member_id,
        parent_message,
        start_at=lead_message_offset,
    )
    child_context = runtime.wait_for_custom_context_message(
        member_id, parent_message, start_at=lead_message_offset
    )
    parent_ack = wait_for_context_object(
        runtime,
        lambda value: (
            value.get("accepted") is True and value.get("agent_id") == member_id
        ),
        "lead send_message result acknowledging the child agent ID",
    )
    assert child_message["payload"]["messageType"] == "crew"
    assert parent_message in str(child_context["payload"].get("messages", []))
    assert requests_for_agent(runtime, DEFINITION)

    child_response_offset = len(runtime.events())
    runtime.release(child_release)
    lead_message = wait_for_crew_message(
        runtime,
        runtime.lead_session_id,
        child_reply,
        start_at=child_response_offset,
    )
    lead_context = runtime.wait_for_custom_context_message(
        runtime.lead_session_id,
        child_reply,
        start_at=child_response_offset,
    )
    wait_for_settled(runtime, member_id, start_at=child_response_offset)
    wait_for_settled(runtime, runtime.lead_session_id, start_at=child_response_offset)
    child_ack = wait_for_context_object(
        runtime,
        lambda value: (
            value.get("accepted") is True
            and value.get("agent_id") == runtime.lead_session_id
        ),
        "child send_message result acknowledging the lead agent ID",
        agent=DEFINITION,
    )
    assert lead_message["payload"]["messageType"] == "crew"
    assert child_reply in str(lead_context["payload"].get("messages", []))
    assert any(pane.get("pane_id") == pane_id for pane in runtime.pane_list())

    state_check_offset = len(runtime.events())
    runtime.herdr(
        [
            "agent",
            "prompt",
            lead_name,
            "Inspect the child's assignment after its reply.",
            "--wait",
            "--timeout",
            "90000",
        ],
        timeout=100,
    )
    wait_for_settled(runtime, runtime.lead_session_id, start_at=state_check_offset)
    listing = wait_for_context_object(
        runtime,
        lambda value: _has_assignment_for(value, member_id),
        "list_agents result showing the child assignment remains outstanding",
    )
    child_row = next(
        row for row in listing["agents"] if row.get("agent_id") == member_id
    )
    assert child_row["assignment_state"] == "outstanding"
    runtime.record(
        "parent-child-message-roundtrip",
        {
            "child_session_id": member_id,
            "parent_message": parent_message,
            "child_reply": child_reply,
            "parent_ack": parent_ack,
            "child_ack": child_ack,
            "assignment_state_after_reply": child_row["assignment_state"],
        },
    )
