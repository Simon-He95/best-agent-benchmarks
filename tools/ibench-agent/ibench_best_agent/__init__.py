"""Harbor installed-agent plugin driving a pinned best-agent CLI inside IBench tasks.

IBench compiles each published task into a Harbor task whose solve step grades a
trusted `candidate.patch`. That patch is produced by the task verifier from the
commits the solver leaves in `/workspace/app`, so this plugin both runs the CLI
and makes the workspace's final state a commit before the verifier runs.

The CLI is installed from the pinned public npm package inside the task
container (the IBench base image already ships Node and npm). Credentials are
uploaded as the CLI's own provider/dimcode identity files, never passed on a
command line.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

DEFAULT_WORKSPACE = "/workspace/app"
LOG_DIR = "/logs/agent"
INSTALL_DIR = "$HOME/.ibench-best-agent"
CLI_BIN = "$HOME/.ibench-best-agent/node_modules/.bin/best-agent"


def _required_env(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"{key} is required")
    return value


def _single_line(key: str, value: str) -> str:
    if any(character in value for character in ("\n", "\r", "\0")):
        raise RuntimeError(f"{key} must be a single line")
    return value


class BestAgentCli(BaseInstalledAgent):
    """Run one headless best-agent CLI attempt per IBench solve/score step."""

    @staticmethod
    @override
    def name() -> str:
        return "best-agent-cli"

    def _setting(self, key: str, default: str | None = None) -> str | None:
        """Read an agent setting.

        Harbor merges the JobConfig agent `env` into `extra_env` and scopes it
        over every agent exec, so that mapping is the per-phase truth. The host
        environment is only a fallback for hosts that set the same names.
        """
        value = self._extra_env.get(key)
        if value:
            return value
        return os.environ.get(key) or default

    def _required_setting(self, key: str) -> str:
        value = self._setting(key)
        if not value:
            raise RuntimeError(f"{key} is required")
        return value

    async def _prepare_provider(self, environment: BaseEnvironment) -> None:
        # Fail on a host configuration error before touching the container.
        provider_config = Path(_required_env("BEST_AGENT_PROVIDER_CONFIG"))
        dimcode_home = Path(_required_env("DIMCODE_HOME"))
        identity = await self.exec_as_agent(
            environment, command='printf \'%s\\n\' "$HOME"; id -u; id -g'
        )
        home, uid, gid = identity.stdout.splitlines()[:3]
        files = [(provider_config, f"{home}/.best-agent/provider.json")]
        for relative in ("config.json", "dimcode/auth.json"):
            source = dimcode_home / relative
            if source.is_file():
                files.append((source, f"{home}/.dimcode/{relative}"))
        await self.exec_as_agent(
            environment,
            command=(
                "set -e; mkdir -p -- "
                + shlex.quote(f"{home}/.best-agent")
                + " "
                + shlex.quote(f"{home}/.dimcode/dimcode")
            ),
        )
        for source, target in files:
            await environment.upload_file(str(source), target)
        targets = " ".join(shlex.quote(target) for _, target in files)
        await self.exec_as_root(
            environment,
            command=(
                f"set -e; chown {shlex.quote(uid + ':' + gid)} -- {targets};"
                f" chmod 600 -- {targets}"
            ),
        )
        # The CLI runs model-issued commands with a null global git config, so a
        # repo-local identity is the only channel a commit it makes can read.
        name = _single_line("BEST_AGENT_GIT_IDENTITY_NAME", self._required_setting("BEST_AGENT_GIT_IDENTITY_NAME"))
        email = _single_line("BEST_AGENT_GIT_IDENTITY_EMAIL", self._required_setting("BEST_AGENT_GIT_IDENTITY_EMAIL"))
        workspace = self._setting("BEST_AGENT_CLI_WORKSPACE", DEFAULT_WORKSPACE)
        await self.exec_as_agent(
            environment,
            command=(
                "set -e\n"
                "if command -v git >/dev/null 2>&1; then\n"
                f"  git config --global --replace-all user.name {shlex.quote(name)}\n"
                f"  git config --global --replace-all user.email {shlex.quote(email)}\n"
                f"  for candidate in {shlex.quote(workspace + '/.git')}"
                f" {shlex.quote(workspace + '/../.git')}; do\n"
                '    if [ -d "$candidate" ]; then\n'
                f"      git --git-dir=\"$candidate\" config user.name {shlex.quote(name)}\n"
                f"      git --git-dir=\"$candidate\" config user.email {shlex.quote(email)}\n"
                "    fi\n"
                "  done\n"
                "fi"
            ),
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        version = self._required_setting("BEST_AGENT_CLI_VERSION")
        package = self._setting("BEST_AGENT_CLI_PACKAGE", "@best-agent/cli")
        probe = await self.exec_as_agent(
            environment, command="set -e; command -v node; node --version; npm --version"
        )
        self.logger.info("best-agent install runtime: %s", probe.stdout.strip().replace("\n", " "))
        await self.exec_as_agent(
            environment,
            command=(
                "set -e\n"
                f"prefix={INSTALL_DIR}\n"
                'mkdir -p "$prefix"\n'
                # The launcher resolves its platform binary through an optional
                # dependency, and npm treats a failed optional fetch as a
                # warning. Installing that binary as an explicit dependency
                # turns a flaky download into a loud failure instead of a
                # container that only fails when the agent starts.
                'arch="$(uname -m)"\n'
                'case "$arch" in\n'
                "  x86_64|amd64) platform=x64 ;;\n"
                "  aarch64|arm64) platform=arm64 ;;\n"
                '  *) echo "unsupported container architecture: $arch" >&2; exit 1 ;;\n'
                "esac\n"
                "install_cli() {\n"
                '  npm install --prefix "$prefix" --no-audit --no-fund --loglevel=error \\\n'
                "    " + shlex.quote(f"{package}@{version}") + " \\\n"
                '    "@best-agent/cli-linux-${platform}-gnu@'
                + version
                + '"\n'
                "}\n"
                "install_cli || install_cli\n"
                f'"{CLI_BIN}" --version\n'
            ),
        )

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        model = self._setting("BEST_AGENT_PROVIDER_MODEL", self.model_name or "")
        if not model:
            raise RuntimeError("BEST_AGENT_PROVIDER_MODEL is required")
        workspace = self._setting("BEST_AGENT_CLI_WORKSPACE", DEFAULT_WORKSPACE)
        commit = self._setting("BEST_AGENT_CLI_COMMIT", "0") == "1"
        model_timeout_ms = self._setting("BEST_AGENT_MODEL_TIMEOUT_MS", "600000")
        run_duration_ms = self._setting("BEST_AGENT_RUN_DURATION_MS", "3300000")
        execution_args = json.loads(self._setting("BEST_AGENT_CLI_EXECUTION_ARGS_JSON", "[]"))
        name = _single_line("BEST_AGENT_GIT_IDENTITY_NAME", self._required_setting("BEST_AGENT_GIT_IDENTITY_NAME"))
        email = _single_line("BEST_AGENT_GIT_IDENTITY_EMAIL", self._required_setting("BEST_AGENT_GIT_IDENTITY_EMAIL"))
        await self._prepare_provider(environment)
        await self.exec_as_agent(
            environment,
            command=(
                "set -e; mkdir -p "
                + shlex.quote(LOG_DIR)
                + "; if [ -d "
                + shlex.quote(workspace + "/.git")
                + " ]; then git -C "
                + shlex.quote(workspace)
                + ' rev-parse HEAD > '
                + shlex.quote(f"{LOG_DIR}/best-agent-workspace-head-before.txt")
                + " 2>/dev/null || true; fi"
            ),
        )
        command = "\n".join(
            [
                "set -e",
                'export BEST_AGENT_PROVIDER_CONFIG="$HOME/.best-agent/provider.json"',
                'export DIMCODE_HOME="$HOME/.dimcode"',
                'export BEST_AGENT_STORAGE_ROOT=' + shlex.quote(f"{LOG_DIR}/best-agent-runtime"),
                "export BEST_AGENT_PROVIDER_MODEL=" + shlex.quote(model),
                "export DIMCODE_VERSION=" + shlex.quote(self._setting("BEST_AGENT_CLI_VERSION", "dev")),
                "mkdir -p " + shlex.quote(f"{LOG_DIR}/best-agent-runtime"),
                # A resumed trial can reuse this logs volume; the CLI refuses an
                # evidence path that already exists, so drop our own stale file.
                "rm -f " + shlex.quote(f"{LOG_DIR}/best-agent-evidence.jsonl"),
                "cd " + shlex.quote(workspace),
                "set +e",
                CLI_BIN
                + " run --model "
                + shlex.quote(model)
                + " --model-timeout-ms "
                + shlex.quote(model_timeout_ms)
                + " --run-duration-ms "
                + shlex.quote(run_duration_ms)
                + " --workspace "
                + shlex.quote(workspace)
                + " "
                + " ".join(shlex.quote(value) for value in execution_args)
                + " --attempt-evidence "
                + shlex.quote(f"{LOG_DIR}/best-agent-evidence.jsonl")
                + " "
                + shlex.quote(instruction)
                + " </dev/null > "
                + shlex.quote(f"{LOG_DIR}/best-agent-stdout.txt")
                + " 2> "
                + shlex.quote(f"{LOG_DIR}/best-agent-stderr.txt"),
                "status=$?",
                "set -e",
                *([self._commit_script(workspace, name, email)] if commit else []),
                "if [ -d "
                + shlex.quote(workspace + "/.git")
                + " ]; then git -C "
                + shlex.quote(workspace)
                + ' rev-parse HEAD > '
                + shlex.quote(f"{LOG_DIR}/best-agent-workspace-head-after.txt")
                + " 2>/dev/null || true; fi",
                "printf '{\"exitCode\":%s,\"committed\":%s}\\n' \"$status\" "
                + ("1" if commit else "0")
                + " > "
                + shlex.quote(f"{LOG_DIR}/best-agent-process-receipt.json"),
                # A non-zero CLI exit is recorded, not raised: IBench grades the
                # committed patch, and a trial that produced one must still be
                # scored rather than discarded as an agent error.
                "exit 0",
            ]
        )
        await self.exec_as_agent(environment, command=command)

    @staticmethod
    def _commit_script(workspace: str, name: str, email: str) -> str:
        quoted = shlex.quote(workspace)
        return (
            f'if [ -d {quoted}/.git ]; then\n'
            f"  git -C {quoted} add -A\n"
            f"  if ! git -C {quoted} diff --cached --quiet; then\n"
            f"    git -C {quoted} -c user.name={shlex.quote(name)}"
            f" -c user.email={shlex.quote(email)} commit --no-verify"
            ' -m "ibench: candidate repair" >/dev/null\n'
            "  fi\n"
            "fi"
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        stdout_path = Path(self.logs_dir) / "best-agent-stdout.txt"
        metadata: dict[str, object] = {}
        if stdout_path.exists():
            text = stdout_path.read_text(errors="replace")
            if text.strip():
                metadata["stdout_tail"] = text[-8000:]
        evidence_path = Path(self.logs_dir) / "best-agent-evidence.jsonl"
        if evidence_path.exists():
            metadata["evidence_bytes"] = evidence_path.stat().st_size
        if metadata:
            context.metadata = metadata
