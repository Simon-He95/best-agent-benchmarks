"""Pier installed-agent plugin for one frozen best-agent CLI candidate."""

import json
import os
import shlex
import shutil
import sqlite3
import tempfile
import time
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


def _read_thread_metrics(database_path: Path) -> dict[str, object] | None:
    """Read the run's provider-reported usage from the CLI's durable thread store.

    ``thread_metrics`` is the single durable projection of provider-reported
    usage; a headless run writes one row under a ``run:<taskRef>`` thread. The
    CLI is killed on agent timeout, so the newest data can still sit in the
    write-ahead log: read the store in place when possible and otherwise read a
    copy of the database together with its sidecar files.
    """
    if not database_path.is_file():
        return None

    def query(path: Path) -> list[tuple[str, str]]:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            return list(
                connection.execute("SELECT thread_id, data_json FROM thread_metrics")
            )
        finally:
            connection.close()

    try:
        rows = query(database_path)
    except sqlite3.Error:
        rows = []
        with tempfile.TemporaryDirectory() as scratch:
            copied = Path(scratch) / database_path.name
            shutil.copy2(database_path, copied)
            for suffix in ("-wal", "-shm"):
                sidecar = database_path.with_name(database_path.name + suffix)
                if sidecar.is_file():
                    shutil.copy2(sidecar, copied.with_name(copied.name + suffix))
            try:
                rows = query(copied)
            except sqlite3.Error:
                return None

    candidates = [row for row in rows if row[0].startswith("run:")] or rows
    for _, data_json in candidates:
        try:
            metrics = json.loads(data_json)
        except (TypeError, ValueError):
            continue
        if isinstance(metrics, dict) and isinstance(metrics.get("usage"), dict):
            return metrics
    return None


# Benchmark-side prompt-prefix experiment. The harness stages each task's own
# instruction.md and freezes its hash before the agent runs, so prepending a prefix
# to the text handed to the CLI changes neither `instructions.frozen` nor the
# task's canonical verdict: the prefix is behaviour guidance only, and it carries
# no task content and no verifier information.
#
# Select with BEST_AGENT_INSTRUCTION_PREFIX=A, =B, =C, =D, =E or =F
# (empty or unknown = unchanged).
# The prefixes are deliberately separated so each layer's effect can be read
# against the same no-prefix control cells:
#   A = budget / delivery discipline (land a real answer),
#   B = spec self-check across the whole value space (close the last checks),
#   C = A + B + preserving the task's input data before the first tool command.
#
# Revision 4 (2026-10-03) adds three single-purpose prefixes, each written against
# a mechanism the rev-3 arms actually exhibited, and each deliberately short: the
# rev-3 union text (C, 1273 characters) lost ground on the cell its B layer had
# already closed and never fired its own clauses, so a longer prefix is not the
# sum of its parts and attribution needs one clause per arm.
#   D = the graded artifact must always hold the current best answer, even before
#     the model is sure of anything (rev-3 arms wrote /app/out.txt zero times,
#     because they only ever wrote once they had a real answer and never had one),
#     plus: when a standard tool returns nonsense, change what it is fed rather
#     than writing more code around the same picture (the gcode arms spent the
#     whole budget on renderers while their OCR returned noise).
#   E = check the new construct against values raised by other code and by the
#     runtime itself, classifying them by what the value says rather than by
#     whether the model's own code produced it (the single expr check that every
#     measured arm fails is exactly this: a host panic that must be classified by
#     its message).
#   F = copy the task's own input data before the first command that could write
#     to it (every measured db-wal arm destroyed its encrypted WAL with its first
#     sqlite3 probe at t=9-27s and could never recover it in-sandbox).
PROMPT_PREFIXES = {
    "A": (
        "You work under a hard wall-clock budget, and the final stretch of it can "
        "be taken away without warning: treat four fifths of the budget as your "
        "real deadline.\n"
        "1. Decide early what artifact the task asks you to produce and where it is "
        "read back from (a file at a given path, a value, a report), then write your "
        "best real answer there as soon as you have one. Never leave a placeholder, "
        "a note to yourself or a stub as the final state: if you write one to claim "
        "the path, the real answer must replace it before you stop.\n"
        "2. When producing the answer needs a capability you do not have (decoding, "
        "rendering, OCR, parsing, reading a format), obtain the standard tool for it "
        "instead of hand-rolling your own substitute; the substitute is what "
        "consumes the whole budget.\n"
        "3. Before you stop, read the deliverable back from its path and confirm it "
        "holds your final answer, not a note in progress."
    ),
    "B": (
        "Before you say done:\n"
        "1. Re-read the task's requirements as a checklist, one item at a time, and "
        "run the actual check that grades each item (the project's own tests, the "
        "CLI, the parser), not a check you invented.\n"
        "2. Exercise every behavior on the values your own code never produces: "
        "values handed in from other code, empty and nil values, non-string values, "
        "error paths, panics and repeated calls. The new construct has to behave on "
        "those exactly as the rest of the project does.\n"
        "3. Confirm the exact strings and classifications that are compared (error "
        "messages, kinds, formats), not just that the result looks right.\n"
        "4. Only then commit. Never report success on your own check when the real "
        "contract is unmet."
    ),
    "C": (
        "You work under a hard wall-clock budget, and the final stretch of it can "
        "be taken away without warning: treat four fifths of the budget as your "
        "real deadline.\n"
        "1. Before any command that could write, keep a copy of the task's input "
        "data (files, databases, archives): your first exploratory command must "
        "never be the thing that destroys the input.\n"
        "2. Decide early what artifact the task asks you to produce and where it is "
        "read back from, then write your best real answer there as soon as you have "
        "one. Never leave a placeholder, a note or a stub as the final state: if you "
        "write one to claim the path, the real answer must replace it before you "
        "stop.\n"
        "3. When producing the answer needs a capability you do not have (decoding, "
        "rendering, OCR, parsing, reading a format), obtain the standard tool for it "
        "instead of hand-rolling your own substitute.\n"
        "4. Before you stop: read the deliverable back from its path; re-read the "
        "requirements as a checklist and run the actual checks the project provides; "
        "cover the values your own code never produces (values from other code, "
        "empty and nil, non-string, error paths, panics); confirm the exact strings "
        "and classifications that are compared. Only then commit, and never report "
        "success on your own check when the real contract is unmet."
    ),
    "D": (
        "You work under a hard wall-clock budget whose last fifth can be taken "
        "away without warning: treat four fifths of the budget as the deadline.\n"
        "1. The artifact the task is graded on must exist early and must always "
        "hold your current best answer - a rough, uncertain value, never a note, a "
        "plan or an empty file. Overwrite it every time your answer improves, and "
        "read it back from its path before you stop.\n"
        "2. If a standard tool you run to obtain the answer returns nonsense, do "
        "not write more of your own code around the same picture: change what you "
        "feed it (preparation, resolution, scale, its default mode) or re-check "
        "your assumption about the raw input."
    ),
    "E": (
        "Before you say done, check the new behavior against values your own code "
        "did not create: values handed in by other code, empty and nil values, "
        "non-string values, error paths, and the runtime's own failures such as "
        "panics. Render and classify such values by what the value itself says - "
        "its message and kind - never by whether your own code produced it, and "
        "confirm the exact strings and kinds that are compared."
    ),
    "F": (
        "Before your first command that opens, converts or probes the task's own "
        "input data, copy it aside and work on the copy: an exploratory command "
        "must never be the thing that destroys the input, because a database or "
        "archive tool can modify or discard companion files it does not recognise "
        "the moment it touches the original. If the input is already damaged, "
        "recover it from any copy before trying to reason about its contents."
    ),
}


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

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        prefix_key = os.environ.get("BEST_AGENT_INSTRUCTION_PREFIX") or ""
        prefix = PROMPT_PREFIXES.get(prefix_key)
        if prefix is not None:
            instruction = f"{prefix}\n\n{instruction}"
        started_ns = time.monotonic_ns()
        model = _required_env("BEST_AGENT_PROVIDER_MODEL")
        model_timeout_ms = _required_env("BEST_AGENT_MODEL_TIMEOUT_MS")
        attempt_budget_ms = int(_required_env("BEST_AGENT_ATTEMPT_BUDGET_MS"))
        workspace = _required_env("BEST_AGENT_CLI_WORKSPACE")
        execution_args = json.loads(_required_env("BEST_AGENT_CLI_EXECUTION_ARGS_JSON"))
        await self._prepare_provider(environment)
        wrapper_elapsed_ms = (time.monotonic_ns() - started_ns) // 1_000_000
        attempt_remaining_ms = attempt_budget_ms - wrapper_elapsed_ms
        if attempt_remaining_ms <= 210_000:
            raise RuntimeError("No admitted attempt delivery window remains after provider setup")
        timing = json.dumps(
            {
                "attemptBudgetMs": attempt_budget_ms,
                "wrapperElapsedMs": wrapper_elapsed_ms,
                "attemptRemainingMs": attempt_remaining_ms,
                "modelTimeoutMs": int(model_timeout_ms),
            },
            separators=(",", ":"),
        )
        command = "\n".join(
            [
                "set -e",
                'export PATH="$HOME/.best-agent-cli/runtime/bin:$PATH"',
                "mkdir -p /logs/agent/best-agent-runtime",
                "printf '%s\\n' " + shlex.quote(timing) + " > /logs/agent/best-agent-attempt-timing.json",
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
                + " --attempt-remaining-ms "
                + shlex.quote(str(attempt_remaining_ms))
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
        metadata: dict[str, object] = {}
        stdout_path = Path(self.logs_dir) / "best-agent-stdout.txt"
        if stdout_path.exists():
            text = stdout_path.read_text(errors="replace")
            if text.strip():
                metadata["stdout_tail"] = text[-8000:]
        # Provider-reported usage is read from the CLI's durable projection
        # (thread_metrics). The benchmark prices it with its own frozen table;
        # the CLI reports raw tokens only, never money.
        metrics = _read_thread_metrics(
            Path(self.logs_dir) / "best-agent-runtime" / "v3-threads.sqlite"
        )
        if metrics is not None:
            usage = metrics.get("usage") or {}
            cache = metrics.get("cacheUsage") or {}
            prompt_tokens = int(usage.get("promptTokens") or 0)
            completion_tokens = int(usage.get("completionTokens") or 0)
            context.n_input_tokens = prompt_tokens
            context.n_output_tokens = completion_tokens
            if cache.get("cacheReadTokens") is not None:
                context.n_cache_tokens = int(cache["cacheReadTokens"])
            metadata["usage"] = {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": int(usage.get("totalTokens") or 0),
                "cache_read_tokens": cache.get("cacheReadTokens"),
                "cache_write_tokens": cache.get("cacheWriteTokens"),
                "no_cache_input_tokens": cache.get("noCacheTokens"),
                "model_call_count": cache.get("modelCallCount"),
                "reported_call_count": cache.get("reportedCallCount"),
                "reported_input_tokens": cache.get("reportedInputTokens"),
            }
        if metadata:
            context.metadata = metadata
