"""Owned Docker/actual CLI controls for frozen setup; no benchmark or paid model."""

import argparse
import hashlib
import json
import os
import shutil
import struct
import zlib
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def inside():
    root = Path("/work")
    selected = json.loads((root / "case.json").read_text())
    workspace = root / "workspace"
    workspace.mkdir()

    def git(*args):
        return subprocess.check_output(["git", "-C", str(workspace), *args])

    git("init", "-q")
    git("config", "user.name", "Owned fixture")
    git("config", "user.email", "owned@invalid")
    dependencies = {"htdocs/includes/lib.php": b"<?php // frozen library\n", "composer.json.disabled": b"{}\n"}
    def png(red):
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes([0, red, 0, 0]))) + chunk(b"IEND", b"")

    originals = {"source.js": b"export const value = 1;\n", "screen.png": png(0), "local.config.json": b"{}\n", "launch.sh": b"#!/bin/sh\nexit 0\n"}
    for name, data in {**dependencies, **originals}.items():
        path = workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    git("add", ".")
    git("commit", "-qm", "Owned frozen source")
    subprocess.run([sys.executable, "/work/vendor-lock.py", "resolve"], cwd=workspace, check=True, capture_output=True)
    git("add", "-f", ".vendor-dependencies.lock.json")
    git("commit", "-qm", "Owned prepared lock")
    if selected["case"] == "mismatch":
        (workspace / "htdocs/includes/lib.php").write_bytes(b"<?php // committed different library\n")
        git("add", ".")
        git("commit", "-qm", "Owned committed mismatch")
    before = git("rev-parse", "HEAD").decode().strip()
    lock_before = (workspace / ".vendor-dependencies.lock.json").read_bytes()
    dependency_before = {name: hashlib.sha256((workspace / name).read_bytes()).hexdigest() for name in dependencies}
    setup = root / "setup.sh"
    setup.write_text('#!/bin/bash\nset -eu\nprintf "mode=%s\\n" "${DEV_ENV_LOCK_MODE:-unset}"\npython3 /work/vendor-lock.py "${DEV_ENV_LOCK_MODE:-resolve}"\n')
    edits = {"source.js": b"export const value = 2;\n", "screen.png": png(255), "local.config.json": b'{"enabled": true}\n', "launch.sh": b"#!/bin/sh\nexit 1\n"}
    (root / "legitimate.py").write_text("from pathlib import Path\n" + "\n".join(f"Path({name!r}).write_bytes({data!r})" for name, data in edits.items()))
    settings = {"workspace": str(workspace), "commands": {"DEV_ENV_READY": 'printf "ready-mode=%s\\n" "${DEV_ENV_LOCK_MODE:-unset}"', "DEV_ENV_SETUP": "bash /work/setup.sh"}, "networkPolicy": {"network_mode": "no-network", "allowed_hosts": []}}
    preparation = root / "preparation.json"
    preparation.write_text(json.dumps(settings))
    prepare = subprocess.run([sys.executable, "/work/attempt.py", "prepare", str(preparation)], capture_output=True, check=True)
    (root / "prepare-stdout.txt").write_bytes(prepare.stdout)
    record = json.loads(prepare.stdout)
    assert hashlib.sha256(record["text"].encode()).hexdigest() == record["sha256"]
    if selected["arm"] == "candidate":
        assert record["observation"]["setupEnvironment"] == {"DEV_ENV_LOCK_MODE": "restore"}
        assert record["text"].count('"setupEnvironment"') == 1
    else:
        assert "setupEnvironment" not in record["observation"]
    requests = []
    faults = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                (root / "requests.json").write_text(json.dumps(requests, indent=2))
                results = {m["tool_call_id"]: json.loads(m["content"]) for m in body["messages"] if m["role"] == "tool"}
                calls = []

                def call(identity, name, arguments):
                    calls.append({"id": identity, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}})

                if selected["case"] == "process":
                    if "owned-start" not in results:
                        call("owned-start", "process-start", {"argv": ["bash", "/work/setup.sh"]})
                    else:
                        start = results["owned-start"]
                        assert start["status"] == "accepted", start
                        if "owned-read" not in results or results["owned-read"]["payload"]["status"] == "running":
                            call("owned-read", "process-read", {"processRef": start["payload"]["processRef"], "waitMs": 1000, "maxBytes": 8192})
                elif "owned-setup" not in results:
                    call("owned-setup", "exec", {"command": "bash", "args": ["/work/setup.sh"]})
                    call("owned-sibling", "exec", {"command": "printf", "args": ["owned sibling retained\\n"]})
                elif selected["case"] == "legitimate" and "owned-edit" not in results:
                    call("owned-edit", "exec", {"command": "python3", "args": ["/work/legitimate.py"]})
                message = {"role": "assistant", "content": "" if calls else "Owned setup observation complete; any original setup error remains in the tool result."}
                if calls:
                    message["tool_calls"] = calls
                response = {"id": "owned-frozen", "object": "chat.completion", "created": 1, "model": "local-test", "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if calls else "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(response).encode())
            except Exception as error:
                faults.append(repr(error))
                self.send_error(500, str(error))

    server = ThreadingHTTPServer(("127.0.0.1", 8767), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    provider = Path.home() / ".best-agent/provider.json"
    provider.parent.mkdir(parents=True, exist_ok=True)
    provider.write_text(json.dumps({"kind": "openai", "model": "local-test", "apiKey": "owned-frozen-fixture", "baseURL": "http://127.0.0.1:8767/v1", "compatibilityMode": "compatible"}))
    dimcode = Path.home() / ".dimcode"
    (dimcode / "dimcode").mkdir(parents=True, exist_ok=True)
    (dimcode / "config.json").write_text("{}")
    (dimcode / "dimcode/auth.json").write_text("{}")
    argv = ["/cli/bin/best-agent", "run", "--model", "local-test", "--workspace", str(workspace), "--model-timeout-ms", "20000", "--run-duration-ms", "3300000", "--attempt-remaining-ms", "120000", *selected["executionArgs"], "--attempt-evidence", "/work/evidence.jsonl", "Run the public setup once and retain its actual result.\n\n" + record["text"]]
    launch = root / "launch.json"
    launch.write_text(json.dumps({"workspace": str(workspace), "argv": argv, "model": "local-test", "version": "0.0.21", "commit": True, "gitName": "owned fixture", "gitEmail": "owned@invalid"}))
    try:
        run = subprocess.run([sys.executable, "/work/attempt.py", "run", str(launch)], capture_output=True, timeout=130)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    (root / "caller-stdout.txt").write_bytes(run.stdout)
    (root / "caller-stderr.txt").write_bytes(run.stderr)
    assert not faults, faults
    assert run.returncode == 0, (run.returncode, run.stderr, (root / "best-agent-stderr.txt").read_text())
    evidence = [json.loads(line) for line in (root / "evidence.jsonl").read_text().splitlines()]
    assert evidence[-1]["complete"]
    terminal = next(row["snapshot"] for row in evidence if row["type"] == "terminal-snapshot")
    assert terminal["status"] == "completed", terminal["status"]
    results = {m["tool_call_id"]: json.loads(m["content"]) for m in requests[-1]["messages"] if m["role"] == "tool"}
    observed = results["owned-read" if selected["case"] == "process" else "owned-setup"]
    expected_mode = "restore" if selected["arm"] == "candidate" else "unset"
    assert "mode=" + expected_mode in observed["payload"]["stdout"], observed
    assert (root / "best-agent-ready-stdout.txt").read_text().strip() == "ready-mode=" + expected_mode
    if selected["case"] == "mismatch":
        assert observed["payload"]["exitCode"] == 1, observed
        assert "Frozen vendored dependencies do not match this checkout" in observed["payload"]["stderr"], observed
        assert results["owned-sibling"]["status"] == "succeeded"
    else:
        assert observed["payload"]["exitCode"] == 0, observed
    paths = git("diff", "--name-only", before, "HEAD").decode().splitlines()
    (root / "candidate.patch").write_bytes(git("diff", "--binary", before, "HEAD"))
    expected_paths = sorted(originals) if selected["case"] == "legitimate" else [] if selected["arm"] == "candidate" else [".vendor-dependencies.lock.json"]
    assert paths == expected_paths, (paths, expected_paths)
    if selected["case"] == "legitimate":
        assert all((workspace / name).read_bytes() == data for name, data in edits.items())
    assert dependency_before == {name: hashlib.sha256((workspace / name).read_bytes()).hexdigest() for name in dependencies}
    if selected["arm"] == "candidate":
        assert lock_before == (workspace / ".vendor-dependencies.lock.json").read_bytes()
    else:
        old, new = json.loads(lock_before), json.loads((workspace / ".vendor-dependencies.lock.json").read_bytes())
        assert [key for key in old if old[key] != new[key]] == ["source_commit"]
    report = {"case": selected["case"], "arm": selected["arm"], "callerExit": run.returncode, "terminal": terminal["status"], "modelRequests": len(requests), "toolCalls": len(results), "setupMode": expected_mode, "setupExitCode": observed["payload"]["exitCode"], "patchPaths": paths, "dependencyBytesUnchanged": True, "footerComplete": True, "sourceErrorInNextRequest": selected["case"] == "mismatch"}
    (root / "result.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


if __name__ == "__main__" and sys.argv[1:] == ["--inside"]:
    inside()
elif __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--vendor-lock", required=True)
    parser.add_argument("--cli-archive", required=True)
    parser.add_argument("--baseline", default="3af0d3e30a1ca21c105e2c0f84be243e1a0f255b")
    parser.add_argument("--image", default="best-agent-ibench-closure:0.0.19")
    args = parser.parse_args()
    root = Path(args.output).resolve()
    root.mkdir(parents=True)
    repo = Path(__file__).resolve().parents[1]
    image = json.loads(subprocess.check_output(["docker", "image", "inspect", args.image]))[0]
    platform = f"{image['Os']}/{image['Architecture']}"
    archive = Path(args.cli_archive).resolve()
    cli_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert cli_hash == "4edf910957c8c48aa3f1d983295be89af8f791aa156d2560434e0d1927c8b256", cli_hash
    subprocess.run(["tar", "-xzf", str(archive), "-C", str(root)], check=True)
    cli = root / "best-agent-0.0.21-linux-x64-gnu"
    path = "tools/ibench-agent/ibench_best_agent/attempt.py"
    sources = {"baseline": subprocess.check_output(["git", "show", args.baseline + ":" + path], cwd=repo), "candidate": (repo / path).read_bytes()}
    execution_args = json.loads(json.loads((repo / "config/ibench/solver-best-agent-deepseek-flash-high.json").read_text())["agents"][0]["env"]["BEST_AGENT_CLI_EXECUTION_ARGS_JSON"])
    order = [("exec", "baseline"), ("exec", "candidate"), ("process", "candidate"), ("process", "baseline"), ("mismatch", "candidate"), ("legitimate", "candidate")]
    plan = {"scope": "Owned actual CLI/helper controls, controlled local model, no benchmark or paid requests", "baseline": args.baseline, "driverHashes": {key: hashlib.sha256(value).hexdigest() for key, value in sources.items()}, "fixtureSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "helperSha256": hashlib.sha256(Path(args.vendor_lock).read_bytes()).hexdigest(), "cliArchiveSha256": cli_hash, "imageId": image["Id"], "order": order}
    (root / "plan.json").write_text(json.dumps(plan, indent=2))
    reports = []
    for case, arm in order:
        directory = root / (case + "-" + arm)
        directory.mkdir()
        (directory / "attempt.py").write_bytes(sources[arm])
        shutil.copy2(args.vendor_lock, directory / "vendor-lock.py")
        shutil.copy2(__file__, directory / "fixture.py")
        (directory / "case.json").write_text(json.dumps({"case": case, "arm": arm, "executionArgs": execution_args}))
        print("START", case, arm, flush=True)
        result = subprocess.run(["docker", "run", "--rm", "--platform", platform, "--network", "none", "--mount", f"type=bind,source={directory},target=/work", "--mount", f"type=bind,source={cli},target=/cli,readonly", "--entrypoint", "python3", args.image, "/work/fixture.py", "--inside"], capture_output=True, timeout=160)
        (directory / "docker-stdout.txt").write_bytes(result.stdout)
        (directory / "docker-stderr.txt").write_bytes(result.stderr)
        assert result.returncode == 0, (case, arm, result.stderr.decode())
        report = json.loads((directory / "result.json").read_text())
        reports.append(report)
        print(json.dumps(report), flush=True)
    (root / "receipt.json").write_text(json.dumps({**plan, "results": reports}, indent=2))
