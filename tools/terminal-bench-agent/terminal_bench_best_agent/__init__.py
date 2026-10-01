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
    """One idempotent write of the attempt's frozen git identity into the task
    environment, in the two places a commit can read it.

    A task image ships no git identity of its own, so a model commit stops at
    "unable to auto-detect email address" and the attempt then pays a turn to work
    around it. Writing the agent user's global config alone does not fix that: the
    CLI runs every command the model issues with ``GIT_CONFIG_GLOBAL=/dev/null``
    and ``GIT_CONFIG_NOSYSTEM=1`` (its own comment calls the chain deterministic),
    so such a commit reads no global config at all. Observed in run 36870673845:
    the global write had already run and the model's ``git config --list
    --show-origin`` still reported nothing but ``file:.git/config``.

    The identity therefore goes into the agent's global config (for commands that
    do read it) and into the local config of every repository already present under
    the workspace, which is the only channel a model-issued commit has. Repositories
    are found by bounded path expansion rather than `find`, so no extra tool has to
    exist; `git` is optional in a task image; a repository that already declares an
    identity keeps it; and a write that fails is a setup failure, never a silently
    skipped one.
    """
    name = _required_env("BEST_AGENT_GIT_IDENTITY_NAME")
    email = _required_env("BEST_AGENT_GIT_IDENTITY_EMAIL")
    for value in (name, email):
        if any(character in value for character in ("\n", "\r", "\0")):
            raise RuntimeError("BEST_AGENT_GIT_IDENTITY_* must be a single line")
    workspace = os.environ.get("BEST_AGENT_CLI_WORKSPACE") or "/app"
    quoted_name = shlex.quote(name)
    quoted_email = shlex.quote(email)
    return (
        "set -e; if command -v git >/dev/null 2>&1; then\n"
        f"git config --global --replace-all user.name {quoted_name}\n"
        f"git config --global --replace-all user.email {quoted_email}\n"
        f"for root in {shlex.quote(workspace)} \"$HOME\"; do\n"
        '  for candidate in "$root"/.git "$root"/*/.git "$root"/*/*/.git'
        ' "$root"/*/*/*/.git; do\n'
        '    if [ -d "$candidate" ]; then\n'
        '      git --git-dir="$candidate" config --local --get user.name'
        ' >/dev/null 2>&1'
        f" || git --git-dir=\"$candidate\" config user.name {quoted_name}\n"
        '      git --git-dir="$candidate" config --local --get user.email'
        ' >/dev/null 2>&1'
        f" || git --git-dir=\"$candidate\" config user.email {quoted_email}\n"
        "    fi\n"
        "  done\n"
        "done\n"
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
