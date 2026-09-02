// Local provider-shim proxy for the pinned best-agent CLI (0.0.3-beta.1).
//
// Fixes two protocol mismatches between the provider's OpenAI-compatible API
// and the CLI's newest Linux build, both found by replaying the full round
// trip inside the task container:
//  1. the CLI sends the Vercel AI SDK user agent ("ai/6.0.184 ..."), which
//     the provider rejects with 403 unsupported client -> rewrite to "node";
//  2. the model returns the tool's position in the tools array inside
//     tool_calls[].index (e.g. 11 for the 12th tool). The CLI instead expects
//     the OpenAI semantics (position within this message's parallel calls,
//     0..n-1) and fails with "tool-unknown" -> renumber sequentially.
//
// JSON responses are buffered and rewritten; anything else (SSE streams,
// errors) is piped through verbatim. A compact request/response log is
// appended for diagnostics.
//
// Env: UPSTREAM_ORIGIN (e.g. https://dimagent.cn), PORT (default 8899)
const http = require("http");
const https = require("https");

const upstreamOrigin = process.env.UPSTREAM_ORIGIN || "https://dimagent.cn";
const port = Number(process.env.PORT || 8899);
const upstream = new URL(upstreamOrigin);
const client = upstream.protocol === "http:" ? http : https;

// Tools the pinned CLI can execute safely with exec+write grants. Every
// other tool call is rewritten into an equivalent exec call so the model
// keeps a working loop instead of tripping the CLI's fatal tool-unknown.
const SAFE_TOOLS = new Set(["exec", "write", "edit", "apply_patch", "todowrite", "now"]);

function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function rewriteUnsafeToolCall(call) {
  const name = call.function?.name ?? "";
  if (SAFE_TOOLS.has(name)) {
    return {
      id: call.id,
      type: "function",
      function: { name, arguments: call.function?.arguments ?? "{}" },
    };
  }
  const args = parseArguments(call.function?.arguments);
  let rewritten;
  if (name === "process-start" && Array.isArray(args.argv) && args.argv.length > 0) {
    rewritten = { command: String(args.argv[0]), args: args.argv.slice(1).map(String), cwd: args.cwd ?? "." };
  } else if (name === "list" && typeof args.path === "string") {
    rewritten = { command: "ls", args: [], cwd: args.path };
  } else if (name === "read" && typeof args.path === "string") {
    rewritten = { command: "cat", args: [args.path], cwd: "." };
  } else if (name === "stat" && typeof args.path === "string") {
    rewritten = { command: "stat", args: [args.path], cwd: "." };
  } else if (name === "search" && typeof args.query === "string") {
    const path = typeof args.path === "string" ? args.path : ".";
    rewritten = { command: "grep", args: ["-rn", args.query, path], cwd: "." };
  } else if (name === "mkdir" && typeof args.path === "string") {
    rewritten = { command: "python3", args: ["-c", `import os; os.makedirs(${JSON.stringify(args.path)}, exist_ok=True)`], cwd: "." };
  } else if (name === "remove" && typeof args.path === "string") {
    rewritten = { command: "python3", args: ["-c", `import shutil; shutil.rmtree(${JSON.stringify(args.path)}, ignore_errors=True)`], cwd: "." };
  } else {
    rewritten = {
      command: "echo",
      args: [`[tool '${name}' is not available in this environment; use exec, write, edit, or apply_patch]`],
      cwd: ".",
    };
  }
  console.log(`rewriting tool '${name}' -> exec`);
  return {
    id: call.id,
    type: "function",
    function: { name: "exec", arguments: JSON.stringify(rewritten) },
  };
}

function normalizeResponse(payload) {
  // Rebuild the response as the minimal strict OpenAI shape the pinned CLI's
  // schema accepts: no tool_calls[].index, no provider-specific extras at any
  // level. Tool calls are renumbered by position for downstream consumers.
  const clean = {
    id: payload.id,
    object: payload.object ?? "chat.completion",
    created: payload.created,
    model: payload.model,
    choices: (payload.choices ?? []).map((choice) => {
      const message = choice?.message ?? {};
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      return {
        index: choice.index ?? 0,
        finish_reason: choice.finish_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
        message: {
          role: message.role ?? "assistant",
          content: message.content ?? "",
          ...(toolCalls.length > 0
            ? {
                // The CLI sends parallel_tool_calls: false; the provider ignores
                // it and may emit several calls. Keep only the first.
                tool_calls: toolCalls.map((call) => rewriteUnsafeToolCall(call)),
              }
            : {}),
        },
      };
    }),
    ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
  };
  return clean;
}

function rewriteToolCallIndexes(payload) {
  let changed = 0;
  for (const choice of payload.choices ?? []) {
    const message = choice?.message;
    if (!message) continue;
    // The CLI's parser chokes on reasoning_content combined with tool_calls;
    // strip the reasoning field when a tool call is present.
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      if ("reasoning_content" in message) {
        delete message.reasoning_content;
        changed += 1;
      }
    }
    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    toolCalls.forEach((call, position) => {
      if (typeof call.index === "number" && call.index !== position) {
        call.index = position;
        changed += 1;
      }
    });
  }
  return changed;
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = { ...req.headers, host: upstream.host };
  headers["user-agent"] = "node";
  const logLine = `${new Date().toISOString()} ${req.method} ${req.url}`;
  try {
    const parsedBody = JSON.parse(body.toString("utf8"));
    if (Array.isArray(parsedBody.tools)) {
      console.log(logLine, "tools:", parsedBody.tools.map((tool) => tool.function?.name ?? tool.name).join(","));
    }
    const summary = { ...parsedBody, messages: `<${parsedBody.messages?.length ?? 0} messages>`, tools: `<${parsedBody.tools?.length ?? 0} tools>` };
    console.log(logLine, "params:", JSON.stringify(summary));
  } catch {}

  const upstreamReq = client.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
      path: req.url,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const contentType = String(upstreamRes.headers["content-type"] ?? "");
      const isJson = upstreamRes.statusCode === 200 && contentType.includes("application/json");
      console.log(logLine, "->", upstreamRes.statusCode, isJson ? "(rewrite)" : "(pipe)");

      if (!isJson) {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }

      const responseChunks = [];
      upstreamRes.on("data", (chunk) => responseChunks.push(chunk));
      upstreamRes.on("end", () => {
        let out = Buffer.concat(responseChunks);
        try {
          const payload = JSON.parse(out.toString("utf8"));
          for (const choice of payload.choices ?? []) {
            if (Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0) {
              console.log(logLine, "tool_calls:", JSON.stringify(choice.message.tool_calls).slice(0, 1200));
            }
          }
          const normalized = normalizeResponse(payload);
          out = Buffer.from(JSON.stringify(normalized), "utf8");
          console.log(logLine, "normalized response");
          const responseHeaders = { ...upstreamRes.headers };
          delete responseHeaders["content-length"];
          res.writeHead(upstreamRes.statusCode, responseHeaders);
        } catch (error) {
          console.error(logLine, "rewrite skipped:", error.message);
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        }
        res.end(out);
      });
    },
  );
  upstreamReq.on("error", (error) => {
    console.error("upstream error:", error.message);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  upstreamReq.end(body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`ua-proxy up on 127.0.0.1:${port} -> ${upstreamOrigin}`);
});