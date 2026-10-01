#!/usr/bin/env node
/**
 * FrontierHarness leaderboard chart (history form).
 *
 * Draws every full-corpus run of this repository as one point of a pass-rate line,
 * in the same visual language as tools/frontier-harness-comparison/chart.py (the
 * published-style comparison figure): one near-black page, one dark panel, a 5%
 * dashed grid, the leaderboard's orange accent, monospace labels, a right-hand
 * column for the published field.
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
 *     --out docs/benchmarks/history/frontier-harness/leader-chart-pass-rate.svg --png
 *
 * The renderer measures every label it places (the stack is monospace, so a label
 * is `0.6em` per character) and refuses to write a figure whose labels would leave
 * the canvas, escape the panel, or overlap another label or an annotation box.
 *
 * A self-run is not comparable to the published leaderboard (different runtime,
 * isolation and network policy); the reference band is context, and the chart says so.
 */
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const EMPTY = { history: undefined, leaderboard: undefined, out: undefined, title: undefined, png: false, dryRun: false };
function parseArgs(argv) {
  const args = { ...EMPTY };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    if (key === "--png" || key === "--dry-run") {
      args[key === "--png" ? "png" : "dryRun"] = true;
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
const shortPct = (value) => `${Math.round(value * 100)}%`;
const today = new Date().toISOString().slice(0, 10);

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
const priceLabel = `${leaderboard.priceTable?.name ?? "official price table"}`.replace(/-\d{4}-\d{2}-\d{2}$/u, "");

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

// --- design tokens (kept in step with tools/frontier-harness-comparison/chart.py) ----
const INK = {
  canvas: "#0a0a0c",
  panel: "#101014",
  grid: "#26262c",
  band: "#17171d",
  text: "#e8e8ea",
  muted: "#9a9aa2",
  faint: "#6a6a72",
  accent: "#ff6418",
  white: "#ffffff",
};
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const ADVANCE = 0.6; // em per glyph: every member of the stack has the same advance

// --- geometry -----------------------------------------------------------------
const WIDTH = 2300;
const HEIGHT = 1320;
const PANEL = { left: 190, right: 2016, top: 240, bottom: 1100, radius: 10 };
const PLOT_INSET = 110; // how far the first and last run sit inside the panel
const Y_MIN = 0.45;
const Y_MAX = 0.8;
const SIZE = {
  title: 46,
  pill: 26,
  subtitle: 26,
  legend: 24,
  headerNote: 26,
  tick: 28,
  axis: 26,
  value: 26,
  repaired: 24,
  repairedNote: 22,
  calloutTitle: 27,
  calloutValue: 25,
  calloutNote: 23,
  footnote: 21,
};

const plotLeft = PANEL.left + PLOT_INSET;
const plotRight = PANEL.right - PLOT_INSET;
const xAt = (index) => plotLeft + ((plotRight - plotLeft) / Math.max(1, runs.length - 1)) * index;
const yAt = (value) => PANEL.bottom - ((value - Y_MIN) / (Y_MAX - Y_MIN)) * (PANEL.bottom - PANEL.top);
const bandTop = yAt(publishedMax);
const bandBottom = yAt(publishedMin);

// --- measured text ------------------------------------------------------------
const parts = [];
const boxes = [];
const escapeXml = (value) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const measure = (value, x, y, size, anchor, kind) => {
  const width = value.length * size * ADVANCE;
  const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  const box = { value, kind, left, right: left + width, top: y - size * 0.74, bottom: y + size * 0.24 };
  boxes.push(box);
  return box;
};
const text = (
  x,
  y,
  value,
  { size = SIZE.value, fill = INK.text, weight = 400, anchor = "start", kind = "text", track = true, dy = undefined } = {},
) => {
  if (track) measure(value, x, y + (dy ?? 0), size, anchor, kind);
  // `y` is always the exact coordinate the label belongs to; `dy` only nudges the
  // glyphs optically, so the figure stays readable as data.
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}"${dy === undefined ? "" : ` dy="${dy}"`} font-family="${FONT}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
};
const line = (x1, y1, x2, y2, { stroke = INK.grid, width = 1, dash = undefined, opacity = undefined, cap = undefined } = {}) =>
  `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${width}"${
    dash ? ` stroke-dasharray="${dash}"` : ""
  }${opacity === undefined ? "" : ` opacity="${opacity}"`}${cap ? ` stroke-linecap="${cap}"` : ""}/>`;
const rect = (x, y, w, h, { fill = "none", stroke = undefined, width = 1, radius = 0, opacity = undefined, clip = undefined } = {}) =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"${radius ? ` rx="${radius}"` : ""} fill="${fill}"${
    stroke ? ` stroke="${stroke}" stroke-width="${width}"` : ""
  }${opacity === undefined ? "" : ` opacity="${opacity}"`}${clip ? ` clip-path="url(#${clip})"` : ""}/>`;

// --- label placement ----------------------------------------------------------
const SLACK_X = 4;
const SLACK_Y = 2;
const overlaps = (a, b) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > SLACK_X &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > SLACK_Y;

/** The box a block of lines would occupy if its first baseline sat at `y0`. */
const blockAt = (cx, y0, lines) => {
  const measured = lines.map((item) => {
    const width = item.value.length * item.size * ADVANCE;
    const x = item.anchor === "middle" ? cx : item.anchor === "end" ? cx + width / 2 : cx - width / 2;
    const y = y0 + (item.dy ?? 0);
    const left = item.anchor === "middle" ? x - width / 2 : item.anchor === "end" ? x - width : x;
    return { left, right: left + width, top: y - item.size * 0.74, bottom: y + item.size * 0.24 };
  });
  return {
    left: Math.min(...measured.map((box) => box.left)),
    right: Math.max(...measured.map((box) => box.right)),
    top: Math.min(...measured.map((box) => box.top)),
    bottom: Math.max(...measured.map((box) => box.bottom)),
  };
};

/**
 * Place a label block near its marker, trying the preferred offset first and then
 * the caller's alternates, and keeping it inside the panel. A block that had to
 * move gets a dotted leader back to its marker, so it stays unambiguous.
 */
const placeBlock = (cx, y0, lines, { offsets = [0], markerY = y0, kind = "label" } = {}) => {
  const fits = (candidate) => {
    const box = blockAt(cx, candidate, lines);
    if (box.left < PANEL.left + 12 || box.right > PANEL.right - 12) return false;
    if (box.top < PANEL.top + 10 || box.bottom > PANEL.bottom - 10) return false;
    return !boxes.some((box2) => overlaps(box, box2));
  };
  let chosen = y0;
  for (const offset of offsets) {
    if (fits(y0 + offset)) {
      chosen = y0 + offset;
      break;
    }
  }
  const box = blockAt(cx, chosen, lines);
  const displaced = Math.abs(chosen - y0) > 24;
  const out = [];
  if (displaced) {
    const from = markerY < box.top ? markerY + 14 : markerY - 14;
    const to = markerY < box.top ? box.top - 8 : box.bottom + 8;
    out.push(line(cx, from, cx, to, { stroke: INK.white, width: 1.4, dash: "3 5", opacity: 0.4 }));
  }
  for (const item of lines) {
    const y = chosen + (item.dy ?? 0);
    out.push(text(cx, y, item.value, { size: item.size, fill: item.fill, weight: item.weight ?? 400, anchor: item.anchor ?? "middle", kind }));
  }
  return out.join("\n");
};

// --- page ---------------------------------------------------------------------
parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${INK.canvas}"/>`);
parts.push(`<defs>
  <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${INK.accent}" stop-opacity="0.22"/>
    <stop offset="55%" stop-color="${INK.accent}" stop-opacity="0.07"/>
    <stop offset="100%" stop-color="${INK.accent}" stop-opacity="0.01"/>
  </linearGradient>
  <clipPath id="panel-clip">${rect(PANEL.left, PANEL.top, PANEL.right - PANEL.left, PANEL.bottom - PANEL.top, { radius: PANEL.radius })}</clipPath>
</defs>`);
parts.push(rect(PANEL.left, PANEL.top, PANEL.right - PANEL.left, PANEL.bottom - PANEL.top, { fill: INK.panel, stroke: INK.grid, radius: PANEL.radius }));

// the published field: a reference band, the two published limits, their colours
parts.push(
  rect(PANEL.left, bandTop, PANEL.right - PANEL.left, bandBottom - bandTop, { fill: INK.band, clip: "panel-clip" }),
);
for (const [value, harness] of [
  [publishedMax, topHarness],
  [publishedMin, bottomHarnesses[0]],
]) {
  parts.push(line(PANEL.left, yAt(value), PANEL.right, yAt(value), { stroke: harness.color, width: 1.6, dash: "5 6", opacity: 0.75 }));
}

// grid: the pass-rate ruler, labelled every 5 points
for (let value = Y_MIN; value <= Y_MAX + 1e-9; value += 0.05) {
  const y = yAt(value);
  parts.push(line(PANEL.left + 1, y, PANEL.right - 1, y, { stroke: INK.grid, width: 1.2, dash: "1 6" }));
  parts.push(text(PANEL.left - 18, y, shortPct(value), { size: SIZE.tick, fill: INK.muted, anchor: "end", kind: "tick", dy: 10 }));
}
parts.push(
  `<text x="96" y="670" transform="rotate(-90 96 670)" font-family="${FONT}" font-size="${SIZE.axis}" fill="${INK.muted}" text-anchor="middle">pass rate</text>`,
);
boxes.push({ value: "pass rate (rotated)", kind: "rotated", left: 75.3, right: 102.7, top: 592.4, bottom: 743.6 });

// the published limits, named in the right-hand column
parts.push(text(PANEL.right + 20, bandTop + 8, `${topHarness.label} ${pct(publishedMax)}`, { size: SIZE.value, fill: topHarness.color }));
parts.push(
  text(PANEL.right + 20, bandBottom + 8, bottomHarnesses.map((entry) => entry.label).join(" · "), {
    size: SIZE.repairedNote,
    fill: bottomHarnesses[0].color,
  }),
);
parts.push(text(PANEL.right + 20, bandBottom + 36, pct(publishedMin), { size: SIZE.repairedNote, fill: bottomHarnesses[0].color }));
const bandMiddle = (bandTop + bandBottom) / 2;
parts.push(
  text(PANEL.right + 20, bandMiddle - 22, "published field", { size: SIZE.value, fill: INK.muted }),
  text(PANEL.right + 20, bandMiddle + 6, `${published.length} entries`, { size: SIZE.repairedNote, fill: INK.faint }),
  text(PANEL.right + 20, bandMiddle + 34, `${priceLabel} pricing`, { size: SIZE.repairedNote, fill: INK.faint }),
);

// --- the strict series --------------------------------------------------------
const strictPath = runs.map((run, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)},${yAt(run.passRate).toFixed(1)}`).join(" ");
const lastIndex = runs.length - 1;
const areaPath = `${strictPath} L${xAt(lastIndex).toFixed(1)},${PANEL.bottom} L${xAt(0).toFixed(1)},${PANEL.bottom} Z`;
parts.push(`<path d="${areaPath}" fill="url(#area)" clip-path="url(#panel-clip)"/>`);
parts.push(`<path d="${strictPath}" fill="none" stroke="${INK.accent}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>`);

// x ticks: one column per run, dated, with the candidate it ran
runs.forEach((run, index) => {
  const x = xAt(index);
  parts.push(line(x, PANEL.top + 1, x, PANEL.bottom - 1, { stroke: INK.grid, width: 1, dash: "1 7", opacity: 0.5 }));
  parts.push(text(x, PANEL.bottom + 46, run.date, { size: SIZE.axis, fill: INK.text, anchor: "middle", kind: "tick" }));
  parts.push(text(x, PANEL.bottom + 78, run.candidate, { size: SIZE.repairedNote, fill: INK.muted, anchor: "middle", kind: "tick" }));
});

// --- the repaired readings ----------------------------------------------------
const readingPoints = [];
for (const [runId, entry] of repairedByRun) {
  const index = runs.findIndex((run) => run.runId === runId);
  if (index < 0 || entry.value === null) continue;
  readingPoints.push({ index, runId, ...entry });
}

// --- markers ------------------------------------------------------------------
for (const [index, run] of runs.entries()) {
  const x = xAt(index);
  const y = yAt(run.passRate);
  const point = readingPoints.find((entry) => entry.index === index);
  if (point) {
    const yReading = yAt(point.value);
    if (Math.abs(yReading - y) > 6) {
      parts.push(line(x, y, x, yReading, { stroke: INK.white, width: 1.6, dash: "4 5", opacity: 0.45 }));
    }
  }
  if (index === lastIndex) {
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="34" fill="none" stroke="${INK.accent}" stroke-width="2" opacity="0.12"/>`);
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="21" fill="none" stroke="${INK.accent}" stroke-width="2" opacity="0.32"/>`);
  }
  parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${INK.accent}" stroke="${INK.canvas}" stroke-width="3"/>`);
}
// A repaired marker sits on the repaired value; where the reading did not move, the
// diamond is drawn around the dot instead, so the run is not double-marked in place.
for (const point of readingPoints) {
  const x = xAt(point.index);
  const yStrict = yAt(runs[point.index].passRate);
  const y = yAt(point.value);
  const radius = Math.abs(y - yStrict) > 6 ? 12 : 19;
  parts.push(
    `<path d="M${x.toFixed(1)},${(y - radius).toFixed(1)} L${(x + radius).toFixed(1)},${y.toFixed(1)} L${x.toFixed(1)},${(y + radius).toFixed(
      1,
    )} L${(x - radius).toFixed(1)},${y.toFixed(1)} Z" fill="${INK.canvas}" stroke="${INK.white}" stroke-width="2.6"/>`,
  );
}

// --- labels -------------------------------------------------------------------
runs.forEach((run, index) => {
  const x = xAt(index);
  const y = yAt(run.passRate);
  parts.push(
    placeBlock(x, y - 26, [{ value: pct(run.passRate), size: SIZE.value, fill: INK.accent, weight: 600 }], {
      offsets: [0, -46, -92, 46],
      markerY: y,
      kind: "value",
    }),
  );
});
for (const point of readingPoints) {
  const x = xAt(point.index);
  const y = yAt(point.value);
  const cells = point.cells.length;
  parts.push(
    placeBlock(
      x,
      y + 40,
      [
        { value: `repaired ${pct(point.value)}`, size: SIZE.repaired, fill: INK.white, weight: 600 },
        { value: cells === 1 ? "1 cell re-measured" : `${cells} cells re-measured`, size: SIZE.repairedNote, fill: INK.muted, dy: 30 },
      ],
      { offsets: [0, 78, 156, -78], markerY: y, kind: "repaired" },
    ),
  );
}

// --- header, legend, callout, footnotes ---------------------------------------
const title = args.title ?? "FrontierHarness Eval";
parts.push(rect(88, 52, 30, 30, { fill: INK.accent }));
const titleWidth = title.length * SIZE.title * ADVANCE;
parts.push(text(136, 92, title, { size: SIZE.title, fill: INK.accent, weight: 700, kind: "furniture" }));
const pill = { x: 136 + titleWidth + 28, width: 4 * SIZE.pill * ADVANCE + 40 };
parts.push(rect(pill.x, 54, pill.width, 40, { fill: "none", stroke: INK.grid, radius: 8 }));
parts.push(text(pill.x + pill.width / 2, 82, "v1.0", { size: SIZE.pill, fill: INK.text, anchor: "middle", kind: "furniture" }));
parts.push(
  text(PANEL.right + 196, 90, `${runs.length} full runs · rendered ${today} UTC`, {
    size: SIZE.headerNote,
    fill: INK.muted,
    anchor: "end",
    kind: "furniture",
  }),
);
parts.push(
  text(88, 148, "pass rate over the 30-task FrontierHarness Eval v1.0 corpus · one predeclared attempt per cell · self-run on GitHub-hosted runners", {
    size: SIZE.subtitle,
    fill: INK.muted,
    kind: "furniture",
  }),
);
const legendY = 202;
parts.push(line(88, legendY, 152, legendY, { stroke: INK.accent, width: 3.2, cap: "round" }));
parts.push(`<circle cx="120" cy="${legendY}" r="9" fill="${INK.accent}" stroke="${INK.canvas}" stroke-width="3"/>`);
parts.push(text(168, legendY + 8, "run's own verdicts — strict pass rate", { size: SIZE.legend, fill: INK.text, kind: "furniture" }));
parts.push(
  `<path d="M735,${legendY - 11} L746,${legendY} L735,${legendY + 11} L724,${legendY} Z" fill="${INK.canvas}" stroke="${INK.white}" stroke-width="2.6"/>`,
);
parts.push(text(762, legendY + 8, "declared repaired reading", { size: SIZE.legend, fill: INK.text, kind: "furniture" }));
parts.push(rect(1162, legendY - 12, 40, 24, { fill: INK.band, stroke: INK.grid }));
parts.push(text(1218, legendY + 8, "published leaderboard band (reference)", { size: SIZE.legend, fill: INK.text, kind: "furniture" }));

// the newest run, read out: the figure exists to answer "where does this stand"
const last = runs[lastIndex];
const lastReading = readingPoints.find((point) => point.index === lastIndex);
const bestStrict = runs.reduce((best, run) => (run.passRate > best.passRate ? run : best), runs[0]);
const callout = { x: 214, y: 252, width: 1060 };
const calloutLines = [
  { value: `latest run ${last.runId} · ${last.candidate} · ${last.date}`, size: SIZE.calloutTitle, fill: INK.text, weight: 600, dy: 0 },
  {
    value: lastReading
      ? `strict ${pct(last.passRate)} (${last.passed}/${last.expected}) → repaired ${pct(lastReading.value)} · ${lastReading.cells.length} cell(s) re-measured`
      : `strict ${pct(last.passRate)} (${last.passed}/${last.expected}) · ${last.error} error · ${last.notEvaluated} not-evaluated`,
    size: SIZE.calloutValue,
    fill: INK.accent,
    weight: 600,
    dy: 42,
  },
  {
    value:
      bestStrict === last
        ? "the best pass rate on record"
        : `ties the best pass rate on record (run ${bestStrict.runId}, ${bestStrict.date})`,
    size: SIZE.calloutNote,
    fill: INK.muted,
    dy: 80,
  },
];
const calloutHeight = 80 + Math.round(calloutLines[2].size * 1.4) + 22;
parts.push(rect(callout.x, callout.y, callout.width, calloutHeight, { fill: "#14141a", stroke: INK.grid, radius: 10 }));
parts.push(rect(callout.x, callout.y, 6, calloutHeight, { fill: INK.accent, radius: 3 }));
boxes.push({ value: "callout panel", kind: "container", left: callout.x, right: callout.x + callout.width, top: callout.y, bottom: callout.y + calloutHeight });
for (const item of calloutLines) {
  parts.push(text(callout.x + 30, callout.y + 40 + item.dy, item.value, { size: item.size, fill: item.fill, weight: item.weight ?? 400, kind: "furniture" }));
}

parts.push(
  text((PANEL.left + PANEL.right) / 2, PANEL.bottom + 118, `full-corpus runs of this repository, oldest to newest (date · candidate commit) · ${runs[0].date} → ${last.date}`, {
    size: SIZE.axis,
    fill: INK.muted,
    anchor: "middle",
    kind: "furniture",
  }),
);
parts.push(
  text(88, 1258, "A self-run is not comparable to the published leaderboard: different runtime, isolation and network policy.", {
    size: SIZE.footnote,
    fill: INK.faint,
    kind: "furniture",
  }),
);
parts.push(
  text(88, 1286, "A repaired reading is declared and frozen: only cells with no verdict are re-measured, once; every strict verdict stands.", {
    size: SIZE.footnote,
    fill: INK.faint,
    kind: "furniture",
  }),
);
parts.push(
  text(PANEL.right + 196, 1258, "source: docs/benchmarks/history/frontier-harness", {
    size: SIZE.footnote,
    fill: INK.faint,
    anchor: "end",
    kind: "furniture",
  }),
);

// --- the figure is only written if it lays out cleanly -------------------------
const layoutIssues = [];
for (const box of boxes) {
  if (box.left < 6 || box.right > WIDTH - 6 || box.top < 6 || box.bottom > HEIGHT - 6) {
    layoutIssues.push(`"${box.value}" leaves the canvas (${box.left.toFixed(0)}..${box.right.toFixed(0)} x ${box.top.toFixed(0)}..${box.bottom.toFixed(0)})`);
  }
  if (box.kind === "value" || box.kind === "repaired") {
    if (box.left < PANEL.left + 6 || box.right > PANEL.right - 6 || box.top < PANEL.top + 4 || box.bottom > PANEL.bottom - 4) {
      layoutIssues.push(`"${box.value}" leaves the plot panel`);
    }
  }
}
for (let i = 0; i < boxes.length; i += 1) {
  for (let j = i + 1; j < boxes.length; j += 1) {
    if (boxes[i].kind === "container" || boxes[j].kind === "container") continue;
    if (overlaps(boxes[i], boxes[j])) {
      layoutIssues.push(`"${boxes[i].value}" overlaps "${boxes[j].value}"`);
    }
  }
}
const widest = boxes.reduce((best, box) => Math.max(best, box.right - box.left), 0);
if (args.dryRun) {
  for (const box of [...boxes].sort((a, b) => a.top - b.top)) {
    console.log(
      `  ${box.kind.padEnd(9)} ${box.value.slice(0, 42).padEnd(44)} ${box.left.toFixed(0).padStart(5)}..${box.right.toFixed(0).padStart(5)} x ${box.top
        .toFixed(0)
        .padStart(5)}..${box.bottom.toFixed(0).padStart(5)}`,
    );
  }
}
console.log(`${boxes.length} measured labels, widest ${widest.toFixed(0)}px, canvas ${WIDTH}x${HEIGHT}`);
if (layoutIssues.length > 0) {
  for (const issue of layoutIssues) console.error(`layout: ${issue}`);
  throw new Error(`${layoutIssues.length} layout problem(s): the figure was not written`);
}
console.log("layout audit: every label is inside the panel and the canvas, and none overlap");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="FrontierHarness Eval v1.0 pass rate across ${runs.length} full runs, ${runs[0].date} to ${last.date}">\n${parts.join(
  "\n",
)}\n</svg>\n`;
if (args.dryRun) {
  console.log("dry run: the figure was not written");
  process.exit(0);
}
writeFileSync(resolve(args.out), svg);

const table = [
  `# FrontierHarness Eval v1.0 — pass rate across full runs`,
  ``,
  `Rendered by \`scripts/frontier-harness-leader-chart.mjs\` into \`${basename(args.out)}\` (+ \`.png\`), ${WIDTH}×${HEIGHT}, on ${today}.`,
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
  `Published leaderboard band: ${pct(publishedMin)} (${bottomHarnesses.map((entry) => entry.label).join(", ")}) to ${pct(publishedMax)} (${topHarness.label}); ${published.length} entries, ${priceLabel} pricing.`,
  ``,
  `A self-run is not comparable to the published leaderboard (different runtime, isolation and network policy). A repaired reading counts the declared re-measurements and is labelled as such; the strict column is the run's own verdicts.`,
  ``,
];
writeFileSync(`${resolve(args.out).replace(/\.svg$/u, "")}.md`, table.join("\n"));
console.log(`chart written to ${resolve(args.out)} (${runs.length} full runs, ${readingPoints.length} repaired reading(s))`);

// Optional raster: the SVG is the deliverable, and a PNG is produced on hosts
// that can rasterize one exactly. Every candidate is verified against the figure's
// own pixel size before it is accepted: a rasterizer that letterboxes or rescales
// the canvas (qlmanage does) is discarded rather than shipped. Absence is
// reported, never a failure.
const pngSize = (path) => {
  if (!existsSync(path)) return null;
  const header = readFileSync(path).subarray(0, 24);
  if (header.subarray(1, 4).toString("ascii") !== "PNG") return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
};
if (args.png) {
  const svgPath = resolve(args.out);
  const pngPath = svgPath.replace(/\.svg$/u, ".png");
  if (existsSync(pngPath)) unlinkSync(pngPath);
  const rasterizers = [
    ["sips", ["-s", "format", "png", svgPath, "--out", pngPath]],
    ["rsvg-convert", ["-w", String(WIDTH), "-o", pngPath, svgPath]],
    ["inkscape", [svgPath, "--export-type=png", `--export-filename=${pngPath}`, `--export-width=${WIDTH}`]],
    ["qlmanage", ["-t", "-s", String(WIDTH), "-o", dirname(svgPath), svgPath]],
  ];
  let produced = false;
  const rejected = [];
  for (const [command, argv] of rasterizers) {
    if (spawnSync(command, ["--version"], { encoding: "utf8" }).error) continue;
    spawnSync(command, argv, { encoding: "utf8" });
    if (command === "qlmanage") {
      const generated = `${svgPath}.png`;
      if (existsSync(generated)) renameSync(generated, pngPath);
    }
    const size = pngSize(pngPath);
    if (size && size.width === WIDTH && size.height === HEIGHT) {
      produced = true;
      console.log(`png written to ${pngPath} (${command}, ${size.width}x${size.height})`);
      break;
    }
    if (size) rejected.push(`${command} ${size.width}x${size.height}`);
    if (existsSync(pngPath)) unlinkSync(pngPath);
  }
  if (!produced) {
    console.log(
      `no rasterizer produced a ${WIDTH}x${HEIGHT} png on this host${
        rejected.length > 0 ? ` (rejected: ${rejected.join(", ")})` : ""
      }; the SVG is the deliverable`,
    );
  }
}

for (const run of runs) {
  const reading = readingPoints.find((point) => point.runId === run.runId);
  console.log(`  ${run.stamp} ${run.candidate} strict ${pct(run.passRate)}${reading ? ` | repaired ${pct(reading.value)}` : ""}`);
}
