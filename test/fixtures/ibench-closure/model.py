"""Deterministic local responses for self-owned closure tasks, not a benchmark solver."""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

case = sys.argv[1]
requests = []
hold = threading.Event()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *unused):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"owned-model-ready")

    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(body)
        Path("/logs/agent/owned-model-requests.json").write_text(
            json.dumps(requests, indent=2)
        )
        if case == "provider-failure":
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"owned-provider-fault"}}')
            return
        if (
            case == "budget-empty"
            or len(requests) >= 3
            and case in ("budget-work", "baseline-work")
        ):
            hold.wait(110)
            return
        calls = []
        if len(requests) == 1:
            calls = [
                {
                    "id": "read-source",
                    "type": "function",
                    "function": {
                        "name": "read",
                        "arguments": json.dumps({"path": "calc.js"}),
                    },
                }
            ]
        elif len(requests) == 2:
            calls = [
                {
                    "id": "repair-source",
                    "type": "function",
                    "function": {
                        "name": "write",
                        "arguments": json.dumps(
                            {
                                "path": "calc.js",
                                "content": "module.exports = (a, b) => a + b;\n",
                            }
                        ),
                    },
                }
            ]
            if case == "commit-failure":
                calls.append(
                    {
                        "id": "controlled-index-lock",
                        "type": "function",
                        "function": {
                            "name": "exec",
                            "arguments": json.dumps(
                                {
                                    "command": "python3",
                                    "args": [
                                        "-c",
                                        "open('.git/index.lock','w').write('owned-commit-fault')",
                                    ],
                                }
                            ),
                        },
                    }
                )
            if case == "budget-tool":
                calls.extend(
                    [
                        {
                            "id": "owned-long-command",
                            "type": "function",
                            "function": {
                                "name": "exec",
                                "arguments": json.dumps(
                                    {
                                        "command": "python3",
                                        "args": [
                                            "-c",
                                            "import time; time.sleep(120)",
                                        ],
                                    }
                                ),
                            },
                        },
                        {
                            "id": "must-not-run",
                            "type": "function",
                            "function": {
                                "name": "write",
                                "arguments": json.dumps(
                                    {
                                        "path": "must-not-run.txt",
                                        "content": "forbidden sibling",
                                    }
                                ),
                            },
                        },
                    ]
                )
        message = {
            "role": "assistant",
            "content": "" if calls else "The requested repair is complete.",
            **({"tool_calls": calls} if calls else {}),
        }
        self.send_response(200)
        self.send_header(
            "Content-Type",
            "text/event-stream" if body.get("stream") else "application/json",
        )
        self.end_headers()
        if body.get("stream"):
            if calls:
                message["tool_calls"] = [
                    {**call, "index": i} for i, call in enumerate(calls)
                ]
            chunks = [
                {
                    "id": "owned",
                    "model": "local-test",
                    "choices": [{"index": 0, "delta": message, "finish_reason": None}],
                },
                {
                    "id": "owned",
                    "model": "local-test",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {},
                            "finish_reason": "tool_calls" if calls else "stop",
                        }
                    ],
                },
            ]
            self.wfile.write(
                (
                    "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
                    + "data: [DONE]\n\n"
                ).encode()
            )
        else:
            self.wfile.write(
                json.dumps(
                    {
                        "id": "owned",
                        "model": "local-test",
                        "choices": [
                            {
                                "index": 0,
                                "message": message,
                                "finish_reason": "tool_calls" if calls else "stop",
                            }
                        ],
                    }
                ).encode()
            )


ThreadingHTTPServer(("127.0.0.1", 8766), Handler).serve_forever()
