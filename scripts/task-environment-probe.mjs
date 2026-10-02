import { createServer as httpServer } from "node:http";
import { connect, createServer as netServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A local scripted provider exercises the selected CLI/tools; it does not call the task model.
export async function probeTaskEnvironment({ repoDir, artifactDir, cliInvocation, executionArgs, probeSource, runProcess, inspectEvidence }) {
  const requests = [];
  let processRef;
  let proof;
  let failure;
  let tcpConnections = 0;
  let unixConnections = 0;
  const privatePath = join(artifactDir, "private-canary.txt");
  const socketDir = mkdtempSync("/tmp/benchmark-probe-");
  const socketPath = join(socketDir, "canary.sock");
  writeFileSync(privatePath, "private preparation evidence", { flag: "wx" });
  const tcp = netServer((socket) => { tcpConnections++; socket.end(); });
  const unix = netServer((socket) => { unixConnections++; socket.end(); });
  const provider = httpServer((request, response) => {
    void receive(request, response).catch((error) => {
      failure = error;
      response.writeHead(500);
      response.end(String(error));
    });
  });
  let source;
  try {
    await new Promise((resolve, reject) => { tcp.once("error", reject); tcp.listen(0, "127.0.0.1", resolve); });
    await new Promise((resolve, reject) => { unix.once("error", reject); unix.listen(socketPath, resolve); });
    await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
    for (const address of [{ port: tcp.address().port, host: "127.0.0.1" }, { path: socketPath }]) {
      await new Promise((resolve, reject) => {
        const socket = connect(address);
        socket.on("error", reject);
        socket.resume();
        socket.on("close", resolve);
      });
    }
    source = [
      "import os, sys, sqlite3, ssl, socket, subprocess, json",
      "assert os.path.realpath(sys.prefix) == os.path.join(os.getcwd(), '.benchmark-runtime')",
      `try:\n open(${JSON.stringify(privatePath)}).read()\nexcept PermissionError:\n pass\nelse:\n raise AssertionError('host-private read was allowed')`,
      `for family, address in [(socket.AF_INET, ('127.0.0.1', ${tcp.address().port})), (socket.AF_UNIX, ${JSON.stringify(socketPath)})]:\n with socket.socket(family, socket.SOCK_STREAM) as s:\n  s.settimeout(2)\n  try:\n   s.connect(address)\n  except PermissionError:\n   pass\n  else:\n   raise AssertionError('network access was allowed')`,
      probeSource,
      "print('BENCHMARK_ENVIRONMENT_PROOF=' + json.dumps(dict(pythonVersion=sys.version.split()[0], prefix=sys.prefix, sqlite=sqlite3.sqlite_version, ssl=ssl.OPENSSL_VERSION)))",
    ].join("\n");
    const result = await runProcess({
      args: [...cliInvocation, ...executionArgs,
        "--system-prompt", "Execute the scripted environment probes only.",
        "--attempt-evidence", join(artifactDir, "probe.evidence.jsonl"),
        "Environment probe only. No benchmark task or real model is involved."],
      cwd: repoDir,
      timeoutMs: 90_000,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        PYTHONDONTWRITEBYTECODE: "1",
        BEST_AGENT_PROVIDER_KIND: "openai", BEST_AGENT_PROVIDER_MODEL: "scripted-preflight",
        BEST_AGENT_PROVIDER_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
        BEST_AGENT_PROVIDER_API_KEY: "local-probe-only", BEST_AGENT_PROVIDER_COMPATIBILITY_MODE: "compatible",
        BEST_AGENT_PROVIDER_CONFIG: join(artifactDir, "no-provider.json"),
        BEST_AGENT_STORAGE_ROOT: join(artifactDir, "probe-storage"), BEST_AGENT_PROVIDER_TIMEOUT_MS: "15000",
      },
    });
    writeFileSync(join(artifactDir, "probe.stdout.txt"), result.stdout, { flag: "wx" });
    writeFileSync(join(artifactDir, "probe.stderr.txt"), result.stderr, { flag: "wx" });
    writeFileSync(join(artifactDir, "probe.process.json"), JSON.stringify(result, null, 2), { flag: "wx" });
    if (failure) throw failure;
    if (result.error) throw result.error;
    if (result.status !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
      throw new Error("Selected CLI environment probe failed: " + (result.stderr || result.stdout));
    }
    if (!proof || tcpConnections !== 1 || unixConnections !== 1) throw new Error("Environment probe did not prove sandbox closure.");
    const evidence = inspectEvidence(join(artifactDir, "probe.evidence.jsonl"));
    if (!evidence.complete || evidence.rootStatus !== "completed") {
      throw new Error("Environment probe evidence is incomplete: " + JSON.stringify(evidence));
    }
    return { ...proof, provider: "local-scripted", requests: requests.length,
      privateReadDenied: true, tcpDenied: true, unixDenied: true, childExitCode: 0, evidence };
  } finally {
    writeFileSync(join(artifactDir, "probe.requests.json"), JSON.stringify(requests), { flag: "wx" });
    provider.closeAllConnections();
    await Promise.all([provider, tcp, unix].map((server) => new Promise((resolve) => server.close(resolve))));
    rmSync(socketDir, { recursive: true, force: true });
  }

  async function receive(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    if (requests.length > 16) throw new Error("Environment probe exceeded its poll bound.");
    let call;
    if (requests.length === 1) {
      const child = `import subprocess,sys\np=subprocess.run([sys.executable,'-B','-c',${JSON.stringify(source)}],capture_output=True,text=True)\nprint(p.stdout,end='')\nprint(p.stderr,end='',file=sys.stderr)\nsys.exit(p.returncode)`;
      call = { name: "process-start", input: { argv: ["python3", "-B", "-c", child], cwd: ".", lifetimeMs: 60_000 } };
    } else {
      const outcome = JSON.parse(body.messages.filter((entry) => entry.role === "tool").at(-1).content);
      if (requests.length === 2) {
        if (outcome.kind !== "known" || outcome.status !== "accepted") throw new Error(JSON.stringify(outcome));
        processRef = outcome.payload.processRef;
      } else {
        if (outcome.kind !== "known" || outcome.status !== "succeeded") throw new Error(JSON.stringify(outcome));
        if (outcome.payload.status === "exited") {
          if (outcome.payload.exitCode !== 0) throw new Error(JSON.stringify(outcome.payload));
          const line = outcome.payload.stdout.split("\n").find((line) => line.startsWith("BENCHMARK_ENVIRONMENT_PROOF="));
          if (!line) throw new Error("Missing selected-entry proof: " + JSON.stringify(outcome.payload));
          proof = JSON.parse(line.slice("BENCHMARK_ENVIRONMENT_PROOF=".length));
        }
      }
      if (!proof) call = { name: "process-read", input: { processRef, waitMs: 5000, maxBytes: 65536 } };
    }
    const message = call
      ? { role: "assistant", content: "", tool_calls: [{ id: `probe-${requests.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }
      : { role: "assistant", content: "environment-probe-complete" };
    const common = { id: `probe-${requests.length}`, created: 1, model: "scripted-preflight" };
    const finish_reason = call ? "tool_calls" : "stop";
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = call ? { ...message, tool_calls: message.tool_calls.map((entry) => ({ ...entry, index: 0 })) } : message;
      response.end([ { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
        { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason }] } ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...common, object: "chat.completion", choices: [{ index: 0, message, finish_reason }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  }
}
