"""Run with the pinned Harbor Python: `<ibench venv>/bin/python test/ibench-agent.test.py`.

The fake environment records every exec and upload, so these tests pin the exact
shell the plugin issues without starting a container.
"""

import json
import os
import shlex
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/ibench-agent"))
from ibench_best_agent import BestAgentCli  # noqa: E402


class RecordedEnvironment:
    def __init__(self, home="/root", uid="0", gid="0"):
        self.home, self.uid, self.gid = home, uid, gid
        self.default_user = None
        self.records = []
        self.uploads = []

    async def exec(self, command, **kwargs):
        self.records.append({"command": command, **kwargs})
        if "id -u" in command:
            return SimpleNamespace(return_code=0, stdout=f"{self.home}\n{self.uid}\n{self.gid}\n", stderr="")
        return SimpleNamespace(return_code=0, stdout="ok", stderr="")

    async def upload_file(self, source_path, target_path):
        self.uploads.append((target_path, Path(source_path).read_bytes()))


SETTINGS = {
    "BEST_AGENT_CLI_VERSION": "0.0.19",
    "BEST_AGENT_CLI_WORKSPACE": "/workspace/app",
    "BEST_AGENT_CLI_COMMIT": "1",
    "BEST_AGENT_PROVIDER_MODEL": "deepseek-v4-flash",
    "BEST_AGENT_MODEL_TIMEOUT_MS": "600000",
    "BEST_AGENT_RUN_DURATION_MS": "3300000",
    "BEST_AGENT_GIT_IDENTITY_NAME": "ibench solver",
    "BEST_AGENT_GIT_IDENTITY_EMAIL": "solver@ibench.invalid",
    "BEST_AGENT_CLI_EXECUTION_ARGS_JSON": json.dumps(
        [
            "--workspace-backend", "plain",
            "--workspace-authorization", "unrestricted",
            "--command-policy", "path",
            "--process-isolation", "host",
            "--workspace-grant", "read",
            "--workspace-grant", "write",
            "--workspace-grant", "exec",
            "--tool-exclude", "network",
        ]
    ),
}


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ibench-agent-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.provider = self.root / "provider.json"
        self.dimcode = self.root / "dimcode-home"
        (self.dimcode / "dimcode").mkdir(parents=True)
        self.provider.write_text(json.dumps({"apiKey": "synthetic-provider-secret"}))
        (self.dimcode / "config.json").write_text(json.dumps({"secret": "synthetic-config-secret"}))
        (self.dimcode / "dimcode/auth.json").write_text(json.dumps({"secret": "synthetic-auth-secret"}))
        self.env_patch = patch.dict(
            os.environ,
            {"BEST_AGENT_PROVIDER_CONFIG": str(self.provider), "DIMCODE_HOME": str(self.dimcode)},
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def agent(self, **overrides):
        return BestAgentCli(logs_dir=self.root, extra_env={**SETTINGS, **overrides})

    def uploads_never_leak(self, environment):
        # Credentials travel only as uploaded identity files, never on a command line.
        for record in environment.records:
            for secret in ("synthetic-provider-secret", "synthetic-config-secret", "synthetic-auth-secret"):
                self.assertNotIn(secret, record["command"])

    async def test_install_pins_the_published_package_and_verifies_the_version(self):
        environment = RecordedEnvironment()
        await self.agent().install(environment)
        install = environment.records[1]["command"]
        self.assertIn("npm install --prefix \"$prefix\"", install)
        self.assertIn(shlex.quote("@best-agent/cli@0.0.19"), install)
        # The platform binary is an npm optional dependency; installing it as an
        # explicit dependency makes a missed fetch a setup failure, not a broken CLI.
        self.assertIn('"@best-agent/cli-linux-${platform}-gnu@0.0.19"', install)
        self.assertIn('case "$arch" in', install)
        self.assertIn("install_cli || install_cli", install)
        self.assertIn("node --version", environment.records[0]["command"])
        self.assertIn("npm --version", environment.records[0]["command"])
        self.assertIn("--version", install)

    async def test_solver_run_uploads_identity_commits_and_keeps_flag_order(self):
        environment = RecordedEnvironment(home="/home/agent space", uid="1000", gid="1000")
        await self.agent().run("Fix the map panning bug.", environment, None)
        targets = [target for target, _ in environment.uploads]
        self.assertEqual(
            targets,
            [
                "/home/agent space/.best-agent/provider.json",
                "/home/agent space/.dimcode/config.json",
                "/home/agent space/.dimcode/dimcode/auth.json",
            ],
        )
        self.uploads_never_leak(environment)
        commands = [record["command"] for record in environment.records]
        chown = next(command for command in commands if "chown" in command)
        self.assertIn("chown 1000:1000 --", chown)
        self.assertIn("chmod 600 --", chown)
        self.assertIn("git config --global --replace-all user.name", next(c for c in commands if "user.name" in c))
        run_command = commands[-1]
        # The CLI rejects workspace-scoped flags that precede --workspace.
        self.assertLess(run_command.index("--workspace /workspace/app"), run_command.index("--workspace-grant"))
        self.assertIn("--attempt-evidence /logs/agent/best-agent-evidence.jsonl", run_command)
        self.assertIn("rm -f /logs/agent/best-agent-evidence.jsonl", run_command)
        self.assertIn("--tool-exclude network", run_command)
        self.assertIn(shlex.quote("Fix the map panning bug."), run_command)
        self.assertIn("git -C /workspace/app add -A", run_command)
        self.assertIn("commit --no-verify", run_command)
        self.assertTrue(run_command.rstrip().endswith("exit 0"), "a failed CLI exit is recorded, not raised")

    async def test_scorer_run_does_not_commit_product_source(self):
        environment = RecordedEnvironment()
        await self.agent(
            BEST_AGENT_CLI_WORKSPACE="/workspace",
            BEST_AGENT_CLI_COMMIT="0",
        ).run("Score the candidate.", environment, None)
        run_command = environment.records[-1]["command"]
        self.assertIn("--workspace /workspace ", run_command)
        self.assertNotIn("git add -A", run_command)
        self.assertNotIn("commit --no-verify", run_command)
        self.assertIn('"committed":%s', run_command)
        self.assertIn('"$status" 0', run_command)

    async def test_missing_provider_identity_fails_before_any_exec(self):
        with patch.dict(os.environ, {"BEST_AGENT_PROVIDER_CONFIG": ""}):
            environment = RecordedEnvironment()
            with self.assertRaises(RuntimeError):
                await self.agent().run("Fix it.", environment, None)
            self.assertEqual(environment.records, [])


if __name__ == "__main__":
    unittest.main()
