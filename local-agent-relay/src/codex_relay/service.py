from __future__ import annotations

import logging
import subprocess
import time

from .commands import extract_task, is_allowed_sender
from .config import AppConfig
from .email_channel import EmailChannel, InboundMessage
from .runner import CodexRunner


LOGGER = logging.getLogger(__name__)


class RelayService:
    def __init__(self, config: AppConfig, channel: EmailChannel | None = None, runner: CodexRunner | None = None):
        self.config = config
        self.channel = channel or EmailChannel(config.imap, config.smtp)
        self.runner = runner or CodexRunner(config.codex)

    def run_forever(self) -> None:
        while True:
            self.run_once()
            time.sleep(self.config.relay.poll_seconds)

    def run_once(self) -> None:
        messages = self.channel.fetch_unseen()
        for message in messages:
            self._handle_message(message)

    def _handle_message(self, message: InboundMessage) -> None:
        if not is_allowed_sender(message.sender, self.config.relay.allowed_senders):
            LOGGER.warning("Ignoring message from non-allowlisted sender: %s", message.sender)
            return

        task = extract_task(message.subject, message.body, self.config.relay.command_prefix)
        if not task:
            LOGGER.info("Ignoring message without command prefix from %s", message.sender)
            return

        LOGGER.info("Running Codex task from %s: %s", message.sender, task[:120])
        try:
            result = self.runner.run(task, dry_run=self.config.relay.dry_run)
            reply = format_reply(result.ok, result.returncode, result.final_message, result.session_id)
        except subprocess.TimeoutExpired as exc:  # type: ignore[name-defined]
            reply = format_reply(False, -1, f"Codex timed out after {exc.timeout} seconds.")
        except Exception as exc:
            LOGGER.exception("Relay failed")
            reply = format_reply(False, -1, f"Relay failed before Codex completed:\n\n{exc}")

        self.channel.send_reply(message, reply)
        if self.config.relay.mark_seen:
            self.channel.mark_seen(message.uid)


def format_reply(ok: bool, returncode: int, final_message: str, session_id: str = "") -> str:
    status = "completed" if ok else "failed"
    session_text = f"\nCodex session id: {session_id}\n" if session_id else ""
    return (
        f"Codex job {status}.\n"
        f"Return code: {returncode}\n"
        f"{session_text}\n"
        f"{final_message.strip() or '(no output)'}\n"
    )
