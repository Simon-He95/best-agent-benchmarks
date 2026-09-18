"""Run with the pinned Pier Python (uv tool install datacurve-pier==0.3.1, then
``uv run --python "$(uv tool dir)/pier/bin/python" test/frontier-harness-agent.test.py``).
Not part of `npm test`; mirrors test/terminal-bench-agent.test.py's recorded-env coverage."""

import base64
import itertools
import json
import logging
import os
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/frontier-harness-agent"))
from frontier_harness_best_agent import BestAgentCli
from pier.agents.installed.base import NonZeroAgentExitCodeError


class RecordedEnvironment:
    def __init__(self, home, uid, gid, failure=None):
        self.home, self.uid, self.gid = home, uid, gid
        self.failure = failure
        self.records, self.uploads = [], []
        self.upload_error = OSError("synthetic upload unavailable")

    def agent_process_env(self, env):
        return env

    async def exec(self, command, **kwargs):
        self.records.append({"command": command, **kwargs})
        stage = ("cli" if 'best-agent" run' in command else
                 "install" if "install-cli.sh" in command else
                 "metadata" if "id -u" in command else
                 "ownership" if "chown" in command else "mkdir")
        return SimpleNamespace(
            return_code=23 if self.failure == stage else 0,
            stdout=f"{self.home}\0{self.uid}\n{self.gid}\n" if stage == "metadata" else "best-agent 0.0.3-beta.17\n",
            stderr="synthetic original error" if self.failure == stage else "",
        )

    async def upload_file(self, source_path, target_path):
        if self.failure == "upload":
            raise self.upload_error
        self.uploads.append((target_path, Path(source_path).read_bytes()))


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fh-agent-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tarball = self.root / "best-agent-cli.tgz"
        self.tarball.write_bytes(b"synthetic candidate tarball")
        self.provider = self.root / "provider.json"
        self.dimcode = self.root / "dimcode-home"
        (self.dimcode / "dimcode").mkdir(parents=True)
        self.secrets = ["synthetic-provider-secret", "synthetic-config-secret", "synthetic-auth-secret"]
        self.provider.write_text(json.dumps({"secret": self.secrets[0]}))
        self.sources = [self.provider, self.dimcode / "config.json", self.dimcode / "dimcode/auth.json"]
        self.env_patch = patch.dict(os.environ, {
            "BEST_AGENT_PROVIDER_CONFIG": str(self.provider), "DIMCODE_HOME": str(self.dimcode),
            "BEST_AGENT_PROVIDER_BASE_URL": "https://dimagent.cn/v1",
            "BEST_AGENT_PROVIDER_MODEL": "synthetic-model", "BEST_AGENT_TIMEOUT_MS": "30000",
            "BEST_AGENT_CLI_WORKSPACE": "/work space",
            "BEST_AGENT_CLI_EXECUTION_ARGS_JSON": '["--no-base-instructions","--tool-exclude","network"]',
            "BEST_AGENT_CLI_TARBALL": str(self.tarball),
            "BEST_AGENT_CLI_TARBALL_SHA256": "a" * 64,
            "BEST_AGENT_CLI_BINARY_SHA256": "b" * 64,
            "BEST_AGENT_CLI_NODE_SHA256": "c" * 64,
            "BEST_AGENT_CLI_NODE_VERSION": "v24.0.0",
            "BEST_AGENT_CLI_RUNTIME_LOCK_SHA256": "d" * 64,
        })
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        self.agent = BestAgentCli(logs_dir=self.root)

    def assert_no_transfer_secrets(self, records, debug, error=""):
        text = json.dumps(records) + debug + error
        for secret in self.secrets:
            self.assertNotIn(secret, text)
            self.assertNotIn(base64.b64encode(secret.encode()).decode(), text)
        for source in self.sources:
            if source.exists():
                self.assertNotIn(base64.b64encode(source.read_bytes()).decode(), text)

    def test_network_allowlist_pins_the_frozen_gateway_host(self):
        allowlist = self.agent.network_allowlist()
        self.assertEqual(allowlist.domains, ["dimagent.cn"])

    def test_network_allowlist_fails_closed_without_gateway(self):
        del os.environ["BEST_AGENT_PROVIDER_BASE_URL"]
        with self.assertRaises(RuntimeError):
            self.agent.network_allowlist()

    async def test_install_uploads_frozen_tarball_and_runs_hash_checked_script(self):
        env = RecordedEnvironment("/home/agent space", 1234, 2345)
        await self.agent.install(env)
        script = Path(
            __import__("frontier_harness_best_agent", fromlist=[""]).__file__
        ).parent / "install-cli.sh"
        self.assertEqual(
            env.uploads,
            [
                ("/tmp/best-agent-cli.tgz", self.tarball.read_bytes()),
                ("/tmp/best-agent-install-cli.sh", script.read_bytes()),
            ],
        )
        self.assertEqual(len(env.records), 1)
        record = env.records[0]
        self.assertEqual(record["user"], None)
        self.assertIn("install-cli.sh", record["command"])
        self.assertEqual(record["env"], {
            "CLI_TARBALL": "/tmp/best-agent-cli.tgz",
            "CLI_TARBALL_SHA256": "a" * 64,
            "CLI_BINARY_SHA256": "b" * 64,
            "CLI_NODE_SHA256": "c" * 64,
            "CLI_NODE_VERSION": "v24.0.0",
            "CLI_RUNTIME_LOCK_SHA256": "d" * 64,
        })

    async def test_exact_transfer_optional_files_and_selected_identity(self):
        for uid, gid in [(0, 0), (1234, 2345)]:
            for config, auth in itertools.product([False, True], repeat=2):
                with self.subTest(uid=uid, config=config, auth=auth):
                    for index, present in enumerate([config, auth], 1):
                        if present:
                            self.sources[index].write_text(json.dumps({"secret": self.secrets[index]}))
                        else:
                            self.sources[index].unlink(missing_ok=True)
                    home = "/home/agent space"
                    env = RecordedEnvironment(home, uid, gid)
                    with self.assertLogs(self.agent.logger, logging.DEBUG) as logs:
                        await self.agent.run("public task 'quoted'", env, None)
                    selected = [p for p in self.sources if p.exists()]
                    targets = [home + "/.best-agent/provider.json"]
                    if config:
                        targets.append(home + "/.dimcode/config.json")
                    if auth:
                        targets.append(home + "/.dimcode/dimcode/auth.json")
                    self.assertEqual(env.uploads, list(zip(targets, [p.read_bytes() for p in selected])))
                    self.assertEqual(len(env.records), 4)
                    self.assertEqual([r["user"] for r in env.records], [None, None, "root", None])
                    ownership = env.records[2]["command"]
                    self.assertIn("set -e", ownership)
                    self.assertIn(f"chown {uid}:{gid} --", ownership)
                    self.assertIn("chmod 600 --", ownership)
                    self.assertNotIn("$HOME", ownership)
                    for target in targets:
                        self.assertEqual(ownership.count(shlex.quote(target)), 2)
                    cli = env.records[-1]["command"]
                    self.assertEqual(cli.count('best-agent" run'), 1)
                    self.assertIn(shlex.quote("public task 'quoted'"), cli)
                    self.assertIn("--no-base-instructions --tool-exclude network", cli)
                    self.assertIn("best-agent-process-receipt.json", cli)
                    self.assert_no_transfer_secrets(env.records, str(logs.records))

    async def test_original_setup_failure_stops_before_cli(self):
        for stage in ["metadata", "mkdir", "upload", "ownership"]:
            with self.subTest(stage=stage):
                env = RecordedEnvironment("/root", 0, 0, stage)
                with self.assertLogs(self.agent.logger, logging.DEBUG) as logs:
                    with self.assertRaises((OSError, NonZeroAgentExitCodeError)) as raised:
                        await self.agent.run("task", env, None)
                if stage == "upload":
                    self.assertIs(raised.exception, env.upload_error)
                else:
                    self.assertIn("exit 23", str(raised.exception))
                    self.assertIn("synthetic original error", str(raised.exception))
                self.assertFalse(any('best-agent" run' in r["command"] for r in env.records))
                self.assert_no_transfer_secrets(env.records, str(logs.records), str(raised.exception))

    async def test_cli_nonzero_preserves_pier_error_without_transfer_secret(self):
        env = RecordedEnvironment("/root", 0, 0, "cli")
        with self.assertLogs(self.agent.logger, logging.DEBUG) as logs:
            with self.assertRaises(NonZeroAgentExitCodeError) as raised:
                await self.agent.run("task", env, None)
        self.assertEqual(sum('best-agent" run' in r["command"] for r in env.records), 1)
        self.assertIn("exit 23", str(raised.exception))
        self.assertIn("synthetic original error", str(raised.exception))
        self.assert_no_transfer_secrets(env.records, str(logs.records), str(raised.exception))


if __name__ == "__main__":
    unittest.main()
