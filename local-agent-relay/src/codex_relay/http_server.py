"""HTTP relay server — exposes a POST /task endpoint that runs Codex locally.

Run with:
    codex-relay serve [--port 8080] [--secret mytoken] [--cwd /repo]

Then expose via ngrok:
    ngrok http 8080

The AgentWeb backend posts tasks to this server and gets back the Codex result.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import mimetypes
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import urlparse

from .config import CodexConfig
from .runner import CodexRunner, SCREENSHOTS_BASE_DIR

logger = logging.getLogger(__name__)

# ngrok (and most reverse proxies) drop a connection after 300s with no bytes
# flowing from the upstream. Long browser scans buffer their whole result until
# the end, so we emit a whitespace keep-alive on this interval to reset that
# idle clock. Leading whitespace is valid JSON, so the final body still parses.
HEARTBEAT_INTERVAL_SECONDS = 30


def _encode_chunk(data: bytes) -> bytes:
    """Frame a byte string as a single HTTP/1.1 transfer-encoding chunk."""
    return f"{len(data):X}\r\n".encode("ascii") + data + b"\r\n"


CHUNKED_TERMINATOR = b"0\r\n\r\n"


class RelayRequestHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler — avoids FastAPI/Flask dependency."""

    # Chunked transfer-encoding (used for the /task heartbeat) is only valid over
    # HTTP/1.1; under the default HTTP/1.0 clients read the chunk framing literally.
    protocol_version = "HTTP/1.1"

    server: "RelayHTTPServer"  # type annotation for IDE

    def log_message(self, fmt: str, *args: object) -> None:
        logger.info(fmt, *args)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def _send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_auth(self) -> bool:
        secret = self.server.secret
        if not secret:
            return True
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[len("Bearer "):]
            return hmac.compare_digest(
                hashlib.sha256(token.encode()).digest(),
                hashlib.sha256(secret.encode()).digest(),
            )
        return False

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json(200, {"status": "ok", "version": "1.0"})
        elif path.startswith("/files/"):
            self._serve_file(path)
        else:
            self._send_json(404, {"error": "not found"})

    def _serve_file(self, path: str) -> None:
        if not self._check_auth():
            self._send_json(401, {"error": "unauthorized"})
            return
        # path is /files/{run_id}/{filename} — strip leading /files/
        rel = path[len("/files/"):]
        # Reject any path traversal attempts
        if ".." in rel or rel.startswith("/"):
            self._send_json(400, {"error": "invalid path"})
            return
        file_path = SCREENSHOTS_BASE_DIR / rel
        if not file_path.is_file():
            self._send_json(404, {"error": "file not found"})
            return
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/task":
            self._send_json(404, {"error": "not found"})
            return

        if not self._check_auth():
            self._send_json(401, {"error": "unauthorized"})
            return

        raw = self._read_body()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON"})
            return

        task = payload.get("task", "").strip()
        if not task:
            self._send_json(400, {"error": "missing 'task' field"})
            return

        # Build config — allow per-request overrides on top of server defaults
        base = self.server.default_config
        config = CodexConfig(
            binary=base.binary,
            cwd=str(payload.get("cwd", base.cwd) or base.cwd),
            sandbox=str(payload.get("sandbox", base.sandbox)),
            timeout_seconds=int(payload.get("timeout_seconds", base.timeout_seconds)),
            model=str(payload.get("model", base.model)),
            reasoning_effort=str(payload.get("reasoning_effort", base.reasoning_effort)),
            extra_args=base.extra_args,
            browser_enabled=bool(payload.get("browser_enabled", base.browser_enabled)),
            browser_backend=str(payload.get("browser_backend", base.browser_backend)),
            browser_headless=bool(payload.get("browser_headless", base.browser_headless)),
            browser_profile_dir=base.browser_profile_dir,
            browser_max_chars=base.browser_max_chars,
            browser_tool_path=base.browser_tool_path,
            session_ref=str(payload.get("session_ref", base.session_ref)),
            session_alias=str(payload.get("session_alias", base.session_alias)),
            new_session=bool(payload.get("new_session", base.new_session)),
            session_store_path=base.session_store_path,
        )

        logger.info("Running task (len=%d): %s…", len(task), task[:120])
        runner = CodexRunner(config)
        self._run_task_with_heartbeat(runner, task)

    def _run_task_with_heartbeat(self, runner: "CodexRunner", task: str) -> None:
        """Run the (possibly multi-minute) task while keeping the connection alive.

        Codex buffers its whole result until the end, which can exceed the proxy's
        300s idle timeout. We send chunked-encoding keep-alive whitespace every
        HEARTBEAT_INTERVAL_SECONDS so the tunnel never sees an idle connection,
        then deliver the real JSON body as the final chunk.
        """
        result_box: dict[str, object] = {}

        def _worker() -> None:
            try:
                result_box["result"] = runner.run(task)
            except Exception as exc:  # noqa: BLE001 — surfaced to client below
                logger.exception("Runner error")
                result_box["error"] = str(exc)

        worker = threading.Thread(target=_worker, daemon=True)
        worker.start()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        try:
            while worker.is_alive():
                worker.join(timeout=HEARTBEAT_INTERVAL_SECONDS)
                if worker.is_alive():
                    self.wfile.write(_encode_chunk(b" "))
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            logger.warning("Client disconnected during task; finishing run in background")
            return

        if "error" in result_box:
            body = json.dumps({"ok": False, "error": result_box["error"]})
        else:
            result = result_box["result"]
            run_id = Path(result.screenshot_dir).name if result.screenshot_dir else ""
            body = json.dumps({
                "ok": result.ok,
                "result": result.final_message,
                "session_id": result.session_id,
                "returncode": result.returncode,
                "screenshots": [
                    {"name": name, "url": f"/files/{run_id}/{name}"}
                    for name in result.screenshots
                ],
            })

        try:
            self.wfile.write(_encode_chunk(body.encode("utf-8")))
            self.wfile.write(CHUNKED_TERMINATOR)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            logger.warning("Client disconnected before final body could be sent")


class RelayHTTPServer(ThreadingMixIn, HTTPServer):
    """Each incoming request is handled in its own thread, allowing concurrent tasks."""
    daemon_threads = True

    def __init__(
        self,
        host: str,
        port: int,
        default_config: CodexConfig,
        secret: str = "",
    ) -> None:
        super().__init__((host, port), RelayRequestHandler)
        self.default_config = default_config
        self.secret = secret


def serve(
    host: str = "0.0.0.0",
    port: int = 8080,
    default_config: CodexConfig | None = None,
    secret: str = "",
) -> None:
    if default_config is None:
        default_config = CodexConfig()
    server = RelayHTTPServer(host, port, default_config, secret)
    logger.info("Local agent relay listening on http://%s:%d", host, port)
    if secret:
        logger.info("Bearer token auth enabled.")
    else:
        logger.warning("No secret set — relay is open to anyone who can reach it. Use --secret.")
    server.serve_forever()
