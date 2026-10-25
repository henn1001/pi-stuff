"""Exercise menu launches, explicit messages, and automatic completion in real Pi."""

from __future__ import annotations

import json
import secrets
import time
from pathlib import Path
from typing import Any

from runtime import Runtime

WORKER = "crew-it-worker"
SCOUT = "crew-it-scout"
ONESHOT = "crew-it-once"


def _wait_for_agent_text(
    runtime: Runtime, target: str, needle: str, *, timeout: float = 20
) -> str:
    return runtime.wait_for(
        lambda: (
            output
            if needle
            in (output := runtime.read_agent(target, source="visible", lines=100))
            else None
        ),
        f"{target} terminal output containing {needle!r}",
        timeout=timeout,
    )


def _spawn_menu_agent(runtime: Runtime, definition: str) -> str:
    """Select one project definition through the actual lead spawn picker."""
    assert runtime.lead_name and runtime.lead_pane_id
    runtime.herdr(["agent", "prompt", runtime.lead_name, "/crew"])
    _wait_for_agent_text(runtime, runtime.lead_name, "Spawn agent")
    runtime.herdr(["agent", "send-keys", runtime.lead_name, "enter"])
    _wait_for_agent_text(runtime, runtime.lead_name, "Spawn agent ·")
    runtime.control(["pane", "send-text", runtime.lead_pane_id, definition])
    runtime.herdr(["agent", "send-keys", runtime.lead_name, "enter"])
    pane_id = runtime.wait_for_agent_pane(definition)
    runtime.herdr(["agent", "send-keys", runtime.lead_name, "esc"])
    runtime.herdr(["agent", "send-keys", runtime.lead_name, "esc"])
    return pane_id


def _wait_for_crew_message(
    runtime: Runtime,
    session_id: str,
    needle: str,
    *,
    start_at: int,
    timeout: float = 45,
) -> dict[str, Any]:
    """Wait for a real Crew custom message delivered to an exact Pi session."""
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


def _contains_request(
    requests: list[dict[str, Any]], tool: str, value: str, *, agent: str | None = None
) -> bool:
    return any(
        (agent is None or request.get("agent") == agent)
        and request.get("next", {}).get("tool") == tool
        and value in json.dumps(request.get("next", {}).get("args", {}))
        for request in requests
    )


def run(runtime: Runtime) -> None:
    """Run the end-to-end smoke workflow using deterministic Pi model responses."""
    started_at = time.monotonic()
    run_id = secrets.token_hex(3).upper()
    lead_name = f"crew-it-lead-{run_id.lower()}"
    worker_token = f"CREW_WORKER_REPLY_{run_id}"
    scout_token = f"CREW_SCOUT_REPLY_{run_id}"
    oneshot_token = f"CREW_ONESHOT_RESULT_{run_id}"
    worker_release = f"release-worker-{run_id.lower()}"
    scout_release = f"release-scout-{run_id.lower()}"
    oneshot_release = f"release-once-{run_id.lower()}"

    runtime.write_definition(
        WORKER, description="Interactive integration worker", auto_exit=False
    )
    runtime.write_definition(
        SCOUT, description="Interactive integration scout", auto_exit=False
    )
    runtime.write_definition(
        ONESHOT, description="Automatic integration worker", auto_exit=True
    )
    runtime.record(
        "definitions-created", {"worker": WORKER, "scout": SCOUT, "oneshot": ONESHOT}
    )

    runtime.create_workspace(run_id.lower())
    runtime.start_lead(lead_name)

    # The first /crew activates the dormant lead; subsequent calls open the menu.
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

    worker_pane = _spawn_menu_agent(runtime, WORKER)
    scout_pane = _spawn_menu_agent(runtime, SCOUT)
    worker_start = runtime.wait_for_event(
        lambda event: event.get("event") == "start" and event.get("agent") == WORKER,
        f"{WORKER} Pi startup",
        timeout=30,
    )
    scout_start = runtime.wait_for_event(
        lambda event: event.get("event") == "start" and event.get("agent") == SCOUT,
        f"{SCOUT} Pi startup",
        timeout=30,
    )
    assert runtime.lead_session_id
    worker_id = worker_start["sessionId"]
    scout_id = scout_start["sessionId"]

    runtime.write_plan(
        [
            {
                "waitForFile": str(runtime.output / worker_release),
                "tool": "send_message",
                "args": {"target": runtime.lead_session_id, "message": worker_token},
            },
            {"text": "Worker reply sent."},
        ],
        agent=WORKER,
    )
    runtime.write_plan(
        [
            {
                "waitForFile": str(runtime.output / scout_release),
                "tool": "send_message",
                "args": {"target": runtime.lead_session_id, "message": scout_token},
            },
            {"text": "Scout reply sent."},
        ],
        agent=SCOUT,
    )
    runtime.write_plan(
        [
            {
                "tool": "send_message",
                "args": {
                    "target": worker_id,
                    "message": f"Reply with {worker_token} using send_message.",
                },
            },
            {"text": "Worker message accepted."},
            {"text": "Worker reply received."},
            {
                "tool": "send_message",
                "args": {
                    "target": scout_id,
                    "message": f"Reply with {scout_token} using send_message.",
                },
            },
            {"text": "Scout message accepted."},
            {"text": "Scout reply received."},
            {
                "tool": "spawn_agent",
                "args": {
                    "task_name": f"it-once-{run_id.lower()}",
                    "agent_type": ONESHOT,
                    "message": f"Return exactly {oneshot_token}.",
                },
            },
            {"text": "One-shot agent launched."},
            {"text": "One-shot result received."},
        ]
    )
    runtime.write_plan(
        [
            {
                "waitForFile": str(runtime.output / oneshot_release),
                "text": oneshot_token,
            },
        ],
        agent=ONESHOT,
    )

    # Gate child responses until the lead's initiating turn has settled. This
    # makes the provider plan order deterministic without changing Crew input.
    lead_event_offset = len(runtime.events())
    runtime.herdr(
        [
            "agent",
            "prompt",
            lead_name,
            "Send the worker its integration message.",
            "--wait",
            "--timeout",
            "90000",
        ],
        timeout=100,
    )
    runtime.wait_for_event(
        lambda event: (
            event.get("event") == "agent_settled"
            and event.get("sessionId") == runtime.lead_session_id
        ),
        "lead worker-message turn to settle",
        timeout=30,
        start_at=lead_event_offset,
    )
    assert _contains_request(
        runtime.requests(), "send_message", worker_id, agent="lead"
    )
    worker_response_offset = len(runtime.events())
    runtime.release(worker_release)
    worker_message = _wait_for_crew_message(
        runtime, runtime.lead_session_id, worker_token, start_at=worker_response_offset
    )
    worker_context = runtime.wait_for_custom_context_message(
        runtime.lead_session_id,
        worker_token,
        timeout=30,
        start_at=worker_response_offset,
    )
    runtime.wait_for(
        lambda: any(
            event.get("event") == "agent_settled"
            and event.get("sessionId") == runtime.lead_session_id
            for event in runtime.events()[worker_response_offset:]
        ),
        "lead to settle after processing the worker reply",
        timeout=30,
    )
    assert any(agent.get("pane_id") == worker_pane for agent in runtime.agent_list())
    runtime.record(
        "interactive-worker-message-roundtrip",
        {
            "worker_session_id": worker_id,
            "token": worker_token,
            "delivered_message": worker_message,
            "model_context": worker_context,
        },
    )

    scout_offset = len(runtime.events())
    runtime.herdr(
        [
            "agent",
            "prompt",
            lead_name,
            "Send the scout its integration message.",
            "--wait",
            "--timeout",
            "90000",
        ],
        timeout=100,
    )
    runtime.wait_for_event(
        lambda event: (
            event.get("event") == "agent_settled"
            and event.get("sessionId") == runtime.lead_session_id
        ),
        "lead scout-message turn to settle",
        timeout=30,
        start_at=scout_offset,
    )
    assert _contains_request(runtime.requests(), "send_message", scout_id, agent="lead")
    scout_response_offset = len(runtime.events())
    runtime.release(scout_release)
    scout_message = _wait_for_crew_message(
        runtime, runtime.lead_session_id, scout_token, start_at=scout_response_offset
    )
    scout_context = runtime.wait_for_custom_context_message(
        runtime.lead_session_id, scout_token, timeout=30, start_at=scout_response_offset
    )
    runtime.wait_for_event(
        lambda event: (
            event.get("event") == "agent_settled"
            and event.get("sessionId") == runtime.lead_session_id
        ),
        "lead to settle after processing the scout reply",
        timeout=30,
        start_at=scout_response_offset,
    )
    assert any(agent.get("pane_id") == scout_pane for agent in runtime.agent_list())
    runtime.record(
        "interactive-scout-message-roundtrip",
        {
            "scout_session_id": scout_id,
            "token": scout_token,
            "delivered_message": scout_message,
            "model_context": scout_context,
        },
    )

    once_offset = len(runtime.events())
    runtime.herdr(
        [
            "agent",
            "prompt",
            lead_name,
            "Run the one-shot integration task.",
            "--wait",
            "--timeout",
            "90000",
        ],
        timeout=100,
    )
    once_pane = runtime.wait_for_agent_pane(ONESHOT, timeout=60)
    once_start = runtime.wait_for_event(
        lambda event: event.get("event") == "start" and event.get("agent") == ONESHOT,
        f"{ONESHOT} Pi startup",
        timeout=30,
    )
    assert _contains_request(runtime.requests(), "spawn_agent", ONESHOT)
    runtime.wait_for_event(
        lambda event: (
            event.get("event") == "agent_settled"
            and event.get("sessionId") == runtime.lead_session_id
        ),
        "lead launch turn to settle before releasing the one-shot result",
        timeout=30,
        start_at=once_offset,
    )
    once_response_offset = len(runtime.events())
    runtime.release(oneshot_release)
    oneshot_message = _wait_for_crew_message(
        runtime,
        runtime.lead_session_id,
        oneshot_token,
        start_at=once_response_offset,
        timeout=60,
    )
    oneshot_context = runtime.wait_for_custom_context_message(
        runtime.lead_session_id,
        oneshot_token,
        timeout=30,
        start_at=once_response_offset,
    )
    runtime.wait_for_event(
        lambda event: (
            event.get("event") == "agent_settled"
            and event.get("sessionId") == runtime.lead_session_id
        ),
        "lead to settle after processing the one-shot result",
        timeout=30,
        start_at=once_response_offset,
    )
    pid = once_start.get("pid")
    runtime.wait_for(
        lambda: (
            not any(pane.get("pane_id") == once_pane for pane in runtime.pane_list())
            and (not pid or not Path(f"/proc/{pid}").exists())
        ),
        "one-shot pane and exact Pi process to exit after reporting",
        timeout=60,
    )
    runtime.record(
        "non-interactive-result-and-exit",
        {
            "session_id": once_start["sessionId"],
            "pane_id": once_pane,
            "pid": pid,
            "token": oneshot_token,
            "delivered_message": oneshot_message,
            "model_context": oneshot_context,
        },
    )
    runtime.record(
        "smoke-passed",
        {
            "lead_session_id": runtime.lead_session_id,
            "interactive_agents": [worker_id, scout_id],
            "one_shot_session_id": once_start["sessionId"],
            "elapsed_seconds": round(time.monotonic() - started_at, 3),
        },
    )
