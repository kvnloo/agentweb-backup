from __future__ import annotations


def extract_task(subject: str, body: str, prefix: str) -> str | None:
    normalized = prefix.lower()
    for candidate in (subject.strip(), body.strip()):
        if candidate.lower().startswith(normalized):
            task = candidate[len(prefix) :].strip()
            return task or None
    return None


def is_allowed_sender(sender: str, allowed_senders: tuple[str, ...]) -> bool:
    return sender.lower() in allowed_senders

