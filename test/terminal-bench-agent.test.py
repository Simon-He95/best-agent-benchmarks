"""Run with the pinned Harbor Python; optional Docker fixtures use TB_AGENT_TEST_IMAGE."""

import base64
import itertools
import json
import logging
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools/terminal-bench-agent"))
from terminal_bench_best_agent import BestAgentCli
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.environments.docker.docker_unix import UnixOps


class RecordedEnvironment:
    def __init__(self, home, uid, gid, failure=None):
        self.home, self.uid, self.gid = home, uid, gid
        self.failure = failure
        self.records, self.uploads = [], []
        self.upload_error = OSError("synthetic upload unavailable")

    async def exec(self, command, **kwargs):
        self.records.append({"command": command, **kwargs})
        stage = ("cli" if 'best-agent" run' in command else
                 "metadata" if "id -u" in command else
                 "ownership" if "chown" in command else "mkdir")
        return SimpleNamespace(
            return_code=23 if self.failure == stage else 0,
            stdout=f"{self.home}\0{self.uid}\n{self.gid}\n" if stage == "metadata" else "synthetic stdout",
            stderr="synthetic original error" if self.failure == stage else "",
        )

    async def upload_file(self, source_path, target_path):
        if self.failure == "upload":
            raise self.upload_error
        self.uploads.append((target_path, Path(source_path).read_bytes()))


def _expected_git_identity_command() -> str:
    """The task environment's git identity, stated independently of the plugin.

    A task image ships no identity of its own, and a model-issued command reads no
    global config at all (the CLI runs it with ``GIT_CONFIG_GLOBAL=/dev/null``), so
    the attempt writes the identity into the agent's global config *and* into the
    local config of every repository under the workspace; every value is quoted as a
    single shell word. The `set -o pipefail; ` prefix is harbor's own wrapping of
    `exec_as_agent`.
    """
    return (
        "set -o pipefail; set -e; if command -v git >/dev/null 2>&1; then\n"
        "git config --global --replace-all user.name 'Test Agent'\n"
        "git config --global --replace-all user.email test.agent@example.invalid\n"
        'for root in \'/work space\' "$HOME"; do\n'
        '  for candidate in "$root"/.git "$root"/*/.git "$root"/*/*/.git "$root"/*/*/*/.git; do\n'
        '    if [ -d "$candidate" ]; then\n'
        '      git --git-dir="$candidate" config --local --get user.name >/dev/null 2>&1 || git --git-dir="$candidate" config user.name \'Test Agent\'\n'
        '      git --git-dir="$candidate" config --local --get user.email >/dev/null 2>&1 || git --git-dir="$candidate" config user.email test.agent@example.invalid\n'
        "    fi\n"
        "  done\n"
        "done\n"
        "fi"
    )


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tb-agent-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.provider = self.root / "provider.json"
        self.dimcode = self.root / "dimcode-home"
        (self.dimcode / "dimcode").mkdir(parents=True)
        self.secrets = ["synthetic-provider-secret", "synthetic-config-secret", "synthetic-auth-secret"]
        self.provider.write_text(json.dumps({"secret": self.secrets[0]}))
        self.sources = [self.provider, self.dimcode / "config.json", self.dimcode / "dimcode/auth.json"]
        self.env_patch = patch.dict(os.environ, {
            "BEST_AGENT_PROVIDER_CONFIG": str(self.provider), "DIMCODE_HOME": str(self.dimcode),
            "BEST_AGENT_PROVIDER_MODEL": "synthetic-model",
            "BEST_AGENT_MODEL_TIMEOUT_MS": "30000",
            "BEST_AGENT_CLI_WORKSPACE": "/work space",
            "BEST_AGENT_CLI_EXECUTION_ARGS_JSON": '["--no-base-instructions","--tool-exclude","network"]',
            "BEST_AGENT_GIT_IDENTITY_NAME": "Test Agent",
            "BEST_AGENT_GIT_IDENTITY_EMAIL": "test.agent@example.invalid",
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
                    # metadata, mkdir, git identity, chown, the workspace `pwd`, the CLI Run.
                    # (The `pwd` record long predates the git identity step; this assertion
                    # said 4 while the plugin already issued 5.)
                    self.assertEqual(len(env.records), 6)
                    self.assertEqual([r["user"] for r in env.records], [None, None, None, "root", None, None])
                    # The task environment's git identity is written as the agent user, after the
                    # agent home exists and before anything the attempt depends on: the container
                    # ships no identity, so a model commit would otherwise be refused.
                    git_identity = env.records[2]["command"]
                    self.assertEqual(git_identity, _expected_git_identity_command())
                    self.assertIn(shlex.quote("Test Agent"), git_identity)
                    self.assertIn(shlex.quote("test.agent@example.invalid"), git_identity)
                    # The global write alone is not enough: the CLI runs every model command with
                    # GIT_CONFIG_GLOBAL=/dev/null, so the identity must also reach each repository's
                    # own config, and the workspace root must survive as one shell word.
                    self.assertIn(shlex.quote("/work space"), git_identity)
                    self.assertEqual(git_identity.count("config --local --get user.name"), 1)
                    self.assertEqual(git_identity.count("config --local --get user.email"), 1)
                    self.assertIn('--git-dir="$candidate" config user.name', git_identity)
                    self.assertIn('--git-dir="$candidate" config user.email', git_identity)
                    ownership = env.records[3]["command"]
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
                    # The attempt-derived ceiling reaches the CLI as its own flag. No attempt wall
                    # clock is exported under a provider-timeout name: the env wins over the flag,
                    # so a leftover export would silently ignore this one.
                    self.assertIn("--model-timeout-ms 30000", cli)
                    self.assertNotIn("BEST_AGENT_PROVIDER_TIMEOUT_MS", cli)
                    self.assertNotIn("BEST_AGENT_TIMEOUT_MS", cli)
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

    async def test_cli_nonzero_preserves_harbor_error_without_transfer_secret(self):
        env = RecordedEnvironment("/root", 0, 0, "cli")
        with self.assertLogs(self.agent.logger, logging.DEBUG) as logs:
            with self.assertRaises(NonZeroAgentExitCodeError) as raised:
                await self.agent.run("task", env, None)
        self.assertEqual(sum('best-agent" run' in r["command"] for r in env.records), 1)
        self.assertIn("exit 23", str(raised.exception))
        self.assertIn("synthetic original error", str(raised.exception))
        self.assert_no_transfer_secrets(env.records, str(logs.records), str(raised.exception))


class DockerEnvironment:
    def __init__(self, compose, home, user):
        self.compose, self.home, self.user = compose, home, user
        self.ops = UnixOps(self)
        self.records, self.before_ownership = [], []

    async def _run_docker_compose_command(self, args, check=True):
        return subprocess.run(["docker", "compose", "-f", str(self.compose), *args],
                              check=check, capture_output=True, text=True)

    async def exec(self, command, user=None, env=None, **kwargs):
        self.records.append({"command": command, "user": user, "env": env})
        args = ["exec", "-T", "--user", str(user or self.user), "-e", f"HOME={self.home}"]
        for key, value in (env or {}).items():
            args += ["-e", f"{key}={value}"]
        result = await self._run_docker_compose_command([*args, "main", "bash", "-c", command], check=False)
        return SimpleNamespace(return_code=result.returncode, stdout=result.stdout, stderr=result.stderr)

    async def upload_file(self, source_path, target_path):
        await self.ops.upload_file(source_path, target_path)
        observed = await self.exec("stat -c '%u:%g:%a' -- " + shlex.quote(target_path), user="root")
        if observed.return_code:
            raise RuntimeError(observed.stderr)
        self.before_ownership.append(observed.stdout.strip())


@unittest.skipUnless(os.environ.get("TB_AGENT_TEST_IMAGE"), "set TB_AGENT_TEST_IMAGE to an existing local image with bash")
class DockerAgentTests(AgentTests):
    async def test_real_upload_ownership_stdout_stderr_receipt_and_setup_errors(self):
        for user in ["0:0", "1234:2345"]:
            with self.subTest(user=user):
                home = "/home/agent space"
                compose = self.root / ("compose-" + user.replace(":", "-") + ".json")
                compose.write_text(json.dumps({"services": {"main": {
                    "image": os.environ["TB_AGENT_TEST_IMAGE"], "pull_policy": "never",
                    "entrypoint": ["bash", "-c", "sleep infinity"],
                }}}))
                env = DockerEnvironment(compose, home, user)
                await env._run_docker_compose_command(["up", "-d", "--no-build"])
                try:
                    cli_path = home + "/.best-agent-cli/bin/best-agent"
                    script = '#!/bin/bash\nprintf "synthetic out\\n"\nprintf "synthetic err\\n" >&2\nexit 23\n'
                    setup = "set -e; mkdir -p " + shlex.quote(home + "/.best-agent-cli/bin") + " '/work space' /logs/agent; "
                    setup += "printf %s " + shlex.quote(script) + " > " + shlex.quote(cli_path) + "; chmod 755 " + shlex.quote(cli_path)
                    setup += "; chown " + user + " " + shlex.quote(home) + " /logs/agent"
                    self.assertEqual((await env.exec(setup, user="root")).return_code, 0)
                    for index in [1, 2]:
                        self.sources[index].write_text(json.dumps({"secret": self.secrets[index]}))
                    with self.assertRaises(NonZeroAgentExitCodeError) as raised:
                        await self.agent.run("public task", env, None)
                    self.assertIn("exit 23", str(raised.exception))
                    self.assertEqual(sum('best-agent" run' in r["command"] for r in env.records), 1)
                    for index, relative in enumerate([".best-agent/provider.json", ".dimcode/config.json", ".dimcode/dimcode/auth.json"]):
                        target = shlex.quote(home + "/" + relative)
                        result = await env.exec("stat -c '%u:%g:%a' -- " + target + "; cat -- " + target)
                        self.assertEqual(result.return_code, 0)
                        self.assertEqual(result.stdout, user + ":600\n" + self.sources[index].read_text())
                    for name, expected in [("stdout.txt", "synthetic out\n"), ("stderr.txt", "synthetic err\n"),
                                           ("process-receipt.json", '{"exitCode":23}\n')]:
                        result = await env.exec("cat /logs/agent/best-agent-" + name)
                        self.assertEqual(result.stdout, expected)
                    self.assert_no_transfer_secrets(env.records, "", str(raised.exception))
                    for failing in ["chown", "chmod"]:
                        setup = "set -e; mkdir -p /failure-bin; rm -f /failure-bin/chown /failure-bin/chmod /tmp/after-chown; "
                        setup += "printf %s " + shlex.quote('#!/bin/bash\necho synthetic-permission-error >&2\nexit 43\n') + " > /failure-bin/" + failing
                        if failing == "chown":
                            setup += "; printf %s " + shlex.quote('#!/bin/bash\ntouch /tmp/after-chown\n') + " > /failure-bin/chmod"
                        setup += "; chmod 755 /failure-bin/*"
                        self.assertEqual((await env.exec(setup, user="root")).return_code, 0)
                        previous = len(env.records)
                        with patch.object(self.agent, "_extra_env", {"PATH": "/failure-bin:/usr/bin:/bin"}):
                            with self.assertRaises(NonZeroAgentExitCodeError) as failed:
                                await self.agent.run("task", env, None)
                        self.assertIn("exit 43", str(failed.exception))
                        self.assertIn("synthetic-permission-error", str(failed.exception))
                        self.assertFalse(any('best-agent" run' in r["command"] for r in env.records[previous:]))
                        self.assertEqual((await env.exec("test ! -e /tmp/after-chown")).return_code, 0)
                    print(json.dumps({"dockerUser": user, "uploadOwnerModes": env.before_ownership[:3], "finalMode": "600", "cliExit": 23}))
                finally:
                    await env._run_docker_compose_command(["down"])


if __name__ == "__main__":
    unittest.main()
