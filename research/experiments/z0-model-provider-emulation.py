#!/usr/bin/env python3
"""Local OpenRouter + TypeSafe emulators for AgentWeb/z0 campaign plumbing.

These responses are intentionally synthetic. They test transport/orchestration only
and must never be interpreted as model-quality evidence.
"""
from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

EVENTS = Path("/tmp/z0-model-provider-emulation-events.jsonl")
LOCK = threading.Lock()


def record(provider: str, path: str, body: dict[str, Any]) -> None:
    row = {
        "provider": provider,
        "path": path,
        "model": body.get("model"),
        "question_types": sorted(
            q.get("type")
            for q in (body.get("questions") or {}).values()
            if isinstance(q, dict) and isinstance(q.get("type"), str)
        ),
    }
    with LOCK:
        with EVENTS.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, sort_keys=True) + "\n")


def read_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    size = int(handler.headers.get("Content-Length", "0") or 0)
    raw = handler.rfile.read(size)
    value = json.loads(raw or b"{}")
    if not isinstance(value, dict):
        raise ValueError("request must be object")
    return value


class QuietHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args: Any) -> None:
        pass

    def json_reply(self, status: int, value: dict[str, Any]) -> None:
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            return self.json_reply(200, {"ok": True})
        return self.json_reply(404, {"error": "not_found"})


class OpenRouterHandler(QuietHandler):
    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            return self.json_reply(404, {"error": "not_found"})
        try:
            body = read_body(self)
        except Exception:
            return self.json_reply(400, {"error": "bad_json"})

        record("openrouter", self.path, body)
        messages = body.get("messages") or []
        system = " ".join(
            str(m.get("content") or "")
            for m in messages
            if isinstance(m, dict) and m.get("role") == "system"
        ).lower()

        if "classify html reports" in system:
            content = "research"
        elif "explicitly asks the assistant to stop" in system:
            content = "no"
        else:
            content = "research"

        model = str(body.get("model") or "local/openrouter-emulation")
        return self.json_reply(
            200,
            {
                "id": "chatcmpl-z0-emulation",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "provider": "z0-local-emulation",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 1,
                    "total_tokens": 13,
                    "cost": 0,
                    "is_byok": False,
                },
            },
        )


class TypeSafeHandler(QuietHandler):
    def do_POST(self) -> None:
        if self.path != "/v1/systemone":
            return self.json_reply(404, {"error": "not_found"})
        try:
            body = read_body(self)
        except Exception:
            return self.json_reply(400, {"error": "bad_json"})

        record("typesafe", self.path, body)
        answers: dict[str, Any] = {}
        for name, question in (body.get("questions") or {}).items():
            if not isinstance(question, dict):
                continue
            qtype = question.get("type")
            if qtype == "choice":
                criteria = question.get("criteria") or {}
                labels = list(criteria)
                if not labels:
                    return self.json_reply(422, {"error": "empty_choice"})
                chosen = labels[0]
                remainder = 0.02 / max(1, len(labels) - 1)
                probabilities = {
                    label: (0.98 if label == chosen else remainder)
                    for label in labels
                }
                # Exact normalization avoids floating drift for arbitrary label counts.
                total = sum(probabilities.values())
                probabilities = {k: v / total for k, v in probabilities.items()}
                answers[name] = {
                    "type": "choice",
                    "choice": chosen,
                    "confidence": probabilities[chosen],
                    "probabilities": probabilities,
                }
            elif qtype == "noul":
                answers[name] = {"type": "noul", "noul": 0.50}
            else:
                return self.json_reply(422, {"error": "unsupported_question_type"})

        return self.json_reply(
            200,
            {
                "model": "jev-1.13.0",
                "answers": answers,
                "usage": {"input_tokens": 10, "output_tokens": max(1, len(answers))},
            },
        )


def serve(port: int, handler: type[BaseHTTPRequestHandler]) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--openrouter-port", type=int, default=18080)
    parser.add_argument("--typesafe-port", type=int, default=18081)
    args = parser.parse_args()

    EVENTS.unlink(missing_ok=True)
    servers = [
        serve(args.openrouter_port, OpenRouterHandler),
        serve(args.typesafe_port, TypeSafeHandler),
    ]
    print(json.dumps({
        "event": "provider_emulation_ready",
        "openrouter_port": args.openrouter_port,
        "typesafe_port": args.typesafe_port,
    }), flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
