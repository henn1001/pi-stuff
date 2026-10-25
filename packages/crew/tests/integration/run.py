#!/usr/bin/env python3
"""Run one named Crew integration scenario or the complete suite."""

from __future__ import annotations

import argparse
import signal
import sys
import traceback
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from scenarios import (
    it_001_activation,
    it_002_menu_spawn,
    it_003_list_agents,
    it_004_messaging,
    it_005_tool_spawn,
    smoke,
)

from runtime import Runtime

# Scenario implementations operate only through the resource-owning runtime.
Scenario = Callable[[Runtime], None]
PROJECT_ROOT = Path(__file__).resolve().parents[2]

SCENARIOS: dict[str, Scenario] = {
    "it-001": it_001_activation.run,
    "it-002": it_002_menu_spawn.run,
    "it-003": it_003_list_agents.run,
    "it-004": it_004_messaging.run,
    "it-005": it_005_tool_spawn.run,
    "smoke": smoke.run,
}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse optional scenario and output paths, defaulting to all scenarios."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario",
        choices=sorted(SCENARIOS),
        help="run only this scenario; default: all",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="output directory for one scenario, or parent directory when running all",
    )
    parser.add_argument(
        "--keep-on-failure",
        action="store_true",
        help="leave each failed scenario's Herdr workspace and Pi processes open",
    )
    parser.add_argument("--list", action="store_true", help="list available scenarios")
    return parser.parse_args(argv)


def _output_for_scenario(
    output: Path | None, timestamp: str, scenario: str, *, run_all: bool
) -> Path:
    """Choose a fresh per-scenario evidence directory under the selected output root."""
    if output is None:
        return PROJECT_ROOT / "tests_tmp" / f"{timestamp}_{scenario}"
    if run_all:
        return output.expanduser() / f"{timestamp}_{scenario}"
    return output.expanduser()


def _run_scenario(
    name: str,
    output: Path,
    timestamp: str,
    *,
    keep_on_failure: bool,
) -> int:
    """Run one scenario, retain diagnostics, and clean up only its owned resources."""
    runtime: Runtime | None = None
    failed = False
    exit_code = 1
    failure_message: str | None = None

    try:
        runtime = Runtime(output, keep_on_failure=keep_on_failure)
        runtime.record(
            "run-started",
            {
                "scenario": name,
                "run_timestamp": timestamp,
                "started_at": datetime.now(UTC).isoformat(),
                "python": sys.version,
                "platform": sys.platform,
                "output": str(runtime.output),
            },
        )
        SCENARIOS[name](runtime)
        runtime.record(
            "scenario-complete",
            {
                "scenario": name,
                "completed_at": datetime.now(UTC).isoformat(),
            },
        )
    except BaseException as error:  # noqa: BLE001
        failed = True
        exit_code = 130 if isinstance(error, (KeyboardInterrupt, SystemExit)) else 1
        failure_message = f"{type(error).__name__}: {error}"
        if runtime:
            try:
                runtime.fail(error, traceback.format_exc())
            except Exception as diagnostic_error:  # noqa: BLE001
                print(
                    f"Could not persist failure diagnostics: {diagnostic_error}",
                    file=sys.stderr,
                )
    finally:
        if runtime:
            try:
                runtime.close(failed=failed)
            except Exception as error:  # noqa: BLE001
                failed = True
                exit_code = 1
                failure_message = f"Cleanup failed: {error}"
                print(f"{failure_message}", file=sys.stderr)
                if not runtime.keep_resources:
                    print(
                        f"Inspect remaining owned resources and evidence under {runtime.output}",
                        file=sys.stderr,
                    )

    if failed:
        print(f"FAIL: {name}: {failure_message}", file=sys.stderr)
        if runtime:
            print(f"Failure evidence: {runtime.output}", file=sys.stderr)
        else:
            print(f"Output path: {output}", file=sys.stderr)
        return exit_code

    assert runtime is not None
    print(f"PASS: {name}; evidence: {runtime.output}")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Run selected scenarios sequentially with one shared output timestamp."""
    options = parse_args(argv)
    if options.list:
        for name in sorted(SCENARIOS):
            print(name)
        return 0

    scenario_names = [options.scenario] if options.scenario else sorted(SCENARIOS)
    run_all = options.scenario is None
    timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")

    def terminate(signum: int, _frame: object) -> None:
        raise SystemExit(f"integration runner received signal {signum}")

    signal.signal(signal.SIGTERM, terminate)
    failures: list[str] = []
    for name in scenario_names:
        output = _output_for_scenario(options.output, timestamp, name, run_all=run_all)
        result = _run_scenario(
            name,
            output,
            timestamp,
            keep_on_failure=options.keep_on_failure,
        )
        if result == 130:
            return result
        if result:
            failures.append(name)

    if failures:
        print(
            f"FAIL: {len(failures)} scenario(s): {', '.join(failures)}", file=sys.stderr
        )
        return 1
    if run_all:
        print(f"PASS: all {len(scenario_names)} scenarios; timestamp: {timestamp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
