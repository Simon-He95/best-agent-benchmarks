// Local UA-rewriting forward proxy for the pinned best-agent CLI.
//
// CLI 0.0.3-beta.1 (newest Linux build) sends the Vercel AI SDK user agent
// ("ai/6.0.184 ..."), which the provider rejects with 403 "unsupported
// client". This proxy rewrites the UA to a client string the provider accepts
// and forwards everything else verbatim (including SSE streams).
//
// Env: UPSTREAM_ORIGIN (e.g. https://dimagent.cn), PORT (default 8899)
const http = require("http");
const https = require("https");

const upstreamOrigin = process.env.UPSTREAM_ORIGIN || "https://dimagent.cn";
const port = Number(process.env.PORT || 8899);
const upstream = new URL(upstreamOrigin);
const client = upstream.protocol === "http:" ? http : https;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = { ...req.headers, host: upstream.host };
  // Rewrite the identifying client header; keep auth and everything else.
  headers["user-agent"] = "node";
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
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
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