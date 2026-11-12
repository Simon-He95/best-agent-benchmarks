// Summarize client-v1 results.csv: medians with interquartile ranges, plus same-run ratios.
// Usage: bun summarize.ts results.csv [--out-dir DIR]
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const input = process.argv[2];
if (input === undefined) throw new Error("usage: bun summarize.ts results.csv [--out-dir DIR]");
const args = parseArgs(process.argv.slice(3));
const outDir = path.resolve(args["out-dir"] ?? path.dirname(path.resolve(input)));
mkdirSync(outDir, { recursive: true });
const rows = parseCsv(readFileSync(input, "utf8"));
if (rows.length === 0) throw new Error("results.csv has no data rows");
const labels = [...new Set(rows.map((row) => row.label!))];
const turnsRequested = readTurns(path.dirname(path.resolve(input)));

const metrics = [
  "first_frame_ms",
  "first_paint_ms",
  "ready_ms",
  "tree_peak_rss_mb",
  "client_peak_rss_mb",
  "server_peak_rss_mb",
  "other_peak_rss_mb",
  "tree_hwm_sum_mb",
  "cpu_total_s",
  "cpu_client_s",
  "cpu_server_s",
  "cpu_turns_s",
  "cpu_client_turns_s",
  "cpu_server_turns_s",
  "turns_wall_s",
] as const;

type Stats = Readonly<{ median: number; q1: number; q3: number; min: number; max: number; n: number }>;
const summary: Record<string, Record<string, Stats | number | string>> = {};
for (const label of labels) {
  const own = rows.filter((row) => row.label === label);
  const stats: Record<string, Stats | number | string> = {
    runs: own.length,
    errorRuns: own.filter((row) => (row.error ?? "") !== "").length,
    turnsOkMedian: median(own.map((row) => Number(row.turns_ok)).filter(Number.isFinite)),
  };
  for (const metric of metrics) {
    const values = own
      .map((row) => Number(row[metric]))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (values.length > 0) stats[metric] = summarize(values);
  }
  summary[label] = stats;
}

const generatedAt = new Date().toISOString();
const report = {
  generatedAt,
  input: path.resolve(input),
  labels,
  turnsRequested,
  summary,
};
await Bun.write(path.join(outDir, "summary.json"), JSON.stringify(report, null, 2) + "\n");

const markdown = renderMarkdown(labels, summary, rows, turnsRequested, generatedAt);
await Bun.write(path.join(outDir, "summary.md"), markdown);
console.log(markdown);

function readTurns(directory: string): number {
  try {
    const meta = JSON.parse(readFileSync(path.join(directory, "meta.json"), "utf8")) as {
      options?: { turns?: number };
    };
    const turns = meta.options?.turns;
    return typeof turns === "number" && turns > 0 ? turns : 20;
  } catch {
    return 20;
  }
}

function renderMarkdown(
  labels: readonly string[],
  summary: Record<string, Record<string, Stats | number | string>>,
  rows: readonly Record<string, string>[],
  turns: number,
  generatedAt: string,
): string {
  const lines: string[] = [];
  lines.push("# Client performance — whole product, cold start");
  lines.push("");
  lines.push(
    `Generated ${generatedAt}. ${rows.length} runs, ${labels.length} labels, ${turns} scripted turns per run, interleaved by round. Values are medians with the interquartile range in brackets.`,
  );
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push(
    "| label | first frame | ready | tree peak RSS | client peak | server peak | CPU total | CPU over turns |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const label of labels) {
    const stats = summary[label]!;
    lines.push(
      `| \`${label}\` | ${cell(stats, "first_frame_ms", ms)} | ${cell(stats, "ready_ms", ms)} | ${cell(stats, "tree_peak_rss_mb", mb)} | ${cell(stats, "client_peak_rss_mb", mb)} | ${cell(stats, "server_peak_rss_mb", mb)} | ${cell(stats, "cpu_total_s", seconds)} | ${cell(stats, "cpu_turns_s", seconds)} |`,
    );
  }
  lines.push("");
  lines.push("## Client-only view");
  lines.push("");
  lines.push(
    "The table above is the whole launched product. This view keeps only the client process set (`client_peak_rss_mb` and `cpu_client_turns_s`), which is the scope OpenCode's published client-only chart uses. For `best-agent-ts` the client is the whole agent because its TUI and harness share one process.",
  );
  lines.push("");
  lines.push("| label | client peak RSS | client CPU over turns |");
  lines.push("| --- | ---: | ---: |");
  for (const label of labels) {
    const stats = summary[label]!;
    lines.push(
      `| \`${label}\` | ${cell(stats, "client_peak_rss_mb", mb)} | ${cell(stats, "cpu_client_turns_s", seconds)} |`,
    );
  }
  lines.push("");
  lines.push("## Same-run ratios");
  lines.push("");
  lines.push(
    "Each cell is this label divided by the named baseline; below 1.00 is lower (better). Ratios use the medians above and remain on the same runner, mock provider and turn script.",
  );
  lines.push("");
  const baselines = ["best-agent-ts", "opencode-ts"].filter((label) => labels.includes(label));
  for (const baseline of baselines) {
    const baselineStats = summary[baseline] as Record<string, Stats | number | string>;
    lines.push(`### Baseline \`${baseline}\``);
    lines.push("");
    lines.push("| label | first frame | tree peak RSS | CPU over turns |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const label of labels) {
      if (label === baseline) continue;
      const stats = summary[label] as Record<string, Stats | number | string>;
      lines.push(
        `| \`${label}\` | ${ratio(stats, baselineStats, "first_frame_ms")} | ${ratio(stats, baselineStats, "tree_peak_rss_mb")} | ${ratio(stats, baselineStats, "cpu_turns_s")} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Reading the numbers");
  lines.push("");
  lines.push(
    "- **Scope is the launched product.** `best-agent-ts` is one Node process that hosts the harness and TUI; `dim-rust` is the Rust client plus the Rust app-server it starts; `opencode-ts` and `opencode-native` each include the TypeScript server they start with `--standalone`.",
  );
  lines.push(
    "- **First frame and ready differ.** First frame is the first cell-producing PTY output; ready is the first prompt-idle screen after the target's own bootstrap. A target can paint before its server is ready, so compare ready when judging a usable launch.",
  );
  lines.push(
    "- **Memory is summed RSS, not unique memory.** Tree peak is the maximum of the summed RSS of every process carrying the run's `BENCH_RUN_ID`; the HWM column is a per-process cross-check. Shared pages are counted once per process and can make the sum higher than unique memory.",
  );
  lines.push(
    "- **CPU is process CPU.** It is utime+stime over the same process set, not wall time or billed model time. The mock provider is offline and the prompt script is identical for every label.",
  );
  lines.push(
    "- **These are runner-specific absolute numbers.** Use the same-run ratios for implementation comparisons; do not compare them to another machine's published values.",
  );
  lines.push("");
  return lines.join("\n");
}

function cell(
  stats: Record<string, Stats | number | string>,
  metric: string,
  format: (value: number) => string,
): string {
  const value = stats[metric];
  if (value === undefined || typeof value === "number" || typeof value === "string") return "—";
  return `${format(value.median)} [${format(value.q1)}–${format(value.q3)}]`;
}

function ratio(
  current: Record<string, Stats | number | string>,
  baseline: Record<string, Stats | number | string>,
  metric: string,
): string {
  const a = current[metric];
  const b = baseline[metric];
  if (a === undefined || b === undefined || typeof a !== "object" || typeof b !== "object")
    return "—";
  if (b.median === 0) return "—";
  return (a.median / b.median).toFixed(2) + "×";
}

function summarize(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: quantile(sorted, 0.5),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
    min: sorted[0]!,
    max: sorted.at(-1)!,
    n: sorted.length,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sorted[base + 1];
  if (next === undefined) return sorted[base]!;
  return sorted[base]! + rest * (next - sorted[base]!);
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0]!.split(",");
  return lines.slice(1).map((line) => {
    const fields = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((name, index) => {
      row[name] = fields[index] ?? "";
    });
    return row;
  });
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      result[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    result[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? next : "1";
    if (next !== undefined && !next.startsWith("--")) index += 1;
  }
  return result;
}

function ms(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function mb(value: number): string {
  return value.toFixed(1);
}

function seconds(value: number): string {
  return value.toFixed(2);
}
