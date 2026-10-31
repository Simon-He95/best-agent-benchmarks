"""Self-owned Harbor/CLI closure cases; no benchmark task or paid model is used."""

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import time
import zipfile
from pathlib import Path

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"

from harbor.job import Job
from harbor.models.job.config import JobConfig

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--wheel", required=True)
parser.add_argument(
    "--cases",
    default="completed,budget-work,budget-empty,budget-tool,provider-failure,commit-failure,readiness-failure,readiness-timeout,baseline-work",
)
args = parser.parse_args()
root = Path(args.output).resolve()
root.mkdir(parents=True)
repository = Path(__file__).resolve().parents[1]
image = json.loads(
    subprocess.check_output(
        ["docker", "image", "inspect", "best-agent-ibench-closure:0.0.19"]
    )
)[0]
os.environ["DOCKER_DEFAULT_PLATFORM"] = f"{image['Os']}/{image['Architecture']}"
wheel = Path(args.wheel).resolve()
with zipfile.ZipFile(wheel) as archive:
    archive.extractall(root / "package")
sys.path.insert(0, str(root / "package"))
provider = root / "provider.json"
dimcode = root / "dimcode-home"
dimcode.mkdir()
(dimcode / "config.json").write_text("{}")
os.environ.update(BEST_AGENT_PROVIDER_CONFIG=str(provider), DIMCODE_HOME=str(dimcode))
reports = []

for case in args.cases.split(","):
    case_root = root / case
    task = case_root / "task"
    (task / "environment").mkdir(parents=True)
    (task / "steps/solve/workdir").mkdir(parents=True)
    (task / "tests").mkdir()
    (task / "steps/solve/instruction.md").write_text(
        "Repair calc.js so its exported function adds a and b. Commit the repair when complete.\n"
    )
    ready = (
        "printf 'owned-ready-fault\\n' >&2; exit 7"
        if case == "readiness-failure"
        else "python3 -c 'import time; time.sleep(30)'"
        if case == "readiness-timeout"
        else "python3 -c 'import urllib.request; assert urllib.request.urlopen(\"http://127.0.0.1:8765\").status == 200'"
    )
    (task / "task.toml").write_text(f"""schema_version = "1.4"
[task]
name = "self-owned/{case}"
[[steps]]
name = "solve"
[steps.agent]
network_mode = "public"
timeout_sec = 100
[steps.verifier]
timeout_sec = 10
[agent]
network_mode = "public"
timeout_sec = 100
[environment]
docker_image = "best-agent-ibench-closure:0.0.19"
network_mode = "public"
workdir = "/workspace"
[environment.env]
DEV_ENV_READY = {json.dumps(ready)}
DEV_ENV_START = "python3 -m http.server 8765 --bind 127.0.0.1"
DEV_ENV_SETUP = "true"
""")
    (task / "steps/solve/workdir/setup.sh").write_text("""#!/bin/bash
set -e
python3 -m http.server 8765 --bind 127.0.0.1 --directory /workspace/app >/tmp/self-owned-http.log 2>&1 &
for i in $(seq 1 30); do
  python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8765")' >/dev/null 2>&1 && exit 0
  sleep 0.1
done
exit 1
""")
    (task / "tests/test.sh").write_text("""#!/bin/bash
set -e
base=$(cat /opt/prepared-sha)
git -C /workspace/app diff --binary "$base" HEAD > /logs/verifier/candidate.patch
if node -e 'if(require("/workspace/app/calc.js")(2,3)!==5)process.exit(1)' && test -s /logs/verifier/candidate.patch; then
  printf '{"reward":1}\\n' > /logs/verifier/reward.json
else
  printf '{"reward":0}\\n' > /logs/verifier/reward.json
fi
""")
    (task / "steps/solve/workdir/owned-model.py").write_bytes(
        (repository / "test/fixtures/ibench-closure/model.py").read_bytes()
    )
    setup = task / "steps/solve/workdir/setup.sh"
    setup.write_text(
        setup.read_text()
        .replace(
            "set -e\n",
            f"set -e\nnohup python3 /workspace/owned-model.py {case} >/tmp/owned-model.log 2>&1 &\n",
            1,
        )
        .replace(
            'urllib.request.urlopen("http://127.0.0.1:8765")',
            'urllib.request.urlopen("http://127.0.0.1:8766/ready"); urllib.request.urlopen("http://127.0.0.1:8765")',
        )
    )
    provider.write_text(
        json.dumps(
            {
                "kind": "openai",
                "model": "local-test",
                "apiKey": "self-owned-fixture",
                "baseURL": "http://127.0.0.1:8766/v1",
                "compatibilityMode": "compatible",
            }
        )
    )
    import_path = "ibench_best_agent:BestAgentCli"
    if case == "baseline-work":
        module = root / "baseline_ibench_best_agent.py"
        module.write_bytes(
            subprocess.check_output(
                [
                    "git",
                    "show",
                    "74e8c4c:tools/ibench-agent/ibench_best_agent/__init__.py",
                ],
                cwd=repository,
            )
        )
        sys.path.insert(0, str(root))
        import_path = "baseline_ibench_best_agent:BestAgentCli"
    config = JobConfig.model_validate(
        {
            "job_name": case,
            "jobs_dir": str(case_root / "jobs"),
            "n_concurrent_trials": 1,
            "n_attempts": 1,
            "retry": {"max_retries": 0},
            "agents": [
                {
                    "import_path": import_path,
                    "model_name": "local-test",
                    "env": {
                        "BEST_AGENT_CLI_VERSION": "0.0.19",
                        "BEST_AGENT_CLI_WORKSPACE": "/workspace/app",
                        "BEST_AGENT_CLI_COMMIT": "1",
                        "BEST_AGENT_PROVIDER_MODEL": "local-test",
                        "BEST_AGENT_PROVIDER_KIND": "openai",
                        "BEST_AGENT_PROVIDER_API_KEY": "self-owned-fixture",
                        "BEST_AGENT_PROVIDER_BASE_URL": "http://127.0.0.1:8766/v1",
                        "BEST_AGENT_PROVIDER_COMPATIBILITY_MODE": "compatible",
                        "HTTP_PROXY": "",
                        "HTTPS_PROXY": "",
                        "ALL_PROXY": "",
                        "http_proxy": "",
                        "https_proxy": "",
                        "all_proxy": "",
                        "NO_PROXY": "host.docker.internal,127.0.0.1,localhost",
                        "no_proxy": "host.docker.internal,127.0.0.1,localhost",
                        "BEST_AGENT_MODEL_TIMEOUT_MS": "600000",
                        "npm_config_offline": "true",
                        "npm_config_cache": "/opt/ibench-npm-cache",
                        "BEST_AGENT_RUN_DURATION_MS": "3300000",
                        "BEST_AGENT_GIT_IDENTITY_NAME": "owned fixture",
                        "BEST_AGENT_GIT_IDENTITY_EMAIL": "owned@invalid",
                        "BEST_AGENT_CLI_EXECUTION_ARGS_JSON": json.loads(
                            (
                                repository
                                / "config/ibench/solver-best-agent-deepseek-flash-high.json"
                            ).read_text()
                        )["agents"][0]["env"]["BEST_AGENT_CLI_EXECUTION_ARGS_JSON"],
                    },
                }
            ],
            "environment": {"type": "docker"},
            "tasks": [{"path": str(task)}],
        }
    )
    started = time.monotonic()
    print("START", case, flush=True)

    async def run_job(config=config):
        job = await Job.create(config)
        return await job.run()

    asyncio.run(run_job())
    trials = list((case_root / "jobs" / case).glob("*/result.json"))
    assert len(trials) == 1, trials
    trial = trials[0].parent
    result = json.loads(trials[0].read_text())
    assert result["exception_info"] is None, result["exception_info"]
    agent = trial / "steps/solve/agent"
    request_path = agent / "owned-model-requests.json"
    requests = json.loads(request_path.read_text()) if request_path.exists() else []
    evidence = agent / "best-agent-evidence.jsonl"
    records = (
        [json.loads(line) for line in evidence.read_text().splitlines()]
        if evidence.exists()
        else []
    )
    snapshots = [
        record["snapshot"]
        for record in records
        if record["type"] == "terminal-snapshot"
    ]
    footer = records[-1] if records and records[-1]["type"] == "footer" else None
    receipt_path = agent / "best-agent-process-receipt.json"
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
    patch = trial / "steps/solve/verifier/candidate.patch"
    patch_bytes = patch.stat().st_size if patch.exists() else 0
    report = {
        "case": case,
        "wheelSha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
        "imageId": image["Id"],
        "platform": os.environ["DOCKER_DEFAULT_PLATFORM"],
        "elapsedSec": round(time.monotonic() - started, 3),
        "modelRequests": len(requests),
        "snapshot": {key: snapshots[-1].get(key) for key in ["status", "terminalCause"]}
        if snapshots
        else None,
        "footerComplete": footer["complete"] if footer else False,
        "receipt": receipt,
        "patchBytes": patch_bytes,
        "trial": str(trial),
        "exception": result["step_results"][0]["exception_info"],
    }
    if case != "baseline-work":
        if case in ("readiness-failure", "readiness-timeout"):
            assert len(requests) == 0 and not records
            assert report["exception"] is not None
            if case == "readiness-failure":
                assert "owned-ready-fault" in json.dumps(report["exception"])
            else:
                prep = json.loads((agent / "best-agent-environment.json").read_text())
                assert (
                    prep["readinessTimedOut"] and prep["readinessSignal"] == "SIGKILL"
                )
                assert prep["readinessExitCode"] is None
        else:
            assert footer and footer["complete"], report
            prefix = evidence.read_bytes().rsplit(b"\n", 2)[0] + b"\n"
            assert hashlib.sha256(prefix).hexdigest() == footer["prefixSha256"]
            assert receipt is not None
            exec_schema = next(
                tool["function"]["parameters"]
                for tool in requests[0]["tools"]
                if tool["function"]["name"] == "exec"
            )
            schemas = [exec_schema]
            maxima = []
            while schemas:
                schema = schemas.pop()
                for key, value in (
                    enumerate(schema) if isinstance(schema, list) else schema.items()
                ):
                    if key == "lifetimeMs":
                        maxima.append(value["maximum"])
                    elif isinstance(value, (dict, list)):
                        schemas.append(value)
            assert maxima and all(value == 120000 for value in maxima)
            assert len(requests) == (
                1
                if case in ["budget-empty", "provider-failure"]
                else 2
                if case == "budget-tool"
                else 3
            ), report
            assert all(
                json.dumps(request["messages"]).count(
                    "Verified initial runtime observations"
                )
                == 1
                for request in requests
            )
            environment = json.loads(
                (agent / "best-agent-environment.json").read_text()
            )
            assert environment["observation"]["sourceRefresh"] == "unverified"
            assert (
                hashlib.sha256(environment["text"].encode()).hexdigest()
                == environment["sha256"]
            )
            assert {"url": "http://127.0.0.1:8765/", "status": 200} in environment[
                "observation"
            ]["httpListeners"]
            assert "PROVIDER_CONFIG" not in environment["text"]
            if case in ("completed", "commit-failure"):
                assert snapshots[-1]["status"] == "completed"
                assert receipt["exitCode"] == 0
            elif case in ("budget-work", "budget-empty", "budget-tool"):
                assert snapshots[-1]["status"] == "cancelled"
                assert snapshots[-1]["terminalCause"] == "stopped"
                assert receipt["exitCode"] == 1
            else:
                assert snapshots[-1]["status"] == "failed"
                assert (
                    "owned-provider-fault"
                    in (agent / "best-agent-stderr.txt").read_text()
                )
            if case == "commit-failure":
                assert receipt["finalizationExitCode"] == 128
                assert (
                    "index.lock"
                    in (agent / "best-agent-finalize-stderr.txt").read_text()
                )
                assert report["exception"] is not None
            else:
                assert receipt["finalizationExitCode"] == 0
            assert (patch_bytes > 0) == (
                case in ("completed", "budget-work", "budget-tool")
            ), report
            if case == "budget-tool":
                assert "must-not-run.txt" not in patch.read_text()
                tools = [
                    entry["result"]
                    for entry in snapshots[-1]["transcript"]
                    if entry["kind"] == "tool"
                ]
                sibling = [tool for tool in tools if tool["callId"] == "must-not-run"]
                assert len(sibling) == 1 and sibling[0]["closure"] == {
                    "kind": "not-invoked",
                    "reason": "stopped",
                }, sibling
                report["toolStopClosures"] = [
                    tool
                    for tool in tools
                    if tool["callId"] in ("owned-long-command", "must-not-run")
                ]
    else:
        assert len(requests) == 3 and not footer and not receipt and patch_bytes == 0, (
            report
        )
        assert report["exception"]["exception_type"] == "AgentTimeoutError"
    reports.append(report)
    (root / "report.json").write_text(json.dumps(reports, indent=2))
    (case_root / "requests.json").write_text(json.dumps(requests, indent=2))
    print(
        "PASS",
        json.dumps({key: value for key, value in report.items() if key != "exception"}),
        flush=True,
    )
