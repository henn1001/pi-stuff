"""Own a disposable Herdr workspace and provide bounded integration-test operations."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any


class IntegrationError(RuntimeError):
    """A setup, Herdr, or bounded-wait failure in an integration scenario."""


class Runtime:
    """Manage resources and evidence owned by one real-Pi integration run.

    The runtime never discovers or modifies existing workspaces. Its Herdr
    operations are scoped to the workspace created by ``create_workspace``.
    """

    def __init__(self, output: Path, *, keep_on_failure: bool = False) -> None:
        if os.environ.get("HERDR_ENV") != "1":
            raise IntegrationError(
                "Run the integration scenario inside a Herdr-managed pane (HERDR_ENV=1)."
            )

        self.root = Path(__file__).resolve().parents[2]
        self.output = output.expanduser().resolve()
        tmp_root = Path(tempfile.gettempdir()).resolve()
        repo_output_root = (self.root / "tests_tmp").resolve()
        allowed_roots = (tmp_root, repo_output_root)
        if not any(
            self.output != root and self.output.is_relative_to(root)
            for root in allowed_roots
        ):
            raise IntegrationError(
                f"Output must be a new directory under {tmp_root} or {repo_output_root}: {self.output}"
            )
        if self.output.exists():
            raise IntegrationError(f"Output directory already exists: {self.output}")
        if sys.platform != "linux":
            raise IntegrationError(
                "Crew integration scenarios require Linux and procfs."
            )
        if not all(
            shutil.which(command) for command in ("herdr", "pi", "flock", "stat")
        ):
            raise IntegrationError(
                "herdr, pi, flock, and stat must be available on PATH."
            )
        self.herdr_integration = self._find_herdr_pi_integration()

        self.keep_on_failure = keep_on_failure
        self.project = self.output / "project"
        self.agent_dir = Path(tempfile.mkdtemp(prefix=".crew-it-", dir=Path.home()))
        self.events_path = self.output / "events.jsonl"
        self.requests_path = self.output / "requests.jsonl"
        self.plan_path = self.output / "plan.json"
        self.workspace_id: str | None = None
        self.tab_id: str | None = None
        self.lead_pane_id: str | None = None
        self.lead_name: str | None = None
        self.lead_session_id: str | None = None
        self.created_panes: dict[str, str] = {}
        self.keep_resources = False
        self.results: list[dict[str, Any]] = []

        try:
            filesystem = self.command(
                ["stat", "-f", "-c", "%T", str(self.agent_dir)]
            ).strip()
            if filesystem not in {"ext2/ext3", "ext4", "xfs", "btrfs", "f2fs", "zfs"}:
                raise IntegrationError(
                    f"Pi agent home must use a supported local persistent filesystem; found {filesystem!r} at {self.agent_dir}."
                )
            self._check_socket_path_budget("w")
            self.output.mkdir(parents=True)
            self.output.chmod(0o700)
            self.project.mkdir()
            (self.project / ".pi" / "agents").mkdir(parents=True)
            self.plan_path.write_text("[]\n", encoding="utf-8")
        except Exception:
            shutil.rmtree(self.agent_dir, ignore_errors=True)
            if self.output.exists():
                shutil.rmtree(self.output, ignore_errors=True)
            raise

        try:
            fixture_dir = self.root / "tests" / "integration" / "fixtures"
            settings = {
                "extensions": [
                    str(self.herdr_integration),
                    str(fixture_dir / "observer.ts"),
                    str(fixture_dir / "provider.ts"),
                ],
                "offline": True,
            }
            settings_path = self.agent_dir / "settings.json"
            settings_path.write_text(
                json.dumps(settings, indent=2) + "\n", encoding="utf-8"
            )
            settings_path.chmod(0o600)

            self.workspace_env = {
                "PI_CODING_AGENT_DIR": str(self.agent_dir),
                "CREW_RUNTIME_EVENTS": str(self.events_path),
                "CREW_RUNTIME_PLAN": str(self.plan_path),
                "CREW_RUNTIME_REQUESTS": str(self.requests_path),
                "PI_OFFLINE": "1",
            }
        except Exception:
            shutil.rmtree(self.agent_dir, ignore_errors=True)
            shutil.rmtree(self.output, ignore_errors=True)
            raise

    def _find_herdr_pi_integration(self) -> Path:
        """Resolve Herdr's installed Pi state reporter without modifying user settings."""
        output = self.command(["herdr", "integration", "status"], timeout=15)
        for line in output.splitlines():
            if not line.startswith("pi:"):
                continue
            match = re.search(r"\(([^()]*)\)\s*$", line)
            if match:
                path = Path(match.group(1)).expanduser()
                if path.is_file():
                    return path
        raise IntegrationError(
            "Herdr's Pi integration is required for session identity reporting. "
            "Install it with `herdr integration install pi` and rerun."
        )

    def _check_socket_path_budget(self, workspace_id: str) -> None:
        """Reject output paths that cannot host Crew's bounded Unix socket paths."""
        socket_probe = (
            self.agent_dir / "crew" / "sockets" / workspace_id / ("b" * 36 + ".sock")
        )
        if len(os.fsencode(socket_probe)) > 100:
            raise IntegrationError(
                f"Pi agent home is too long for Crew Unix sockets ({len(os.fsencode(socket_probe))} bytes): {self.agent_dir}"
            )

    def command(self, argv: list[str], *, timeout: float = 15) -> str:
        """Run an argument-vector command and return stdout, including diagnostics on failure."""
        try:
            completed = subprocess.run(
                argv, check=False, capture_output=True, text=True, timeout=timeout
            )
        except subprocess.TimeoutExpired as error:
            raise IntegrationError(
                f"Command timed out after {timeout:g}s: {argv[0]}"
            ) from error
        if completed.returncode != 0:
            details = completed.stderr.strip() or completed.stdout.strip()
            raise IntegrationError(
                f"Command failed ({completed.returncode}): {argv[0]} {argv[1:]}\n{details}"
            )
        return completed.stdout

    def control(self, args: list[str], *, timeout: float = 15) -> str:
        """Run an owned Herdr control command whose response is intentionally not JSON."""
        return self.command(["herdr", *args], timeout=timeout)

    def herdr(self, args: list[str], *, timeout: float = 15) -> dict[str, Any]:
        """Run a Herdr command and return its JSON ``result`` object."""
        try:
            response = json.loads(self.command(["herdr", *args], timeout=timeout))
        except json.JSONDecodeError as error:
            raise IntegrationError(
                f"Herdr returned invalid JSON for {args[0]}."
            ) from error
        result = response.get("result")
        if not isinstance(result, dict):
            raise IntegrationError(f"Herdr returned no result object for {args[0]}.")
        return result

    def create_workspace(self, label_suffix: str) -> None:
        """Create the fresh test workspace and retain its returned resource IDs."""
        args = [
            "workspace",
            "create",
            "--cwd",
            str(self.project),
            "--label",
            f"crew-it-{label_suffix}",
            "--no-focus",
        ]
        for key, value in self.workspace_env.items():
            args.extend(["--env", f"{key}={value}"])
        result = self.herdr(args, timeout=30)
        workspace = result.get("workspace", {})
        tab = result.get("tab", {})
        root_pane = result.get("root_pane", {})
        self.workspace_id = workspace.get("workspace_id")
        self.tab_id = tab.get("tab_id")
        self.lead_pane_id = root_pane.get("pane_id")
        if not all((self.workspace_id, self.tab_id, self.lead_pane_id)):
            raise IntegrationError(
                "Herdr workspace creation response omitted an owned resource ID."
            )
        self._check_socket_path_budget(self.workspace_id)
        self.record("workspace-created", result)

    def start_lead(self, name: str) -> dict[str, Any]:
        """Start the real Crew-enabled Pi lead in the owned workspace root pane."""
        if not self.lead_pane_id:
            raise IntegrationError("Create the workspace before starting the lead.")
        self.lead_name = name
        extension = self.root / "src" / "index.ts"
        observer = self.root / "tests" / "integration" / "fixtures" / "observer.ts"
        provider = self.root / "tests" / "integration" / "fixtures" / "provider.ts"
        args = [
            "agent",
            "start",
            name,
            "--kind",
            "pi",
            "--pane",
            self.lead_pane_id,
            "--timeout",
            "90000",
            "--",
            "--no-extensions",
            "--no-builtin-tools",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-themes",
            "--offline",
            "--provider",
            "crew-validation",
            "--model",
            "deterministic",
            "--thinking",
            "low",
            "--extension",
            str(self.herdr_integration),
            "--extension",
            str(extension),
            "--extension",
            str(observer),
            "--extension",
            str(provider),
        ]
        result = self.herdr(args, timeout=100)
        start = self.wait_for_event(
            lambda event: (
                event.get("event") == "start" and event.get("pid") is not None
            ),
            "lead Pi startup observer event",
            timeout=15,
        )
        self.lead_session_id = start["sessionId"]
        self.wait_for(
            lambda: next(
                (
                    agent
                    for agent in self.agent_list()
                    if agent.get("pane_id") == self.lead_pane_id
                    and isinstance(agent.get("agent_session"), dict)
                    and agent["agent_session"].get("value")
                ),
                None,
            ),
            "Herdr Pi session identity for the lead",
            timeout=15,
        )
        self.record(
            "lead-started",
            {"agent": name, "pane_id": self.lead_pane_id, "event": start},
        )
        return result

    def write_definition(self, name: str, *, description: str, auto_exit: bool) -> Path:
        """Write a test-owned project agent definition with explicit lifecycle settings."""
        if not re.fullmatch(r"[a-z0-9-]+", name):
            raise IntegrationError(f"Invalid integration definition name: {name}")
        path = self.project / ".pi" / "agents" / f"{name}.md"
        path.write_text(
            "---\n"
            f"name: {name}\n"
            f"description: {description}\n"
            "tools: []\n"
            "skills: []\n"
            "spawning: false\n"
            f"auto-exit: {'true' if auto_exit else 'false'}\n"
            "---\n"
            "Deterministic integration-test agent. Follow the assigned message exactly.\n",
            encoding="utf-8",
        )
        return path

    def write_plan(
        self, steps: list[dict[str, Any]], *, agent: str | None = None
    ) -> Path:
        """Atomically replace the deterministic provider plan for the lead or a definition."""
        path = self.plan_path if agent is None else Path(f"{self.plan_path}.{agent}")
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(steps) + "\n", encoding="utf-8")
        temporary.replace(path)
        return path

    def release(self, gate: str) -> None:
        """Release a fixture provider request waiting on a scenario-owned gate file."""
        (self.output / gate).touch()

    def record(self, name: str, evidence: Any) -> None:
        """Append scenario evidence and persist the current result summary."""
        self.results.append({"name": name, "evidence": evidence})
        self._write_json(self.output / "results.json", self.results)

    def _write_json(self, path: Path, value: Any) -> None:
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(value, indent=2, default=str) + "\n", encoding="utf-8"
        )
        temporary.replace(path)

    def events(self) -> list[dict[str, Any]]:
        """Read complete observer events; tolerate only a partially written final line."""
        return self._read_jsonl(self.events_path)

    def requests(self) -> list[dict[str, Any]]:
        """Read model requests captured at the deterministic provider boundary."""
        return self._read_jsonl(self.requests_path)

    @staticmethod
    def _read_jsonl(path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        lines = path.read_text(encoding="utf-8").splitlines()
        values = []
        for index, line in enumerate(lines):
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                if index == len(lines) - 1:
                    break
                raise
            if isinstance(value, dict):
                values.append(value)
        return values

    def wait_for(
        self,
        predicate: Callable[[], Any],
        description: str,
        *,
        timeout: float = 30,
        interval: float = 0.2,
    ) -> Any:
        """Poll an observable condition until it succeeds or a monotonic deadline expires."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(interval)
        raise TimeoutError(f"Timed out after {timeout:g}s waiting for {description}.")

    def wait_for_event(
        self,
        predicate: Callable[[dict[str, Any]], bool],
        description: str,
        *,
        timeout: float = 30,
        start_at: int = 0,
    ) -> dict[str, Any]:
        """Wait for a matching Pi observer event after the supplied event offset."""
        return self.wait_for(
            lambda: next(
                (event for event in self.events()[start_at:] if predicate(event)), None
            ),
            description,
            timeout=timeout,
        )

    def wait_for_agent_pane(self, definition: str, *, timeout: float = 60) -> str:
        """Return the owned pane hosting a menu-spawned definition after Pi is recognized."""
        if not self.workspace_id:
            raise IntegrationError("Workspace has not been created.")

        def find() -> str | None:
            panes = self.herdr(["pane", "list", "--workspace", self.workspace_id]).get(
                "panes", []
            )
            pane = next(
                (
                    item
                    for item in panes
                    if item.get("label") == definition
                    or item.get("title") == definition
                ),
                None,
            )
            if not pane:
                return None
            pane_id = pane.get("pane_id")
            agents = self.herdr(["agent", "list"]).get("agents", [])
            if pane_id and any(agent.get("pane_id") == pane_id for agent in agents):
                return pane_id
            return None

        pane_id = self.wait_for(
            find, f"recognized pane for {definition}", timeout=timeout
        )
        self.created_panes[definition] = pane_id
        self.record(
            "agent-pane-created", {"definition": definition, "pane_id": pane_id}
        )
        return pane_id

    def wait_for_custom_context_message(
        self,
        session_id: str,
        needle: str,
        *,
        timeout: float = 30,
        start_at: int = 0,
    ) -> dict[str, Any]:
        """Wait until Pi's model context contains the actual Crew-delivered custom message."""

        def contains_message(event: dict[str, Any]) -> bool:
            if event.get("event") != "context" or event.get("sessionId") != session_id:
                return False
            messages = event.get("payload", {}).get("messages", [])
            return any(
                message.get("role") == "custom"
                and message.get("customType") == "crew"
                and needle in str(message.get("content", ""))
                for message in messages
                if isinstance(message, dict)
            )

        return self.wait_for_event(
            contains_message,
            f"{session_id} model context containing Crew message {needle!r}",
            timeout=timeout,
            start_at=start_at,
        )

    def read_agent(
        self, target: str, *, lines: int = 120, source: str = "recent-unwrapped"
    ) -> str:
        """Read terminal output from a Herdr-recognized agent or owned pane."""
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
            ],
            timeout=15,
        )

    def agent_list(self) -> list[dict[str, Any]]:
        """Return the current Herdr-recognized agents without inferring exit from connectivity."""
        return self.herdr(["agent", "list"]).get("agents", [])

    def pane_list(self) -> list[dict[str, Any]]:
        """Return panes in the owned workspace only."""
        if not self.workspace_id:
            return []
        return self.herdr(["pane", "list", "--workspace", self.workspace_id]).get(
            "panes", []
        )

    def snapshot(self) -> dict[str, Any]:
        """Capture current owned workspace topology and agent recognition for diagnostics."""
        snapshot: dict[str, Any] = {
            "workspace_id": self.workspace_id,
            "tab_id": self.tab_id,
            "lead_pane_id": self.lead_pane_id,
            "lead_name": self.lead_name,
            "lead_session_id": self.lead_session_id,
            "created_panes": self.created_panes,
            "output": str(self.output),
            "agent_home": str(self.agent_dir),
        }
        try:
            snapshot["panes"] = self.pane_list()
            snapshot["agents"] = self.agent_list()
        except Exception as error:  # noqa: BLE001
            snapshot["inspection_error"] = str(error)
        return snapshot

    def fail(self, error: BaseException, traceback_text: str) -> None:
        """Persist failure diagnostics and choose whether owned Herdr resources remain live."""
        error_text = f"{type(error).__name__}: {error}"
        self.keep_resources = self.keep_on_failure and self.workspace_id is not None
        failure = {
            "error": error_text,
            "traceback": traceback_text,
            "snapshot": self.snapshot(),
            "events": self.events(),
            "requests": self.requests(),
        }
        self._write_json(self.output / "failure.json", failure)

    def close(self, *, failed: bool) -> None:
        """Close only the owned workspace unless failure retention was explicitly requested."""
        if failed and self.keep_resources:
            print(
                "Retained failed integration workspace for inspection: "
                f"workspace={self.workspace_id} tab={self.tab_id} "
                f"lead_pane={self.lead_pane_id} output={self.output} agent_home={self.agent_dir}"
            )
            return
        if self.workspace_id:
            self.herdr(["workspace", "close", self.workspace_id], timeout=30)
            self.record("workspace-closed", {"workspace_id": self.workspace_id})
        if self.agent_dir.exists():
            shutil.rmtree(self.agent_dir)
