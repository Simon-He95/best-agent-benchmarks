"""Run with the pinned Harbor Python: `<ibench venv>/bin/python test/ibench-agent.test.py`.

The fake environment records every exec and upload, so these tests pin the exact
shell the plugin issues without starting a container.
"""

import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/ibench-agent"))
import tomllib
from harbor.models.task.config import TaskConfig
from harbor.models.trial.config import TrialConfig
from harbor.trial.multi_step import MultiStepTrial
from ibench_best_agent import BestAgentCli


class RecordedEnvironment:
    def __init__(
        self,
        root,
        home="/root",
        uid="0",
        gid="0",
        phase="solve",
        timeout=3600,
        trial_overrides=None,
    ):
        self.home, self.uid, self.gid = home, uid, gid
        self.default_user = None
        task = root / "task"
        self.environment_dir = task / "environment"
        self.environment_dir.mkdir(parents=True, exist_ok=True)
        (task / "task.toml").write_text(
            f'schema_version = "1.4"\n[task]\nname = "self-owned/closure"\n'
            f'[[steps]]\nname = "{phase}"\n[steps.agent]\ntimeout_sec = {timeout}\n'
        )
        trial = TrialConfig.model_validate(
            {
                "task": {"path": str(task)},
                "agent": {"import_path": "ibench_best_agent:BestAgentCli"},
                **(trial_overrides or {}),
            }
        )
        config_path = root / "trial.json"
        config_path.write_text(trial.model_dump_json())
        self.trial_paths = SimpleNamespace(config_path=config_path)
        self.task_env_config = SimpleNamespace(
            env={
                "DEV_ENV_READY": "true",
                "DEV_ENV_START": "public-start",
                "PROVIDER_SECRET": "never-copy",
            }
        )
        self.records = []
        self.uploads = []

    async def exec(self, command, **kwargs):
        self.records.append({"command": command, **kwargs})
        if "id -u" in command:
            return SimpleNamespace(
                return_code=0,
                stdout=f"{self.home}\n{self.uid}\n{self.gid}\n",
                stderr="",
            )
        if " prepare " in command:
            return SimpleNamespace(
                return_code=0,
                stdout=json.dumps({"text": "Verified initial runtime: fixture"}),
                stderr="",
            )
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
            "--workspace-backend",
            "plain",
            "--workspace-authorization",
            "unrestricted",
            "--command-policy",
            "path",
            "--process-isolation",
            "host",
            "--workspace-grant",
            "read",
            "--workspace-grant",
            "write",
            "--workspace-grant",
            "exec",
            "--tool-exclude",
            "network",
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
        (self.dimcode / "config.json").write_text(
            json.dumps({"secret": "synthetic-config-secret"})
        )
        (self.dimcode / "dimcode/auth.json").write_text(
            json.dumps({"secret": "synthetic-auth-secret"})
        )
        self.env_patch = patch.dict(
            os.environ,
            {
                "BEST_AGENT_PROVIDER_CONFIG": str(self.provider),
                "DIMCODE_HOME": str(self.dimcode),
            },
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def agent(self, **overrides):
        return BestAgentCli(logs_dir=self.root, extra_env={**SETTINGS, **overrides})

    def uploads_never_leak(self, environment):
        # Credentials travel only as uploaded identity files, never on a command line.
        for record in environment.records:
            for secret in (
                "synthetic-provider-secret",
                "synthetic-config-secret",
                "synthetic-auth-secret",
            ):
                self.assertNotIn(secret, record["command"])

    async def test_install_pins_the_published_package_and_verifies_the_version(self):
        environment = RecordedEnvironment(self.root)
        await self.agent().install(environment)
        install = environment.records[1]["command"]
        self.assertIn('npm install --prefix "$prefix"', install)
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
        environment = RecordedEnvironment(
            self.root, home="/home/agent space", uid="1000", gid="1000"
        )
        await self.agent().run("Fix the map panning bug.", environment, None)
        targets = [target for target, _ in environment.uploads]
        self.assertEqual(
            targets[:3],
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
        self.assertIn(
            "git config --global --replace-all user.name",
            next(c for c in commands if "user.name" in c),
        )
        launch = json.loads((self.root / "best-agent-launch.json").read_text())
        argv = launch["argv"]
        self.assertLess(argv.index("--workspace"), argv.index("--workspace-grant"))
        self.assertIn("--attempt-remaining-ms", argv)
        remaining = int(argv[argv.index("--attempt-remaining-ms") + 1])
        self.assertGreater(remaining, 3_560_000)
        self.assertLessEqual(remaining, 3_570_000)
        self.assertEqual(argv[argv.index("--model-timeout-ms") + 1], "600000")
        self.assertTrue(argv[-1].startswith("Fix the map panning bug.\n\n"))
        self.assertEqual(argv[-1].count("Verified initial runtime"), 1)
        self.assertTrue(launch["commit"])
        prep = json.loads((self.root / "best-agent-preparation-input.json").read_text())
        self.assertNotIn("PROVIDER_SECRET", prep["commands"])
        self.assertIn("DEV_ENV_READY", prep["commands"])
        self.assertIn(" run ", commands[-1])

    async def test_scorer_run_does_not_commit_or_append_solve_environment(self):
        environment = RecordedEnvironment(self.root, phase="score")
        await self.agent(
            BEST_AGENT_CLI_WORKSPACE="/workspace", BEST_AGENT_CLI_COMMIT="0"
        ).run("Score the candidate.", environment, None)
        launch = json.loads((self.root / "best-agent-launch.json").read_text())
        self.assertFalse(launch["commit"])
        self.assertEqual(launch["argv"][-1], "Score the candidate.")
        self.assertFalse(
            any(" prepare " in record["command"] for record in environment.records)
        )

    async def test_budget_projection_matches_pinned_harbor_overrides_and_multiplier(
        self,
    ):
        environment = RecordedEnvironment(
            self.root,
            timeout=3600,
            trial_overrides={
                "agent": {
                    "import_path": "ibench_best_agent:BestAgentCli",
                    "override_timeout_sec": 200,
                    "max_timeout_sec": 150,
                },
                "agent_timeout_multiplier": 1.5,
            },
        )
        task = TaskConfig.model_validate(
            tomllib.loads(
                (environment.environment_dir.parent / "task.toml").read_text()
            )
        )
        trial = object.__new__(MultiStepTrial)
        trial.config = TrialConfig.model_validate_json(
            environment.trial_paths.config_path.read_bytes()
        )
        trial.task = SimpleNamespace(config=task)
        expected = trial._step_agent_timeout_sec(task.steps[0])
        self.assertEqual(
            BestAgentCli._attempt_budget_ms(environment), int(expected * 1000)
        )
        self.assertEqual(expected, 225)

    async def test_preparation_time_and_finalization_reserve_are_subtracted_once(self):
        environment = RecordedEnvironment(self.root)
        with patch(
            "ibench_best_agent.time.monotonic_ns",
            side_effect=[10_000_000_000, 17_000_000_000],
        ):
            await self.agent().run("Fix it.", environment, None)
        timing = json.loads((self.root / "best-agent-attempt-timing.json").read_text())
        self.assertEqual(timing["wrapperElapsedMs"], 7000)
        self.assertEqual(timing["finalizationReserveMs"], 30000)
        self.assertEqual(timing["attemptRemainingMs"], 3563000)

    async def test_exhausted_budget_never_launches_cli(self):
        environment = RecordedEnvironment(self.root, timeout=20)
        with self.assertRaisesRegex(RuntimeError, "No attempt time remains"):
            await self.agent().run("Fix it.", environment, None)
        self.assertFalse(
            any(" run " in record["command"] for record in environment.records)
        )

    async def test_readiness_failure_never_launches_cli(self):
        environment = RecordedEnvironment(self.root)
        original = environment.exec

        async def fail_probe(command, **kwargs):
            if " prepare " in command:
                return SimpleNamespace(
                    return_code=7, stdout="", stderr="original readiness failure"
                )
            return await original(command, **kwargs)

        environment.exec = fail_probe
        with self.assertRaisesRegex(RuntimeError, "original readiness failure"):
            await self.agent().run("Fix it.", environment, None)
        self.assertFalse(
            any(" run " in record["command"] for record in environment.records)
        )

    async def test_missing_provider_identity_fails_before_any_exec(self):
        with patch.dict(os.environ, {"BEST_AGENT_PROVIDER_CONFIG": ""}):
            environment = RecordedEnvironment(self.root)
            with self.assertRaises(RuntimeError):
                await self.agent().run("Fix it.", environment, None)
            self.assertEqual(environment.records, [])


class FinalizationTests(unittest.TestCase):
    def test_finalization_timeout_kills_its_process_group_and_retains_primary_receipt(
        self,
    ):
        with tempfile.TemporaryDirectory(prefix="ibench-finalize-") as name:
            root = Path(name)
            (root / ".git").mkdir()
            (root / "bin").mkdir()
            git = root / "bin/git"
            git.write_text(
                '#!/bin/bash\nif [ "$3" = "rev-parse" ]; then echo fixture-head; exit 0; fi\n'
                f"(sleep 34; touch {shlex.quote(str(root / 'late-write'))}) &\nwait\n"
            )
            git.chmod(0o755)
            launch = root / "launch.json"
            launch.write_text(
                json.dumps(
                    {
                        "workspace": str(root),
                        "argv": [
                            sys.executable,
                            "-c",
                            "print('owned primary completed')",
                        ],
                        "commit": True,
                        "gitName": "fixture",
                        "gitEmail": "fixture@invalid",
                        "model": "local-test",
                        "version": "0.0.19",
                    }
                )
            )
            started = time.monotonic()
            result = subprocess.run(
                [
                    sys.executable,
                    str(
                        Path(__file__).resolve().parents[1]
                        / "tools/ibench-agent/ibench_best_agent/attempt.py"
                    ),
                    "run",
                    str(launch),
                ],
                env={
                    **os.environ,
                    "PATH": str(root / "bin") + os.pathsep + os.environ["PATH"],
                },
                capture_output=True,
                text=True,
                check=False,
                timeout=38,
            )
            self.assertEqual(result.returncode, 124, result.stderr)
            self.assertLess(time.monotonic() - started, 35)
            receipt = json.loads((root / "best-agent-process-receipt.json").read_text())
            self.assertEqual(receipt["exitCode"], 0)
            self.assertTrue(receipt["finalizationTimedOut"])
            self.assertEqual(receipt["finalizationSignal"], "SIGKILL")
            self.assertIsNone(receipt["finalizationExitCode"])
            time.sleep(5)
            self.assertFalse((root / "late-write").exists())


if __name__ == "__main__":
    unittest.main()
