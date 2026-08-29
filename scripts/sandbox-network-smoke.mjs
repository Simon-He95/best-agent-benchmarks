#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.env.BEST_AGENT_CLI_PATH;
if (!executable) throw new Error("BEST_AGENT_CLI_PATH is required.");

const root = mkdtempSync(join(tmpdir(), "best-agent-network-smoke-"));
const workspace = join(root, "workspace");
const storage = join(root, "storage");
const modelRequests = [];
let probeRequests = 0;
let server;
let probeUrl;

try {
  mkdirSync(workspace);
  mkdirSync(storage);
  server = createServer((request, response) => {
    void receiveRequest(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Smoke server unavailable.");
  probeUrl = `http://127.0.0.1:${address.port}/probe`;
  await hostProbe(probeUrl);

  const environment = { ...process.env };
  delete environment.VITEST;
  const result = await run(
    executable,
    [
      "run",
      "--workspace",
      workspace,
      "--workspace-backend",
      "sandbox",
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
      "Call exec exactly once with the supplied command, then finish.",
      "Verify the supplied local URL is blocked.",
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

  if (result.code !== 0) {
    throw new Error(`CLI network smoke failed (${result.code}).\n${result.stderr || result.stdout}`);
  }
  if (modelRequests.length !== 2) {
    throw new Error(`Expected 2 provider requests, received ${modelRequests.length}.`);
  }
  if (probeRequests !== 1) {
    throw new Error(`Sandbox exec reached the host probe (${probeRequests - 1} sandbox requests).`);
  }
  if (result.stdout.trim() !== "sandbox-network-smoke-complete") {
    throw new Error(`Unexpected CLI output: ${JSON.stringify(result.stdout)}`);
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, modelRequests: modelRequests.length, hostProbe: true, sandboxProbe: false })}\n`,
  );
} finally {
  if (server !== undefined) await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}

async function receiveRequest(request, response) {
  if (request.url === "/probe") {
    probeRequests += 1;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("reachable");
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  modelRequests.push(body);
  if (modelRequests.length > 2) {
    response.writeHead(500);
    response.end("retry not allowed");
    return;
  }
  if (modelRequests.length === 1) {
    const execTool = body.tools?.find((entry) => entry.function?.name === "exec");
    if (execTool === undefined) throw new Error("Installed CLI did not expose exec.");
    respond(response, body, {
      toolCall: {
        id: "call-network-smoke",
        name: "exec",
        arguments: JSON.stringify({
          command: "node",
          args: [
            "-e",
            `fetch(${JSON.stringify(probeUrl)}).then(() => process.exit(0), () => process.exit(7))`,
          ],
          cwd: ".",
        }),
      },
    });
    return;
  }
  const toolMessages = body.messages.filter((message) => message.role === "tool");
  if (toolMessages.length !== 1) throw new Error("Expected one exec ToolResult.");
  const outcome = JSON.parse(toolMessages[0].content);
  if (outcome.kind !== "known" || outcome.status !== "failed") {
    throw new Error(`Sandbox exec did not report network failure: ${JSON.stringify(outcome)}`);
  }
  respond(response, body, { content: "sandbox-network-smoke-complete" });
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
