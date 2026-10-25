"""Shared Herdr operations for directly runnable Crew scenario scripts."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any


class ScenarioError(RuntimeError):
    """A setup, Herdr command, or scenario assertion failure."""


class HerdrScenario:
    """Provide bounded Herdr operations without owning teardown or cleanup."""

    def __init__(self, project: Path) -> None:
        """Validate local prerequisites and use ``project`` as the workspace cwd."""
        self.project = project.resolve()
        if not self.project.is_dir():
            raise ScenarioError(f"Project directory not found: {self.project}")
        if os.environ.get("HERDR_ENV") != "1":
            raise ScenarioError("Run this scenario from a Herdr-managed pane (HERDR_ENV=1 is required).")
        for executable in ("herdr", "pi"):
            if not shutil.which(executable):
                raise ScenarioError(f"{executable} is not on PATH.")

        timeout_value = os.environ.get("CREW_SMOKE_TIMEOUT_MS", "180000")
        if not timeout_value.isdecimal() or int(timeout_value) < 1:
            raise ScenarioError("CREW_SMOKE_TIMEOUT_MS must be a positive integer.")
        self.timeout_ms = int(timeout_value)
        self.timeout_seconds = self.timeout_ms / 1000
        self.workspace_id: str | None = None
        self.tab_id: str | None = None
        self.lead_pane_id: str | None = None
        self.lead_name: str | None = None

    def command(self, argv: list[str], *, timeout: float = 15) -> str:
        """Run a command and include its output in failures."""
        try:
            completed = subprocess.run(
                argv,
                cwd=self.project,
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            raise ScenarioError(f"Command timed out after {timeout:g}s: {' '.join(argv)}") from error
        if completed.returncode != 0:
            details = completed.stderr.strip() or completed.stdout.strip()
            raise ScenarioError(f"Command failed ({completed.returncode}): {' '.join(argv)}\n{details}")
        return completed.stdout

    def herdr(self, args: list[str], *, timeout: float = 15) -> dict[str, Any]:
        """Run a Herdr command and return its JSON ``result`` object."""
        output = self.command(["herdr", *args], timeout=timeout)
        try:
            response = json.loads(output)
        except json.JSONDecodeError as error:
            raise ScenarioError(f"Herdr returned invalid JSON for {args[0]}.") from error
        result = response.get("result")
        if not isinstance(result, dict):
            raise ScenarioError(f"Herdr returned no result object for {args[0]}.")
        return result

    def create_workspace(self, label: str) -> None:
        """Create a new workspace rooted at the scenario project and retain its IDs."""
        result = self.herdr(
            [
                "workspace",
                "create",
                "--cwd",
                str(self.project),
                "--label",
                label,
                "--no-focus",
            ],
            timeout=30,
        )
        workspace = result.get("workspace", {})
        tab = result.get("tab", {})
        root_pane = result.get("root_pane", {})
        self.workspace_id = workspace.get("workspace_id")
        self.tab_id = tab.get("tab_id")
        self.lead_pane_id = root_pane.get("pane_id")
        if not all((self.workspace_id, self.tab_id, self.lead_pane_id)):
            raise ScenarioError("Herdr workspace creation omitted a workspace, tab, or pane ID.")

    def write_definition(
        self,
        name: str,
        *,
        description: str,
        instructions: str,
        auto_exit: bool,
    ) -> Path:
        """Write a unique project agent definition and leave it available for inspection."""
        if not re.fullmatch(r"[a-z0-9-]+", name):
            raise ScenarioError(f"Invalid agent definition name: {name}")
        agent_dir = self.project / ".pi" / "agents"
        path = agent_dir / f"{name}.md"
        if path.exists():
            raise ScenarioError(f"Agent definition already exists: {path}")
        agent_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "---\n"
            f"name: {name}\n"
            f"description: {description}\n"
            "tools: []\n"
            "skills: []\n"
            f"auto-exit: {'true' if auto_exit else 'false'}\n"
            "---\n"
            f"{instructions.strip()}\n",
            encoding="utf-8",
        )
        return path

    def start_lead(self, name: str, extension: Path) -> None:
        """Start Pi with the Crew extension in the new workspace's root pane."""
        if not self.lead_pane_id:
            raise ScenarioError("Create the workspace before starting the lead.")
        if not extension.is_file():
            raise ScenarioError(f"Crew extension entry point not found: {extension}")
        self.lead_name = name
        self.command(["herdr", "pane", "rename", self.lead_pane_id, f"crew-pending-{name}"])
        self.herdr(
            [
                "agent",
                "start",
                name,
                "--kind",
                "pi",
                "--pane",
                self.lead_pane_id,
                "--timeout",
                "60000",
                "--",
                "--thinking",
                "low",
            ],
            timeout=90,
        )

    def activate_crew(self) -> None:
        """Enable Crew in the lead and wait for Herdr to label its pane."""
        if not self.lead_name or not self.workspace_id or not self.lead_pane_id:
            raise ScenarioError("Start the lead before activating Crew.")
        self.command(["herdr", "agent", "prompt", self.lead_name, "/crew"])
        self.wait_for(
            "Crew to label the lead pane",
            lambda: next(
                (
                    pane
                    for pane in self.pane_list()
                    if pane.get("pane_id") == self.lead_pane_id and pane.get("label") == "lead"
                ),
                None,
            ),
            timeout=30,
        )

    def pane_list(self) -> list[dict[str, Any]]:
        """Return panes in this scenario's workspace."""
        if not self.workspace_id:
            raise ScenarioError("Create the workspace before listing its panes.")
        panes = self.herdr(["pane", "list", "--workspace", self.workspace_id]).get("panes")
        if not isinstance(panes, list):
            raise ScenarioError("Herdr returned no pane list.")
        return panes

    def agent_list(self) -> list[dict[str, Any]]:
        """Return Herdr's current agent list."""
        agents = self.herdr(["agent", "list"]).get("agents")
        if not isinstance(agents, list):
            raise ScenarioError("Herdr returned no agent list.")
        return agents

    def wait_for_agent_pane(self, definition: str, *, timeout: float = 60) -> str:
        """Wait until a project definition has a pane and Herdr recognizes its agent."""
        pane = self.wait_for(
            f"pane for agent definition {definition}",
            lambda: next(
                (pane for pane in self.pane_list() if pane.get("label") == definition),
                None,
            ),
            timeout=timeout,
        )
        pane_id = pane.get("pane_id")
        if not isinstance(pane_id, str) or not pane_id:
            raise ScenarioError(f"Herdr pane for {definition} has no pane ID.")
        self.wait_for(
            f"Herdr to recognize agent pane {pane_id}",
            lambda: pane_id if self.agent_present(pane_id) else None,
            timeout=timeout,
        )
        return pane_id

    def spawn_menu_agent(self, definition: str) -> str:
        """Spawn a menu agent through the lead's actual Crew picker."""
        if not self.lead_name or not self.lead_pane_id:
            raise ScenarioError("Start the lead before spawning a menu agent.")
        self.command(["herdr", "agent", "prompt", self.lead_name, "/crew"])
        self.wait_for_agent_text(self.lead_name, "Spawn agent", timeout=15, source="visible")
        self.command(["herdr", "agent", "send-keys", self.lead_name, "enter"])
        self.wait_for_agent_text(self.lead_name, "Spawn agent ·", timeout=15, source="visible")
        self.command(["herdr", "pane", "send-text", self.lead_pane_id, definition])
        self.command(["herdr", "agent", "send-keys", self.lead_name, "enter"])
        pane_id = self.wait_for_agent_pane(definition)
        self.command(["herdr", "agent", "send-keys", self.lead_name, "esc"])
        self.command(["herdr", "agent", "send-keys", self.lead_name, "esc"])
        return pane_id

    def agent_output(self, target: str, *, source: str = "recent-unwrapped", lines: int = 120) -> str:
        """Read an agent terminal snapshot using Herdr's selected output source."""
        return self.command(
            [
                "herdr",
                "agent",
                "read",
                target,
                "--source",
                source,
                "--lines",
                str(lines),
            ]
        )

    def wait_for_agent_text(
        self,
        target: str,
        needle: str,
        *,
        timeout: float = 20,
        source: str = "recent-unwrapped",
        lines: int = 120,
    ) -> str:
        """Wait for ``needle`` to appear in an agent's terminal snapshot."""

        def find_text() -> str | None:
            try:
                output = self.agent_output(target, source=source, lines=lines)
            except ScenarioError as error:
                if "agent_not_idle" in str(error):
                    return None
                raise
            return output if needle in output else None

        return self.wait_for(
            f"{target} terminal output containing {needle!r}",
            find_text,
            timeout=timeout,
        )

    def agent_present(self, pane_id: str) -> bool:
        """Return whether Herdr currently recognizes an agent in ``pane_id``."""
        return any(agent.get("pane_id") == pane_id for agent in self.agent_list())

    def agent_pane(self, definition: str) -> str | None:
        """Return a pane ID currently labeled or titled with an agent definition."""
        pane = next(
            (pane for pane in self.pane_list() if pane.get("label") == definition or pane.get("title") == definition),
            None,
        )
        pane_id = pane.get("pane_id") if pane else None
        return pane_id if isinstance(pane_id, str) else None

    def wait_for(
        self,
        description: str,
        probe: Callable[[], Any | None],
        *,
        timeout: float,
    ) -> Any:
        """Poll a probe until it returns a truthy value or the deadline expires."""
        deadline = time.monotonic() + timeout
        while True:
            value = probe()
            if value:
                return value
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ScenarioError(f"Timed out after {timeout:g}s waiting for {description}.")
            time.sleep(min(0.25, remaining))

    def require(self, condition: bool, message: str) -> None:
        """Fail the scenario when a simple assertion is false."""
        if not condition:
            raise ScenarioError(message)
