#!/usr/bin/env node
/**
 * FrontierHarness Eval v1.0 — one final result against the published field, on the
 * published field's own axes: cost per pass (x, log) against pass rate (y).
 *
 * Input is the comparison dataset built by scripts/frontier-harness-comparison.mjs,
 * so the numbers on this page come from the same frozen pipeline as the repository's
 * other comparison figures. The page draws the published harnesses as context, this
 * repository's latest full run as one highlighted point, and adds the one sensitivity
 * the cost axis needs: the same tokens re-priced on the field's own frozen table.
 *
 * Usage:
 *   node scripts/frontier-harness-field-chart.mjs \
 *     --dataset docs/benchmarks/history/frontier-harness/leaderboard-comparison-deepseek-v4.1-flash-36915041446.json \
 *     --out docs/benchmarks/history/frontier-harness/leader-chart-final-vs-field.svg --png
 *
 * Every label is measured before it is placed (the stack is monospace, so a label is
 * `0.6em` per character). A label tries above, below and beside its marker and takes
 * the first slot that is free of other labels, of every marker, and of the panel
 * edges; a displaced label gets a dotted leader back to its point. A figure whose
 * labels would leave the panel, leave the canvas, cover a marker, or overlap another
 * label is not written. The PNG is accepted only from a rasterizer that reproduces
 * the figure's own pixel size.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = {};
for (let i = 0; i < process.argv.slice(2).length; i += 1) {
  const key = process.argv[2 + i];
  if (key === "--png" || key === "--dry-run") {
    args[key === "--png" ? "png" : "dryRun"] = true;
    continue;
  }
  if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
  args[key.slice(2)] = process.argv[3 + i];
  i += 1;
}
for (const required of ["dataset", "out"]) {
  if (!args[required]) throw new Error(`--${required} is required`);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const money = (value) => (value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`);
const today = new Date().toISOString().slice(0, 10);

// --- the two sides ------------------------------------------------------------
const dataset = readJson(resolve(args.dataset));
const ours = dataset.point;
const published = dataset.officialHarnesses ?? [];
if (published.length === 0) throw new Error("the dataset carries no published harnesses");
const repriced = ours.officialPriceRepricing?.costPerPass ?? null;
const runId = /(\d+)\.json$/u.exec(dataset.provenance?.primaryRecord ?? "")?.[1] ?? "";
const officialSource = dataset.provenance?.officialSource ?? {};
const officialPriceTable = dataset.provenance?.officialPriceTable ?? {};
const officialName = officialPriceTable.name ?? "the field's frozen table";
const withoutVerdict = (dataset.reading?.stillWithoutVerdict ?? []).length;
const failedCells = ours.cells - ours.passes - withoutVerdict;
const bestPublished = published.reduce((best, entry) => (entry.passRate > best.passRate ? entry : best), published[0]);
const cheapestPublished = published.reduce((best, entry) => (entry.costPerPass < best.costPerPass ? entry : best), published[0]);
const priciestPublished = published.reduce((worst, entry) => (entry.costPerPass > worst.costPerPass ? entry : worst), published[0]);
const weakestPublished = published.reduce((worst, entry) => (entry.passRate < worst.passRate ? entry : worst), published[0]);
const fieldCostAverage = published.reduce((sum, entry) => sum + entry.costPerPass, 0) / published.length;
const fieldRateAverage = published.reduce((sum, entry) => sum + entry.passRate, 0) / published.length;
const cheaperThanBest = bestPublished.costPerPass / ours.costPerPass;

// --- the view -----------------------------------------------------------------
// Both views are the published chart's own: pass rate against cost per pass, and
// pass rate against the median time of a successful task. The speed view is drawn
// on a linear axis, because that is how the published page draws it.
const VIEW = args.view ?? "cost";
if (VIEW !== "cost" && VIEW !== "speed") throw new Error(`unknown --view: ${VIEW}`);
const isCost = VIEW === "cost";
const seconds = (value) => `${Math.floor(Math.round(value) / 60)}m ${String(Math.round(value) % 60).padStart(2, "0")}s`;
const metricOf = (entry) => (isCost ? entry.costPerPass : entry.medianSuccessfulSeconds);
const formatMetric = (value) => (isCost ? money(value) : seconds(value));
const fastestPublished = published.reduce(
  (best, entry) => (entry.medianSuccessfulSeconds < best.medianSuccessfulSeconds ? entry : best),
  published[0],
);
const speedRatio = ours.medianSuccessfulSeconds / fastestPublished.medianSuccessfulSeconds;
const speedSlowestRatio = ours.medianSuccessfulSeconds / Math.max(...published.map((entry) => entry.medianSuccessfulSeconds));
const metricTitle = isCost ? "cost per pass (USD, log scale)" : "median time per successful task";
// The speed column is noisy across this repository's own runs, and the dataset holds
// only one of them. Rather than imply a stability the figure cannot show, the caller
// declares the spread it measured (`--speed-range low,high`), and the figure prints it.
const speedRange = typeof args["speed-range"] === "string" ? args["speed-range"].split(",").map(Number) : null;
if (speedRange !== null && (speedRange.length !== 2 || speedRange.some((value) => !Number.isFinite(value)))) {
  throw new Error("--speed-range takes two comma-separated seconds: low,high");
}

// --- design tokens (the same page as this history's other figures) -------------
const INK = {
  canvas: "#0a0a0c",
  panel: "#101014",
  grid: "#26262c",
  text: "#e8e8ea",
  muted: "#9a9aa2",
  faint: "#6a6a72",
  accent: "#ff6418",
};
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const ADVANCE = 0.6;

// --- geometry -----------------------------------------------------------------
// `field` is the record-shaped page. `share` is the same page cut to 16:9 with a
// larger headline and a lighter label load, so the same numbers can be posted on
// their own. Both layouts go through the same measurement and audit below.
const LAYOUT = args.layout ?? "field";
if (LAYOUT !== "field" && LAYOUT !== "share") throw new Error(`unknown --layout: ${LAYOUT}`);
const SHARE = LAYOUT === "share";
const WIDTH = SHARE ? 2400 : 2300;
const HEIGHT = SHARE ? 1350 : 1320;
const PANEL = SHARE ? { left: 210, right: 2250, top: 400, bottom: 1090 } : { left: 190, right: 2016, top: 300, bottom: 1060 };
const LOG_MIN = Math.log10(0.1);
const LOG_MAX = Math.log10(30);
const SPEED_VALUES = isCost ? [] : [...published.map((entry) => entry.medianSuccessfulSeconds), ours.medianSuccessfulSeconds];
// The speed axis is linear, so its rungs must be evenly spaced *and* read as round
// numbers: a 100-second grid would label itself 3m/5m/7m/8m and imply a curved axis.
// Two-minute rungs keep the spacing equal and the labels integral.
const SPEED_STEP = 120;
const X_MIN = isCost ? 0 : Math.max(0, Math.floor((Math.min(...SPEED_VALUES) - 60) / SPEED_STEP) * SPEED_STEP);
const X_MAX = isCost ? 0 : Math.ceil((Math.max(...SPEED_VALUES) + 60) / SPEED_STEP) * SPEED_STEP;
const xAt = isCost
  ? (cost) => PANEL.left + ((Math.log10(cost) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * (PANEL.right - PANEL.left)
  : (value) => PANEL.left + ((value - X_MIN) / (X_MAX - X_MIN)) * (PANEL.right - PANEL.left);
const X_TICKS = isCost
  ? [0.1, 0.2, 0.5, 1, 2, 5, 10, 20]
  : Array.from({ length: (X_MAX - X_MIN) / SPEED_STEP + 1 }, (_, index) => X_MIN + index * SPEED_STEP);
const xTickLabel = (tick) => (isCost ? `$${tick}` : `${Math.round(tick / 60)}m`);
const Y_MIN = 0.45;
const Y_MAX = 0.84;
const yAt = (rate) => PANEL.bottom - ((rate - Y_MIN) / (Y_MAX - Y_MIN)) * (PANEL.bottom - PANEL.top);
const SIZE = SHARE
  ? {
      title: 48,
      pill: 26,
      subtitle: 27,
      legend: 26,
      headline: 170,
      subhead: 34,
      delta: 28,
      tick: 24,
      axis: 25,
      name: 25,
      value: 23,
      ours: 34,
      oursValue: 28,
      note: 23,
      footnote: 24,
    }
  : {
      title: 46,
      pill: 26,
      subtitle: 26,
      legend: 25,
      headline: 100,
      subhead: 26,
      delta: 24,
      tick: 24,
      axis: 25,
      name: 25,
      value: 23,
      ours: 32,
      oursValue: 27,
      note: 22,
      footnote: 20,
    };

// --- measured text ------------------------------------------------------------
const parts = [];
const boxes = [];
const markers = [];
const escapeXml = (value) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const text = (x, y, value, { size = SIZE.name, fill = INK.text, weight = 400, anchor = "start", kind = "label", dy = undefined } = {}) => {
  const width = value.length * size * ADVANCE;
  const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  boxes.push({ value, kind, left, right: left + width, top: y - size * 0.74, bottom: y + size * 0.24 });
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}"${dy === undefined ? "" : ` dy="${dy}"`} font-family="${FONT}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
};
const rect = (x, y, w, h, { fill = "none", stroke = undefined, width = 1, radius = 0, opacity = undefined } = {}) =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"${radius ? ` rx="${radius}"` : ""} fill="${fill}"${
    stroke ? ` stroke="${stroke}" stroke-width="${width}"` : ""
  }${opacity === undefined ? "" : ` opacity="${opacity}"`}/>`;
const line = (x1, y1, x2, y2, { stroke = INK.grid, width = 1, dash = undefined, opacity = undefined } = {}) =>
  `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${width}"${
    dash ? ` stroke-dasharray="${dash}"` : ""
  }${opacity === undefined ? "" : ` opacity="${opacity}"`}/>`;

/** The published field's own marker vocabulary, as polygons around (cx, cy). */
const shapeAt = (shape, cx, cy, radius, { fill, stroke = INK.canvas, width = 2 }) => {
  const points = (list) => list.map(([x, y]) => `${(cx + x * radius).toFixed(1)},${(cy + y * radius).toFixed(1)}`).join(" ");
  const paint = `fill="${fill}" stroke="${stroke}" stroke-width="${width}"`;
  if (shape === "circle") return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" ${paint}/>`;
  if (shape === "square") return `<polygon points="${points([[-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85]])}" ${paint}/>`;
  if (shape === "triangle") return `<polygon points="${points([[0, -1], [0.92, 0.78], [-0.92, 0.78]])}" ${paint}/>`;
  if (shape === "diamond") return `<polygon points="${points([[0, -1.1], [1.1, 0], [0, 1.1], [-1.1, 0]])}" ${paint}/>`;
  if (shape === "hexagon") {
    return `<polygon points="${points(
      [...Array(6).keys()].map((i) => {
        const angle = Math.PI / 2 + (i * Math.PI) / 3;
        return [Math.cos(angle), Math.sin(angle)];
      }),
    )}" ${paint}/>`;
  }
  if (shape === "star") {
    return `<polygon points="${points(
      [...Array(10).keys()].map((i) => {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const scale = i % 2 === 0 ? 1 : 0.44;
        return [Math.cos(angle) * scale, Math.sin(angle) * scale];
      }),
    )}" ${paint} stroke-linejoin="round"/>`;
  }
  throw new Error(`unknown marker shape: ${shape}`);
};

// --- page ---------------------------------------------------------------------
parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="${INK.canvas}"/>`);
parts.push(rect(PANEL.left, PANEL.top, PANEL.right - PANEL.left, PANEL.bottom - PANEL.top, { fill: INK.panel, stroke: INK.grid, radius: 10 }));

// the pass-rate ruler
for (let tick = 0.45; tick <= Y_MAX + 1e-9; tick += 0.05) {
  const y = yAt(tick);
  parts.push(line(PANEL.left + 1, y, PANEL.right - 1, y, { stroke: INK.grid, width: 1.2, dash: "1 6" }));
  parts.push(text(PANEL.left - 18, y, `${Math.round(tick * 100)}%`, { size: SIZE.tick, fill: INK.muted, anchor: "end", kind: "tick", dy: 9 }));
}
// the x ruler: the published chart's own rungs (log dollars for cost, whole minutes for speed)
for (const tick of X_TICKS) {
  const x = xAt(tick);
  parts.push(line(x, PANEL.top + 1, x, PANEL.bottom - 1, { stroke: INK.grid, width: 1.1, dash: "1 6" }));
  parts.push(text(x, PANEL.bottom + 38, xTickLabel(tick), { size: SIZE.tick, fill: INK.muted, anchor: "middle", kind: "tick" }));
}
parts.push(
  `<text x="${(PANEL.left + PANEL.right) / 2}" y="${PANEL.bottom + 84}" font-family="${FONT}" font-size="${SIZE.axis}" fill="${INK.muted}" text-anchor="middle">${metricTitle}</text>`,
);
const xAxisTitle = metricTitle;
const xAxisHalf = (xAxisTitle.length * SIZE.axis * ADVANCE) / 2;
boxes.push({
  value: xAxisTitle,
  kind: "axis",
  left: (PANEL.left + PANEL.right) / 2 - xAxisHalf,
  right: (PANEL.left + PANEL.right) / 2 + xAxisHalf,
  top: PANEL.bottom + 84 - SIZE.axis * 0.74,
  bottom: PANEL.bottom + 84 + SIZE.axis * 0.24,
});
// The y title is rotated, so its box is the text's length laid on the other axis.
const yAxisX = PANEL.left - 104;
const yAxisY = (PANEL.top + PANEL.bottom) / 2;
parts.push(
  `<text x="${yAxisX}" y="${yAxisY}" transform="rotate(-90 ${yAxisX} ${yAxisY})" font-family="${FONT}" font-size="${SIZE.axis}" fill="${INK.muted}" text-anchor="middle">pass rate</text>`,
);
const yAxisHalf = (9 * SIZE.axis * ADVANCE) / 2;
boxes.push({
  value: "pass rate",
  kind: "axis",
  left: yAxisX - SIZE.axis * 0.74,
  right: yAxisX + SIZE.axis * 0.24,
  top: yAxisY - yAxisHalf,
  bottom: yAxisY + yAxisHalf,
});

// the best published pass rate, drawn as the line this run has to clear
const bestY = yAt(bestPublished.passRate);
parts.push(line(PANEL.left + 1, bestY, PANEL.right - 1, bestY, { stroke: INK.muted, width: 1.5, dash: "7 7", opacity: 0.5 }));
parts.push(text(PANEL.left + 20, bestY, `best published ${pct(bestPublished.passRate)} (${bestPublished.label})`, { size: SIZE.note, fill: INK.muted, kind: "guide", dy: -12 }));

// --- the published field ------------------------------------------------------
const ordered = [...published].sort((left, right) => metricOf(left) - metricOf(right));
// The published chart's orange staircase: from the cheapest (or fastest) toward the
// best pass rate, keeping every rung that improves it.
let bestSoFar = -Infinity;
const frontier = [];
for (const entry of ordered) {
  if (entry.passRate > bestSoFar) {
    frontier.push(entry);
    bestSoFar = entry.passRate;
  }
}
parts.push(
  `<path d="${frontier.map((entry, index) => `${index === 0 ? "M" : "L"}${xAt(metricOf(entry)).toFixed(1)},${yAt(entry.passRate).toFixed(1)}`).join(" ")}" fill="none" stroke="${INK.accent}" stroke-width="1.8" opacity="0.5" stroke-linejoin="round"/>`,
);

const MARKER_R = 13;
for (const entry of published) {
  const cx = xAt(metricOf(entry));
  const cy = yAt(entry.passRate);
  parts.push(shapeAt(entry.shape, cx, cy, MARKER_R, { fill: entry.color }));
  markers.push({ x: cx, y: cy, r: MARKER_R + 5, label: entry.label });
}

// this repository's one point, and (on the cost view) the same tokens on the
// field's own price table
const ourX = xAt(metricOf(ours));
const ourY = yAt(ours.passRate);
if (isCost && repriced !== null && Math.abs(Math.log10(repriced) - Math.log10(ours.costPerPass)) > 0.05) {
  const repricedX = xAt(repriced);
  parts.push(line(ourX, ourY, repricedX, ourY, { stroke: INK.accent, width: 1.6, dash: "4 5", opacity: 0.65 }));
  parts.push(shapeAt(ours.shape, repricedX, ourY, MARKER_R * 1.55, { fill: "none", stroke: INK.accent, width: 2.4 }));
  markers.push({ x: repricedX, y: ourY, r: MARKER_R * 1.55 + 6, label: "repriced" });
}
parts.push(`<circle cx="${ourX.toFixed(1)}" cy="${ourY.toFixed(1)}" r="${(MARKER_R * 2.7).toFixed(1)}" fill="none" stroke="${INK.accent}" stroke-width="2" opacity="0.15"/>`);
parts.push(`<circle cx="${ourX.toFixed(1)}" cy="${ourY.toFixed(1)}" r="${(MARKER_R * 1.75).toFixed(1)}" fill="none" stroke="${INK.accent}" stroke-width="2" opacity="0.38"/>`);
parts.push(shapeAt(ours.shape, ourX, ourY, MARKER_R * 1.95, { fill: INK.accent, stroke: "#ffffff", width: 2 }));
markers.push({ x: ourX, y: ourY, r: MARKER_R * 2.7 + 6, label: ours.label });

// --- label placement ----------------------------------------------------------
const SLACK_X = 4;
const SLACK_Y = 2;
const overlaps = (a, b) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > SLACK_X && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > SLACK_Y;
const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
const blockAt = (cx, cy, lines, offset) => {
  const measured = lines.map((item) => {
    const width = item.value.length * item.size * ADVANCE;
    const x = cx + offset.dx;
    const y = cy + offset.dy + (item.dy ?? 0);
    const left = item.anchor === "end" ? x - width : item.anchor === "start" ? x : x - width / 2;
    return { left, right: left + width, top: y - item.size * 0.74, bottom: y + item.size * 0.24 };
  });
  return {
    left: Math.min(...measured.map((box) => box.left)),
    right: Math.max(...measured.map((box) => box.right)),
    top: Math.min(...measured.map((box) => box.top)),
    bottom: Math.max(...measured.map((box) => box.bottom)),
  };
};
// Preferences: straight above, straight below, then the same rung shifted sideways,
// then further rungs. Every candidate is tested before it is used, so the order only
// decides which free slot wins.
const CANDIDATES = [];
for (const dy of [-32, 48, -82, 98, -132, 148, -182, 198, 0, -232, 248]) CANDIDATES.push({ dx: 0, dy });
for (const dx of [80, -80, 170, -170, 260, -260, 360, -360]) {
  for (const dy of [-32, 48, -82, 98, -132, 148, 0, -182, 198, -232, 248]) CANDIDATES.push({ dx, dy });
}
const obstructs = (box) => {
  if (box.left < PANEL.left + 8 || box.right > PANEL.right - 8) return true;
  if (box.top < PANEL.top + 8 || box.bottom > PANEL.bottom - 8) return true;
  if (boxes.some((other) => overlaps(box, other))) return true;
  return markers.some((marker) =>
    overlaps(box, { left: marker.x - marker.r, right: marker.x + marker.r, top: marker.y - marker.r, bottom: marker.y + marker.r }),
  );
};
const penalty = (box) => {
  let score = 0;
  if (box.left < PANEL.left + 8) score += (PANEL.left + 8 - box.left) * 400;
  if (box.right > PANEL.right - 8) score += (box.right - (PANEL.right - 8)) * 400;
  if (box.top < PANEL.top + 8) score += (PANEL.top + 8 - box.top) * 400;
  if (box.bottom > PANEL.bottom - 8) score += (box.bottom - (PANEL.bottom - 8)) * 400;
  for (const other of boxes) score += overlapArea(box, other);
  for (const marker of markers) {
    score += overlapArea(box, { left: marker.x - marker.r, right: marker.x + marker.r, top: marker.y - marker.r, bottom: marker.y + marker.r });
  }
  return score;
};
const place = (cx, cy, lines) => {
  let chosen = null;
  for (const offset of CANDIDATES) {
    const box = blockAt(cx, cy, lines, offset);
    if (!obstructs(box)) {
      chosen = { offset, box };
      break;
    }
  }
  if (chosen === null) {
    // No free slot: take the cheapest obstruction and let the audit report it, so a
    // genuinely over-constrained page fails loudly instead of shipping a collision.
    chosen = CANDIDATES.map((offset) => ({ offset, box: blockAt(cx, cy, lines, offset) })).reduce((best, candidate) =>
      penalty(candidate.box) < penalty(best.box) ? candidate : best,
    );
  }
  const out = [];
  const displaced = Math.abs(chosen.offset.dy) > 44 || Math.abs(chosen.offset.dx) > 44;
  if (displaced) {
    const endX = Math.min(Math.max(cx, chosen.box.left), chosen.box.right);
    const endY = Math.min(Math.max(cy, chosen.box.top), chosen.box.bottom);
    const distance = Math.hypot(endX - cx, endY - cy);
    if (distance > 1) {
      const startDistance = MARKER_R * 2.9 + 8;
      const ratio = Math.min(1, startDistance / distance);
      out.push(
        line(cx + (endX - cx) * ratio, cy + (endY - cy) * ratio, endX, endY, { stroke: INK.text, width: 1.1, dash: "3 5", opacity: 0.34 }),
      );
    }
  }
  for (const item of lines) {
    out.push(
      text(cx + chosen.offset.dx, cy + chosen.offset.dy + (item.dy ?? 0), item.value, {
        size: item.size,
        fill: item.fill,
        weight: item.weight ?? 400,
        anchor: item.anchor ?? "middle",
        kind: item.kind ?? "data",
      }),
    );
  }
  return out.join("\n");
};

// the headline point first: it owns the best free slot
parts.push(
  place(ourX, ourY, [
    { value: `${ours.label} — ${pct(ours.passRate)}`, size: SIZE.ours, fill: INK.accent, weight: 700 },
    {
      value: `${ours.passes}/${ours.cells} passed · ${formatMetric(metricOf(ours))} per task`,
      size: SIZE.oursValue,
      fill: INK.text,
      dy: 34,
    },
  ]),
);
// The share card names the field's corners only — best, cheapest, priciest, weakest —
// so the eye lands on this run; the record-shaped page names every entry.
const labelled = SHARE
  ? published.filter(
      (entry) =>
        entry.passRate === bestPublished.passRate ||
        entry.costPerPass === cheapestPublished.costPerPass ||
        entry.costPerPass === priciestPublished.costPerPass ||
        entry.passRate === weakestPublished.passRate,
    )
  : ordered;
for (const entry of labelled) {
  parts.push(
    place(xAt(metricOf(entry)), yAt(entry.passRate), [
      { value: entry.label, size: SIZE.name, fill: INK.text },
      { value: `${pct(entry.passRate)} · ${formatMetric(metricOf(entry))}`, size: SIZE.value, fill: entry.color, dy: 27 },
    ]),
  );
}
if (isCost && repriced !== null) {
  parts.push(
    place(xAt(repriced), ourY, [
      { value: "same tokens on the field's price table", size: SIZE.value, fill: INK.accent },
      { value: `${money(repriced)} per pass`, size: SIZE.value, fill: INK.accent, dy: 27 },
    ]),
  );
}

// --- header, headline, footnotes ----------------------------------------------
const HEAD = SHARE
  ? { markX: 110, markY: 96, mark: 36, titleX: 166, titleY: 126, subtitleY: 186, legendY: 250, legendX: 162, noteX: 800, bigY: 180, subY: 250, deltaY: 296 }
  : { markX: 88, markY: 52, mark: 30, titleX: 136, titleY: 92, subtitleY: 148, legendY: 200, legendX: 140, noteX: 814, bigY: 166, subY: 216, deltaY: 252 };
parts.push(rect(HEAD.markX, HEAD.markY, HEAD.mark, HEAD.mark, { fill: INK.accent }));
parts.push(text(HEAD.titleX, HEAD.titleY, "FrontierHarness Eval", { size: SIZE.title, fill: INK.accent, weight: 700, kind: "header" }));
const titleWidth = 19 * SIZE.title * ADVANCE;
const pill = { x: HEAD.titleX + titleWidth + 28, y: HEAD.titleY - 38, width: 4 * SIZE.pill * ADVANCE + 40, height: 40 };
parts.push(rect(pill.x, pill.y, pill.width, pill.height, { fill: "none", stroke: INK.grid, radius: 8 }));
parts.push(
  text(pill.x + pill.width / 2, HEAD.titleY - 10, "v1.0", { size: SIZE.pill, fill: INK.text, anchor: "middle", kind: "header" }),
);
parts.push(
  text(
    HEAD.markX,
    HEAD.subtitleY,
    `pass rate against ${isCost ? "cost per pass" : "time per successful task"} · ${ours.cells} tasks · one predeclared attempt per cell`,
    {
    size: SIZE.subtitle,
    fill: INK.muted,
    kind: "header",
    },
  ),
);
parts.push(shapeAt("star", HEAD.markX + 20, HEAD.legendY, 14, { fill: INK.accent, stroke: INK.canvas, width: 2 }));
parts.push(text(HEAD.legendX, HEAD.legendY + 10, "best-agent — this repository's self-run", { size: SIZE.legend, fill: INK.text, kind: "header" }));
parts.push(
  text(
    HEAD.noteX,
    HEAD.legendY + 10,
    SHARE
      ? isCost
        ? `vs ${published.length} published harnesses (${money(cheapestPublished.costPerPass)}–${money(priciestPublished.costPerPass)} per pass)`
        : `vs ${published.length} published harnesses (${seconds(Math.min(...published.map((entry) => entry.medianSuccessfulSeconds)))}–${seconds(
            Math.max(...published.map((entry) => entry.medianSuccessfulSeconds)),
          )} per task)`
      : "published field staircase",
    { size: SIZE.legend, fill: INK.muted, kind: "header" },
  ),
);
if (!SHARE) {
  parts.push(line(760, HEAD.legendY, 800, HEAD.legendY, { stroke: INK.accent, width: 1.8, opacity: 0.6 }));
  parts.push(shapeAt(published[0].shape, 1220, HEAD.legendY, 11, { fill: INK.muted }));
  parts.push(text(1244, HEAD.legendY + 10, `${published.length} published harnesses`, { size: SIZE.legend, fill: INK.muted, kind: "header" }));
}

parts.push(text(PANEL.right, HEAD.bigY, pct(ours.passRate), { size: SIZE.headline, fill: INK.accent, weight: 700, anchor: "end", kind: "headline" }));
parts.push(text(PANEL.right, HEAD.subY, `${ours.passes} of ${ours.cells} tasks passed`, { size: SIZE.subhead, fill: INK.text, anchor: "end", kind: "headline" }));
parts.push(
  text(
    PANEL.right,
    HEAD.deltaY,
    isCost
      ? `${money(ours.costPerPass)} per pass — ${cheaperThanBest.toFixed(0)}× below ${bestPublished.label} (${money(bestPublished.costPerPass)})`
      : speedRatio < 1
        ? `${seconds(ours.medianSuccessfulSeconds)} per task — faster than all ${published.length} published entries (fastest ${fastestPublished.label} ${seconds(
            fastestPublished.medianSuccessfulSeconds,
          )})`
        : `${seconds(ours.medianSuccessfulSeconds)} per task — slowest of ${published.length + 1}: ${fastestPublished.label} is ${speedRatio.toFixed(
            2,
          )}× quicker`,
    { size: SIZE.delta, fill: INK.muted, anchor: "end", kind: "headline" },
  ),
);
parts.push(
  text(PANEL.right, HEAD.deltaY + (SHARE ? 34 : 30), ours.sublabel ?? "", { size: SIZE.delta - 4, fill: INK.faint, anchor: "end", kind: "headline" }),
);

const fieldSpread = `${seconds(Math.min(...published.map((entry) => entry.medianSuccessfulSeconds)))}–${seconds(
  Math.max(...published.map((entry) => entry.medianSuccessfulSeconds)),
)}`;
const footerLines = (
  SHARE
    ? isCost
      ? [
          {
            text: `${money(ours.costPerPass)} per pass — ${cheaperThanBest.toFixed(0)}× below the best published entry, ${(fieldCostAverage / ours.costPerPass).toFixed(0)}× below the field average`,
            fill: INK.accent,
            size: 30,
          },
          {
            text: `Self-run, not leaderboard-comparable: different model (${ours.sublabel ?? "this repository's provider"} vs ${officialSource.modelLabel ?? "the published model"}), different runtime; costs are frozen price tables, not bills.`,
            fill: INK.faint,
            size: 22,
          },
        ]
      : [
          {
            text:
              speedRatio < 1
                ? `${seconds(ours.medianSuccessfulSeconds)} per successful task — faster than all ${published.length} published entries (field ${fieldSpread})`
                : `${seconds(ours.medianSuccessfulSeconds)} per successful task — slower than all ${published.length} published entries (field ${fieldSpread})`,
            fill: INK.accent,
            size: 30,
          },
          speedRange === null
            ? null
            : {
                text: `Speed is this page's noisiest column: this repository's own full runs span ${seconds(speedRange[0])}–${seconds(
                  speedRange[1],
                )}, a wider spread than the whole published field's.`,
                fill: INK.muted,
                size: 22,
              },
          {
            text: `Self-run, not leaderboard-comparable: different model (${ours.sublabel ?? "this repository's provider"} vs ${officialSource.modelLabel ?? "the published model"}) and runtime (GitHub-hosted runner vs Runta golden checkpoints).`,
            fill: INK.faint,
            size: 22,
          },
        ]
    : [
        {
          text: `A self-run is not comparable to the published leaderboard: this is best-agent on GitHub-hosted runners, the field is ${officialSource.modelLabel ?? "one model"} on Runta checkpoints.`,
          fill: INK.faint,
          size: SIZE.footnote,
        },
        {
          text: isCost
            ? `Cost is a frozen price table, not a bill: this run on the adopted DeepSeek public list (off-peak), the field on ${officialName}; the hollow star re-prices this run's tokens.`
            : `Time is the trial's own wall clock (environment build, agent and verifier), the field's own definition; the field spans ${fieldSpread} per successful task.`,
          fill: INK.faint,
          size: SIZE.footnote,
        },
        {
          text: isCost
            ? `run ${runId}: ${ours.passes} passed / ${failedCells} failed / ${withoutVerdict} without verdict · cost coverage ${Math.round(
                (ours.costCoverage ?? 0) * 100,
              )}% of ${ours.cells} cells · field average ${pct(fieldRateAverage)} at ${money(fieldCostAverage)} per pass.`
            : `run ${runId}: ${ours.passes} passed / ${failedCells} failed / ${withoutVerdict} without verdict${
                speedRange === null ? "" : ` · this repository's own full runs span ${seconds(speedRange[0])}–${seconds(speedRange[1])}`
              }.`,
          fill: INK.faint,
          size: SIZE.footnote,
        },
      ]
).filter((item) => item !== null);
const footerStart = HEIGHT - 44 - (footerLines.length - 1) * 28 - (SHARE ? 12 : 0);
footerLines.forEach((item, index) => {
  parts.push(text(HEAD.markX, footerStart + index * 28, item.text, { size: item.size, fill: item.fill, kind: "footer" }));
});

// --- the figure is only written if it lays out cleanly -------------------------
const layoutIssues = [];
for (const box of boxes) {
  if (box.left < 6 || box.right > WIDTH - 6 || box.top < 6 || box.bottom > HEIGHT - 6) layoutIssues.push(`"${box.value}" leaves the canvas`);
  if ((box.kind === "data" || box.kind === "guide") && (box.left < PANEL.left + 2 || box.right > PANEL.right - 2)) {
    layoutIssues.push(`"${box.value}" leaves the plot panel`);
  }
}
for (let i = 0; i < boxes.length; i += 1) {
  for (let j = i + 1; j < boxes.length; j += 1) {
    if (overlaps(boxes[i], boxes[j])) layoutIssues.push(`"${boxes[i].value}" overlaps "${boxes[j].value}"`);
  }
}
console.log(`${boxes.length} measured labels, ${published.length + 1} data points, canvas ${WIDTH}x${HEIGHT}`);
if (args.dryRun) {
  for (const box of [...boxes].sort((a, b) => a.top - b.top)) {
    console.log(
      `  ${box.kind.padEnd(7)} ${box.value.slice(0, 44).padEnd(46)} ${box.left.toFixed(0).padStart(5)}..${box.right.toFixed(0).padStart(5)} x ${box.top
        .toFixed(0)
        .padStart(5)}..${box.bottom.toFixed(0).padStart(5)}`,
    );
  }
}
if (layoutIssues.length > 0) {
  for (const issue of layoutIssues) console.error(`layout: ${issue}`);
  throw new Error(`${layoutIssues.length} layout problem(s): the figure was not written`);
}
console.log("layout audit: every label is inside the panel and the canvas, clear of every marker, and none overlap");
if (args.dryRun) {
  console.log("dry run: the figure was not written");
  process.exit(0);
}

const svgTitle = isCost
  ? `best-agent ${pct(ours.passRate)} at ${money(ours.costPerPass)} per pass, against the published FrontierHarness Eval v1.0 field`
  : `best-agent ${pct(ours.passRate)} at ${seconds(ours.medianSuccessfulSeconds)} per successful task, against the published FrontierHarness Eval v1.0 field`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="FrontierHarness Eval v1.0: ${svgTitle}"><title>${svgTitle}</title>\n${parts.join(
  "\n",
)}\n</svg>\n`;
writeFileSync(resolve(args.out), svg);

const table = [
  `# FrontierHarness Eval v1.0 — best-agent's final result, pass rate against ${isCost ? "cost per pass" : "time per successful task"}`,
  ``,
  `Rendered by \`scripts/frontier-harness-field-chart.mjs\` into \`${basename(args.out)}\` (+ \`.png\`), ${WIDTH}×${HEIGHT}, on ${today}. Data: \`${basename(args.dataset)}\`, built by \`scripts/frontier-harness-comparison.mjs\` from the frozen record of run ${runId} and the published snapshot.`,
  ``,
  `| harness | pass rate | cost per pass | median time per successful task | source |`,
  `| --- | --- | --- | --- | --- |`,
  `| **${ours.label}** (this repository's self-run) | **${pct(ours.passRate)}** (${ours.passes}/${ours.cells}) | **${money(ours.costPerPass)}** | **${seconds(ours.medianSuccessfulSeconds)}** | run ${runId}, ${ours.sublabel ?? ""} |`,
  ...published
    .slice()
    .sort((left, right) => metricOf(left) - metricOf(right))
    .map(
      (entry) =>
        `| ${entry.label} | ${pct(entry.passRate)} (${entry.successful}/30) | ${money(entry.costPerPass)} | ${Math.round(
          entry.medianSuccessfulSeconds,
        )}s | published leaderboard, ${entry.version} |`,
    ),
  ``,
  `Field average: ${pct(fieldRateAverage)} at ${money(fieldCostAverage)} per pass. Best published entry: ${bestPublished.label} ${pct(bestPublished.passRate)} at ${money(
    bestPublished.costPerPass,
  )}. Cheapest published entry: ${cheapestPublished.label} at ${money(cheapestPublished.costPerPass)}. This run is ${cheaperThanBest.toFixed(
    1,
  )}× below the best published entry's cost per pass.`,
  ``,
  `Same tokens, the field's own price table (${officialName}): ${repriced === null ? "not available" : `${money(repriced)} per pass`} — a re-pricing, not a bill; it separates token volume from unit price.`,
  ``,
  `## Speed, read the same way the published page reads it`,
  ``,
  `The speed column is \`median_duration_seconds\`: median wall-clock seconds per **successful** cell — the value behind the published "speed" view. This run reads **${seconds(
    ours.medianSuccessfulSeconds,
  )}**; the published field spans ${fieldSpread} (fastest ${fastestPublished.label} ${seconds(
    fastestPublished.medianSuccessfulSeconds,
  )}, slowest ${seconds(Math.max(...published.map((entry) => entry.medianSuccessfulSeconds)))}${
    published.filter((entry) => entry.medianSuccessfulSeconds === Math.max(...published.map((other) => other.medianSuccessfulSeconds)))[0]?.label ?? ""
  }). This run is therefore ${
    speedRatio < 1
      ? `**faster than every published entry on this metric** (${speedRatio.toFixed(2)}× the fastest entry)`
      : `${speedRatio.toFixed(2)}× the fastest entry and ${speedSlowestRatio.toFixed(2)}× the slowest: **slower than every published entry on this metric**.`
  }`,
  ``,
  speedRange === null
    ? `The speed spread across this repository's own full runs was not declared to this invocation (\`--speed-range\`), so it is not quoted here.`
    : `Before that is read as a result, the same metric across this repository's own nine full runs spans ${seconds(speedRange[0])}–${seconds(
        speedRange[1],
      )} — a **wider spread than the published field's**, on the same corpus and mostly the same candidate. The honest reading is that one run's speed here cannot separate this composition from the field; the per-cell breakdown in the record (not this table) is where a cause would have to be established.`,
  ``,
  `## The boundary this comparison travels with`,
  ``,
  `1. **Different model.** The published field ran one model only (${officialSource.modelLabel ?? "one model"}, ${
    officialSource.modelServing ?? "one gateway"
  }); this run is ${ours.sublabel ?? "this repository's own provider"}. The page places this run *next to* the published rows; it is not a harness-versus-harness comparison.`,
  `2. **Different runtime.** The field runs on Runta golden checkpoints (fresh restore, identical vCPU/memory/disk); this run is a diagnostic self-run on GitHub-hosted runners. Repository rule: a self-run is not comparable to the published leaderboard, and the figure says so on its face.`,
  `3. **Cost is a price table, not a bill.** The published rows are priced on ${officialName}; this run on the adopted DeepSeek public list (off-peak), because the repository ships no frozen table for its provider and its records carry \`costUsd: null\` by design. The low cost is mostly unit price; the hollow star shows what the same tokens would cost on the field's table.`,
  `4. **Nothing was re-measured for this figure.** The number is the frozen run's own single predeclared attempt per cell: ${ours.passes} passed, ${failedCells} failed, ${withoutVerdict} without a verdict. No cell was refilled from a recovery batch, and no repaired reading is mixed in.`,
  `5. **Cost coverage.** ${Math.round((ours.costCoverage ?? 0) * 100)}% of the ${ours.cells} cells carry a recorded usage block; a cell without one would contribute nothing to the sum rather than an estimate.`,
  ``,
];
writeFileSync(`${resolve(args.out).replace(/\.svg$/u, "")}.md`, table.join("\n"));
console.log(`chart written to ${resolve(args.out)} (${published.length + 1} points, best published ${pct(bestPublished.passRate)})`);

// The PNG is accepted only if the rasterizer reproduces the figure's own pixel size.
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
      `no rasterizer produced a ${WIDTH}x${HEIGHT} png on this host${rejected.length > 0 ? ` (rejected: ${rejected.join(", ")})` : ""}; the SVG is the deliverable`,
    );
  }
}
