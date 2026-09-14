#!/usr/bin/env node
// Identity check for the reused (pinned) Terminal-Bench CLI candidate.
//
// A candidate id is derived from the built SEA binary and the packed tarball, so a
// rebuild of the same source commit produces different bytes and therefore a different
// candidate id: run 34757660356 recorded cli-0.0.3-beta.25-c692211-565089632a08-21f3137069de
// while the later rebuild of the same commit recorded cli-0.0.3-beta.25-c692211-fb439a62e41e-fcfbfa548647.
// Every run therefore reuses the one frozen candidate artifact declared in
// config/terminal-bench.json instead of rebuilding it, and this module fails closed
// unless the downloaded artifact reproduces the frozen receipt and byte hashes exactly.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CANDIDATE_FILES = ["best-agent-cli.tgz", "build-report.json", "candidate.json"];

const RECEIPT_FIELDS = [
  "packageName",
  "cliVersion",
  "sourceRepository",
  "sourceCommit",
  "target",
  "binarySha256",
  "buildReportSha256",
  "tarballSha256",
  "lockfileSha256",
  "runtimeLockSha256",
  "nodeBinarySha256",
  "nodeVersion",
];

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function candidateId(receipt) {
  return `cli-${receipt.cliVersion}-${receipt.sourceCommit.slice(0, 7)}-${receipt.binarySha256.slice(0, 12)}-${receipt.tarballSha256.slice(0, 12)}`;
}

export function verifyPinnedCandidate(candidateDir, config) {
  const cli = config.cli ?? {};
  const pin = cli.candidate;
  if (pin === undefined) {
    throw new Error("No frozen candidate pin is declared in config/terminal-bench.json.");
  }
  const files = readdirSync(candidateDir).sort();
  if (JSON.stringify(files) !== JSON.stringify([...CANDIDATE_FILES].sort())) {
    throw new Error(
      `A pinned candidate artifact must contain exactly ${CANDIDATE_FILES.join(", ")}; found ${files.join(", ")}.`,
    );
  }
  const receipt = JSON.parse(readFileSync(join(candidateDir, "candidate.json"), "utf8"));
  if (receipt.schemaVersion !== 1) {
    throw new Error(`Pinned candidate receipt schemaVersion must be 1, got ${String(receipt.schemaVersion)}.`);
  }
  const expected = { ...pin, ...cli };
  for (const field of RECEIPT_FIELDS) {
    const actual = receipt[field];
    if (actual !== expected[field]) {
      throw new Error(`Pinned candidate ${field} mismatch: ${String(actual)} != ${String(expected[field])}.`);
    }
  }
  const id = candidateId(receipt);
  if (id !== pin.candidateId) {
    throw new Error(`Pinned candidate id mismatch: ${id} != ${pin.candidateId}.`);
  }
  if (JSON.stringify(receipt.runtimeDependencies) !== JSON.stringify(pin.runtimeDependencies)) {
    throw new Error("Pinned candidate runtime dependency tree changed.");
  }
  const tarballSha256 = sha256File(join(candidateDir, "best-agent-cli.tgz"));
  if (tarballSha256 !== pin.tarballSha256) {
    throw new Error(`Pinned candidate tarball bytes changed: ${tarballSha256} != ${pin.tarballSha256}.`);
  }
  const buildReportSha256 = sha256File(join(candidateDir, "build-report.json"));
  if (buildReportSha256 !== pin.buildReportSha256) {
    throw new Error(`Pinned candidate build report bytes changed: ${buildReportSha256} != ${pin.buildReportSha256}.`);
  }
  return {
    candidateId: id,
    packageName: receipt.packageName,
    cliVersion: receipt.cliVersion,
    sourceCommit: receipt.sourceCommit,
    binarySha256: receipt.binarySha256,
    tarballSha256,
    buildReportSha256,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [candidateDir, configPath] = process.argv.slice(2);
  const config = JSON.parse(
    readFileSync(configPath ?? resolve(import.meta.dirname, "../config/terminal-bench.json"), "utf8"),
  );
  const verified = verifyPinnedCandidate(resolve(candidateDir ?? "results/candidate"), config);
  console.log(JSON.stringify({ verified: true, ...verified }));
}
