"""Exercise dormant-lead activation and its role-scoped menu."""

from __future__ import annotations

from runtime import Runtime
from scenarios.common import start_lead, wait_for_agent_text


def run(runtime: Runtime) -> None:
    """Verify activation and menu presentation do not invoke the model."""
    _, lead_name = start_lead(runtime, "it001")
    assert runtime.lead_pane_id
    event_offset = len(runtime.events())
    request_count = len(runtime.requests())

    runtime.herdr(["agent", "prompt", lead_name, "/crew"])
    runtime.wait_for(
        lambda: next(
            (
                pane
                for pane in runtime.pane_list()
                if pane.get("pane_id") == runtime.lead_pane_id
                and pane.get("label") == "lead"
            ),
            None,
        ),
        "Crew activation to label the lead pane",
        timeout=30,
    )
    activation_output = wait_for_agent_text(runtime, lead_name, "Crew enabled")
    assert "Spawn agent" not in activation_output
    wait_for_agent_text(runtime, lead_name, "0 connected")

    runtime.herdr(["agent", "prompt", lead_name, "/crew"])
    menu_output = wait_for_agent_text(runtime, lead_name, "Spawn agent")
    assert "Connected agents" in menu_output
    assert len(runtime.requests()) == request_count
    assert not any(
        event.get("event") in {"context", "turn_end"}
        for event in runtime.events()[event_offset:]
    )
    runtime.record(
        "activation-and-lead-menu",
        {
            "pane_id": runtime.lead_pane_id,
            "activation_output": activation_output,
            "menu_visible": all(
                label in menu_output for label in ("Spawn agent", "Connected agents")
            ),
            "provider_requests": len(runtime.requests()) - request_count,
        },
    )
