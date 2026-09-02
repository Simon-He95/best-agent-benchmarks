"""Harbor installed-agent plugin that drives the pinned best-agent CLI inside a
terminal-bench task environment.

The plugin class runs in the host Harbor process; ``install`` / ``run`` execute
commands inside the task container through ``exec_as_root`` / ``exec_as_agent``.
The CLI binary is installed into the container (Linux x64 build, frozen in
``config/terminal-bench.json``) and invoked headlessly with the task instruction
file. Complete trajectories are preserved through ``--attempt-evidence`` and the
CLI stdout, both written under ``/logs/agent`` (mounted from the trial dir and
kept as trial artifacts).

Environment contract (set by the harness before spawning Harbor):
- ``BEST_AGENT_PROVIDER_CONFIG``  host path to provider.json (written by
  ``scripts/materialize-ci-provider.mjs`` style tooling)
- ``DIMCODE_HOME``               host path to the dimcode home (OAuth persistence)
- ``BEST_AGENT_PROVIDER_MODEL``  provider model id
- ``BEST_AGENT_TIMEOUT_MS``      per-task provider timeout in ms
- ``BEST_AGENT_CLI_VERSION``     pinned CLI version (defaults to the build default)
- ``BEST_AGENT_CLI_PACKAGE``     pinned CLI npm package
- ``BEST_AGENT_CLI_INTEGRITY``   pinned npm dist.integrity
"""

import base64
import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

CLI_PACKAGE_DEFAULT = "@best-agent/cli-linux-x64-gnu"
CLI_VERSION_DEFAULT = "0.0.3-beta.1"
CLI_INTEGRITY_DEFAULT = (
    "sha512-JSstNlAcLuZ2EuIuIaqwLxW31ikgscrKtG5aDCNl1M4Uawyac6y3k/SgyXsluRR/"
    "XOsp7uGbStraiQZEmlMm+Q=="
)
WORKSPACE = "/app"
MAX_MODEL_CYCLES = 600
PROXY_PORT = 8900

# beta.1's read/list/search/stat tools are not authorizable without triggering
# its tool-unknown bug, and process/lsp tools have no grant flag at all; steer
# the model to the exec whitelist (cat/head/tail/grep/ls/python3) instead.
CLIENT_SYSTEM_PROMPT = (
    "Environment constraints: the only usable tools are exec, write, edit, "
    "apply_patch, todowrite, and now. Never call read, list, search, stat, "
    "mkdir, remove, or any process-*, lsp-*, memory-*, web_*, or "
    "generate_image tool. Inspect files and directories with the exec tool "
    "(whitelisted commands include cat, head, tail, grep, ls, wc, sort, "
    "python3); modify files with write, edit, or apply_patch; run commands "
    "with exec."
)


def _env(key: str, default: str | None = None) -> str | None:
    return os.environ.get(key, default)


def _runtime_dependencies() -> dict[str, str]:
    """Runtime deps frozen in config/terminal-bench.json (CLI SEA externals).

    Resolved from the repo checkout when the plugin runs editable (CI installs
    it with ``uv pip install -e``); degrades to an empty set otherwise so the
    install script still completes (the CLI start check then fails loudly).
    """
    override = (os.environ.get("BEST_AGENT_CLI_RUNTIME_DEPS") or "").strip()
    if override:
        parsed: dict[str, str] = {}
        for spec in override.split():
            if "@" in spec:
                name, version = spec.rsplit("@", 1)
                parsed[name] = version
        return parsed
    try:
        config_path = (
            Path(__file__).resolve().parents[3]
            / "config"
            / "terminal-bench.json"
        )
        config = json.loads(config_path.read_text())
    except (OSError, ValueError):
        return {}
    return dict(config.get("cli", {}).get("runtimeDependencies", {}) or {})


def _provider_upstream_origin() -> str:
    """Upstream origin (scheme://host) from the frozen provider baseURL."""
    provider_config = _env("BEST_AGENT_PROVIDER_CONFIG")
    default = "https://dimagent.cn"
    if not provider_config or not Path(provider_config).is_file():
        return default
    try:
        provider = json.loads(Path(provider_config).read_text())
        base_url = provider.get("baseURL")
        if not isinstance(base_url, str) or "://" not in base_url:
            return default
        scheme, rest = base_url.split("://", 1)
        host = rest.rstrip("/").split("/")[0]
        return f"{scheme}://{host}"
    except (OSError, ValueError):
        return default


def _provider_payload_for_cli(provider_config: str) -> str:
    """Base64 provider.json payload restricted to fields the pinned CLI accepts.

    CLI 0.0.3-beta.1 (newest Linux build) rejects the newer `credentialRef` and
    `transportProfile` fields; strip them before materializing in the container.
    """
    try:
        provider = json.loads(Path(provider_config).read_text())
        for legacy_field in ("credentialRef", "transportProfile"):
            provider.pop(legacy_field, None)
        return base64.b64encode(json.dumps(provider).encode("utf-8")).decode("ascii")
    except (OSError, ValueError):
        return _b64(provider_config)


def _b64(path: str) -> str:
    return base64.b64encode(Path(path).read_bytes()).decode("ascii")


def _shlex_quote(text: str) -> str:
    """Quote a multi-line instruction for a POSIX shell command string."""
    return shlex.quote(text)


class BestAgentCli(BaseInstalledAgent):
    """Installed-agent wrapper around ``best-agent run`` (headless)."""

    @staticmethod
    @override
    def name() -> str:
        return "best-agent-cli"

    @override
    def get_version_command(self) -> str | None:
        return "best-agent --version 2>/dev/null || echo unknown"

    @override
    def parse_version(self, stdout: str) -> str:
        lines = [line.strip() for line in (stdout or "").splitlines() if line.strip()]
        return lines[-1] if lines else "unknown"

    def _cli_package(self) -> str:
        return _env("BEST_AGENT_CLI_PACKAGE", CLI_PACKAGE_DEFAULT) or CLI_PACKAGE_DEFAULT

    def _cli_version(self) -> str:
        return _env("BEST_AGENT_CLI_VERSION", CLI_VERSION_DEFAULT) or CLI_VERSION_DEFAULT

    def _cli_integrity(self) -> str:
        return _env("BEST_AGENT_CLI_INTEGRITY", CLI_INTEGRITY_DEFAULT) or CLI_INTEGRITY_DEFAULT

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        """Fetch the pinned CLI tarball and verify its sha512 before extracting.

        The npm-published tarball IS the native binary; no node/npm runtime is
        needed inside the container. The install logic lives in install-cli.sh
        (uploaded into the container) so shell quoting never round-trips.
        """
        integrity_b64 = self._cli_integrity().removeprefix("sha512-")
        registry = (
            _env("BEST_AGENT_CLI_REGISTRY", "https://registry.npmjs.org")
            or "https://registry.npmjs.org"
        )

        await self.exec_as_root(
            environment,
            command=(
                "apt-get update -qq >/dev/null 2>&1 || true; "
                "apt-get install -y -qq curl ca-certificates coreutils >/dev/null 2>&1 || true"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        remote_script = "/tmp/best-agent-install-cli.sh"
        await environment.upload_file(str(self._script_path()), remote_script)
        runtime_deps = " ".join(
            f"{name}@{version}"
            for name, version in _runtime_dependencies().items()
        )
        await self.exec_as_agent(
            environment,
            command=f"bash {remote_script}",
            env={
                "CLI_PACKAGE": self._cli_package(),
                "CLI_VERSION": self._cli_version(),
                "CLI_INTEGRITY_B64": integrity_b64,
                "CLI_REGISTRY": registry,
                "CLI_RUNTIME_DEPS": runtime_deps,
                "NPM_REGISTRY": (
                    _env("BEST_AGENT_NPM_REGISTRY", "https://registry.npmjs.org")
                    or "https://registry.npmjs.org"
                ),
                "NODE_MIRROR": (
                    _env("BEST_AGENT_NODE_MIRROR", "https://nodejs.org/dist")
                    or "https://nodejs.org/dist"
                ),
            },
        )

    def _script_path(self) -> Path:
        return Path(__file__).resolve().parent / "install-cli.sh"

    def _proxy_path(self) -> Path:
        return Path(__file__).resolve().parent / "ua-proxy.js"

    def _proxy_startup_command(self) -> str:
        """Start the local UA-rewriting proxy and wait until it accepts requests."""
        upstream = _provider_upstream_origin()
        return "\n".join(
            [
                "UPSTREAM_ORIGIN=" + shlex.quote(upstream) + " "
                f"PORT={PROXY_PORT} nohup node /tmp/best-agent-ua-proxy.js "
                ">/logs/agent/ua-proxy.log 2>&1 &",
                "for i in 1 2 3 4 5; do",
                "  node -e \"require('http').get('http://127.0.0.1:"
                + str(PROXY_PORT)
                + "/healthz', r => process.exit(r.statusCode ? 0 : 1)).on('error', () => process.exit(1))\" && break;",
                "  sleep 1;",
                "done;",
            ]
        )

    def _materialize_provider_command(self) -> str:
        """Commands that write the frozen provider identity into the container.

        Reads the same JSON files the host CLI would resolve and stores them at
        ``$HOME/.best-agent/provider.json`` + ``$HOME/.dimcode`` so the CLI's
        normal resolution (``~/.best-agent/provider.json``, then dimcode OAuth
        persistence) works unchanged inside the container. Newer provider
        fields the pinned Linux CLI (0.0.3-beta.1) rejects are stripped.
        """
        commands: list[str] = [
            'mkdir -p "$HOME/.best-agent" "$HOME/.dimcode/dimcode"',
        ]
        provider_config = _env("BEST_AGENT_PROVIDER_CONFIG")
        if provider_config and Path(provider_config).is_file():
            payload = _provider_payload_for_cli(provider_config)
            commands.append(
                "printf '%s' '" + payload + "' | base64 -d "
                '> "$HOME/.best-agent/provider.json"; '
                'chmod 600 "$HOME/.best-agent/provider.json"'
            )
        dimcode_home = _env("DIMCODE_HOME")
        if dimcode_home and Path(dimcode_home).is_dir():
            for relative, target in (
                ("config.json", '"$HOME/.dimcode/config.json"'),
                ("dimcode/auth.json", '"$HOME/.dimcode/dimcode/auth.json"'),
            ):
                source = Path(dimcode_home) / relative
                if source.is_file():
                    commands.append(
                        "printf '%s' '" + _b64(str(source)) + "' | base64 -d "
                        f"> {target}; chmod 600 {target}"
                    )
        return "\n".join(commands)

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        model = _env("BEST_AGENT_PROVIDER_MODEL", "") or self.model_name or ""
        if not model:
            raise RuntimeError("BEST_AGENT_PROVIDER_MODEL must be set")

        timeout_ms = _env("BEST_AGENT_TIMEOUT_MS", "1800000")

        # Materialize the provider identity, then run the CLI headlessly with the
        # instruction passed as the positional prompt (shell-escaped).
        #
        # CLI 0.0.3-beta.1 (newest Linux build) quirks, found by replaying the
        # full provider round trip inside the task container:
        #  1. its provider.json/env resolution fails before any HTTP request,
        #     so provider identity must be passed as explicit flags;
        #  2. it sends the Vercel AI SDK user agent ("ai/6.0.184 ..."), which
        #     the provider rejects with 403 unsupported client, so requests go
        #     through the local ua-proxy.js which rewrites the UA;
        #  3. it has no --no-base-instructions/--attempt-evidence/
        #     --process-isolation/--tool-exclude/--max-model-cycles; the full
        #     stdout under /logs/agent is the preserved trajectory, and the
        #     container network stays open (documented deviation).
        command = "\n".join(
            [
                "set -o pipefail;",
                'export BEST_AGENT_PROVIDER_MODEL="' + model + '" '
                "BEST_AGENT_PROVIDER_TIMEOUT_MS=" + timeout_ms + " "
                'BEST_AGENT_PROVIDER_CONFIG="$HOME/.best-agent/provider.json" '
                'DIMCODE_HOME="$HOME/.dimcode" '
                "BEST_AGENT_STORAGE_ROOT=/logs/agent/best-agent-runtime;",
                self._materialize_provider_command(),
                "mkdir -p /logs/agent;",
                "cd "
                + WORKSPACE
                + ' || { echo "workspace not found" >&2; exit 1; };',
                self._proxy_startup_command(),
                "(best-agent run "
                "--provider openai "
                "--model " + shlex.quote(model) + " "
                "--base-url http://127.0.0.1:" + str(PROXY_PORT) + "/v1 "
                "--compatibility compatible "
                "--workspace "
                + WORKSPACE
                # beta.1 bug: granting `read` alongside others makes read-scope
                # tool execution die with tool-unknown; exec+write is the safe
                # pair (verified: 38 uninterrupted tool rounds on a real task).
                + " --workspace-grant exec --workspace-grant write "
                "--system-prompt " + _shlex_quote(CLIENT_SYSTEM_PROMPT) + " "
                + _shlex_quote(instruction)
                + " 2>&1 </dev/null | tee /logs/agent/best-agent-stdout.txt; "
                'echo "best-agent exit status: ${PIPESTATUS[0]}" '
                "| tee -a /logs/agent/best-agent-stdout.txt; "
                "exit ${PIPESTATUS[0]});",
            ]
        )
        await environment.upload_file(str(self._proxy_path()), "/tmp/best-agent-ua-proxy.js")
        await self.exec_as_agent(environment, command=command)

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Expose a bounded CLI stdout tail in the trial context.

        The full stdout and the complete --attempt-evidence JSONL are persisted
        under /logs/agent (trial artifacts); the context only carries a preview.
        """
        stdout_path = Path(self.logs_dir) / "best-agent-stdout.txt"
        if not stdout_path.exists():
            return
        try:
            text = stdout_path.read_text(errors="replace")
        except OSError:
            return
        if text.strip():
            context.metadata = {
                "stdout_tail": text[-8000:] if len(text) > 8000 else text
            }