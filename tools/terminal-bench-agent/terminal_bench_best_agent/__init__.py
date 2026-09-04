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


class BestAgentCli(BaseInstalledAgent):
    @staticmethod
    @override
    def name() -> str:
        return "best-agent-cli"

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
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y ca-certificates coreutils",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(
            environment,
            command=f"bash {remote_script}",
            env={
                "CLI_TARBALL": remote_tarball,
                "CLI_TARBALL_SHA256": _required_env("BEST_AGENT_CLI_TARBALL_SHA256"),
                "CLI_BINARY_SHA256": _required_env("BEST_AGENT_CLI_BINARY_SHA256"),
                "CLI_RUNTIME_LOCK_SHA256": _required_env(
                    "BEST_AGENT_CLI_RUNTIME_LOCK_SHA256"
                ),
                "CLI_VERSION": _required_env("BEST_AGENT_CLI_VERSION"),
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
        timeout_ms = _required_env("BEST_AGENT_TIMEOUT_MS")
        workspace = _required_env("BEST_AGENT_CLI_WORKSPACE")
        execution_args = json.loads(_required_env("BEST_AGENT_CLI_EXECUTION_ARGS_JSON"))
        provider_config = Path(_required_env("BEST_AGENT_PROVIDER_CONFIG"))
        dimcode_home = Path(_required_env("DIMCODE_HOME"))
        await environment.upload_file(str(provider_config), "/tmp/best-agent-provider.json")
        await environment.upload_file(
            str(dimcode_home / "config.json"), "/tmp/best-agent-dimcode-config.json"
        )
        auth_config = dimcode_home / "dimcode" / "auth.json"
        if auth_config.is_file():
            await environment.upload_file(
                str(auth_config), "/tmp/best-agent-dimcode-auth.json"
            )
        command = "\n".join(
            [
                "set -e",
                'mkdir -p "$HOME/.best-agent" "$HOME/.dimcode/dimcode"',
                'cp /tmp/best-agent-provider.json "$HOME/.best-agent/provider.json"',
                'cp /tmp/best-agent-dimcode-config.json "$HOME/.dimcode/config.json"',
                *(
                    ['cp /tmp/best-agent-dimcode-auth.json "$HOME/.dimcode/dimcode/auth.json"']
                    if auth_config.is_file()
                    else []
                ),
                'chmod 600 "$HOME/.best-agent/provider.json" "$HOME/.dimcode/config.json"',
                *(
                    ['chmod 600 "$HOME/.dimcode/dimcode/auth.json"']
                    if auth_config.is_file()
                    else []
                ),
                "mkdir -p /logs/agent/best-agent-runtime",
                "cd " + shlex.quote(workspace) + " || exit 1",
                'export BEST_AGENT_PROVIDER_CONFIG="$HOME/.best-agent/provider.json"',
                'export DIMCODE_HOME="$HOME/.dimcode"',
                "export BEST_AGENT_STORAGE_ROOT=/logs/agent/best-agent-runtime",
                "export BEST_AGENT_PROVIDER_MODEL=" + shlex.quote(model),
                "export BEST_AGENT_PROVIDER_TIMEOUT_MS=" + shlex.quote(timeout_ms),
                "set +e",
                '"$HOME/.best-agent-cli/bin/best-agent" run '
                + "--model "
                + shlex.quote(model)
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
