from __future__ import annotations

import email
import imaplib
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage, Message
from email.policy import default
from email.utils import getaddresses, make_msgid, parseaddr

from .config import ImapConfig, SmtpConfig


@dataclass(frozen=True)
class InboundMessage:
    uid: str
    sender: str
    reply_to: str
    subject: str
    body: str
    message_id: str


class EmailChannel:
    def __init__(self, imap: ImapConfig, smtp: SmtpConfig):
        self.imap = imap
        self.smtp = smtp

    def fetch_unseen(self) -> list[InboundMessage]:
        with imaplib.IMAP4_SSL(self.imap.host, self.imap.port) as conn:
            if self.imap.username:
                conn.login(self.imap.username, self.imap.password)
            conn.select(self.imap.mailbox)
            status, data = conn.uid("search", None, "UNSEEN")
            if status != "OK":
                raise RuntimeError(f"IMAP search failed: {status}")

            messages: list[InboundMessage] = []
            for uid_bytes in data[0].split():
                uid = uid_bytes.decode("ascii")
                fetch_status, fetch_data = conn.uid("fetch", uid, "(RFC822)")
                if fetch_status != "OK":
                    continue
                raw = _extract_raw_message(fetch_data)
                if raw is None:
                    continue
                messages.append(parse_message(uid, raw))
            return messages

    def mark_seen(self, uid: str) -> None:
        with imaplib.IMAP4_SSL(self.imap.host, self.imap.port) as conn:
            if self.imap.username:
                conn.login(self.imap.username, self.imap.password)
            conn.select(self.imap.mailbox)
            conn.uid("store", uid, "+FLAGS", "\\Seen")

    def send_reply(self, inbound: InboundMessage, body: str) -> None:
        msg = EmailMessage()
        msg["From"] = self.smtp.from_addr
        msg["To"] = inbound.reply_to or inbound.sender
        msg["Subject"] = f"Re: {inbound.subject}"
        msg["Message-ID"] = make_msgid()
        if inbound.message_id:
            msg["In-Reply-To"] = inbound.message_id
            msg["References"] = inbound.message_id
        msg.set_content(body)

        with smtplib.SMTP(self.smtp.host, self.smtp.port) as conn:
            if self.smtp.use_tls:
                conn.starttls()
            if self.smtp.username:
                conn.login(self.smtp.username, self.smtp.password)
            conn.send_message(msg)


def parse_message(uid: str, raw: bytes) -> InboundMessage:
    msg = email.message_from_bytes(raw, policy=default)
    sender = parseaddr(msg.get("From", ""))[1].lower()
    reply_to = parseaddr(msg.get("Reply-To", ""))[1].lower() or sender
    return InboundMessage(
        uid=uid,
        sender=sender,
        reply_to=reply_to,
        subject=str(msg.get("Subject", "")),
        body=_message_body(msg),
        message_id=str(msg.get("Message-ID", "")),
    )


def _extract_raw_message(fetch_data: list[bytes | tuple[bytes, bytes]]) -> bytes | None:
    for item in fetch_data:
        if isinstance(item, tuple) and len(item) == 2:
            return item[1]
    return None


def _message_body(msg: Message) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_maintype() == "multipart":
                continue
            if part.get_content_type() == "text/plain":
                return part.get_content()
        return ""
    if msg.get_content_type() == "text/plain":
        return msg.get_content()
    return ""


def all_recipients(header_value: str) -> list[str]:
    return [addr.lower() for _, addr in getaddresses([header_value]) if addr]

