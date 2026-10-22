"""The egress-probe receipt contract.

Run with the Pier environment:
  .tmp/pier-venv/bin/python tools/frontier-harness-agent/tests/run_tests.py
(the module imports Pier, so the venv is required).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from frontier_harness_best_agent import (  # noqa: E402
    build_egress_probe_command,
    evaluate_egress_probe,
)

ALLOW = "dimagent.cn"
DENY = ["github.com", "registry.npmjs.org"]
ALL = [ALLOW, *DENY]


def bounded_stdout() -> str:
    lines = [f"DIRECT {host} blocked:gaierror" for host in ALL]
    lines.append(f"PROXY {ALLOW} reachable")
    lines += [f"PROXY {host} blocked:403" for host in DENY]
    return "\n".join(lines) + "\n"


def test_bounded_needs_isolation_provider_and_denials_together():
    receipt = evaluate_egress_probe(bounded_stdout(), ALLOW, DENY)
    assert receipt["verdict"] == "bounded"
    assert receipt["directBlocked"] == ALL
    assert receipt["providerReachableThroughProxy"] is True
    assert receipt["deniedHostsBlockedThroughProxy"] == DENY


def test_unproven_when_the_container_still_has_a_route_out():
    # The provider answering a bare TCP connect means there is a default route,
    # so a shell `git clone` would too.
    stdout = bounded_stdout().replace(f"DIRECT {ALLOW} blocked:gaierror", f"DIRECT {ALLOW} reachable 203.0.113.9")
    receipt = evaluate_egress_probe(stdout, ALLOW, DENY)
    assert receipt["verdict"] == "unproven"
    assert ALLOW not in receipt["directBlocked"]


def test_unproven_when_the_proxy_admits_an_answer_source():
    stdout = bounded_stdout().replace("PROXY github.com blocked:403", "PROXY github.com reachable")
    receipt = evaluate_egress_probe(stdout, ALLOW, DENY)
    assert receipt["verdict"] == "unproven"
    assert receipt["deniedHostsBlockedThroughProxy"] == ["registry.npmjs.org"]


def test_unproven_when_the_provider_is_not_reachable_through_the_proxy():
    stdout = bounded_stdout().replace(f"PROXY {ALLOW} reachable", f"PROXY {ALLOW} blocked:407")
    receipt = evaluate_egress_probe(stdout, ALLOW, DENY)
    assert receipt["verdict"] == "unproven"
    assert receipt["providerReachableThroughProxy"] is False


def test_unproven_when_the_probe_produced_nothing():
    # No interpreter in the image: silence must never read as a pass.
    receipt = evaluate_egress_probe("DIRECT probes blocked:no-interpreter\n", ALLOW, DENY)
    assert receipt["verdict"] == "unproven"
    assert receipt["directBlocked"] == []


def test_a_partial_probe_is_not_bounded():
    # Direct isolation measured, proxy path never measured.
    stdout = "\n".join(f"DIRECT {host} blocked:gaierror" for host in ALL) + "\n"
    receipt = evaluate_egress_probe(stdout, ALLOW, DENY)
    assert receipt["verdict"] == "unproven"


def test_command_covers_both_interpreters_and_quotes_every_host():
    command = build_egress_probe_command(ALLOW, DENY)
    assert "command -v node" in command
    assert "command -v python3" in command
    assert "blocked:no-interpreter" in command
    for host in ALL:
        assert host in command
    hostile = build_egress_probe_command(ALLOW, ["evil.example; rm -rf /"])
    # The hostile name stays one quoted argument: the injection cannot run.
    assert "rm -rf /" in hostile
    assert "'evil.example; rm -rf /'" in hostile


def test_both_paths_are_reported_for_every_host():
    receipt = evaluate_egress_probe(bounded_stdout(), ALLOW, DENY)
    paths = {(o["path"], o["host"]) for o in receipt["observations"]}
    assert paths == {("DIRECT", host) for host in ALL} | {("PROXY", host) for host in ALL}
