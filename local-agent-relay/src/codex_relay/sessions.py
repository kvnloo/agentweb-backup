from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_SESSION_STORE = "~/.codex-relay/sessions.json"
SESSION_ID_PATTERN = re.compile(r"session_id['\"]?\s*[:=]\s*['\"]?([0-9a-fA-F-]{36})")
UUID_PATTERN = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")


@dataclass(frozen=True)
class SessionRecord:
    alias: str
    session_ref: str
    cwd: str


class SessionStore:
    def __init__(self, path: str | Path = DEFAULT_SESSION_STORE):
        self.path = Path(path).expanduser()

    def resolve_alias(self, alias: str) -> str:
        item = self._read().get("aliases", {}).get(alias)
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            return str(item.get("session_ref") or item.get("session_id") or "")
        return ""

    def set_alias(self, alias: str, session_ref: str, cwd: str) -> None:
        data = self._read()
        data.setdefault("aliases", {})[alias] = {"session_ref": session_ref, "cwd": cwd}
        self._write(data)

    def get_alias(self, alias: str) -> SessionRecord | None:
        item = self._read().get("aliases", {}).get(alias)
        if not isinstance(item, dict):
            return None
        session_ref = str(item.get("session_ref") or item.get("session_id") or "")
        if not session_ref:
            return None
        return SessionRecord(alias=alias, session_ref=session_ref, cwd=str(item.get("cwd", "")))

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"aliases": {}}
        return migrate_session_store(json.loads(self.path.read_text(encoding="utf-8")))

    def _write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def migrate_session_store(data: dict[str, Any]) -> dict[str, Any]:
    if set(data.keys()) == {"aliases"} or ("aliases" in data and "sessions" not in data):
        data.setdefault("aliases", {})
        return data

    aliases: dict[str, Any] = {}
    for key, item in data.items():
        if key == "sessions" and isinstance(item, dict):
            for session_item in item.values():
                if isinstance(session_item, dict) and session_item.get("alias"):
                    aliases[str(session_item["alias"])] = {
                        "session_ref": str(session_item.get("session_id", "")),
                        "cwd": str(session_item.get("cwd", "")),
                    }
        elif isinstance(item, dict):
            aliases[str(key)] = {
                "session_ref": str(item.get("session_ref") or item.get("session_id") or ""),
                "cwd": str(item.get("cwd", "")),
            }
    return {"aliases": aliases}


def extract_session_id(stdout: str, stderr: str = "") -> str:
    combined = f"{stdout}\n{stderr}"
    for pattern in (SESSION_ID_PATTERN, UUID_PATTERN):
        match = pattern.search(combined)
        if match:
            return match.group(1) if match.lastindex else match.group(0)
    return ""

