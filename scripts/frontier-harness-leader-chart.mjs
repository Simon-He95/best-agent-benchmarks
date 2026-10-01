#!/usr/bin/env node
/**
 * FrontierHarness leaderboard chart (line form).
 *
 * Renders this repository's full-corpus FrontierHarness runs as a line chart in the
 * published leaderboard's visual language: near-black canvas, monospace type, the
 * orange accent, a dashed grid on the leaderboard's tick rhythm (1/18 of the corpus),
 * and the published harnesses as a labelled reference band.
 *
 * Two series are drawn, and they are never mixed:
 *   - strict pass rate: the run's own verdicts, exactly one predeclared attempt per
 *     cell, over the 30 Docker-eligible tasks;
 *   - declared repaired reading: the same run with the cells a frozen, declared
 *     manifest re-measured, computed by scripts/frontier-harness-repaired-reading.mjs.
 *
 * Usage:
 *   node scripts/frontier-harness-leader-chart.mjs \
 *     --history docs/benchmarks/history/frontier-harness \
 *     --leaderboard docs/benchmarks/history/frontier-harness/leaderboard-official-v1.0-k3.json \
 *     --out docs/benchmarks/history/frontier-harness/leader-chart-pass-rate.svg
 *
 * A self-run is not comparable to the published leaderboard (different runtime,
 * isolation and network policy); the reference band is context, and the chart says so.
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const EMPTY = { history: undefined, leaderboard: undefined, out: undefined, title: undefined, png: false };
function parseArgs(argv) {
  const args = { ...EMPTY };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    if (key === "--png") {
      args.png = true;
      continue;
    }
    args[key.slice(2)] = argv[++i];
  }
  for (const required of ["history", "leaderboard", "out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const historyDir = resolve(args.history);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pct = (value) => `${(value * 100).toFixed(1)}%`;

const leaderboard = readJson(resolve(args.leaderboard));
const published = (leaderboard.harnesses ?? []).map((entry) => ({
  label: entry.label,
  passRate: entry.passRate,
  color: entry.color,
}));
if (published.length === 0) throw new Error("the leaderboard record carries no harnesses");
const publishedMin = Math.min(...published.map((entry) => entry.passRate));
const publishedMax = Math.max(...published.map((entry) => entry.passRate));
const topHarness = published.find((entry) => entry.passRate === publishedMax);
const bottomHarnesses = published.filter((entry) => entry.passRate === publishedMin);

// Full-corpus runs only: a partial batch is a diagnostic and never a point.
const fileName = /^(\d{8})T(\d{6})Z--(\d+)\.json$/u;
const runs = [];
const repairedByRun = new Map();
for (const name of readdirSync(historyDir).sort()) {
  if (name.endsWith(".official.json")) {
    const reading = readJson(join(historyDir, name));
    const runId = reading.sourceRun?.runId;
    if (runId === undefined || runId === null) continue;
    repairedByRun.set(String(runId), {
      file: name,
      value: reading.official?.value ?? reading.repairedReading?.passRate ?? null,
      cells: reading.repairedReading?.cells ?? [],
      expected: reading.repairedReading?.expected ?? null,
      passed: reading.repairedReading?.passed ?? null,
    });
    continue;
  }
  const match = fileName.exec(name);
  if (!match) continue;
  const record = readJson(join(historyDir, name));
  const expected = record.coverage?.expectedEligible ?? record.coverage?.expected;
  if (expected !== 30 || !record.results) continue;
  runs.push({
    runId: match[3],
    date: `${match[1].slice(4, 6)}-${match[1].slice(6, 8)}`,
    stamp: name.slice(0, 15),
    candidate: (record.cli?.sourceCommit ?? "").slice(0, 7),
    passed: record.results.passed,
    failed: record.results.failed,
    error: record.results.error,
    notEvaluated: record.results.notEvaluated ?? 0,
    passRate: record.results.passed / expected,
    expected,
  });
}
// A comparison point is a repaired reading of the run it names in its provenance.
for (const name of readdirSync(historyDir)) {
  if (!name.startsWith("leaderboard-comparison-") || !name.endsWith(".json")) continue;
  const comparison = readJson(join(historyDir, name));
  const primary = comparison.provenance?.primaryRecord;
  if (typeof primary !== "string") continue;
  const runId = /\d+\.json$/u.exec(basename(primary))?.[0]?.replace(".json", "");
  if (!runId || repairedByRun.has(runId)) continue;
  const point = comparison.point;
  if (!point || typeof point.passRate !== "number") continue;
  const refilled = Array.isArray(comparison.reading?.refilledFromRecovery)
    ? comparison.reading.refilledFromRecovery.length
    : 0;
  repairedByRun.set(runId, {
    file: name,
    value: point.passRate,
    cells: new Array(refilled).fill(null),
    expected: point.cells ?? null,
    passed: point.passes ?? null,
  });
}
if (runs.length === 0) throw new Error("no full-corpus run was found in the history directory");

// --- geometry -----------------------------------------------------------------
const WIDTH = 1680;
const HEIGHT = 1680;
const PLOT = { left: 130, right: 470, top: 250, bottom: 220 };
const plotRight = WIDTH - PLOT.right;
const plotBottom = HEIGHT - PLOT.bottom;
const hex = "#ff6418"; // the leaderboard's own best-agent / accent colour
const stroke = {
  grid: "#3a3a3a",
  axis: "#8a8a8a",
  text: "#e8e8e8",
  dim: "#9a9a9a",
  band: "#2a2a2a",
};
const font = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// The leaderboard's vertical rhythm is one corpus cell (1/30 = 3.3 pts) with labels
// every second cell; the axis is zoomed to the band this history actually occupies.
const CELL = 1 / 30;
const strictValues = runs.map((run) => run.passRate);
const readingValues = [...repairedByRun.values()].map((entry) => entry.value).filter((value) => value !== null);
const observed = [...strictValues, ...readingValues, publishedMin, publishedMax];
const lowest = Math.floor(Math.min(...observed) / CELL) * CELL - CELL;
const highest = Math.ceil(Math.max(...observed) / CELL) * CELL + CELL;
const y = (value) => plotBottom - ((value - lowest) / (highest - lowest)) * (plotBottom - PLOT.top);
const step = runs.length > 1 ? (plotRight - PLOT.left) / (runs.length - 1) : 0;
const x = (index) => PLOT.left + index * step;

// --- svg ----------------------------------------------------------------------
const parts = [];
const text = (xPos, yPos, value, { size = 20, fill = stroke.text, weight = 400, anchor = "start", extra = "" } = {}) =>
  `<text x="${xPos.toFixed(1)}" y="${yPos.toFixed(1)}" font-family="${font}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}" ${extra}>${value}</text>`;

parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#0a0a0a"/>`);
parts.push(`<rect x="${PLOT.left}" y="${PLOT.top}" width="${plotRight - PLOT.left}" height="${plotBottom - PLOT.top}" fill="#0d0d0d" stroke="${stroke.axis}" stroke-width="1"/>`);

// grid + y labels, on the leaderboard's own tick rhythm
for (let value = lowest; value <= highest + 1e-9; value += CELL) {
  const yPos = y(value);
  const major = Math.abs(Math.round(value * 18) - value * 18) < 1e-6;
  parts.push(
    `<line x1="${PLOT.left}" y1="${yPos.toFixed(1)}" x2="${plotRight}" y2="${yPos.toFixed(1)}" stroke="${stroke.grid}" stroke-width="${major ? 1.2 : 0.8}" stroke-dasharray="${major ? "6 6" : "2 6"}"/>`,
  );
  if (major) {
    parts.push(text(PLOT.left - 18, yPos + 7, pct(value), { size: 19, fill: stroke.dim, anchor: "end" }));
  }
}

// the published leaderboard band: context, labelled as such
const bandTop = y(publishedMax);
const bandBottom = y(publishedMin);
parts.push(
  `<rect x="${PLOT.left}" y="${bandTop.toFixed(1)}" width="${plotRight - PLOT.left}" height="${(bandBottom - bandTop).toFixed(1)}" fill="${stroke.band}" opacity="0.55"/>`,
);
for (const [value, label, color] of [
  [publishedMax, `${topHarness.label} ${pct(publishedMax)}`, topHarness.color],
  [publishedMin, `${bottomHarnesses.map((entry) => entry.label).join(" · ")} ${pct(publishedMin)}`, bottomHarnesses[0].color],
]) {
  parts.push(
    `<line x1="${PLOT.left}" y1="${y(value).toFixed(1)}" x2="${plotRight}" y2="${y(value).toFixed(1)}" stroke="${color}" stroke-width="1.6" stroke-dasharray="4 5" opacity="0.85"/>`,
    text(plotRight + 14, y(value) + 6, label, { size: 18, fill: color }),
  );
}
parts.push(
  text(plotRight + 14, (bandTop + bandBottom) / 2, "published harnesses", { size: 18, fill: stroke.dim }),
  text(plotRight + 14, (bandTop + bandBottom) / 2 + 22, `${published.length} entries · kimi-k3 pricing`, { size: 16, fill: stroke.dim }),
);

// x gridlines and run labels
runs.forEach((run, index) => {
  const xPos = x(index);
  parts.push(
    `<line x1="${xPos.toFixed(1)}" y1="${PLOT.top}" x2="${xPos.toFixed(1)}" y2="${plotBottom}" stroke="${stroke.grid}" stroke-width="0.8" stroke-dasharray="2 6"/>`,
  );
  parts.push(text(xPos, plotBottom + 34, run.date, { size: 19, fill: stroke.text, anchor: "middle" }));
  parts.push(text(xPos, plotBottom + 56, run.candidate, { size: 17, fill: stroke.dim, anchor: "middle" }));
  parts.push(text(xPos, plotBottom + 76, `${run.passed}/${run.expected}`, { size: 17, fill: stroke.dim, anchor: "middle" }));
});

// strict series
const strictPath = runs.map((run, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(run.passRate).toFixed(1)}`).join(" ");
parts.push(`<path d="${strictPath}" fill="none" stroke="${hex}" stroke-width="3"/>`);
runs.forEach((run, index) => {
  const xPos = x(index);
  const yPos = y(run.passRate);
  parts.push(`<circle cx="${xPos.toFixed(1)}" cy="${yPos.toFixed(1)}" r="6" fill="#0a0a0a" stroke="${hex}" stroke-width="3"/>`);
  parts.push(text(xPos, yPos - 16, pct(run.passRate), { size: 18, fill: hex, weight: 600, anchor: "middle" }));
});

// declared repaired readings
const readingPoints = [];
for (const [runId, entry] of repairedByRun) {
  const index = runs.findIndex((run) => run.runId === runId);
  if (index < 0 || entry.value === null) continue;
  readingPoints.push({ index, runId, ...entry });
}
for (const point of readingPoints) {
  const xPos = x(point.index);
  const yPos = y(point.value);
  parts.push(
    `<path d="M${xPos.toFixed(1)},${(yPos - 9).toFixed(1)} l9,9 l-9,9 l-9,-9 z" fill="#0a0a0a" stroke="#ffffff" stroke-width="2.5"/>`,
  );
  parts.push(text(xPos, yPos + 34, `repaired ${pct(point.value)}`, { size: 18, fill: "#ffffff", anchor: "middle" }));
  parts.push(text(xPos, yPos + 55, `${point.cells.length} cell(s) re-measured`, { size: 15, fill: stroke.dim, anchor: "middle" }));
}

// title block, the page's own furniture
parts.push(`<rect x="60" y="46" width="26" height="26" fill="${hex}"/>`);
parts.push(text(98, 68, "FrontierHarness Eval", { size: 34, fill: hex, weight: 700 }));
parts.push(`<rect x="540" y="40" width="86" height="36" rx="4" fill="none" stroke="${stroke.axis}"/>`);
parts.push(text(583, 65, "v1.0", { size: 21, fill: stroke.text, anchor: "middle" }));
parts.push(
  text(
    60,
    108,
    "best-agent · self-run on GitHub-hosted runners · 30 Docker-eligible tasks · one predeclared attempt per cell",
    { size: 20, fill: stroke.dim },
  ),
);
parts.push(
  text(60, 138, "— line: the run's own verdicts (strict pass rate)      ◆ declared repaired reading · grey band: published leaderboard (reference)", {
    size: 19,
    fill: stroke.dim,
  }),
);
parts.push(text(60, 166, "x: full-corpus runs of this repository, oldest to newest (date · candidate · passed/30)    y: pass rate", { size: 18, fill: stroke.dim }));

// The final point is the one being read: call it out inside the plot, above the band.
const last = runs.at(-1);
const lastReading = readingPoints.find((point) => point.runId === last.runId);
const headline = lastReading ? lastReading.value : last.passRate;
const callout = { x: PLOT.left + 18, y: PLOT.top + 18, w: 720, h: 66 };
parts.push(
  `<rect x="${callout.x}" y="${callout.y}" width="${callout.w}" height="${callout.h}" rx="6" fill="#111111" stroke="${stroke.band}"/>`,
);
parts.push(
  text(callout.x + 18, callout.y + 28, `final: run ${last.runId} (${last.candidate})`, { size: 21, fill: stroke.text, weight: 600 }),
);
parts.push(
  text(
    callout.x + 18,
    callout.y + 55,
    lastReading
      ? `strict ${pct(last.passRate)} (${last.passed}/30) → repaired reading ${pct(headline)} · ${lastReading.cells.length} declared re-measurement(s)`
      : `strict ${pct(last.passRate)} (${last.passed}/30) — no declared repaired reading yet`,
    { size: 19, fill: hex },
  ),
);
parts.push(
  text(
    WIDTH - 60,
    HEIGHT - 30,
    "a self-run is not comparable to the published leaderboard (different runtime, isolation, network)",
    { size: 16, fill: stroke.dim, anchor: "end" },
  ),
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="FrontierHarness Eval v1.0 pass rate line chart">\n${parts.join("\n")}\n</svg>\n`;
writeFileSync(resolve(args.out), svg);

const table = [
  `# FrontierHarness Eval v1.0 — pass rate across full runs`,
  ``,
  `| # | run | date | candidate | strict | repaired reading | notes |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...runs.map((run, index) => {
    const reading = readingPoints.find((point) => point.runId === run.runId);
    return `| ${index + 1} | ${run.runId} | ${run.date} | ${run.candidate} | ${pct(run.passRate)} (${run.passed}/${run.expected}) | ${
      reading ? `${pct(reading.value)} (${reading.cells.length} re-measured)` : "—"
    } | ${run.error} error / ${run.notEvaluated} not-evaluated |`;
  }),
  ``,
  `Published leaderboard band: ${pct(publishedMin)} (${bottomHarnesses.map((entry) => entry.label).join(", ")}) to ${pct(publishedMax)} (${topHarness.label}); ${published.length} entries, kimi-k3 pricing.`,
  ``,
  `A self-run is not comparable to the published leaderboard (different runtime, isolation and network policy). A repaired reading counts the declared re-measurements and is labelled as such; the strict column is the run's own verdicts.`,
  ``,
];
writeFileSync(`${resolve(args.out).replace(/\.svg$/u, "")}.md`, table.join("\n"));
console.log(
  `chart written to ${resolve(args.out)} (${runs.length} full runs, ${readingPoints.length} repaired reading(s))`,
);

// Optional raster: the SVG is the deliverable, and a PNG is produced on hosts
// that can rasterize one (macOS ships qlmanage; Linux hosts usually have
// rsvg-convert or Inkscape). Absence is reported, never a failure.
if (args.png) {
  const svgPath = resolve(args.out);
  const pngPath = svgPath.replace(/\.svg$/u, ".png");
  const rasterizers = [
    ["qlmanage", ["-t", "-s", String(WIDTH), "-o", dirname(svgPath), svgPath]],
    ["rsvg-convert", ["-w", String(WIDTH), "-o", pngPath, svgPath]],
    ["inkscape", [svgPath, "--export-type=png", `--export-filename=${pngPath}`, `--export-width=${WIDTH}`]],
  ];
  let produced = false;
  for (const [command, argv] of rasterizers) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
    if (probe.error) continue;
    const result = spawnSync(command, argv, { encoding: "utf8" });
    if (command === "qlmanage") {
      const generated = `${svgPath}.png`;
      if (result.status === 0 && existsSync(generated)) {
        renameSync(generated, pngPath);
      }
    }
    if (existsSync(pngPath)) {
      produced = true;
      console.log(`png written to ${pngPath} (${command})`);
      break;
    }
  }
  if (!produced) console.log("no rasterizer available on this host; the SVG is the deliverable");
}

for (const run of runs) {
  const reading = readingPoints.find((point) => point.runId === run.runId);
  console.log(
    `  ${run.stamp} ${run.candidate} strict ${pct(run.passRate)}${reading ? ` | repaired ${pct(reading.value)}` : ""}`,
  );
}
