from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import asyncio
from dataclasses import dataclass
from pathlib import Path

_codex_logger = logging.getLogger("codex_relay.codex")

from .browser import browser_context_for_task, task_needs_browser
from .config import CodexConfig
from .sessions import SessionStore, extract_session_id


MACOS_CODEX_APP_BINARY = "/Applications/Codex.app/Contents/Resources/codex"


@dataclass(frozen=True)
class CodexResult:
    ok: bool
    final_message: str
    returncode: int
    stdout: str
    stderr: str
    command: tuple[str, ...]
    session_id: str = ""


class CodexRunner:
    def __init__(self, config: CodexConfig):
        self.config = config

    def run(self, task: str, *, dry_run: bool = False) -> CodexResult:
        task = _augment_task_with_browser_context(task, self.config)
        command = self._build_command()
        if dry_run:
            return CodexResult(
                ok=True,
                final_message=_format_dry_run(command, task),
                returncode=0,
                stdout="",
                stderr="",
                command=tuple(command),
            )

        with tempfile.TemporaryDirectory(prefix="codex-relay-") as tmp:
            output_path = Path(tmp) / "last-message.md"
            command.extend(["-o", str(output_path), task])
            proc = subprocess.Popen(
                command,
                cwd=self.config.cwd,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=_exec_env(self.config),
            )
            stdout_lines: list[str] = []
            assert proc.stdout is not None
            for line in proc.stdout:
                stdout_lines.append(line)
                _log_codex_line(line.rstrip())
            try:
                proc.wait(timeout=self.config.timeout_seconds)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            stdout = "".join(stdout_lines)
            final_message = output_path.read_text(encoding="utf-8") if output_path.exists() else ""
            if not final_message.strip():
                final_message = _last_json_message(stdout) or stdout[-4000:]
            session_id = self._save_session_id(stdout, "")
            return CodexResult(
                ok=proc.returncode == 0,
                final_message=final_message.strip(),
                returncode=proc.returncode or 0,
                stdout=stdout,
                stderr="",
                command=tuple(command),
                session_id=session_id,
            )

    def _build_command(self) -> list[str]:
        resume_id = self._resume_session_id()
        command = [
            _resolve_binary(self.config.binary),
            "exec",
        ]
        if resume_id:
            command.extend(["resume", resume_id])
        command.append("--json")
        if not resume_id:
            command.extend(["--sandbox", self.config.sandbox])
        if self.config.model:
            command.extend(["--model", self.config.model])
        if self.config.reasoning_effort:
            command.extend(["--config", f"model_reasoning_effort={self.config.reasoning_effort}"])
        command.extend(self.config.extra_args)
        return command

    def _resume_session_id(self) -> str:
        if self.config.new_session:
            return ""
        if self.config.session_ref:
            return self.config.session_ref
        if self.config.session_alias:
            return SessionStore(self.config.session_store_path).resolve_alias(self.config.session_alias)
        return ""

    def _save_session_id(self, stdout: str, stderr: str) -> str:
        session_id = extract_session_id(stdout, stderr)
        session_ref = session_id or self.config.session_ref
        if session_ref and self.config.session_alias:
            SessionStore(self.config.session_store_path).set_alias(self.config.session_alias, session_ref, self.config.cwd)
        return session_ref


def _log_codex_line(line: str) -> None:
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        if line.strip():
            _codex_logger.debug("raw: %s", line)
        return
    msg_type = event.get("type", "")
    item = event.get("item", {})
    item_type = item.get("type", "")
    if item_type == "command_execution":
        cmd = item.get("command", "")
        output = (item.get("aggregated_output") or "").strip()
        exit_code = item.get("exit_code")
        status = item.get("status", "")
        if status == "in_progress":
            _codex_logger.info("run: %s", cmd[:200])
        elif output:
            _codex_logger.info("out (exit=%s): %s", exit_code, output[:400])
    elif item_type == "agent_message":
        text = (item.get("text") or "").strip()
        if text:
            _codex_logger.info("agent: %s", text[:400])
    elif msg_type not in ("thread.started", "turn.started", "turn.completed"):
        _codex_logger.debug("[%s]", msg_type)


def _last_json_message(stdout: str) -> str:
    last = ""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = event.get("message") or event.get("content") or ""
        if isinstance(message, str) and message.strip():
            last = message.strip()
    return last


def _resolve_binary(binary: str) -> str:
    if "/" in binary:
        return binary
    resolved = shutil.which(binary)
    if resolved:
        return resolved
    if binary == "codex" and shutil.which(MACOS_CODEX_APP_BINARY):
        return MACOS_CODEX_APP_BINARY
    raise FileNotFoundError(
        f"Could not find '{binary}' on PATH. Pass --binary /path/to/codex, "
        f"or add Codex to PATH. On macOS desktop installs, try: {MACOS_CODEX_APP_BINARY}"
    )


def _augment_task_with_browser_context(task: str, config: CodexConfig) -> str:
    if not config.browser_enabled:
        return task
    context = ""
    if task_needs_browser(task):
        context = asyncio.run(
            browser_context_for_task(
                task,
                max_chars_per_page=config.browser_max_chars,
                backend=config.browser_backend,
                headless=config.browser_headless,
                profile_dir=config.browser_profile_dir,
            )
        )
    tool = _browser_tool_path(config)
    sections = [task]
    if tool:
        sections.append(
            "<browser_tools>\n"
            "For browser actions against the user's existing logged-in Google Chrome, use terminal commands only. "
            "Do not use Computer Use for Chrome. Use this exact helper path:\n\n"
            f"{_quote(tool)}\n\n"
            "Examples:\n"
            f"{_quote(tool)} read\n"
            f"{_quote(tool)} click --text \"Like\" --index 1\n"
            f"{_quote(tool)} click --role button --name \"Like\" --index 1\n"
            f"{_quote(tool)} type \"hello\" --selector \"textarea\"\n"
            "</browser_tools>"
        )
    if context:
        sections.append(
            "<browser_context>\n"
            "The relay loaded the requested page before invoking Codex. Use this browser context for the answer.\n\n"
            f"{context}\n"
            "</browser_context>"
        )
    return "\n\n".join(sections)


def _browser_tool_path(config: CodexConfig) -> str:
    if config.browser_tool_path:
        return str(Path(config.browser_tool_path).expanduser())
    cwd_tool = Path(config.cwd).expanduser() / ".venv" / "bin" / "codex-relay-browser"
    if cwd_tool.exists():
        return str(cwd_tool)
    resolved = shutil.which("codex-relay-browser")
    return resolved or ""


def _exec_env(config: CodexConfig) -> dict[str, str]:
    env = os.environ.copy()
    tool = _browser_tool_path(config)
    if tool:
        tool_dir = str(Path(tool).parent)
        env["PATH"] = f"{tool_dir}{os.pathsep}{env.get('PATH', '')}"
    return env


def _shell_join(parts: list[str]) -> str:
    return " ".join(_quote(part) for part in parts)


def _quote(value: str) -> str:
    if not value or any(char.isspace() for char in value):
        return "'" + value.replace("'", "'\\''") + "'"
    return value


def _format_dry_run(command: list[str], task: str) -> str:
    return f"Dry run. Would execute:\n\n{_shell_join(command)}\n\nTask:\n{task}"
