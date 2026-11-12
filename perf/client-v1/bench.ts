// Whole-product TUI benchmark for best-agent and Dim, with OpenCode as a same-run reference.
//
// This measures the product the user launches, not only its client process:
//   - first_frame / first_paint: exec -> first cell-producing PTY output / first painted xterm cell
//   - ready: prompt is drawn and idle, every target's own ready marker is on screen
//   - memory: peak summed RSS over every process carrying this run's BENCH_RUN_ID
//   - CPU: utime+stime of the same process set over 20 scripted turns
//
// Linux only: process sampling reads /proc. Each run gets a fresh HOME, XDG tree, project
// directory and mock provider. Targets are interleaved by round; odd rounds reverse the order.
//
// Usage:
//   BENCH_NODE=$(command -v node) \
//   BENCH_BEST_AGENT=/path/to/apps/cli/dist/index.js \
//   BENCH_DIM=/path/to/dimcode \
//   BENCH_OPENCODE_TS=/path/to/opencode \
//   BENCH_OPENCODE_NATIVE=/path/to/opencode-native \
//   bun bench.ts --matrix matrix.json --rounds 8 --turns 20 --out results.csv
import { Terminal as Xterm } from "@xterm/headless";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

type Role = "client" | "server" | "other";
type ProviderKind = "opencode" | "best-agent" | "dim";

type Target = Readonly<{
  label: string;
  provider: ProviderKind;
  client: readonly string[];
  env?: Readonly<Record<string, string>>;
  ready?: string;
  busy?: string;
}>;

type Options = Readonly<{
  matrix: string;
  rounds: number;
  turns: number;
  sampleMs: number;
  turnTimeoutMs: number;
  work: string;
  sandboxRoot: string;
  out: string;
  only?: readonly string[];
  keepBoxes: boolean;
  firstRound: number;
}>;

type Stats = {
  requests: number;
  chat: number;
  streamChat: number;
  inflight: number;
  completed: number;
  cancelled: number;
  paths: Record<string, number>;
};

type Proc = {
  role: Role;
  peakKb: number;
  hwmKb: number;
  cpuSeconds: number;
  lastRssKb: number;
  startTime: number;
};

const args = parseArgs(process.argv.slice(2));
const options: Options = {
  matrix: args.matrix ?? "",
  rounds: intArg(args.rounds, 8),
  turns: intArg(args.turns, 20),
  sampleMs: intArg(args["sample-ms"], 20),
  turnTimeoutMs: intArg(args["turn-timeout"], 60_000),
  work: path.resolve(args.work ?? "perf-runs"),
  sandboxRoot: path.resolve(args["sandbox-root"] ?? "/tmp/best-agent-client-perf"),
  out: path.resolve(args.out ?? path.join(args.work ?? "perf-runs", "results.csv")),
  only: args.only === undefined ? undefined : args.only.split(","),
  keepBoxes: args["keep-boxes"] === "1",
  firstRound: intArg(args["first-round"], 1),
};
if (options.matrix === "") throw new Error("--matrix is required");
if (options.rounds < 1 || options.turns < 1) throw new Error("--rounds and --turns must be positive");
if (process.platform !== "linux")
  throw new Error("This benchmark samples /proc and requires Linux; run it on the CI runner.");

const matrix = JSON.parse(readFileSync(options.matrix, "utf8")) as Target[];
validateMatrix(matrix);
const targets =
  options.only === undefined
    ? matrix
    : matrix.filter((target) => options.only!.includes(target.label));
if (targets.length === 0) throw new Error("No targets selected");

const columns = [
  "label",
  "round",
  "started_at",
  "source_sha",
  "dim_sha",
  "load1_before",
  "load5_before",
  "load1_after",
  "first_frame_ms",
  "first_paint_ms",
  "ready_ms",
  "turns_ok",
  "turns_wall_s",
  "tree_peak_rss_mb",
  "client_peak_rss_mb",
  "server_peak_rss_mb",
  "other_peak_rss_mb",
  "tree_hwm_sum_mb",
  "client_hwm_mb",
  "server_hwm_mb",
  "cpu_total_s",
  "cpu_client_s",
  "cpu_server_s",
  "cpu_other_s",
  "cpu_startup_s",
  "cpu_turns_s",
  "cpu_client_startup_s",
  "cpu_server_startup_s",
  "cpu_client_turns_s",
  "cpu_server_turns_s",
  "rss_at_ready_mb",
  "procs_seen",
  "mock_requests",
  "mock_chat_requests",
  "mock_stream_requests",
  "error",
] as const;

const clkTck = commandInt(["getconf", "CLK_TCK"]) ?? 100;
const pageKb = (commandInt(["getconf", "PAGESIZE"]) ?? 4096) / 1024;
const subst: Record<string, string> = {
  node: envPath("BENCH_NODE", process.execPath),
  bestAgent: envPath("BENCH_BEST_AGENT"),
  dim: envPath("BENCH_DIM"),
  opencodeTs: envPath("BENCH_OPENCODE_TS"),
  opencodeNative: envPath("BENCH_OPENCODE_NATIVE"),
};
const sourceSha = process.env.BENCH_SOURCE_SHA ?? "";
const dimSha = process.env.BENCH_DIM_SHA ?? "";

mkdirSync(options.work, { recursive: true });
mkdirSync(options.sandboxRoot, { recursive: true, mode: 0o700 });
mkdirSync(path.dirname(options.out), { recursive: true });
if (!existsSync(options.out) || readFileSync(options.out, "utf8").trim() === "")
  appendFileSync(options.out, columns.join(",") + "\n");
mkdirSync(path.join(options.work, "screens"), { recursive: true });
mkdirSync(path.join(options.work, "failures"), { recursive: true });

const meta = {
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  clkTck,
  pageKb,
  cpuModel: firstLine("/proc/cpuinfo", /^model name\s*:\s*(.+)$/u),
  logicalCpus: commandInt(["nproc"]) ?? 0,
  matrix,
  options,
};
await Bun.write(path.join(options.work, "meta.json"), JSON.stringify(meta, null, 2) + "\n");

let failedRuns = 0;
for (let round = options.firstRound; round < options.firstRound + options.rounds; round += 1) {
  const order = round % 2 === 0 ? [...targets].reverse() : targets;
  for (const target of order) {
    const row = await runOnce(target, round);
    if (row.error) failedRuns += 1;
    appendFileSync(options.out, columns.map((column) => csv(row[column])).join(",") + "\n");
    console.log(
      `[${target.label} #${round}] frame=${fmt(row.first_frame_ms)} paint=${fmt(row.first_paint_ms)} ` +
        `ready=${fmt(row.ready_ms)} peak=${fmt(row.tree_peak_rss_mb)}MB ` +
        `(client ${fmt(row.client_peak_rss_mb)}, server ${fmt(row.server_peak_rss_mb)}) ` +
        `cpu=${fmt(row.cpu_total_s, 2)}s (turns ${fmt(row.cpu_turns_s, 2)}s) ` +
        `turns=${fmt(row.turns_ok)}/${options.turns} load=${fmt(row.load1_before)}` +
        (row.error ? ` ERROR ${row.error}` : ""),
    );
    await Bun.sleep(1_000);
  }
}
if (failedRuns > 0) {
  console.error(`${failedRuns} benchmark run(s) failed; see results.csv and results/failures/.`);
  process.exitCode = 1;
}

async function runOnce(target: Target, round: number): Promise<Record<string, string | number>> {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const runId = `${target.label}-${round}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  const box = mkdtempSync(path.join(options.sandboxRoot, `${target.label}-${round}-`));
  mkdirSync(path.join(box, "project"), { recursive: true });
  mkdirSync(path.join(box, "home"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(box, "run"), { recursive: true, mode: 0o700 });
  const home = path.join(box, "home");
  const project = path.join(box, "project");
  const mock = startMock();
  const tree = new Tree(runId, box);
  const row: Record<string, string | number> = {
    label: target.label,
    round,
    started_at: new Date().toISOString(),
    source_sha: sourceSha,
    dim_sha: dimSha,
  };
  let clientProc: ReturnType<typeof Bun.spawn> | undefined;
  let pty: Bun.Terminal | undefined;
  let xterm: Xterm | undefined;
  let sampler: ReturnType<typeof setInterval> | undefined;
  let discovery: ReturnType<typeof setInterval> | undefined;
  try {
    const env = sandboxEnv(target, { box, home, project, mockURL: mock.url, runId });
    const client = target.client.map((value) => resolveTemplate(value, { home, project }));
    if (client.length === 0) throw new Error("client command is empty");
    const ready = (target.ready ?? "").split("&&").map((source) => new RegExp(source));
    const busy = new RegExp(target.busy ?? "[Ee]sc interrupt");
    const lastOutput = { at: 0 };
    const firstFrame = { ms: undefined as number | undefined };
    const firstPaint = { ms: undefined as number | undefined };
    const raw = { text: "" };
    const decoder = new TextDecoder();
    let firstFrameDone = false;
    const t0 = performance.now();

    xterm = new Xterm({ cols: 120, rows: 40, allowProposedApi: true });
    const terminal = new Bun.Terminal({
      cols: 120,
      rows: 40,
      data(_terminal, data) {
        const at = performance.now();
        lastOutput.at = at;
        const text = decoder.decode(data, { stream: true });
        answerColorQueries(text, (reply) => terminal.write(reply));
        if (!firstFrameDone) {
          raw.text += text;
          if (printsCells(raw.text)) {
            firstFrameDone = true;
            firstFrame.ms = at - t0;
          }
        }
        xterm!.write(data, () => {
          if (firstPaint.ms === undefined && painted(xterm!, 120, 40)) firstPaint.ms = at - t0;
        });
      },
    });
    pty = terminal;
    xterm.onData((reply) => terminal.write(reply));

    const [load1, load5] = loadavg();
    row.load1_before = load1;
    row.load5_before = load5;
    clientProc = Bun.spawn(client, {
      cwd: project,
      env,
      terminal,
    });
    tree.addRoot(clientProc.pid, "client");
    discovery = setInterval(() => tree.discover(), 250);
    sampler = setInterval(() => tree.sample(), options.sampleMs);
    tree.discover();
    const screen = () => screenText(xterm!, 40);
    const idle = () => {
      const text = screen();
      return ready.every((re) => re.test(text)) && !busy.test(text);
    };
    await waitFor(() => idle(), 60_000, "ready");
    row.ready_ms = round1(performance.now() - t0);
    row.first_frame_ms = firstFrame.ms === undefined ? -1 : round1(firstFrame.ms);
    row.first_paint_ms = firstPaint.ms === undefined ? -1 : round1(firstPaint.ms);
    tree.discover();
    tree.sample();
    row.rss_at_ready_mb = mb(tree.currentRssKb());
    const atReady = tree.cpu();

    const turnsStart = performance.now();
    let ok = 0;
    for (let index = 1; index <= options.turns; index += 1) {
      const before = snapshot(mock.stats);
      terminal.write(`turn ${index}: reply with the usual text`);
      await Bun.sleep(30);
      terminal.write("\r");
      await waitFor(
        () =>
          mock.stats.completed > before.completed &&
          mock.stats.inflight === 0 &&
          idle() &&
          performance.now() - lastOutput.at > 150,
        options.turnTimeoutMs,
        `turn ${index}`,
      );
      ok += 1;
    }
    row.turns_ok = ok;
    row.turns_wall_s = round3((performance.now() - turnsStart) / 1000);
    await Bun.sleep(300);
    clearInterval(sampler);
    clearInterval(discovery);
    tree.discover();
    tree.sample();
    const end = tree.cpu();
    const peaks = tree.peaks();
    row.tree_peak_rss_mb = mb(peaks.treeKb);
    row.client_peak_rss_mb = mb(peaks.roleKb.client);
    row.server_peak_rss_mb = mb(peaks.roleKb.server);
    row.other_peak_rss_mb = mb(peaks.roleKb.other);
    row.tree_hwm_sum_mb = mb(peaks.hwmSumKb);
    row.client_hwm_mb = mb(peaks.hwmRoleKb.client);
    row.server_hwm_mb = mb(peaks.hwmRoleKb.server);
    row.cpu_total_s = round3(end.total);
    row.cpu_client_s = round3(end.client);
    row.cpu_server_s = round3(end.server);
    row.cpu_other_s = round3(end.other);
    row.cpu_startup_s = round3(atReady.total);
    row.cpu_turns_s = round3(end.total - atReady.total);
    row.cpu_client_startup_s = round3(atReady.client);
    row.cpu_server_startup_s = round3(atReady.server);
    row.cpu_client_turns_s = round3(end.client - atReady.client);
    row.cpu_server_turns_s = round3(end.server - atReady.server);
    row.procs_seen = tree.size;
    row.mock_requests = mock.stats.requests;
    row.mock_chat_requests = mock.stats.chat;
    row.mock_stream_requests = mock.stats.streamChat;
    writeScreen(options.work, "screens", target.label, round, screen());
  } catch (error) {
    row.error = String(error instanceof Error ? error.message : error)
      .replaceAll(",", ";")
      .replaceAll("\n", " ");
    if (xterm !== undefined)
      writeScreen(options.work, "failures", target.label, round, screenText(xterm, 40));
  } finally {
    if (sampler !== undefined) clearInterval(sampler);
    if (discovery !== undefined) clearInterval(discovery);
    tree.discover();
    tree.killAll();
    try {
      clientProc?.kill("SIGKILL");
    } catch {}
    try {
      pty?.close();
    } catch {}
    try {
      xterm?.dispose();
    } catch {}
    await mock.stop();
    row.load1_after = loadavg()[0];
    if (!options.keepBoxes) rmSync(box, { recursive: true, force: true });
  }
  return row;
}

function sandboxEnv(
  target: Target,
  paths: Readonly<{ box: string; home: string; project: string; mockURL: string; runId: string }>,
): Record<string, string> {
  const providerConfig = path.join(paths.home, "provider.json");
  const modelConfig = path.join(paths.home, "model.json");
  const bestAgentHome = path.join(paths.home, "best-agent");
  mkdirSync(bestAgentHome, { recursive: true });
  mkdirSync(path.join(paths.home, "dim"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(paths.home, "tmp"), { recursive: true });
  const env: Record<string, string> = {
    HOME: paths.home,
    PATH: [
      path.dirname(subst.node),
      path.dirname(subst.opencodeTs),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
    SHELL: "/bin/sh",
    TMPDIR: path.join(paths.home, "tmp"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    XDG_CONFIG_HOME: path.join(paths.home, ".config"),
    XDG_DATA_HOME: path.join(paths.home, ".local/share"),
    XDG_STATE_HOME: path.join(paths.home, ".local/state"),
    XDG_CACHE_HOME: path.join(paths.home, ".cache"),
    XDG_RUNTIME_DIR: path.join(paths.box, "run"),
    BENCH_RUN_ID: paths.runId,
  };
  if (target.provider === "opencode") {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: "mock/mock-model",
      update: "disable",
      share: "disabled",
      snapshots: false,
      providers: {
        mock: {
          name: "Mock",
          package: "@ai-sdk/openai-compatible",
          settings: { baseURL: `${paths.mockURL}/v1`, apiKey: "mock" },
          models: {
            "mock-model": {
              name: "Mock Model",
              capabilities: { tools: false },
              limit: { context: 200000, output: 8192 },
            },
          },
        },
      },
    });
    env.OPENCODE_DISABLE_MODELS_FETCH = "1";
    env.OPENCODE_DISABLE_AUTOUPDATE = "1";
    env.OPENCODE_TS_BIN = subst.opencodeTs;
  }
  if (target.provider === "best-agent") {
    appendFileSync(
      providerConfig,
      JSON.stringify({
        apiKey: "bench",
        baseURL: `${paths.mockURL}/v1`,
        kind: "openai",
        model: "bench-model",
        compatibilityMode: "compatible",
      }) + "\n",
    );
    env.BEST_AGENT_HOME = bestAgentHome;
    env.BEST_AGENT_PROVIDER_CONFIG = providerConfig;
    env.BEST_AGENT_STORAGE_ROOT = path.join(paths.home, "best-agent-storage");
    env.BEST_AGENT_LANG = "en";
  }
  if (target.provider === "dim") {
    appendFileSync(
      modelConfig,
      JSON.stringify({
        defaultModel: { providerId: "openai", modelId: "bench-model" },
        providers: [
          {
            id: "openai",
            kind: "openai-chat",
            apiKeyEnv: "BENCH_API_KEY",
            baseUrl: `${paths.mockURL}/v1`,
            models: [
              {
                id: "bench-model",
                contextWindow: 128000,
                maxOutputTokens: 8192,
                config: { maxTokens: 4096 },
              },
            ],
          },
        ],
      }) + "\n",
    );
    env.BENCH_API_KEY = "bench";
    env.DIMCODE_LANG = "en";
    env.DIMCODE_NO_UPDATE = "1";
  }
  for (const [key, value] of Object.entries(target.env ?? {}))
    env[key] = resolveTemplate(value, paths);
  return env;
}

function resolveTemplate(value: string, paths: Readonly<{ home: string; project: string }>): string {
  const all: Record<string, string> = {
    ...subst,
    home: paths.home,
    project: paths.project,
    modelConfig: path.join(paths.home, "model.json"),
    providerConfig: path.join(paths.home, "provider.json"),
  };
  return value.replace(/\{([A-Za-z0-9_]+)\}/gu, (_match, key: string) => {
    const resolved = all[key];
    if (resolved === undefined) throw new Error(`Unknown template placeholder {${key}}`);
    return resolved;
  });
}

function validateMatrix(targets: Target[]): void {
  const labels = new Set<string>();
  for (const target of targets) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(target.label))
      throw new Error(`Invalid label: ${target.label}`);
    if (labels.has(target.label)) throw new Error(`Duplicate label: ${target.label}`);
    labels.add(target.label);
    if (!["opencode", "best-agent", "dim"].includes(target.provider))
      throw new Error(`Invalid provider for ${target.label}: ${target.provider}`);
    if (target.client.length === 0) throw new Error(`Empty client for ${target.label}`);
    if (target.ready === undefined || target.ready === "")
      throw new Error(`Missing ready marker for ${target.label}`);
  }
}

// The same offline OpenAI-compatible stub for every target. One streamed reply per turn, 40
// chunks 5 ms apart, about 1.6 KB of markdown; every turn of every run is identical.
function startMock(): Readonly<{ url: string; stats: Stats; stop: () => Promise<void> }> {
  const stats: Stats = {
    requests: 0,
    chat: 0,
    streamChat: 0,
    inflight: 0,
    completed: 0,
    cancelled: 0,
    paths: {},
  };
  const chunks = 40;
  const delay = 5;
  const words =
    "The quick brown fox jumps over the lazy dog while the benchmark measures memory and CPU of the whole process tree.".split(
      " ",
    );
  const pieces = Array.from({ length: chunks }, (_, index) => {
    const line = Array.from(
      { length: 6 },
      (_, offset) => words[(index * 6 + offset) % words.length],
    ).join(" ");
    return index % 8 === 7 ? `\n- ${line}\n` : `${line} `;
  });
  const body = pieces.join("");
  const usage = { prompt_tokens: 1000, completion_tokens: chunks * 6, total_tokens: 1000 + chunks * 6 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      stats.requests += 1;
      stats.paths[url.pathname] = (stats.paths[url.pathname] ?? 0) + 1;
      if (url.pathname === "/__stats") return Response.json(stats);
      if (url.pathname.endsWith("/models"))
        return Response.json({
          object: "list",
          data: [{ id: "mock-model", object: "model", owned_by: "mock" }],
        });
      if (!url.pathname.endsWith("/chat/completions"))
        return new Response("not found", { status: 404 });
      stats.chat += 1;
      const requestBody = (await request.json()) as {
        stream?: boolean;
        response_format?: { json_schema?: { name?: string } };
        messages?: readonly { role?: string; content?: unknown }[];
      };
      if (asksForAutomaticMemory(requestBody)) return Response.json({ selected: [] });
      if (asksForFacts(requestBody)) return Response.json({ facts: [] });
      const id = `chatcmpl-${stats.chat}`;
      const created = 1_700_000_000;
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: "mock-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      if (requestBody.stream === false)
        return Response.json({
          id,
          object: "chat.completion",
          created,
          model: "mock-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: body },
              finish_reason: "stop",
            },
          ],
          usage,
        });
      stats.streamChat += 1;
      stats.inflight += 1;
      let settled = false;
      const settle = (cancelled: boolean) => {
        if (settled) return;
        settled = true;
        stats.inflight -= 1;
        if (cancelled) stats.cancelled += 1;
        else stats.completed += 1;
      };
      const stream = new ReadableStream({
        cancel() {
          settle(true);
        },
        async start(controller) {
          const encoder = new TextEncoder();
          try {
            controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "" }, null)));
            for (const piece of pieces) {
              await Bun.sleep(delay);
              controller.enqueue(encoder.encode(chunk({ content: piece }, null)));
            }
            controller.enqueue(encoder.encode(chunk({}, "stop")));
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: "mock-model",
                  choices: [],
                  usage,
                })}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            settle(false);
          } catch (error) {
            settle(true);
            try {
              controller.error(error);
            } catch {}
          }
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    stats,
    stop: async () => {
      await server.stop(true);
    },
  };
}

function asksForAutomaticMemory(body: {
  response_format?: { json_schema?: { name?: string } };
  messages?: readonly { content?: unknown }[];
}): boolean {
  return (
    body.response_format?.json_schema?.name === "automatic_memory_selection" ||
    JSON.stringify(body.messages ?? []).includes("automatic_memory_selection")
  );
}

function asksForFacts(body: {
  response_format?: { json_schema?: { name?: string } };
  messages?: readonly { content?: unknown }[];
}): boolean {
  return (
    body.response_format?.json_schema?.name === "facts" ||
    JSON.stringify(body.messages ?? []).includes("Observe only the following newly completed")
  );
}

class Tree {
  private readonly runIdBuffer: Buffer;
  private readonly marker: string;
  private readonly matched = new Set<number>();
  private readonly procs = new Map<number, Proc>();
  private readonly roots = new Map<number, Role>();
  private treePeakKb = 0;
  private rolePeakKb: Record<Role, number> = { client: 0, server: 0, other: 0 };
  private liveRssKb = 0;
  private liveCpu = { total: 0, client: 0, server: 0, other: 0 };

  constructor(runId: string, marker: string) {
    this.runIdBuffer = Buffer.from(`BENCH_RUN_ID=${runId}\0`);
    this.marker = marker;
  }

  addRoot(pid: number, role: Role): void {
    this.roots.set(pid, role);
    this.matched.add(pid);
  }

  get size(): number {
    return this.procs.size;
  }

  discover(): void {
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      const pid = Number(entry);
      if (this.matched.has(pid)) continue;
      let matched = false;
      try {
        matched = readFileSync(`/proc/${pid}/environ`).includes(this.runIdBuffer);
      } catch {}
      if (!matched && !readCmdline(pid).includes(this.marker)) continue;
      this.matched.add(pid);
      const role = classify(pid, this.roots.get(pid));
      if (this.roots.has(pid) || role === "server") this.roots.set(pid, role);
    }
  }

  sample(): void {
    const seen = new Set<number>();
    const rss: Record<Role, number> = { client: 0, server: 0, other: 0 };
    const cpu: Record<Role, number> = { client: 0, server: 0, other: 0 };
    let totalRss = 0;
    let totalCpu = 0;
    for (const pid of this.matched) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const stat = readStat(pid);
      if (stat === undefined) continue;
      const rssKb = readRssKb(pid);
      const role = classify(pid, this.roots.get(pid));
      const known = this.procs.get(pid);
      const entry =
        known !== undefined && known.startTime === stat.startTime
          ? known
          : ({ role, peakKb: 0, hwmKb: 0, cpuSeconds: 0, lastRssKb: 0, startTime: stat.startTime } satisfies Proc);
      entry.role = role;
      entry.peakKb = Math.max(entry.peakKb, rssKb);
      entry.hwmKb = Math.max(entry.hwmKb, readHwmKb(pid));
      entry.cpuSeconds = stat.cpuSeconds;
      entry.lastRssKb = rssKb;
      this.procs.set(pid, entry);
      rss[role] += rssKb;
      cpu[role] += stat.cpuSeconds;
      totalRss += rssKb;
      totalCpu += stat.cpuSeconds;
    }
    this.liveRssKb = totalRss;
    this.liveCpu = { total: totalCpu, ...cpu };
    this.treePeakKb = Math.max(this.treePeakKb, totalRss);
    for (const role of ["client", "server", "other"] as const)
      this.rolePeakKb[role] = Math.max(this.rolePeakKb[role], rss[role]);
  }

  currentRssKb(): number {
    return this.liveRssKb;
  }

  cpu(): { total: number; client: number; server: number; other: number } {
    return { ...this.liveCpu };
  }

  peaks(): {
    treeKb: number;
    roleKb: Record<Role, number>;
    hwmSumKb: number;
    hwmRoleKb: Record<Role, number>;
  } {
    const hwmRoleKb: Record<Role, number> = { client: 0, server: 0, other: 0 };
    for (const proc of this.procs.values()) hwmRoleKb[proc.role] += proc.hwmKb;
    return {
      treeKb: this.treePeakKb,
      roleKb: { ...this.rolePeakKb },
      hwmSumKb: hwmRoleKb.client + hwmRoleKb.server + hwmRoleKb.other,
      hwmRoleKb,
    };
  }

  killAll(): void {
    for (const pid of this.matched) {
      const known = this.procs.get(pid);
      if (known !== undefined) {
        const stat = readStat(pid);
        if (stat === undefined || stat.startTime !== known.startTime) continue;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}

function classify(pid: number, rootRole: Role | undefined): Role {
  if (rootRole === "client" && pid !== 0) {
    // A root stays the role it was admitted with, even when its cmdline later looks generic.
    if (isClientHelper(pid)) return "client";
  }
  const cmd = readCmdline(pid);
  if (cmd.includes("__best_agent_tui_ui")) return "client";
  if (cmd.includes("cpu-supervisor") || cmd.includes("workspace-read-helper")) return "client";
  if (/(?:^|\s)(?:app-server|serve)(?:\s|$)/u.test(cmd)) return "server";
  return rootRole ?? "other";
}

function isClientHelper(pid: number): boolean {
  const cmd = readCmdline(pid);
  return (
    cmd === "" ||
    cmd.includes("__best_agent_tui_ui") ||
    cmd.includes("cpu-supervisor") ||
    cmd.includes("workspace-read-helper")
  );
}

function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
}

function readStat(
  pid: number,
): Readonly<{ cpuSeconds: number; startTime: number }> | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return {
      cpuSeconds:
        (Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14])) /
        clkTck,
      startTime: Number(fields[19]),
    };
  } catch {
    return undefined;
  }
}

function readRssKb(pid: number): number {
  try {
    return Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * pageKb;
  } catch {
    return 0;
  }
}

function readHwmKb(pid: number): number {
  try {
    const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmHWM:\s+(\d+) kB$/mu);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

function loadavg(): readonly [number, number, number] {
  try {
    const parts = readFileSync("/proc/loadavg", "utf8").split(" ");
    return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  } catch {
    return [0, 0, 0];
  }
}

// xterm-headless answers DA/DSR/DECRQM through onData; it does not answer OSC 10/11 colours.
// OpenTUI waits for those replies, so emulate a dark terminal using the query's own terminator.
function answerColorQueries(text: string, reply: (value: string) => void): void {
  for (const match of text.matchAll(/\x1b\](1[01]);\?(\x07|\x1b\\)/gu)) {
    reply(
      `\x1b]${match[1]};${
        match[1] === "10" ? "rgb:ffff/ffff/ffff" : "rgb:0000/0000/0000"
      }${match[2]}`,
    );
  }
}

// True once the output has printed any cell, blank or not. Escape sequences and control
// characters print nothing; an incomplete escape at the end is ignored until the next read.
function printsCells(raw: string): boolean {
  const stripped = raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1b[\]P_^X][\s\S]*?(\x07|\x1b\\)/gu, "")
    .replace(/\x1b[()*+#%][\s\S]/gu, "")
    .replace(/\x1b[^\[\]P_^X()*+#%]/gu, "");
  const cut = stripped.indexOf("\x1b");
  return (cut === -1 ? stripped : stripped.slice(0, cut)).replace(/[\x00-\x1f\x7f]/gu, "").length > 0;
}

function painted(xterm: Xterm, cols: number, rows: number): boolean {
  const buffer = xterm.buffer.active;
  const cell = buffer.getNullCell();
  for (let y = 0; y < rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) continue;
    for (let x = 0; x < cols; x += 1) {
      line.getCell(x, cell);
      if (cell.getChars().trim() !== "" || !cell.isBgDefault()) return true;
    }
  }
  return false;
}

function screenText(xterm: Xterm, rows: number): string {
  const buffer = xterm.buffer.active;
  return Array.from(
    { length: rows },
    (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? "",
  ).join("\n");
}

function writeScreen(
  work: string,
  directory: string,
  label: string,
  round: number,
  text: string,
): void {
  const target = path.join(work, directory);
  mkdirSync(target, { recursive: true });
  void Bun.write(path.join(target, `${label}-${round}.txt`), text + "\n");
}

function snapshot(stats: Stats): Stats {
  return { ...stats, paths: { ...stats.paths } };
}

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      result[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = "1";
    }
  }
  return result;
}

function intArg(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

function envPath(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) throw new Error(`${name} does not exist: ${resolved}`);
  return resolved;
}

function commandInt(argv: string[]): number | undefined {
  try {
    const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return undefined;
    const value = Number(result.stdout.toString().trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(file: string, pattern: RegExp): string {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = line.match(pattern);
      if (match) return match[1]!.trim();
    }
  } catch {}
  return "";
}

function mb(kb: number): number {
  return Math.round((kb / 1024) * 10) / 10;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fmt(value: unknown, digits = 0): string {
  return typeof value === "number" ? value.toFixed(digits) : "-";
}

function csv(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[,\r\n]/gu, ";");
}
