"""Real Harbor agent-phase / Docker pairs with a controlled local model, no benchmark."""

import argparse
import ast
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
from harbor.job import Job
from harbor.models.job.config import JobConfig

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--baseline", default="c38ca2d91f2609b197f20ee1e9dd11bc0bf2da5c")
parser.add_argument("--image", default="best-agent-ibench-closure:0.0.19")
args = parser.parse_args()
root = Path(args.output).resolve()
root.mkdir(parents=True)
repository = Path(__file__).resolve().parents[1]
image = json.loads(subprocess.check_output(["docker", "image", "inspect", args.image]))[0]
os.environ.pop("DOCKER_DEFAULT_PLATFORM", None)
provider = root / "provider.json"
provider.write_text(json.dumps({"kind": "openai", "model": "local-test", "apiKey": "owned-env-fixture", "baseURL": "http://127.0.0.1:8766/v1", "compatibilityMode": "compatible"}))
dimcode = root / "dimcode"
(dimcode / "dimcode").mkdir(parents=True)
(dimcode / "config.json").write_text("{}")
(dimcode / "dimcode/auth.json").write_text("{}")
os.environ.update(BEST_AGENT_PROVIDER_CONFIG=str(provider), DIMCODE_HOME=str(dimcode))
sources = {}
for arm in ("baseline", "candidate"):
    directory = root / arm
    directory.mkdir()
    for source, target in (("__init__.py", f"h05_{arm}_agent.py"), ("attempt.py", "attempt.py")):
        path = "tools/ibench-agent/ibench_best_agent/" + source
        data = subprocess.check_output(["git", "show", args.baseline + ":" + path], cwd=repository) if arm == "baseline" else (repository / path).read_bytes()
        (directory / target).write_bytes(data)
        sources[arm + "/" + source] = hashlib.sha256(data).hexdigest()
    sys.path.insert(0, str(directory))

model = r'''import json
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
requests=[]
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self): self.send_response(200);self.end_headers();self.wfile.write(b'owned-ready')
 def do_HEAD(self): self.send_response(200);self.end_headers()
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));requests.append(body)
  Path('/logs/agent/owned-env-requests.json').write_text(json.dumps(requests,indent=2))
  user=next(m['content'] for m in body['messages'] if m['role']=='user')
  marker='Verified initial runtime observations (before your changes):\n'
  text=user.split(marker,1)[1]
  observation,_=json.JSONDecoder().raw_decode(text)
  results={m.get('tool_call_id'):json.loads(m['content']) for m in body['messages'] if m['role']=='tool'}
  history=observation.get('gitHistory')
  value=history['isShallowRepository'] if history and history.get('status')=='observed' else None
  if value is None and 'owned-git' in results:
   result=results['owned-git'];assert result['kind']=='known' and result['status']=='succeeded'
   value=result['payload']['stdout'].strip()=='true'
  calls=[]
  if value is None:
   calls=[{'id':'owned-git','type':'function','function':{'name':'exec','arguments':json.dumps({'command':'git','args':['rev-parse','--is-shallow-repository']})}}]
  elif 'owned-report' not in results:
   calls=[{'id':'owned-report','type':'function','function':{'name':'write','arguments':json.dumps({'path':'owned-env-report.json','content':json.dumps({'isShallowRepository':value})})}}]
  message={'role':'assistant','content':'' if calls else 'Owned environment report complete.'}
  if calls: message['tool_calls']=calls
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
  self.wfile.write(json.dumps({'id':'owned-env','object':'chat.completion','created':1,'model':'local-test','choices':[{'index':0,'message':message,'finish_reason':'tool_calls' if calls else 'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':5,'total_tokens':15}}).encode())
ThreadingHTTPServer(('127.0.0.1',8766),Handler).serve_forever()
'''
reports = []
assert any(
    isinstance(node, ast.Constant)
    and node.value == "Verified initial runtime observations (before your changes):\n"
    for node in ast.walk(ast.parse(model))
)
order = (("full", "baseline"), ("full", "candidate"), ("shallow", "candidate"), ("shallow", "baseline"))
(root / "plan.json").write_text(json.dumps({"scope": "Native Harbor/Docker no-network agent phase with controlled source model. Same CLI/image/tasks/budgets, original adapter versus candidate; no paid model, benchmark or retries", "baseline": args.baseline, "sourceHashes": sources, "imageId": image["Id"], "platformSelection": "Each cached image's own platform; no global override on mixed-architecture agent/sidecar", "order": order}, indent=2))
for case, arm in order:
    name = case + "-" + arm
    directory = root / name
    task = directory / "task"
    (task / "environment").mkdir(parents=True)
    workdir = task / "steps/solve/workdir"
    workdir.mkdir(parents=True)
    (task / "tests").mkdir()
    (task / "steps/solve/instruction.md").write_text("Report the workspace Git shallow-repository bit in owned-env-report.json. Keep calc.js unchanged. Do not fetch, install, change source or access the internet.\n")
    (task / "task.toml").write_text(f'''schema_version = "1.4"
[task]
name = "self-owned/h05-{name}"
[[steps]]
name = "solve"
[steps.agent]
network_mode = "no-network"
timeout_sec = 180
[steps.verifier]
timeout_sec = 15
[agent]
network_mode = "no-network"
timeout_sec = 180
[environment]
docker_image = {json.dumps(args.image)}
network_mode = "public"
workdir = "/workspace"
[environment.env]
DEV_ENV_READY = "true"
''')
    (workdir / "owned-env-model.py").write_text(model)
    shallow = "mv /workspace/app /workspace/source\ngit clone --depth=1 file:///workspace/source /workspace/app\n" if case == "shallow" else ""
    (workdir / "setup.sh").write_text("#!/bin/bash\nset -e\n" + shallow + "nohup python3 /workspace/owned-env-model.py >/tmp/owned-env-model.log 2>&1 &\nfor i in $(seq 1 50); do\n python3 -c 'import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:8766/ready\")' >/dev/null 2>&1 && exit 0\n sleep 0.1\ndone\nexit 1\n")
    verifier = r"""#!/bin/bash
set -e
python3 - <<'VERIFY'
import json,subprocess
from pathlib import Path
workspace=Path('/workspace/app')
expected=subprocess.check_output(['git','-C',str(workspace),'rev-parse','--is-shallow-repository'],text=True).strip()=='true'
assert json.loads((workspace/'owned-env-report.json').read_text())=={'isShallowRepository':expected}
assert (workspace/'calc.js').read_text()=='module.exports = (a, b) => a - b;\n'
VERIFY
printf '{"reward":1}\n' >/logs/verifier/reward.json
"""
    compile(verifier.split("<<'VERIFY'\n", 1)[1].split("\nVERIFY", 1)[0], "owned-verifier", "exec")
    (task / "tests/test.sh").write_text(verifier)
    config = JobConfig.model_validate({
        "job_name": name, "jobs_dir": str(directory / "jobs"), "n_concurrent_trials": 1, "n_attempts": 1, "retry": {"max_retries": 0},
        "agents": [{"import_path": f"h05_{arm}_agent:BestAgentCli", "model_name": "local-test", "env": {
            "BEST_AGENT_CLI_VERSION": "0.0.19", "BEST_AGENT_CLI_INSTALL": "npm-in-container", "BEST_AGENT_CLI_WORKSPACE": "/workspace/app", "BEST_AGENT_CLI_COMMIT": "1", "BEST_AGENT_PROVIDER_MODEL": "local-test",
            "BEST_AGENT_PROVIDER_KIND": "openai", "BEST_AGENT_PROVIDER_API_KEY": "owned-env-fixture", "BEST_AGENT_PROVIDER_BASE_URL": "http://127.0.0.1:8766/v1", "BEST_AGENT_PROVIDER_COMPATIBILITY_MODE": "compatible",
            "BEST_AGENT_MODEL_TIMEOUT_MS": "600000", "BEST_AGENT_RUN_DURATION_MS": "3300000", "BEST_AGENT_GIT_IDENTITY_NAME": "owned fixture", "BEST_AGENT_GIT_IDENTITY_EMAIL": "owned@invalid",
            "npm_config_offline": "true", "npm_config_cache": "/opt/ibench-npm-cache", "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "", "http_proxy": "", "https_proxy": "", "all_proxy": "", "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
            "BEST_AGENT_CLI_EXECUTION_ARGS_JSON": json.loads((repository / "config/ibench/solver-best-agent-deepseek-flash-high.json").read_text())["agents"][0]["env"]["BEST_AGENT_CLI_EXECUTION_ARGS_JSON"],
        }}], "environment": {"type": "docker"}, "tasks": [{"path": str(task)}],
    })
    started = time.monotonic()
    print("START", name, flush=True)
    async def run_job():
        job = await Job.create(config)
        return await job.run()
    asyncio.run(run_job())
    paths = list((directory / "jobs" / name).glob("*/result.json"))
    assert len(paths) == 1, paths
    result = json.loads(paths[0].read_text())
    assert result["exception_info"] is None, result["exception_info"]
    step = result["step_results"][0]
    assert result["exception_info"] is None and step["exception_info"] is None, result
    assert result["verifier_result"]["rewards"]["reward"] == 1, result
    logs = paths[0].parent / "steps/solve/agent"
    requests = json.loads((logs / "owned-env-requests.json").read_text())
    record = json.loads((logs / "best-agent-environment.json").read_text())
    assert requests[0]["messages"][-1]["content"].count("Verified initial runtime observations") == 1
    assert hashlib.sha256(record["text"].encode()).hexdigest() == record["sha256"]
    evidence = [json.loads(line) for line in (logs / "best-agent-evidence.jsonl").read_text().splitlines()]
    terminal = next(row["snapshot"] for row in evidence if row["type"] == "terminal-snapshot")
    tools = [entry["result"] for entry in terminal["transcript"] if entry["kind"] == "tool"]
    assert evidence[-1]["complete"] and terminal["status"] == "completed"
    assert len(requests) == (2 if arm == "candidate" else 3)
    assert len(tools) == (1 if arm == "candidate" else 2)
    if arm == "candidate":
        assert record["observation"]["networkPolicy"] == {"network_mode": "no-network", "allowed_hosts": []}
        assert record["observation"]["gitHistory"] == {"status": "observed", "isShallowRepository": case == "shallow"}
    else:
        assert "gitHistory" not in record["observation"] and "networkPolicy" not in record["observation"]
    reports.append({"case": case, "arm": arm, "elapsedSec": time.monotonic() - started, "modelRequests": len(requests), "toolCalls": len(tools), "preModelShallowQueries": int(arm == "candidate"), "modelShallowQueries": int(arm == "baseline"), "ownedAcceptance": True, "terminal": terminal["status"], "footerComplete": True, "activeAgentPolicyExact": arm == "candidate", "taskEnvironmentNetworkMode": "public", "agentPhasePolicy": "no-network"})
    (root / "results.json").write_text(json.dumps(reports, indent=2))
    print(json.dumps(reports[-1]), flush=True)
(root / "receipt.json").write_text(json.dumps({"scope": "Actual Harbor/Docker caller with controlled local source; not live model obedience or benchmark success. Added initial Git read replaces a later model-mediated read, total shallow queries remains one per arm; extra snapshot bytes/preparation time are costs", "sourceHashes": sources, "results": reports}, indent=2))
