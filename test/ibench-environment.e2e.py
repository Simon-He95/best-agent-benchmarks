"""Owned Linux preparation controls; no model or benchmark is executed."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--image", default="best-agent-ibench-closure:0.0.19")
args = parser.parse_args()
root = Path(args.output).resolve()
root.mkdir(parents=True, exist_ok=True)
repository = Path(__file__).resolve().parents[1]
driver = repository / "tools/ibench-agent/ibench_best_agent/attempt.py"
image = json.loads(subprocess.check_output(["docker", "image", "inspect", args.image]))[0]
platform = f"{image['Os']}/{image['Architecture']}"
reports = []
for case in ("full", "shallow", "no-git", "nonzero", "junk", "timeout"):
    directory = root / case
    workspace = directory / "workspace"
    workspace.mkdir(parents=True)
    (workspace / "owned.txt").write_text("unchanged owned source\n")
    if case != "no-git":
        for command in (
            ["git", "init", "-q", str(workspace)],
            ["git", "-C", str(workspace), "add", "."],
            ["git", "-C", str(workspace), "-c", "user.name=Owned fixture", "-c", "user.email=owned@invalid", "commit", "-qm", "owned base"],
        ):
            subprocess.run(command, check=True)
    if case == "shallow":
        head = subprocess.check_output(["git", "-C", str(workspace), "rev-parse", "HEAD"])
        (workspace / ".git/shallow").write_bytes(head)
    shutil.copy2(driver, directory / "attempt.py")
    (directory / "bin").mkdir()
    wrapper = directory / "bin/git"
    behavior = {
        "nonzero": "print('owned-git-source-fault',file=sys.stderr);sys.exit(7)",
        "junk": "print('owned-not-a-boolean')",
        "timeout": "print('owned-git-before-timeout',flush=True);time.sleep(10)",
    }.get(case, "os.execv('/usr/bin/git',['git',*sys.argv[1:]])")
    wrapper.write_text(
        "#!/usr/bin/python3\nimport os,sys,json,time\n"
        "with open('/work/git-entries.jsonl','a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')\n"
        + behavior
        + "\n"
    )
    wrapper.chmod(0o755)
    selected = {
        "workspace": "/work/workspace",
        "commands": {"DEV_ENV_READY": "true"},
        "networkPolicy": {"network_mode": "no-network", "allowed_hosts": []},
    }
    (directory / "preparation.json").write_text(json.dumps(selected))
    completed = subprocess.run(
        ["docker", "run", "--rm", "--platform", platform, "--network", "none",
         "--mount", f"type=bind,source={directory},target=/work",
         "--env", "PATH=/work/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
         "--entrypoint", "python3", args.image, "/work/attempt.py", "prepare", "/work/preparation.json"],
        capture_output=True, timeout=45,
    )
    (directory / "caller-stdout.txt").write_bytes(completed.stdout)
    (directory / "caller-stderr.txt").write_bytes(completed.stderr)
    assert completed.returncode == 0, completed.stderr
    record = json.loads(completed.stdout)
    observation = record["observation"]
    assert observation["networkPolicy"] == selected["networkPolicy"]
    assert hashlib.sha256(record["text"].encode()).hexdigest() == record["sha256"]
    assert record["text"].count('"networkPolicy"') == 1
    assert observation["sourceRefresh"] == "unverified"
    assert (workspace / "owned.txt").read_text() == "unchanged owned source\n"
    entries = directory / "git-entries.jsonl"
    calls = [json.loads(line) for line in entries.read_text().splitlines()] if entries.exists() else []
    assert calls == ([] if case == "no-git" else [["rev-parse", "--is-shallow-repository"]])
    observed = observation["gitHistory"]
    if case in ("full", "shallow"):
        assert observed == {"status": "observed", "isShallowRepository": case == "shallow"}
        assert (directory / "best-agent-git-history-stdout.txt").read_bytes() == (b"true\n" if case == "shallow" else b"false\n")
    elif case == "no-git":
        assert observed == {"status": "unavailable", "probePerformed": False}
    elif case == "timeout":
        assert observed == {"status": "unavailable", "probeTimedOut": True}
        assert (directory / "best-agent-git-history-stdout.txt").read_bytes() == b"owned-git-before-timeout\n"
    else:
        assert observed == {"status": "unavailable", "probeReturnCode": 7 if case == "nonzero" else 0}
        if case == "nonzero":
            assert (directory / "best-agent-git-history-stderr.txt").read_bytes() == b"owned-git-source-fault\n"
        else:
            assert (directory / "best-agent-git-history-stdout.txt").read_bytes() == b"owned-not-a-boolean\n"
    reports.append({"case": case, "callerExit": completed.returncode, "probeEntries": len(calls), "gitHistory": observed, "networkPolicyExact": True, "sourceUnchanged": True, "textHashValid": True, "modelRequests": 0})
    print(json.dumps(reports[-1]), flush=True)
(root / "receipt.json").write_text(json.dumps({"scope": "Actual uploaded Python driver in owned Linux Docker/no-network, controlled Git faults explicitly labeled, no model or benchmark", "driverSha256": hashlib.sha256(driver.read_bytes()).hexdigest(), "imageId": image["Id"], "platform": platform, "cases": reports}, indent=2))
