"""Exercise synchronous spawn results and automatic child completion."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from runtime import Runtime
from scenarios.common import (
    activate_crew,
    prepare_workspace,
    requests_for_agent,
    wait_for_agent_start,
    wait_for_context_object,
    wait_for_crew_message,
    wait_for_settled,
)

DEFINITION = "it-once-worker"
DESCRIPTION = "Non-interactive completion integration worker"


def _has_agent(value: dict[str, Any], session_id: str) -> bool:
    return any(
        isinstance(row, dict) and row.get("agent_id") == session_id
        for row in value.get("agents", [])
    )


def run(runtime: Runtime) -> None:
    """Verify tool launch correlation, initial assignment, and automatic result settlement."""
    run_id, lead_name = prepare_workspace(runtime, "it005")
    runtime.write_definition(DEFINITION, description=DESCRIPTION, auto_exit=True)
    task_name = f"it-once-{run_id.lower()}"
    initial_message = f"INITIAL_ASSIGNMENT_{run_id}"
    result_text = f"NON_INTERACTIVE_RESULT_{run_id}"
    child_release = f"release-completion-{run_id.lower()}"
    runtime.write_plan(
        [
            {
                "waitForFile": str(runtime.output / child_release),
                "text": result_text,
            }
        ],
        agent=DEFINITION,
    )
    runtime.write_plan(
        [
            {
                "tool": "spawn_agent",
                "args": {
                    "task_name": task_name,
                    "agent_type": DEFINITION,
                    "message": initial_message,
                },
            },
            {"text": "Spawn result received."},
            {"text": "Child outcome processed."},
            {"tool": "list_agents", "args": {}},
            {"text": "Settled assignment inspected."},
        ]
    )
    runtime.start_lead(lead_name)
    activate_crew(runtime, lead_name)
    assert runtime.lead_session_id

    lead_event_offset = len(runtime.events())
    runtime.herdr(
        [
            "agent",
            "prompt",
            lead_name,
            "Delegate the integration task to a non-interactive worker.",
            "--wait",
            "--timeout",
            "90000",
        ],
        timeout=100,
    )
    wait_for_settled(runtime, runtime.lead_session_id, start_at=lead_event_offset)
    child_start = wait_for_agent_start(runtime, DEFINITION)
    child_id = child_start["sessionId"]
    pane_id = runtime.wait_for_agent_pane(DEFINITION)
    spawn_result = wait_for_context_object(
        runtime,
        lambda value: (
            value.get("agent_id") == child_id and value.get("task_name") == task_name
        ),
        "spawn_agent result with the launched session ID and task name",
    )
    child_request = runtime.wait_for(
        lambda: next(
            (
                request
                for request in requests_for_agent(runtime, DEFINITION)
                if request.get("next", {}).get("waitForFile")
                == str(runtime.output / child_release)
            ),
            None,
        ),
        "child's initial model request waiting on its release gate",
        timeout=30,
    )
    assert initial_message in json.dumps(child_request.get("context", {}))

    result_offset = len(runtime.events())
    runtime.release(child_release)
    delivered = wait_for_crew_message(
        runtime,
        runtime.lead_session_id,
        result_text,
        start_at=result_offset,
        timeout=60,
    )
    result_context = runtime.wait_for_custom_context_message(
        runtime.lead_session_id,
        result_text,
        start_at=result_offset,
    )
    wait_for_settled(runtime, child_id, start_at=result_offset, timeout=60)
    wait_for_settled(
        runtime, runtime.lead_session_id, start_at=result_offset, timeout=60
    )
    delivered_text = delivered["payload"].get("text", "")
    assert delivered_text.endswith(f"] {result_text}")
    assert result_text in str(result_context["payload"].get("messages", []))
    assert len(requests_for_agent(runtime, DEFINITION)) == 1
    assert (
        requests_for_agent(runtime, DEFINITION)[0].get("next", {}).get("tool") is None
    )

    pid = child_start.get("pid")
    runtime.wait_for(
        lambda: (
            not any(pane.get("pane_id") == pane_id for pane in runtime.pane_list())
            and pid is not None
            and not Path(f"/proc/{pid}").exists()
        ),
        "automatic completion to close the child pane and Pi process",
        timeout=60,
    )

    listing_offset = len(runtime.events())
    runtime.herdr(
        [
            "agent",
            "prompt",
            lead_name,
            "Inspect the completed worker assignment.",
            "--wait",
            "--timeout",
            "90000",
        ],
        timeout=100,
    )
    wait_for_settled(runtime, runtime.lead_session_id, start_at=listing_offset)
    listing = wait_for_context_object(
        runtime,
        lambda value: _has_agent(value, child_id),
        "list_agents result containing the completed child",
    )
    child_row = next(
        row for row in listing["agents"] if row.get("agent_id") == child_id
    )
    assert child_row["assignment_state"] == "settled"
    assert child_row["process_state"] == "exited"
    runtime.record(
        "synchronous-spawn-and-automatic-completion",
        {
            "agent_id": spawn_result["agent_id"],
            "task_name": spawn_result["task_name"],
            "initial_message": initial_message,
            "result": delivered_text,
            "process_state": child_row["process_state"],
            "assignment_state": child_row["assignment_state"],
        },
    )
