"""Harbor installed-agent plugin for one frozen best-agent CLI candidate."""

import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

def _required_env(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"{key} is required")
    return value


def _git_identity_command() -> str:
    """One idempotent write of the attempt's frozen git identity into the agent's
    global git config.

    A task image ships no git identity of its own, so a model commit stops at
    "unable to auto-detect email address" — observed in a real attempt — and the
    model then spends a turn working around it on every commit. The identity is
    read from the harness host and passed in, so the task environment carries the
    same one the run declared. `git` itself is optional in a task image: an image
    without it is left as it is instead of failing the attempt.
    """
    name = _required_env("BEST_AGENT_GIT_IDENTITY_NAME")
    email = _required_env("BEST_AGENT_GIT_IDENTITY_EMAIL")
    for value in (name, email):
        if any(character in value for character in ("\n", "\r", "\0")):
            raise RuntimeError("BEST_AGENT_GIT_IDENTITY_* must be a single line")
    return (
        "set -e; if command -v git >/dev/null 2>&1; then "
        f"git config --global --replace-all user.name {shlex.quote(name)}; "
        f"git config --global --replace-all user.email {shlex.quote(email)}; "
        "fi"
    )


class BestAgentCli(BaseInstalledAgent):
    @staticmethod
    @override
    def name() -> str:
        return "best-agent-cli"

    async def _prepare_provider(self, environment: BaseEnvironment) -> None:
        identity = await self.exec_as_agent(
            environment, command='set -e; printf \'%s\\0\' "$HOME"; id -u; id -g'
        )
        home, ids = identity.stdout.split("\0", 1)
        uid, gid = ids.splitlines()
        files = [(Path(_required_env("BEST_AGENT_PROVIDER_CONFIG")), f"{home}/.best-agent/provider.json")]
        dimcode_home = Path(_required_env("DIMCODE_HOME"))
        for relative in ("config.json", "dimcode/auth.json"):
            source = dimcode_home / relative
            if source.is_file():
                files.append((source, f"{home}/.dimcode/{relative}"))
        await self.exec_as_agent(
            environment,
            command="set -e; mkdir -p -- " + shlex.quote(f"{home}/.best-agent") + " " + shlex.quote(f"{home}/.dimcode/dimcode"),
        )
        # The task environment's git identity: a commit the model makes is part of
        # the workspace the verifier grades, and an image with no identity refuses it.
        await self.exec_as_agent(environment, command=_git_identity_command())
        for source, target in files:
            await environment.upload_file(str(source), target)
        targets = " ".join(shlex.quote(target) for _, target in files)
        await self.exec_as_root(
            environment,
            command=f"set -e; chown {shlex.quote(uid + ':' + gid)} -- {targets}; chmod 600 -- {targets}",
        )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        tarball = Path(_required_env("BEST_AGENT_CLI_TARBALL"))
        if not tarball.is_file():
            raise RuntimeError("BEST_AGENT_CLI_TARBALL does not exist")
        remote_tarball = "/tmp/best-agent-cli.tgz"
        remote_script = "/tmp/best-agent-install-cli.sh"
        await environment.upload_file(str(tarball), remote_tarball)
        await environment.upload_file(
            str(Path(__file__).resolve().parent / "install-cli.sh"), remote_script
        )
        await self.exec_as_agent(
            environment,
            command=f"bash {remote_script}",
            env={
                "CLI_TARBALL": remote_tarball,
                "CLI_TARBALL_SHA256": _required_env("BEST_AGENT_CLI_TARBALL_SHA256"),
                "CLI_BINARY_SHA256": _required_env("BEST_AGENT_CLI_BINARY_SHA256"),
                "CLI_NODE_SHA256": _required_env("BEST_AGENT_CLI_NODE_SHA256"),
                "CLI_NODE_VERSION": _required_env("BEST_AGENT_CLI_NODE_VERSION"),
                "CLI_RUNTIME_LOCK_SHA256": _required_env("BEST_AGENT_CLI_RUNTIME_LOCK_SHA256"),
            },
        )

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        model = _required_env("BEST_AGENT_PROVIDER_MODEL")
        model_timeout_ms = _required_env("BEST_AGENT_MODEL_TIMEOUT_MS")
        execution_args = json.loads(_required_env("BEST_AGENT_CLI_EXECUTION_ARGS_JSON"))
        await self._prepare_provider(environment)
        workspace = (await self.exec_as_agent(environment, command="pwd")).stdout.strip()
        command = "\n".join(
            [
                "set -e",
                'export PATH="$HOME/.best-agent-cli/runtime/bin:$PATH"',
                "mkdir -p /logs/agent/best-agent-runtime",
                "cd " + shlex.quote(workspace) + " || exit 1",
                'export BEST_AGENT_PROVIDER_CONFIG="$HOME/.best-agent/provider.json"',
                'export DIMCODE_HOME="$HOME/.dimcode"',
                "export BEST_AGENT_STORAGE_ROOT=/logs/agent/best-agent-runtime",
                "export BEST_AGENT_PROVIDER_MODEL=" + shlex.quote(model),
                "set +e",
                '"$HOME/.best-agent-cli/bin/best-agent" run '
                + "--model "
                + shlex.quote(model)
                + " --model-timeout-ms "
                + shlex.quote(model_timeout_ms)
                + " --workspace "
                + shlex.quote(workspace)
                + " "
                + " ".join(shlex.quote(value) for value in execution_args)
                + " --attempt-evidence /logs/agent/best-agent-evidence.jsonl"
                + " "
                + shlex.quote(instruction)
                + " </dev/null > /logs/agent/best-agent-stdout.txt"
                + " 2> /logs/agent/best-agent-stderr.txt",
                "status=$?",
                "set -e",
                "printf '{\"exitCode\":%s}\\n' \"$status\" > /logs/agent/best-agent-process-receipt.json",
                "exit \"$status\"",
            ]
        )
        await self.exec_as_agent(environment, command=command)

    def populate_context_post_run(self, context: AgentContext) -> None:
        stdout_path = Path(self.logs_dir) / "best-agent-stdout.txt"
        if not stdout_path.exists():
            return
        text = stdout_path.read_text(errors="replace")
        if text.strip():
            context.metadata = {"stdout_tail": text[-8000:]}
