#!/usr/bin/env python3
"""Tiny System One-compatible fixture server for fork-only integration CI."""
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

COUNTER = Path(os.environ.get("TYPESAFE_MOCK_COUNTER", "/tmp/typesafe-mock-counts.json"))
LOCK = threading.Lock()
COUNTS = {"total": 0, "choice": 0, "noul": 0}


def persist():
    COUNTER.write_text(json.dumps(COUNTS, sort_keys=True) + "\n", encoding="utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/v1/systemone":
            return self.reply(404, {"detail": "not found"})
        size = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(size))
        question = (payload.get("questions") or {}).get("decision") or {}
        kind = question.get("type")
        if kind not in ("choice", "noul"):
            return self.reply(422, {"detail": "unsupported fixture question"})
        with LOCK:
            COUNTS["total"] += 1
            COUNTS[kind] += 1
            persist()

        if kind == "choice":
            criteria = question.get("criteria") or {}
            label = "performance" if "performance" in criteria else next(iter(criteria))
            probabilities = {
                key: (0.97 if key == label else 0.03 / max(1, len(criteria) - 1))
                for key in criteria
            }
            answer = {
                "type": "choice",
                "choice": label,
                "confidence": 0.97,
                "probabilities": probabilities,
            }
        else:
            answer = {"type": "noul", "noul": 0.93}

        return self.reply(200, {
            "model": "jev-1.13.0",
            "usage": {"input_tokens": 12, "output_tokens": 3},
            "answers": {"decision": answer},
        })


if __name__ == "__main__":
    persist()
    ThreadingHTTPServer(("127.0.0.1", 11888), Handler).serve_forever()
