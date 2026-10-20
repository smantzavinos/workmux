#!/usr/bin/env python3
"""Opt-in real Pi/pi-subagents/workmux smoke with a loopback-only fixture model.

Run from any directory; see CONTRIBUTING.md. Not collected by pytest. Requires
Pi, tmux, a built workmux binary and a compatible pi-subagents extension locally.
No packages are installed and no real credentials or model services are used.
"""

import argparse
import http.server
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "tests/fixtures/pi-subagents-smoke"


def rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def record(root: Path, filename: str, data: dict[str, Any]) -> None:
    with (root / filename).open("a") as stream:
        stream.write(json.dumps({"at": time.time(), **data}) + "\n")


def executable(value: str) -> str:
    resolved = shutil.which(value)
    if not resolved:
        raise argparse.ArgumentTypeError(f"Executable not found: {value}")
    return str(Path(resolved).absolute())


def fixture_model(root: Path) -> http.server.ThreadingHTTPServer:
    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            text = json.dumps(body.get("messages", [])[-1])
            delay = (
                6
                if "SMOKE_FAIL" in text
                else 24
                if "SMOKE_SLOW" in text or "SMOKE_STOP" in text
                else 0
            )
            record(root, "model.jsonl", {"phase": "start", "delay": delay})
            try:
                if delay == 6:
                    time.sleep(delay)
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(
                        json.dumps(
                            {
                                "error": {
                                    "message": "Deterministic smoke failure",
                                    "type": "invalid_request_error",
                                }
                            }
                        ).encode()
                    )
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    time.sleep(delay)
                    for delta, finish in [
                        ({"role": "assistant", "content": "Fixture complete."}, None),
                        ({}, "stop"),
                    ]:
                        data = {
                            "id": "smoke",
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": "fixture",
                            "choices": [
                                {"index": 0, "delta": delta, "finish_reason": finish}
                            ],
                        }
                        self.wfile.write(
                            ("data: " + json.dumps(data) + "\n\n").encode()
                        )
                        self.wfile.flush()
                    self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                record(root, "model.jsonl", {"phase": "complete", "delay": delay})
            except (BrokenPipeError, ConnectionResetError):
                # The stop scenario intentionally aborts its in-flight request.
                record(root, "model.jsonl", {"phase": "aborted", "delay": delay})

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    config = {
        "providers": {
            "smoke": {
                "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
                "api": "openai-completions",
                "apiKey": "dummy-fixture-only",
                "models": [
                    {
                        "id": "fixture",
                        "name": "Fixture",
                        "reasoning": False,
                        "input": ["text"],
                        "cost": {
                            "input": 0,
                            "output": 0,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                        },
                        "contextWindow": 64000,
                        "maxTokens": 1024,
                    }
                ],
            }
        }
    }
    (root / "agent/models.json").write_text(json.dumps(config))
    return server


def host(root: Path) -> None:
    """Run inside the private pane so all children inherit its real identity."""
    config = json.loads((root / "launch.json").read_text())
    server = fixture_model(root)
    command = [
        config["pi"],
        "--offline",
        "--mode",
        "rpc",
        "--no-extensions",
        "--extension",
        config["extension"],
        "--extension",
        config["owner"],
        "--extension",
        str(FIXTURES / "controller.ts"),
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-mcp",
        "--no-approve",
        "--model",
        "smoke/fixture",
        "--thinking",
        "off",
    ]
    with (
        (root / "pi.stdout.jsonl").open("w") as out,
        (root / "pi.stderr.log").open("w") as err,
    ):
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=out, stderr=err, cwd=root / "work"
        )
        assert process.stdin is not None
        record(
            root,
            "host.jsonl",
            {"phase": "started", "pid": process.pid, "pane": os.environ["TMUX_PANE"]},
        )
        try:
            deadline = time.monotonic() + config["timeout"] + 10
            sent_parent = False
            while time.monotonic() < deadline and not (root / "stop").exists():
                if process.poll() is not None:
                    raise RuntimeError(f"Pi exited: {process.returncode}")
                if (root / "launched").exists() and not sent_parent:
                    process.stdin.write(
                        (
                            json.dumps(
                                {
                                    "type": "prompt",
                                    "message": "Reply briefly; this is the parent smoke turn.",
                                }
                            )
                            + "\n"
                        ).encode()
                    )
                    process.stdin.flush()
                    sent_parent = True
                time.sleep(0.1)
        finally:
            try:
                if process.poll() is None:
                    # Stop only our RPC-owned runs before disposing their owner.
                    process.stdin.write(
                        b'{"type":"prompt","message":"/workmux-smoke-stop"}\n'
                    )
                    process.stdin.flush()
                    end = time.monotonic() + 13
                    while (
                        time.monotonic() < end
                        and not (root / "cleanup.complete").exists()
                        and process.poll() is None
                    ):
                        time.sleep(0.1)
            except (BrokenPipeError, OSError):
                pass
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            server.shutdown()
            server.server_close()
            record(root, "host.jsonl", {"phase": "stopped", "code": process.returncode})


class SidebarObserver:
    """Observe the real daemon's length-prefixed JSON snapshots, not a fake UI."""

    def __init__(self, path: Path) -> None:
        self.stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.stream.settimeout(0.1)
        self.stream.connect(str(path))
        self.buffer = b""
        self.snapshots: list[dict[str, Any]] = []

    def receive(self) -> None:
        try:
            self.buffer += self.stream.recv(1024 * 1024)
        except socket.timeout:
            return
        while len(self.buffer) >= 4:
            size = int.from_bytes(self.buffer[:4], "big")
            if size > 1024 * 1024:
                raise RuntimeError("Invalid sidebar snapshot size")
            if len(self.buffer) < size + 4:
                return
            self.snapshots.append(
                {"at": time.time(), **json.loads(self.buffer[4 : size + 4])}
            )
            self.buffer = self.buffer[size + 4 :]


def prepare(root: Path, config: dict[str, Any]) -> dict[str, str]:
    for name in [
        "home",
        "agent/agents",
        "bin",
        "state",
        "config/workmux",
        "cache",
        "temp",
        "work",
    ]:
        (root / name).mkdir(parents=True, exist_ok=True)
    (root / "launch.json").write_text(json.dumps(config))
    (root / "agent/settings.json").write_text(
        json.dumps({"quietStartup": True, "subagents": {"confirmProjectAgents": False}})
    )
    (root / "config/workmux/config.yaml").write_text("status_format: false\n")
    # pi-subagents uses simple scalar lists, not a general YAML list decoder.
    paths = "\n".join(
        f"  - {path}" for path in [config["extension"], FIXTURES / "child-probe.ts"]
    )
    (root / "agent/agents/smoke-native.md").write_text(
        f"---\nname: smoke-native\ndescription: Native smoke fixture\nmodel: smoke/fixture\nthinking: off\ntools:\nextensions:\n{paths}\nacceptance: {{level: none, reason: deterministic smoke fixture}}\n---\nReply briefly. Do not use tools.\n"
    )
    command_log = root / "workmux-command.py"
    command_log.write_text(
        f"import json, os, sys, time\nwith open(os.environ['WORKMUX_SMOKE_ROOT']+'/commands.jsonl','a') as out:\n out.write(json.dumps({{'at':time.time(),'args':sys.argv[1:],'child':os.environ.get('PI_SUBAGENT_CHILD')}})+'\\n')\nos.execv({config['workmux']!r}, [{config['workmux']!r},*sys.argv[1:]])\n"
    )
    wrapper = root / "bin/workmux"
    wrapper.write_text(
        f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(command_log))} "$@"\n'
    )
    wrapper.chmod(0o755)
    # Whitelist, do not inherit credentials, live multiplexer targets or Pi settings.
    return {
        "HOME": str(root / "home"),
        "USER": "workmux-smoke",
        "LANG": "C.UTF-8",
        "PATH": str(root / "bin") + os.pathsep + os.environ.get("PATH", os.defpath),
        "WORKMUX_SMOKE_ROOT": str(root),
        "PI_CODING_AGENT_DIR": str(root / "agent"),
        "PI_OFFLINE": "1",
        "PI_SUBAGENTS_TEMP_ROOT": str(root / "temp"),
        "TMPDIR": str(root / "temp"),
        "XDG_STATE_HOME": str(root / "state"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "SHELL": shutil.which("sh") or "/bin/sh",
        "TERM": "xterm-256color",
    }


def verify(
    root: Path,
    samples: list[dict[str, Any]],
    snapshots: list[dict[str, Any]],
    pane: str,
) -> dict[str, Any]:
    commands = rows(root / "commands.jsonl")
    assert sum(row["args"] == ["register-agent"] for row in commands) == 1, (
        "A child re-registered the pane"
    )
    assert all(row.get("child") != "1" for row in commands), (
        "A child published pane status"
    )
    children = rows(root / "children.jsonl")
    assert len(children) == 3 and all(
        row["child"] == "1" and row["pane"] == pane for row in children
    ), children
    model = rows(root / "model.jsonl")
    start = next(
        row["at"] for row in model if row["phase"] == "start" and row["delay"] == 24
    )
    quiet = [row for row in samples if start + 3 < row["at"] < start + 20]
    assert quiet and all(row["status"] == "working" for row in quiet), (
        "Quiet child activity reported done"
    )
    assert len({row["status_ts"] for row in quiet}) == 1, (
        "Heartbeats reset the elapsed timer"
    )
    assert len({row["updated_ts"] for row in quiet}) >= 4, (
        "Missing quiet-work heartbeats"
    )
    assert all(row["at"] - row["updated_ts"] < 5 for row in quiet), (
        "Heartbeat gap exceeded its budget"
    )
    controller = rows(root / "controller.jsonl")
    assert any(
        row["phase"] == "parent-settled" and row["idle"] and row["at"] < start + 10
        for row in controller
    ), "Parent did not settle while children ran"
    counts = [
        row["fleet"]["totalActive"] for row in controller if row["phase"] == "fleet"
    ]
    assert all(count in counts for count in [3, 2, 1, 0]), counts
    quiet_snapshots = [row for row in snapshots if start + 12 < row["at"] < start + 20]
    assert quiet_snapshots, "No sidebar observation beyond the inactivity timeout"
    for row in quiet_snapshots:
        assert pane not in row["interrupted_pane_ids"], (
            "Sidebar marked quiet work interrupted"
        )
        assert any(
            agent["pane_id"] == pane and agent["status"] == "working"
            for agent in row["agents"]
        ), "Sidebar lost the working parent row"
    states = [
        json.loads(path.read_text())["state"]
        for path in (root / "temp/async-subagent-runs").glob("*/status.json")
    ]
    assert all(state in states for state in ["complete", "failed", "stopped"]), states
    assert samples[-1]["status"] == "done", (
        "Final child completion did not clear working"
    )
    assert len(list((root / "state/workmux/agents").glob("*.json"))) == 1, (
        "Unexpected child rows"
    )
    return {
        "result": "pass",
        "fleet_transitions": list(dict.fromkeys(counts)),
        "terminal_run_states": states,
        "child_sessions_guarded": len(children),
        "quiet_seconds": 17,
        "sidebar_quiet_observations": len(quiet_snapshots),
        "heartbeat_timestamps": sorted({row["updated_ts"] for row in quiet}),
        "final_status": "done",
    }


def run(root: Path, config: dict[str, Any]) -> dict[str, Any]:
    env = prepare(root, config)
    base = [config["tmux"], "-S", str(root / "tmux.sock"), "-f", os.devnull]
    command = shlex.join(
        [sys.executable, str(Path(__file__).resolve()), "--host", str(root)]
    )
    samples: list[dict[str, Any]] = []
    observer: SidebarObserver | None = None
    daemon_pid: int | None = None
    started = False
    try:
        subprocess.run(
            [
                *base,
                "new-session",
                "-d",
                "-s",
                "smoke",
                "-x",
                "160",
                "-y",
                "40",
                "-c",
                str(root / "work"),
                command,
            ],
            env=env,
            check=True,
            capture_output=True,
            timeout=10,
        )
        started = True
        deadline = time.monotonic() + config["timeout"]
        pane = ""
        while time.monotonic() < deadline:
            errors = [
                row
                for row in rows(root / "controller.jsonl")
                if row["phase"] == "error"
            ]
            if errors:
                raise RuntimeError(errors)
            hosts = rows(root / "host.jsonl")
            if any(row["phase"] == "stopped" for row in hosts):
                raise RuntimeError(
                    "Pi host stopped unexpectedly; inspect pi.stderr.log"
                )
            states = list((root / "state/workmux/agents").glob("*.json"))
            if states:
                state = json.loads(states[0].read_text())
                samples.append({"at": time.time(), **state})
                pane = state["pane_key"]["pane_id"]
                if observer is None:
                    inside = {
                        **env,
                        "TMUX": f"{root / 'tmux.sock'},0,0",
                        "TMUX_PANE": pane,
                    }
                    subprocess.run(
                        [config["workmux"], "sidebar", "--session", "on"],
                        env=inside,
                        cwd=root / "work",
                        check=True,
                        capture_output=True,
                        timeout=10,
                    )
                    # The daemon outlives tmux itself. Capture only the PID
                    # registered on this test's freshly created private server.
                    pid = subprocess.run(
                        [*base, "show-options", "-gqv", "@workmux_sidebar_daemon_pid"],
                        env=env,
                        check=True,
                        capture_output=True,
                        text=True,
                        timeout=10,
                    ).stdout.strip()
                    assert pid.isdecimal() and int(pid) > 1, (
                        "Missing private sidebar daemon PID"
                    )
                    daemon_pid = int(pid)
                    paths = list((root / "temp").glob("workmux-sidebar-*.sock"))
                    assert len(paths) == 1, "Expected one private sidebar daemon"
                    observer = SidebarObserver(paths[0])
                observer.receive()
            completed = [
                row
                for row in rows(root / "model.jsonl")
                if row["phase"] == "complete" and row["delay"] == 24
            ]
            if (
                completed
                and samples
                and samples[-1]["status"] == "done"
                and time.time() > completed[-1]["at"] + 3
            ):
                assert observer is not None
                return verify(root, samples, observer.snapshots, pane)
            time.sleep(0.2)
        raise TimeoutError("Smoke deadline exceeded; inspect retained artifacts")
    finally:
        (root / "stop").touch()
        if started:
            for _ in range(300):
                if any(row["phase"] == "stopped" for row in rows(root / "host.jsonl")):
                    break
                time.sleep(0.1)
            if daemon_pid is not None:
                try:
                    os.kill(daemon_pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            subprocess.run(
                [*base, "kill-server"], env=env, capture_output=True, timeout=10
            )
        if observer:
            observer.stream.close()
            (root / "snapshots.json").write_text(
                json.dumps(observer.snapshots, indent=2)
            )
        (root / "samples.json").write_text(json.dumps(samples, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pi-subagents",
        type=Path,
        required=True,
        help="Installed pi-subagents extension entry point (index.js or index.ts)",
    )
    parser.add_argument(
        "--pi", type=executable, default="pi", help="Pi executable (default: PATH)"
    )
    built = REPO / "target/debug/workmux"
    parser.add_argument(
        "--workmux",
        type=executable,
        default=str(built) if built.exists() else "workmux",
        help="Workmux executable (default: target/debug/workmux, then PATH)",
    )
    parser.add_argument(
        "--tmux",
        type=executable,
        default="tmux",
        help="Tmux executable (default: PATH)",
    )
    parser.add_argument(
        "--keep-artifacts",
        action="store_true",
        help="Keep successful run artifacts too; failures are always retained",
    )
    parser.add_argument(
        "--timeout", type=int, default=60, help="Smoke deadline in seconds (minimum 35)"
    )
    args = parser.parse_args()
    if not args.pi_subagents.is_file():
        parser.error("--pi-subagents must name an existing extension entry point")
    if args.timeout < 35:
        parser.error("--timeout must be at least 35 seconds")
    root = Path(tempfile.mkdtemp(prefix="wm-pi-"))
    # Unix sockets have small platform-specific path limits. Give an actionable
    # preflight error instead of silently connecting to a different tmux server.
    if len(os.fsencode(root / "temp/workmux-sidebar-0000000000000000.sock")) >= 104:
        shutil.rmtree(root)
        parser.error(
            "Temporary path too long for Unix sockets; rerun with a shorter TMPDIR"
        )
    config = {
        "pi": args.pi,
        "owner": str(args.pi_subagents.resolve()),
        "workmux": args.workmux,
        "tmux": args.tmux,
        "timeout": args.timeout,
        "extension": str(REPO / "resources/pi/extensions/workmux-status.ts"),
    }
    print(f"Smoke artifacts: {root}", flush=True)
    try:
        report = run(root, config)
    except BaseException:
        print(f"Smoke failed; artifacts retained at {root}", file=sys.stderr)
        raise
    else:
        print(json.dumps(report, indent=2))
        if not args.keep_artifacts:
            shutil.rmtree(root)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--host":
        host(Path(sys.argv[2]))
    else:
        main()
