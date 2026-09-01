#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, get } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.env.BEST_AGENT_CLI_PATH;
if (!executable) throw new Error("BEST_AGENT_CLI_PATH is required.");
const cliInvocation = /\.[cm]?js$/u.test(executable) ? [process.execPath, executable] : [executable];

const root = mkdtempSync(join(tmpdir(), "best-agent-network-smoke-"));
const workspace = join(root, "workspace");
const storage = join(root, "storage");
const privateCanaryPath = join(root, "host-private-canary.txt");
const workspaceCanaryPath = join(workspace, "workspace-canary.txt");
const unixSocketPath = join(root, "host-private.sock");
const modelRequests = [];
let tcpProbeRequests = 0;
let unixProbeConnections = 0;
let httpServer;
let unixServer;
let probeUrl;
let processRef;
const trace = (stage) => {
  if (process.env.BEST_AGENT_SMOKE_TRACE === "1") process.stderr.write(`[smoke] ${stage}\n`);
};

try {
  mkdirSync(workspace);
  mkdirSync(storage);
  writeFileSync(privateCanaryPath, "host-private\n");
  writeFileSync(workspaceCanaryPath, "workspace-visible\n");
  httpServer = createHttpServer((request, response) => {
    void receiveRequest(request, response);
  });
  unixServer = createNetServer((socket) => {
    unixProbeConnections += 1;
    socket.end("reachable");
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => unixServer.listen(unixSocketPath, resolve));
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("Smoke server unavailable.");
  probeUrl = `http://127.0.0.1:${address.port}/probe`;
  await hostProbe(probeUrl);
  await hostUnixProbe(unixSocketPath);
  trace("host probes complete");

  const environment = { ...process.env };
  delete environment.VITEST;
  trace("starting CLI");
  const result = await run(
    cliInvocation[0],
    [
      ...cliInvocation.slice(1),
      "run",
      "--workspace",
      workspace,
      "--exec-alias",
      `node=${process.execPath}`,
      "--workspace-backend",
      "sandbox",
      "--process-isolation",
      "workspace-sandbox",
      "--workspace-grant",
      "read",
      "--workspace-grant",
      "write",
      "--workspace-grant",
      "exec",
      "--tool-exclude",
      "network",
      "--no-base-instructions",
      "--system-prompt",
      "Follow the supplied tool calls exactly, then finish.",
      "Verify workspace-sandbox process isolation.",
    ],
    {
      ...environment,
      BEST_AGENT_PROVIDER_KIND: "openai",
      BEST_AGENT_PROVIDER_MODEL: "local-network-smoke",
      BEST_AGENT_PROVIDER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      BEST_AGENT_PROVIDER_API_KEY: "test-key",
      BEST_AGENT_PROVIDER_COMPATIBILITY_MODE: "compatible",
      BEST_AGENT_PROVIDER_CONFIG: join(root, "missing-provider.json"),
      BEST_AGENT_STORAGE_ROOT: storage,
    },
  );
  trace("CLI closed");

  if (result.code !== 0) {
    throw new Error(`CLI network smoke failed (${result.code}).\n${result.stderr || result.stdout}`);
  }
  if (modelRequests.length !== 4) {
    throw new Error(`Expected 4 provider requests, received ${modelRequests.length}.`);
  }
  if (tcpProbeRequests !== 1) {
    throw new Error(
      `A sandboxed descendant reached the TCP probe (${tcpProbeRequests - 1} sandbox requests).`,
    );
  }
  if (unixProbeConnections !== 1) {
    throw new Error(
      `A sandboxed descendant reached the Unix socket (${unixProbeConnections - 1} sandbox connections).`,
    );
  }
  if (result.stdout.trim() !== "sandbox-network-smoke-complete") {
    throw new Error(`Unexpected CLI output: ${JSON.stringify(result.stdout)}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      modelRequests: modelRequests.length,
      providerTransport: true,
      exec: { workspace: true, hostPrivate: false, tcp: false, unix: false },
      processDescendant: { workspace: true, hostPrivate: false, tcp: false, unix: false },
      host: { platform: process.platform, arch: process.arch },
    })}\n`,
  );
} finally {
  trace("closing servers");
  if (httpServer !== undefined) {
    const closed = new Promise((resolve) => httpServer.close(resolve));
    httpServer.closeAllConnections();
    await closed;
  }
  if (unixServer !== undefined) await new Promise((resolve) => unixServer.close(resolve));
  trace("servers closed");
  rmSync(root, { recursive: true, force: true });
}

async function receiveRequest(request, response) {
  if (request.url === "/probe") {
    tcpProbeRequests += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("reachable");
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  modelRequests.push(body);
  if (process.env.BEST_AGENT_SMOKE_TRACE === "1" && modelRequests.length === 1) {
    const execTool = body.tools?.find((tool) => tool.function?.name === "exec");
    trace(`exec schema ${JSON.stringify(execTool?.function?.parameters)}`);
  }
  if (modelRequests.length > 4) {
    response.writeHead(500);
    response.end("retry not allowed");
    return;
  }
  if (modelRequests.length === 1) {
    const execTool = body.tools?.find((entry) => entry.function?.name === "exec");
    if (execTool === undefined) throw new Error("Installed CLI did not expose exec.");
    const execSource = isolationProbeSource("exec-proof.txt");
    trace(`exec source bytes ${Buffer.byteLength(execSource)}`);
    respond(response, body, {
      toolCall: {
        id: "call-network-smoke",
        name: "exec",
        arguments: JSON.stringify({
          command: "node",
          args: ["-e", execSource],
          cwd: ".",
        }),
      },
    });
    return;
  }
  const toolMessages = body.messages.filter((message) => message.role === "tool");
  const outcome = JSON.parse(toolMessages.at(-1)?.content ?? "null");
  if (modelRequests.length === 2) {
    assertProbeOutcome(outcome, "exec");
    const childSource = isolationProbeSource("process-proof.txt");
    respond(response, body, {
      toolCall: {
        id: "call-process-start-smoke",
        name: "process-start",
        arguments: JSON.stringify({
          argv: [
            "node",
            "-e",
            `const {spawnSync}=require("node:child_process");const result=spawnSync(process.execPath,["-e",${JSON.stringify(childSource)}],{encoding:"utf8"});process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);`,
          ],
          cwd: ".",
          lifetimeMs: 10_000,
        }),
      },
    });
    return;
  }
  if (modelRequests.length === 3) {
    if (
      outcome.kind !== "known" ||
      outcome.status !== "accepted" ||
      typeof outcome.payload?.processRef !== "string"
    ) {
      throw new Error(`process-start was not accepted: ${JSON.stringify(outcome)}`);
    }
    processRef = outcome.payload.processRef;
    respond(response, body, {
      toolCall: {
        id: "call-process-read-smoke",
        name: "process-read",
        arguments: JSON.stringify({ processRef, waitMs: 5_000, maxBytes: 16_384 }),
      },
    });
    return;
  }
  if (toolMessages.length !== 3) throw new Error("Expected three isolation ToolResults.");
  assertProbeOutcome(outcome, "process descendant");
  respond(response, body, { content: "sandbox-network-smoke-complete" });
}

function assertProbeOutcome(outcome, source) {
  if (outcome?.kind !== "known" || outcome.status !== "succeeded") {
    throw new Error(`${source} isolation probe failed: ${JSON.stringify(outcome)}`);
  }
  if (source === "process descendant" && outcome.payload?.status !== "exited") {
    throw new Error(`process descendant did not exit: ${JSON.stringify(outcome)}`);
  }
  let proof;
  try {
    proof = JSON.parse(outcome.payload?.stdout ?? "");
  } catch {
    throw new Error(`${source} returned invalid proof: ${JSON.stringify(outcome)}`);
  }
  if (
    proof.workspaceRead !== true ||
    proof.workspaceWrite !== true ||
    proof.hostPrivateBlocked !== true ||
    proof.tcpBlocked !== true ||
    proof.unixBlocked !== true
  ) {
    throw new Error(`${source} escaped isolation: ${JSON.stringify(proof)}`);
  }
}

function isolationProbeSource(outputPath) {
  const port = new URL(probeUrl).port;
  return [
    'const {readFileSync,writeFileSync}=require("node:fs");',
    'const {connect}=require("node:net");',
    'function blocked(options){return new Promise((resolve)=>{const socket=connect(options,()=>{socket.destroy();resolve(false)});socket.setTimeout(500,()=>{socket.destroy();resolve(true)});socket.on("error",()=>resolve(true))})}',
    '(async()=>{',
    "let hostPrivateBlocked=false;",
    `try{readFileSync(${JSON.stringify(privateCanaryPath)},"utf8")}catch{hostPrivateBlocked=true}`,
    'const workspaceRead=readFileSync("workspace-canary.txt","utf8")==="workspace-visible\\n";',
    `writeFileSync(${JSON.stringify(outputPath)},"workspace-write-ok\\n");`,
    `const workspaceWrite=readFileSync(${JSON.stringify(outputPath)},"utf8")==="workspace-write-ok\\n";`,
    `const tcpBlocked=await blocked({host:"127.0.0.1",port:${JSON.stringify(Number(port))}});`,
    `const unixBlocked=await blocked({path:${JSON.stringify(unixSocketPath)}});`,
    "const proof={workspaceRead,workspaceWrite,hostPrivateBlocked,tcpBlocked,unixBlocked};",
    "if(Object.values(proof).some((value)=>value!==true))throw new Error(JSON.stringify(proof));",
    "process.stdout.write(JSON.stringify(proof));",
    "})().catch((error)=>{process.stderr.write(error.stack||String(error));process.exit(1)});",
  ].join("");
}

function respond(response, request, message) {
  if (request.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse(message));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "chatcmpl-network-smoke",
      object: "chat.completion",
      created: 1,
      model: "local-network-smoke",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: message.content ?? "",
            ...(message.toolCall === undefined
              ? {}
              : {
                  tool_calls: [
                    {
                      id: message.toolCall.id,
                      type: "function",
                      function: {
                        name: message.toolCall.name,
                        arguments: message.toolCall.arguments,
                      },
                    },
                  ],
                }),
          },
          finish_reason: message.toolCall === undefined ? "stop" : "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}

function sse({ content, toolCall }) {
  const events = [
    {
      id: "chatcmpl-network-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: "local-network-smoke",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
  ];
  if (toolCall === undefined) {
    events.push({
      id: "chatcmpl-network-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: "local-network-smoke",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
  } else {
    events.push({
      id: "chatcmpl-network-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: "local-network-smoke",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: toolCall.id,
                type: "function",
                function: { name: toolCall.name, arguments: toolCall.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  events.push({
    id: "chatcmpl-network-smoke",
    object: "chat.completion.chunk",
    created: 1,
    model: "local-network-smoke",
    choices: [
      { index: 0, delta: {}, finish_reason: toolCall === undefined ? "stop" : "tool_calls" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function hostProbe(url) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      response.resume();
      response.on("end", resolve);
    });
    request.on("error", reject);
  });
}

function hostUnixProbe(path) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.resume();
    socket.on("connect", () => socket.end());
    socket.on("close", resolve);
    socket.on("error", reject);
  });
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI network smoke timed out."));
    }, 30_000);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
