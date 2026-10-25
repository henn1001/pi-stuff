"""Shared setup and evidence helpers for focused integration cases."""

from __future__ import annotations

import json
import secrets
from collections.abc import Callable, Iterator
from typing import Any

from runtime import Runtime


def prepare_workspace(runtime: Runtime, case_id: str) -> tuple[str, str]:
    """Create a fresh project workspace and return its run ID and lead name."""
    run_id = secrets.token_hex(3).upper()
    lead_name = f"crew-{case_id}-{run_id.lower()}"
    runtime.create_workspace(f"{case_id}-{run_id.lower()}")
    return run_id, lead_name


def start_lead(runtime: Runtime, case_id: str) -> tuple[str, str]:
    """Create a fresh workspace and start a Crew-capable lead without activating Crew."""
    run_id, lead_name = prepare_workspace(runtime, case_id)
    runtime.start_lead(lead_name)
    return run_id, lead_name


def activate_crew(runtime: Runtime, lead_name: str) -> None:
    """Activate the dormant lead and wait for its Herdr pane label."""
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
    runtime.record(
        "lead-activated",
        {"session_id": runtime.lead_session_id, "pane_id": runtime.lead_pane_id},
    )


def wait_for_agent_text(
    runtime: Runtime, target: str, needle: str, *, timeout: float = 20
) -> str:
    """Wait until a Herdr agent's visible terminal output contains the requested text."""
    return runtime.wait_for(
        lambda: (
            output
            if needle
            in (output := runtime.read_agent(target, source="visible", lines=120))
            else None
        ),
        f"{target} terminal output containing {needle!r}",
        timeout=timeout,
    )


def spawn_menu_agent(runtime: Runtime, definition: str) -> str:
    """Spawn a project definition from the lead's actual picker and leave it open."""
    assert runtime.lead_name and runtime.lead_pane_id
    runtime.herdr(["agent", "prompt", runtime.lead_name, "/crew"])
    wait_for_agent_text(runtime, runtime.lead_name, "Spawn agent")
    runtime.herdr(["agent", "send-keys", runtime.lead_name, "enter"])
    wait_for_agent_text(runtime, runtime.lead_name, "Spawn agent ·")
    runtime.control(["pane", "send-text", runtime.lead_pane_id, definition])
    runtime.herdr(["agent", "send-keys", runtime.lead_name, "enter"])
    pane_id = runtime.wait_for_agent_pane(definition)
    wait_for_agent_text(runtime, runtime.lead_name, f"{definition} —")
    return pane_id


def close_spawn_picker(runtime: Runtime) -> None:
    """Close the spawn picker and its surrounding Crew menu with Escape."""
    assert runtime.lead_name
    runtime.herdr(["agent", "send-keys", runtime.lead_name, "esc"])
    runtime.herdr(["agent", "send-keys", runtime.lead_name, "esc"])


def wait_for_agent_start(
    runtime: Runtime, definition: str, *, timeout: float = 30
) -> dict[str, Any]:
    """Wait for the observed Pi session-start event of a named definition."""
    return runtime.wait_for_event(
        lambda event: (
            event.get("event") == "start" and event.get("agent") == definition
        ),
        f"{definition} Pi startup",
        timeout=timeout,
    )


def wait_for_crew_message(
    runtime: Runtime,
    session_id: str,
    needle: str,
    *,
    start_at: int = 0,
    timeout: float = 45,
) -> dict[str, Any]:
    """Wait for a Crew custom message event on the exact Pi session."""
    return runtime.wait_for_event(
        lambda event: (
            event.get("event") == "message_end"
            and event.get("sessionId") == session_id
            and event.get("payload", {}).get("role") == "custom"
            and event.get("payload", {}).get("messageType") == "crew"
            and needle in event.get("payload", {}).get("text", "")
        ),
        f"Crew message {needle!r} delivered to {session_id}",
        timeout=timeout,
        start_at=start_at,
    )


def wait_for_settled(
    runtime: Runtime,
    session_id: str,
    *,
    start_at: int = 0,
    timeout: float = 30,
) -> dict[str, Any]:
    """Wait for a Pi settled-turn event for the exact session."""
    return runtime.wait_for_event(
        lambda event: (
            event.get("event") == "agent_settled"
            and event.get("sessionId") == session_id
        ),
        f"{session_id} turn to settle",
        timeout=timeout,
        start_at=start_at,
    )


def requests_for_agent(runtime: Runtime, agent: str) -> list[dict[str, Any]]:
    """Return deterministic provider requests attributed to a lead or definition."""
    return [request for request in runtime.requests() if request.get("agent") == agent]


def _walk_json(value: Any) -> Iterator[Any]:
    """Yield nested JSON values, parsing tool-result strings that encode JSON."""
    yield value
    if isinstance(value, dict):
        for nested in value.values():
            yield from _walk_json(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_json(nested)
    elif isinstance(value, str):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return
        if isinstance(decoded, (dict, list)):
            yield from _walk_json(decoded)


def wait_for_context_object(
    runtime: Runtime,
    predicate: Callable[[dict[str, Any]], bool],
    description: str,
    *,
    agent: str = "lead",
    timeout: float = 30,
) -> dict[str, Any]:
    """Wait for a structured tool result embedded in a captured provider context."""

    def find() -> dict[str, Any] | None:
        for request in requests_for_agent(runtime, agent):
            for value in _walk_json(request.get("context", {})):
                if isinstance(value, dict) and predicate(value):
                    return value
        return None

    return runtime.wait_for(find, description, timeout=timeout)
