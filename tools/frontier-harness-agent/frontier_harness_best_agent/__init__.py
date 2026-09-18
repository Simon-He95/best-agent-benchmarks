"""Pier installed-agent plugin for one frozen best-agent CLI candidate."""

import json
import os
import shlex
from pathlib import Path
from urllib.parse import urlparse

from pier.agents.installed.base import BaseInstalledAgent, with_prompt_template
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist


def _required_env(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"{key} is required")
    return value


class BestAgentCli(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "best-agent-cli"

    def get_version_command(self) -> str:
        return '"$HOME/.best-agent-cli/bin/best-agent" --version'

    def parse_version(self, stdout: str) -> str:
        text = stdout.strip()
        for token in text.split():
            if token[0].isdigit() and "." in token:
                return token
        return text

    def install_spec(self) -> AgentInstallSpec:
        # Pier 0.3.1 requires at least one install step and inlines the steps
        # into the build-time agent Dockerfile (FROM <task image>). The frozen
        # CLI tarball cannot be baked that way: for docker_image tasks Pier
        # builds from an empty context, so the real install happens at trial
        # time via install() (tarball upload from the benchmark host). The
        # single root step below is a harmless marker that mirrors what
        # BaseInstalledAgent.setup() does before install() runs.
        tarball_sha = os.environ.get("BEST_AGENT_CLI_TARBALL_SHA256")
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[InstallStep(user="root", run="mkdir -p /installed-agent")],
            verification_command=self.get_version_command(),
            # Identity of the frozen CLI candidate: keeps the per-task agent
            # image name (and its fingerprint) tied to the tarball actually
            # uploaded at trial time.
            cache_key=(
                f"best-agent-cli-{tarball_sha[:16]}"
                if tarball_sha
                else "best-agent-cli-unpinned"
            ),
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        # BaseInstalledAgent.setup() skips install() when the environment's
        # install spec carries this agent's name (the preinstalled-agent fast
        # path for build-time installs). Our install is a trial-time tarball
        # upload, so always run it, then keep the base contract for the
        # /installed-agent marker and best-effort version detection.
        await environment.exec(command="mkdir -p /installed-agent", user="root")
        try:
            await self.install(environment)
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"Agent install failed: {exc}") from exc
        if self._version is None:
            version_cmd = self.get_version_command()
            if version_cmd:
                try:
                    version_result = await environment.exec(command=version_cmd)
                    if version_result.return_code == 0 and version_result.stdout:
                        self._version = self.parse_version(version_result.stdout)
                except Exception:
                    pass  # Version detection is best-effort

    def network_allowlist(self) -> NetworkAllowlist:
        # Air-gapped tasks (allow_internet = false / no-network) still need the
        # agent's own inference egress; Pier honors this per-agent allowlist.
        base_url = _required_env("BEST_AGENT_PROVIDER_BASE_URL")
        parsed = urlparse(base_url if "://" in base_url else f"https://{base_url}")
        if not parsed.hostname:
            raise RuntimeError(f"BEST_AGENT_PROVIDER_BASE_URL has no host: {base_url}")
        return NetworkAllowlist(domains=[parsed.hostname])

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
                "CLI_RUNTIME_LOCK_SHA256": _required_env(
                    "BEST_AGENT_CLI_RUNTIME_LOCK_SHA256"
                ),
            },
        )

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
        for source, target in files:
            await environment.upload_file(str(source), target)
        targets = " ".join(shlex.quote(target) for _, target in files)
        await self.exec_as_root(
            environment,
            command=f"set -e; chown {shlex.quote(uid + ':' + gid)} -- {targets}; chmod 600 -- {targets}",
        )

    @with_prompt_template
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
        await self._prepare_provider(environment)
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
                "printf '{\\\"exitCode\\\":%s}\\n' \"$status\" > /logs/agent/best-agent-process-receipt.json",
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
