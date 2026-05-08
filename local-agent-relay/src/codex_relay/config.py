from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


_ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


@dataclass(frozen=True)
class RelayConfig:
    poll_seconds: int = 60
    command_prefix: str = "codex:"
    dry_run: bool = True
    mark_seen: bool = True
    allowed_senders: tuple[str, ...] = ()


@dataclass(frozen=True)
class ImapConfig:
    host: str
    port: int = 993
    username: str = ""
    password: str = ""
    mailbox: str = "INBOX"


@dataclass(frozen=True)
class SmtpConfig:
    host: str
    port: int = 587
    username: str = ""
    password: str = ""
    from_addr: str = ""
    use_tls: bool = True


@dataclass(frozen=True)
class CodexConfig:
    binary: str = "codex"
    cwd: str = "."
    sandbox: str = "workspace-write"
    timeout_seconds: int = 1800
    model: str = ""
    reasoning_effort: str = ""
    extra_args: tuple[str, ...] = field(default_factory=tuple)
    browser_enabled: bool = True
    browser_backend: str = "chrome"
    browser_headless: bool = False
    browser_profile_dir: str = "~/.codex-relay/chrome-profile"
    browser_max_chars: int = 12000
    browser_tool_path: str = ""
    session_ref: str = ""
    session_alias: str = ""
    new_session: bool = False
    session_store_path: str = "~/.codex-relay/sessions.json"


@dataclass(frozen=True)
class AppConfig:
    relay: RelayConfig
    imap: ImapConfig
    smtp: SmtpConfig
    codex: CodexConfig


def load_config(path: str | Path) -> AppConfig:
    raw = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    expanded = _expand_env(raw)

    relay = expanded.get("relay", {})
    imap = expanded.get("imap", {})
    smtp = expanded.get("smtp", {})
    codex = expanded.get("codex", {})

    return AppConfig(
        relay=RelayConfig(
            poll_seconds=int(relay.get("poll_seconds", 60)),
            command_prefix=str(relay.get("command_prefix", "codex:")),
            dry_run=bool(relay.get("dry_run", True)),
            mark_seen=bool(relay.get("mark_seen", True)),
            allowed_senders=tuple(str(s).lower() for s in relay.get("allowed_senders", [])),
        ),
        imap=ImapConfig(
            host=str(imap["host"]),
            port=int(imap.get("port", 993)),
            username=str(imap.get("username", "")),
            password=str(imap.get("password", "")),
            mailbox=str(imap.get("mailbox", "INBOX")),
        ),
        smtp=SmtpConfig(
            host=str(smtp["host"]),
            port=int(smtp.get("port", 587)),
            username=str(smtp.get("username", "")),
            password=str(smtp.get("password", "")),
            from_addr=str(smtp.get("from_addr", "")),
            use_tls=bool(smtp.get("use_tls", True)),
        ),
        codex=CodexConfig(
            binary=str(codex.get("binary", "codex")),
            cwd=str(codex.get("cwd", ".")),
            sandbox=str(codex.get("sandbox", "workspace-write")),
            timeout_seconds=int(codex.get("timeout_seconds", 1800)),
            model=str(codex.get("model", "")),
            reasoning_effort=str(codex.get("reasoning_effort", "")),
            extra_args=tuple(str(arg) for arg in codex.get("extra_args", [])),
            browser_enabled=bool(codex.get("browser_enabled", True)),
            browser_backend=str(codex.get("browser_backend", "chrome")),
            browser_headless=bool(codex.get("browser_headless", False)),
            browser_profile_dir=str(codex.get("browser_profile_dir", "~/.codex-relay/chrome-profile")),
            browser_max_chars=int(codex.get("browser_max_chars", 12000)),
            browser_tool_path=str(codex.get("browser_tool_path", "")),
            session_ref=str(codex.get("session_ref", "")),
            session_alias=str(codex.get("session_alias", "")),
            new_session=bool(codex.get("new_session", False)),
            session_store_path=str(codex.get("session_store_path", "~/.codex-relay/sessions.json")),
        ),
    )


def _expand_env(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _expand_env(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_expand_env(item) for item in value]
    if isinstance(value, str):
        return _ENV_PATTERN.sub(lambda match: os.environ.get(match.group(1), ""), value)
    return value
