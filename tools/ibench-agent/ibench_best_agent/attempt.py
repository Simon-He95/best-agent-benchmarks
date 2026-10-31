"""Container-side initial observations and one CLI attempt's bounded finalization."""

import hashlib
import http.client
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
from pathlib import Path

mode, input_path = sys.argv[1:]
settings = json.loads(Path(input_path).read_text())
logs = Path(input_path).parent
workspace = settings["workspace"]

if mode == "prepare":
    commands = settings["commands"]
    observation = {
        "workspace": workspace,
        "commands": commands,
        "sourceRefresh": "unverified",
    }
    if "DEV_ENV_READY" in commands:
        with (
            (logs / "best-agent-ready-stdout.txt").open("wb") as stdout,
            (logs / "best-agent-ready-stderr.txt").open("wb") as stderr,
        ):
            try:
                ready = subprocess.Popen(
                    ["bash", "-c", commands["DEV_ENV_READY"]],
                    cwd=workspace,
                    stdout=stdout,
                    stderr=stderr,
                    start_new_session=True,
                )
                ready.wait(timeout=10)
                observation["readinessExitCode"] = (
                    ready.returncode if ready.returncode >= 0 else None
                )
                if ready.returncode < 0:
                    observation["readinessSignal"] = signal.Signals(
                        -ready.returncode
                    ).name
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(ready.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                ready.wait()
                observation["readinessTimedOut"] = True
                observation["readinessSignal"] = (
                    signal.Signals(-ready.returncode).name
                    if ready.returncode < 0
                    else None
                )
                observation["readinessExitCode"] = (
                    ready.returncode if ready.returncode >= 0 else None
                )
        if (
            observation.get("readinessTimedOut")
            or observation["readinessExitCode"] != 0
        ):
            (logs / "best-agent-environment.json").write_text(
                json.dumps(observation, indent=2)
            )
            sys.stderr.write(
                (logs / "best-agent-ready-stderr.txt").read_text(errors="replace")
            )
            sys.stderr.write("Selected readiness probe failed before model entry\n")
            sys.exit(
                124
                if observation.get("readinessTimedOut")
                else ready.returncode
                if ready.returncode > 0
                else 128 - ready.returncode
            )
    browser = shutil.which("agent-browser")
    observation["browser"] = {"path": browser}
    if browser:
        version = subprocess.run(
            [browser, "--version"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        observation["browser"].update(
            exitCode=version.returncode, version=version.stdout.strip()
        )
        (logs / "best-agent-browser-stderr.txt").write_text(version.stderr)
    ports = set()
    for name in ("tcp", "tcp6"):
        for line in Path(f"/proc/net/{name}").read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] == "0A":
                ports.add(int(fields[1].split(":")[1], 16))
    observation["httpListeners"] = []
    observation["listenerProbeTruncated"] = len(ports) > 8
    for port in sorted(ports)[:8]:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.5)
        try:
            connection.request("HEAD", "/")
            response = connection.getresponse()
            observation["httpListeners"].append(
                {"url": f"http://127.0.0.1:{port}/", "status": response.status}
            )
        except (OSError, http.client.HTTPException):
            pass  # A listening TCP socket need not be an HTTP service.
        finally:
            connection.close()
    text = (
        "Verified initial runtime observations (before your changes):\n"
        + json.dumps(observation, indent=2)
    )
    text += "\nHTTP reachability describes the initial runtime only. Source-to-runtime refresh has not been verified; a service may serve built assets. The listed public setup/start commands identify its runtime preparation."
    if len(text.encode()) > 65_536:
        raise ValueError("Initial runtime observation exceeds 65536 UTF-8 bytes")
    record = {
        "observation": observation,
        "text": text,
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
    }
    encoded = json.dumps(record, indent=2)
    if len(encoded.encode()) > 65_536:
        raise ValueError("Initial runtime record exceeds 65536 UTF-8 bytes")
    (logs / "best-agent-environment.json").write_text(encoded)
    print(json.dumps(record))
elif mode == "run":
    home = str(Path.home())
    argv = settings["argv"]
    argv[0] = argv[0].replace("$HOME", home)
    os.environ.update(
        BEST_AGENT_PROVIDER_CONFIG=f"{home}/.best-agent/provider.json",
        DIMCODE_HOME=f"{home}/.dimcode",
        BEST_AGENT_STORAGE_ROOT=str(logs / "best-agent-runtime"),
        BEST_AGENT_PROVIDER_MODEL=settings["model"],
        DIMCODE_VERSION=settings["version"],
    )
    if Path(workspace, ".git").is_dir():
        before = subprocess.run(
            ["git", "-C", workspace, "rev-parse", "HEAD"],
            capture_output=True,
            check=True,
        )
        (logs / "best-agent-workspace-head-before.txt").write_bytes(before.stdout)
    with (
        (logs / "best-agent-stdout.txt").open("wb") as stdout,
        (logs / "best-agent-stderr.txt").open("wb") as stderr,
    ):
        primary = subprocess.run(
            argv,
            cwd=workspace,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            check=False,
        )
    receipt = {
        "exitCode": primary.returncode if primary.returncode >= 0 else None,
        "signal": signal.Signals(-primary.returncode).name
        if primary.returncode < 0
        else None,
        "commitRequested": settings["commit"],
        "finalizationExitCode": None,
        "finalizationSignal": None,
        "finalizationTimedOut": False,
    }
    receipt_path = logs / "best-agent-process-receipt.json"
    receipt_path.write_text(json.dumps(receipt))
    if settings["commit"]:
        script = (
            "set -e\n"
            f"git -C {shlex.quote(workspace)} add -A\n"
            f"if ! git -C {shlex.quote(workspace)} diff --cached --quiet; then\n"
            f"  git -C {shlex.quote(workspace)} -c user.name={shlex.quote(settings['gitName'])}"
            f" -c user.email={shlex.quote(settings['gitEmail'])} commit --no-verify -m 'ibench: candidate repair'\n"
            "fi\n"
            f"git -C {shlex.quote(workspace)} rev-parse HEAD > {shlex.quote(str(logs / 'best-agent-workspace-head-after.txt'))}\n"
        )
        with (
            (logs / "best-agent-finalize-stdout.txt").open("wb") as stdout,
            (logs / "best-agent-finalize-stderr.txt").open("wb") as stderr,
        ):
            try:
                final = subprocess.Popen(
                    ["bash", "-c", script],
                    stdout=stdout,
                    stderr=stderr,
                    start_new_session=True,
                )
                final.wait(timeout=30)
                receipt["finalizationExitCode"] = (
                    final.returncode if final.returncode >= 0 else None
                )
                receipt["finalizationSignal"] = (
                    signal.Signals(-final.returncode).name
                    if final.returncode < 0
                    else None
                )
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(final.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                final.wait()
                receipt["finalizationExitCode"] = (
                    final.returncode if final.returncode >= 0 else None
                )
                receipt["finalizationSignal"] = (
                    signal.Signals(-final.returncode).name
                    if final.returncode < 0
                    else None
                )
                receipt["finalizationTimedOut"] = True
        receipt_path.write_text(json.dumps(receipt))
        if receipt["finalizationExitCode"] != 0:
            sys.stderr.write(
                (logs / "best-agent-finalize-stderr.txt").read_text(errors="replace")
            )
            sys.stderr.write(
                f"Git finalization: exit={receipt['finalizationExitCode']}; signal={receipt['finalizationSignal']}; timedOut={receipt['finalizationTimedOut']}\n"
            )
    if primary.returncode != 0:
        sys.stderr.write((logs / "best-agent-stderr.txt").read_text(errors="replace"))
    final_status = (
        124
        if receipt["finalizationTimedOut"]
        else 128 + signal.Signals[receipt["finalizationSignal"]]
        if receipt["finalizationSignal"]
        else receipt["finalizationExitCode"] or 0
    )
    sys.exit(
        (primary.returncode if primary.returncode >= 0 else 128 - primary.returncode)
        or final_status
    )
else:
    raise ValueError(f"Unknown attempt phase: {mode}")
