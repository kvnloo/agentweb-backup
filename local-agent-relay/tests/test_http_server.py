import json
import socket
import threading
import time
import unittest
from unittest.mock import patch

from codex_relay import http_server
from codex_relay.config import CodexConfig
from codex_relay.http_server import CHUNKED_TERMINATOR, RelayHTTPServer, _encode_chunk
from codex_relay.runner import CodexResult


class EncodeChunkTests(unittest.TestCase):
    def test_encodes_length_prefixed_chunk(self):
        self.assertEqual(_encode_chunk(b" "), b"1\r\n \r\n")

    def test_encodes_hex_length_for_large_chunk(self):
        data = b"x" * 255
        self.assertEqual(_encode_chunk(data), b"FF\r\n" + data + b"\r\n")

    def test_terminator_is_zero_length_chunk(self):
        self.assertEqual(CHUNKED_TERMINATOR, b"0\r\n\r\n")


def _read_full(sock: socket.socket) -> bytes:
    sock.settimeout(20)
    chunks = []
    while True:
        try:
            data = sock.recv(4096)
        except socket.timeout:
            break
        if not data:
            break
        chunks.append(data)
        if CHUNKED_TERMINATOR in b"".join(chunks):
            break
    return b"".join(chunks)


def _parse_chunked_body(raw: bytes) -> bytes:
    """Decode an HTTP/1.1 chunked-transfer body, dropping leading whitespace chunks."""
    _, _, body = raw.partition(b"\r\n\r\n")
    decoded = bytearray()
    while body:
        size_line, _, rest = body.partition(b"\r\n")
        size = int(size_line.strip(), 16)
        if size == 0:
            break
        decoded += rest[:size]
        body = rest[size + 2:]  # skip chunk data + trailing CRLF
    return bytes(decoded)


class HeartbeatServerTests(unittest.TestCase):
    def setUp(self):
        # Shrink the interval so the test runs quickly.
        self._interval_patch = patch.object(http_server, "HEARTBEAT_INTERVAL_SECONDS", 0.2)
        self._interval_patch.start()
        self.addCleanup(self._interval_patch.stop)

        config = CodexConfig(binary="/bin/echo", cwd=".")
        self.server = RelayHTTPServer("127.0.0.1", 0, config, secret="topsecret")
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._shutdown)

    def _shutdown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def _post_task(self, *, auth: bool = True) -> bytes:
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=20)
        body = json.dumps({"task": "browse https://example.com", "timeout_seconds": 5}).encode()
        headers = [
            f"POST /task HTTP/1.1",
            f"Host: 127.0.0.1:{self.port}",
            "Content-Type: application/json",
            f"Content-Length: {len(body)}",
            "Connection: close",
        ]
        if auth:
            headers.append("Authorization: Bearer topsecret")
        request = ("\r\n".join(headers) + "\r\n\r\n").encode() + body
        sock.sendall(request)
        raw = _read_full(sock)
        sock.close()
        return raw

    def test_long_task_sends_heartbeats_then_final_body(self):
        slow_result = CodexResult(
            ok=True,
            final_message="scan complete",
            returncode=0,
            stdout="",
            stderr="",
            command=("codex",),
            session_id="sess-123",
        )

        def slow_run(self_runner, task, *, dry_run=False):
            time.sleep(0.7)  # spans multiple 0.2s heartbeats
            return slow_result

        with patch("codex_relay.runner.CodexRunner.run", slow_run):
            raw = self._post_task()

        # Chunked encoding is only valid over HTTP/1.1; the handler must advertise it
        # or clients (curl, Node) read the chunk framing literally instead of decoding.
        self.assertTrue(raw.startswith(b"HTTP/1.1 200"))
        self.assertIn(b"chunked", raw.lower())
        # At least one whitespace heartbeat chunk should precede the final body.
        self.assertIn(b"1\r\n \r\n", raw)
        self.assertIn(CHUNKED_TERMINATOR, raw)

        parsed = json.loads(_parse_chunked_body(raw))
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["result"], "scan complete")
        self.assertEqual(parsed["session_id"], "sess-123")

    def test_runner_error_returns_ok_false_body(self):
        def boom(self_runner, task, *, dry_run=False):
            raise RuntimeError("chromium crashed")

        with patch("codex_relay.runner.CodexRunner.run", boom):
            raw = self._post_task()

        parsed = json.loads(_parse_chunked_body(raw))
        self.assertFalse(parsed["ok"])
        self.assertIn("chromium crashed", parsed["error"])

    def test_missing_auth_is_rejected(self):
        raw = self._post_task(auth=False)
        self.assertIn(b"401", raw)
        self.assertIn(b"unauthorized", raw)


if __name__ == "__main__":
    unittest.main()
