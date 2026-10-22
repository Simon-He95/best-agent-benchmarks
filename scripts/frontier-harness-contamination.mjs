#!/usr/bin/env node
/**
 * Contamination check for a frozen Frontier-Harness attempt.
 *
 * A cell is contaminated when the model reached a source that carries the answer
 * rather than solving the task: the task's own upstream repository (its later
 * commits), a published build of the project under test, or the hidden test
 * corpus. That is not a capability measurement, so the reading has to say so.
 *
 * The check reads only what a frozen attempt already records:
 *   <cell>/pier-task/task.toml        repository_url, base_commit_hash
 *   <cell>/pier-task/instruction.md   the commands the task itself tells the model to run
 *   <cell>/<trial>/agent/best-agent-evidence.jsonl   every tool call the model made
 *
 * Classification of one call (case-insensitive):
 *   instruction-sanctioned  the command (or its URL) appears in instruction.md — the
 *                           task itself asked for it, e.g. `git clone --branch 0.5.3 …`
 *   upstream-access         reaches the task's own repository without an
 *                           instruction-sanctioned command
 *   upstream-history        `git log --all`, `--unshallow`, `git show <other sha>`,
 *                           `FETCH_HEAD` on the task's repository: later commits
 *   published-package       `npm pack|view|install <name>` / `pip download|install <name>`
 *                           for the project under test: the published artifact may
 *                           already contain the fix
 *   test-corpus             `test262` (or the task's declared test suite) fetched from
 *                           the network: the hidden tests
 *   other-network           any other egress; recorded, and itself a boundary failure
 *                           when the attempt declared no egress at all
 *
 * Verdict per cell: `contaminated` when any answer-source class is present, otherwise
 * `clean`. Exit status is non-zero when a cell that must be clean is contaminated, so a
 * workflow step can gate on it.
 *
 * usage: node scripts/frontier-harness-contamination.mjs --jobs <dir> [--output <file>]
 *        [--require-clean] [--json]
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ANSWER_SOURCE_CLASSES = new Set([
  "upstream-access",
  "upstream-history",
  "published-package",
  "test-corpus",
]);

const NETWORK_SHAPES = [
  /\bgit\s+(clone|fetch|pull|ls-remote|remote\s+add)\b/i,
  /\bnpm\s+(pack|view|info|install|i|ci|exec)\b/i,
  /\bpip3?\s+(download|install)\b/i,
  /\b(uv|poetry|yarn|pnpm)\s+(add|install|pip)\b/i,
  /\b(curl|wget|http|https|xh|nc|netcat|ssh|scp|rsync)\b/i,
  /\bgh\s+api\b/i,
  /\bgit\s+show\s+[0-9a-f]{7,40}/i,
];

/** Commands that read history beyond the pinned ref. */
const HISTORY_SHAPES = [
  /\bgit\s+(fetch|pull)\b/i,
  /--unshallow/,
  /\bgit\s+log\b[^\n]*--all\b/i,
  /\bgit\s+(show|diff)\s+[0-9a-f]{7,40}/i,
  /FETCH_HEAD/,
];

/** Every exec/process-start/fetch call in one attempt, in call order. */
export function readCalls(evidenceLines) {
  const calls = new Map();
  for (const line of evidenceLines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "terminal-snapshot") continue;
    for (const item of entry.snapshot?.transcript ?? []) {
      if (item.kind !== "assistant") continue;
      for (const call of item.message?.toolCalls ?? []) calls.set(call.callId, call);
    }
  }
  return [...calls.values()];
}

/** The command text of one call, whichever field carries it. */
export function callText(call) {
  const input = call.input ?? {};
  if (call.name === "exec") return [input.command, ...(input.args ?? [])].filter(Boolean).join(" ");
  if (call.name === "process-start") return (input.argv ?? []).join(" ");
  if (call.name === "web_fetch") return String(input.url ?? "");
  if (call.name === "web_search") return String(input.query ?? "");
  return "";
}

function repoSlug(repositoryUrl) {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i.exec(repositoryUrl ?? "");
  return match ? `${match[1]}/${match[2]}`.replace(/\.git$/i, "").toLowerCase() : undefined;
}

function projectName(repositoryUrl) {
  const slug = repoSlug(repositoryUrl);
  return slug?.split("/")[1];
}

/**
 * Classify one call against the task's own declaration.
 *
 * @returns {{ kind: string, detail: string } | undefined} undefined when the call
 *   makes no network attempt at all.
 */
export function classifyCall(text, task) {
  if (!text) return undefined;
  if (!NETWORK_SHAPES.some((shape) => shape.test(text))) return undefined;

  // The task's own instruction outranks every rule: when it names this exact command
  // (or its URL), running it is part of the task, not an answer lookup.
  const instruction = task.instruction ?? "";
  const urls = text.match(/https?:\/\/[^\s'"`)]+/gi) ?? [];
  for (const url of urls) {
    const trimmed = url.replace(/[.,;:]+$/, "");
    if (instruction.includes(trimmed)) return { kind: "instruction-sanctioned", detail: trimmed };
    const slug = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i.exec(trimmed);
    if (slug) {
      const candidate = `${slug[1]}/${slug[2]}`.replace(/\.git$/i, "");
      if (instruction.toLowerCase().includes(`github.com/${candidate.toLowerCase()}`)) {
        return { kind: "instruction-sanctioned", detail: candidate };
      }
    }
  }
  if (task.instruction?.includes(text.trim())) return { kind: "instruction-sanctioned", detail: "verbatim" };

  const slug = repoSlug(task.repositoryUrl);
  const name = projectName(task.repositoryUrl);
  const lower = text.toLowerCase();

  if (/test262/i.test(text)) return { kind: "test-corpus", detail: "test262" };
  if (slug && lower.includes(slug)) {
    if (/\bgit\s+(fetch|pull)\b|--unshallow|--all\b|\bgit\s+log\s+[^\n]*--all\b/i.test(text)) {
      return { kind: "upstream-history", detail: slug };
    }
    const otherSha = [...text.matchAll(/\bgit\s+(?:show|log|diff)\s+([0-9a-f]{7,40})/gi)]
      .map((match) => match[1].toLowerCase())
      .filter((sha) => !String(task.baseCommit ?? "").toLowerCase().startsWith(sha));
    if (otherSha.length) return { kind: "upstream-history", detail: otherSha.join(",") };
    return { kind: "upstream-access", detail: slug };
  }
  if (name) {
    const packageShape = new RegExp(
      `\\b(npm\\s+(pack|view|info|install|i)|pip3?\\s+(download|install)|npx)\\s+[^\\s]*${name}`, "i",
    );
    if (packageShape.test(text)) return { kind: "published-package", detail: name };
  }
  return { kind: "other-network", detail: urls[0] ?? text.slice(0, 80) };
}

function readTaskDeclaration(jobsDir, cell) {
  const taskToml = join(jobsDir, cell, "pier-task", "task.toml");
  const instruction = join(jobsDir, cell, "pier-task", "instruction.md");
  const toml = existsSync(taskToml) ? readFileSync(taskToml, "utf8") : "";
  return {
    repositoryUrl: /repository_url\s*=\s*"([^"]+)"/.exec(toml)?.[1],
    baseCommit: /base_commit_hash\s*=\s*"([^"]+)"/.exec(toml)?.[1],
    instruction: existsSync(instruction) ? readFileSync(instruction, "utf8") : "",
  };
}

function evidenceFile(jobsDir, cell) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  return walk(join(jobsDir, cell)).find((file) => file.endsWith("best-agent-evidence.jsonl"));
}

/** Scan one cell. */
export function scanCell(jobsDir, cell) {
  const task = readTaskDeclaration(jobsDir, cell);
  const file = evidenceFile(jobsDir, cell);
  const calls = file ? readCalls(readFileSync(file, "utf8").split("\n").filter(Boolean)) : [];
  const findings = [];
  let unsanctionedClone = undefined;
  for (const call of calls) {
    const text = callText(call);
    let verdict = classifyCall(text, task);
    if (!verdict) continue;
    // A history read is only an answer lookup once the attempt has fetched the
    // task's own repository itself: `git show <sha>` in a sanctioned clone of a
    // dependency at its pinned tag is still the task's own step, while the same
    // command in a repository the instruction never named is later history.
    if (
      (verdict.kind === "other-network" || verdict.kind === "instruction-sanctioned") &&
      HISTORY_SHAPES.some((shape) => shape.test(text)) &&
      (unsanctionedClone !== undefined || verdict.kind === "other-network")
    ) {
      verdict =
        verdict.kind === "instruction-sanctioned" && unsanctionedClone === undefined
          ? verdict
          : { kind: "upstream-history", detail: unsanctionedClone ?? text.slice(0, 80) };
    }
    if (verdict.kind === "upstream-access") unsanctionedClone = verdict.detail;
    findings.push({ tool: call.name, ...verdict });
  }
  const counts = {};
  for (const finding of findings) counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  const answerSource = findings.filter((finding) => ANSWER_SOURCE_CLASSES.has(finding.kind));
  return {
    cell,
    repository: repoSlug(task.repositoryUrl) ?? null,
    toolCalls: calls.length,
    networkCalls: findings.length,
    counts,
    verdict: answerSource.length ? "contaminated" : "clean",
    answerSource: answerSource.map((finding) => `${finding.kind}: ${finding.detail}`),
    otherNetwork: findings
      .filter((finding) => finding.kind === "other-network" || finding.kind === "instruction-sanctioned")
      .map((finding) => `${finding.kind}: ${finding.detail}`),
  };
}

export function scanJobs(jobsDir) {
  const cells = readdirSync(jobsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return cells.map((cell) => scanCell(jobsDir, cell));
}

function main(argv) {
  const options = { jobs: undefined, output: undefined, requireClean: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--jobs") options.jobs = argv[++index];
    else if (token === "--output") options.output = argv[++index];
    else if (token === "--require-clean") options.requireClean = true;
    else if (token === "--json") options.json = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!options.jobs) throw new Error("usage: --jobs <dir> [--output <file>] [--require-clean] [--json]");

  const cells = scanJobs(options.jobs);
  const receipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    jobsDir: options.jobs,
    answerSourceClasses: [...ANSWER_SOURCE_CLASSES],
    verdict: cells.some((cell) => cell.verdict === "contaminated") ? "contaminated" : "clean",
    cells,
  };
  if (options.output) writeFileSync(options.output, `${JSON.stringify(receipt, null, 2)}\n`);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    for (const cell of cells) {
      const counts = Object.entries(cell.counts).map(([kind, n]) => `${kind}=${n}`).join(" ") || "no network";
      process.stdout.write(`${cell.verdict === "contaminated" ? "CONTAMINATED" : "clean"}  ${cell.cell}  (${counts})\n`);
      for (const hit of cell.answerSource) process.stdout.write(`    answer source: ${hit}\n`);
    }
    process.stdout.write(`\nverdict: ${receipt.verdict}\n`);
  }

  if (options.requireClean && receipt.verdict !== "clean") {
    process.stderr.write(
      "Refusing a contaminated attempt: the model reached an answer source, so this attempt is not a measurement.\n",
    );
    process.exit(1);
  }
}

// The exact script path, not a prefix: a test file named after it also matches a prefix.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
