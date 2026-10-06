#!/usr/bin/env python3
"""Actual installed Pi TUI /reload proof; DUMMY workspace and no provider calls."""
import argparse
import errno
import json
import os
from pathlib import Path
import pty
import re
import secrets
import select
import shutil
import signal
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("--pi-bin", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="factory CP07 reload DUMMY ") as temporary:
    scratch = Path(temporary)
    project = scratch / "project"
    agent = scratch / "agent"
    project.mkdir()
    agent.mkdir()
    (project / ".factory/tasks").mkdir(parents=True)
    for source, target in [("project.yaml", ".factory/project.yaml"), ("completion.yaml", ".factory/completion.yaml"), ("task.yaml", ".factory/tasks/CTX-001.yaml"), ("PROJECT.md", "PROJECT.md"), ("ARCHITECTURE.md", "ARCHITECTURE.md")]:
        shutil.copyfile(root / "test/fixtures/ctx" / source, project / target)
    subprocess.run(["git", "init", "--quiet", str(project)], check=True)
    subprocess.run(["git", "-C", str(project), "add", "."], check=True)
    subprocess.run(["git", "-C", str(project), "-c", "user.name=CP07 DUMMY", "-c", "user.email=cp07@example.invalid", "commit", "--quiet", "-m", "DUMMY fixture"], check=True)
    # Explicit whitelist: no credentials, user settings, telemetry or catalog network.
    env = {"PATH": os.environ["PATH"], "HOME": str(scratch), "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "TERM": "xterm-256color"}
    command = [args.pi_bin, "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-approve", "--model", "openai/gpt-4.1", "-e", str(root)]
    master, slave = pty.openpty()
    process = subprocess.Popen(command, cwd=project, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    raw = bytearray()
    statuses = []
    nonce = f"POSTRELOAD_DUMMY_{secrets.token_hex(4)}"

    ansi = re.compile(rb"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])")
    label = re.compile(rb"exit: (\d+)(?=\D)")

    def wait_for(find, seconds=30):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            found = find()
            if found is not None:
                return found
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                raw.extend(chunk)
        raise AssertionError(f"Pi did not display expected output; status={process.poll()}")

    def marker_after(text, start):
        index = raw.find(text.encode(), start)
        return None if index < 0 else index + len(text.encode())

    def send(command, marker, expected_exit=None):
        start = len(raw)
        # The marker must be new output of this invocation, never a redraw of prior transcript.
        if marker.encode() in raw:
            raise AssertionError(f"marker {marker!r} was already displayed before {command!r}")
        os.write(master, command.encode() + b"\r")
        end = wait_for(lambda: marker_after(marker, start))
        observed = None
        if expected_exit is not None:
            match = wait_for(lambda: label.search(ansi.sub(b"", bytes(raw[end:]))))
            observed = int(match.group(1))
            if observed != expected_exit:
                raise AssertionError(f"{command!r} displayed exit {observed}, expected {expected_exit}")
        statuses.append({"command": command, "marker": marker, "cli_exit_code": observed})

    try:
        wait_for(lambda: marker_after("factory.ts", 0))
        send("/factory validate", "Factory validate: context-fixture", 0)
        send("/factory run", "FACTORY_ARGUMENT_ERROR", 2)
        send("/factory context", "VALIDATION_ERROR: context requires TASK-ID", 2)
        send("/reload", "Reloaded")
        send("/factory validate --json", '"command": "validate"', 0)
        send("/factory status", "Factory status: NOT COMPLETE", 0)
        send(f"/factory status {nonce}", f"VALIDATION_ERROR: Unknown argument: {nonce}", 2)
        os.write(master, b"/quit\r")
        process.wait(timeout=15)
        if process.returncode != 0:
            raise AssertionError(f"Pi exit {process.returncode}")
        summary = {"command": command, "reload_command": "/reload", "statuses": statuses, "pi_exit": process.returncode, "network": "--offline; no model input; sterile credential-free HOME", "foreground": "all CLI completions observed before next input; Pi exited normally"}
        (output / "reload.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2))
    finally:
        (output / "tui.log").write_bytes(raw)
        if process.poll() is None:
            # Only this positively identified disposable proof process group.
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=10)
        os.close(master)
