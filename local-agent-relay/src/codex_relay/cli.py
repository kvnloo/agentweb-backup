from __future__ import annotations

import argparse
import logging
import os
import sys
from dataclasses import replace
from pathlib import Path

from .config import CodexConfig, load_config
from .http_server import serve
from .runner import CodexRunner
from .service import RelayService


def main() -> None:
    parser = argparse.ArgumentParser(description="Relay remote commands to Codex CLI.")
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="Run one Codex task locally without email.")
    run_parser.add_argument("task", nargs="?", help="Task prompt. Use '-' or omit to read stdin.")
    run_parser.add_argument("-C", "--cwd", default=".", help="Repository directory for Codex.")
    run_parser.add_argument("--binary", default="codex", help="Codex executable path.")
    run_parser.add_argument("--sandbox", default="workspace-write", choices=("read-only", "workspace-write", "danger-full-access"))
    run_parser.add_argument("--timeout", type=int, default=1800, help="Timeout in seconds.")
    run_parser.add_argument("--model", default="", help="Optional Codex model override.")
    run_parser.add_argument("--reasoning-effort", default="", help="Optional reasoning effort config value.")
    run_parser.add_argument("--extra-arg", action="append", default=[], help="Extra argument passed to codex exec. Repeatable.")
    run_parser.add_argument("--no-browser", action="store_true", help="Do not pre-load URLs with the relay browser helper.")
    run_parser.add_argument("--browser-backend", choices=("chrome", "playwright"), default="chrome", help="Use existing Chrome or Playwright.")
    run_parser.add_argument("--browser-headless", action="store_true", help="Load URLs in headless browser mode.")
    run_parser.add_argument("--browser-profile-dir", default="~/.codex-relay/chrome-profile", help="Persistent Chrome profile for browser tasks.")
    run_parser.add_argument("--browser-max-chars", type=int, default=12000, help="Maximum visible text chars to pass to Codex per page.")
    run_parser.add_argument("--session", default="", help="Codex session id or Codex thread title to resume.")
    run_parser.add_argument("--session-alias", default="", help="Optional local alias that maps to a Codex session id.")
    run_parser.add_argument("--new-session", action="store_true", help="Start a fresh Codex session.")
    run_parser.add_argument("--session-store", default="~/.codex-relay/sessions.json", help="Path to relay session alias store.")
    run_parser.add_argument("--dry-run", action="store_true", help="Print what would run without invoking Codex.")

    serve_parser = subparsers.add_parser("serve", help="Start HTTP relay server (expose via ngrok).")
    serve_parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0).")
    serve_parser.add_argument("--port", type=int, default=8080, help="Listen port (default: 8080).")
    serve_parser.add_argument("--secret", default="", help="Bearer token secret. Required for production use.")
    serve_parser.add_argument("-C", "--cwd", default=".", help="Default working directory for Codex.")
    serve_parser.add_argument("--binary", default="codex", help="Codex executable path.")
    serve_parser.add_argument("--sandbox", default="workspace-write", choices=("read-only", "workspace-write", "danger-full-access"))
    serve_parser.add_argument("--timeout", type=int, default=1800, help="Timeout in seconds.")
    serve_parser.add_argument("--model", default="", help="Optional Codex model override.")
    serve_parser.add_argument("--reasoning-effort", default="", help="Optional reasoning effort config value.")
    serve_parser.add_argument("--no-browser", action="store_true", help="Disable browser pre-loading.")
    serve_parser.add_argument("--browser-backend", choices=("chrome", "playwright"), default="chrome")
    serve_parser.add_argument("--browser-headless", action="store_true")

    poll_parser = subparsers.add_parser("poll-email", help="Poll IMAP and reply by SMTP.")
    poll_parser.add_argument("--config", default="config.toml", help="Path to config TOML file.")
    poll_parser.add_argument("--once", action="store_true", help="Poll once and exit.")
    poll_parser.add_argument("--dry-run", action="store_true", help="Override config and do not invoke Codex.")

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.command == "run":
        raise SystemExit(_run_local(args))
    if args.command == "serve":
        _run_serve(args)
        return
    if args.command == "poll-email":
        _run_email(args)
        return

    parser.error(f"Unknown command: {args.command}")


def _run_local(args: argparse.Namespace) -> int:
    task = _read_task(args.task)
    config = CodexConfig(
        binary=args.binary,
        cwd=str(Path(args.cwd).expanduser()),
        sandbox=args.sandbox,
        timeout_seconds=args.timeout,
        model=args.model,
        reasoning_effort=args.reasoning_effort,
        extra_args=tuple(args.extra_arg),
        browser_enabled=not args.no_browser,
        browser_backend=args.browser_backend,
        browser_headless=args.browser_headless,
        browser_profile_dir=args.browser_profile_dir,
        browser_max_chars=args.browser_max_chars,
        session_ref=args.session,
        session_alias=args.session_alias,
        new_session=args.new_session,
        session_store_path=args.session_store,
    )
    result = CodexRunner(config).run(task, dry_run=args.dry_run)
    print(result.final_message)
    if result.session_id:
        print(f"\nCodex session id: {result.session_id}")
    if result.stderr and not result.ok:
        print(result.stderr, file=sys.stderr)
    return 0 if result.ok else result.returncode or 1


def _run_serve(args: argparse.Namespace) -> None:
    secret = args.secret or os.environ.get("RELAY_SECRET", "")
    config = CodexConfig(
        binary=args.binary,
        cwd=str(Path(args.cwd).expanduser()),
        sandbox=args.sandbox,
        timeout_seconds=args.timeout,
        model=args.model,
        reasoning_effort=args.reasoning_effort,
        browser_enabled=not args.no_browser,
        browser_backend=args.browser_backend,
        browser_headless=args.browser_headless,
    )
    serve(host=args.host, port=args.port, default_config=config, secret=secret)


def _run_email(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    if args.dry_run:
        config = replace(config, relay=replace(config.relay, dry_run=True))

    service = RelayService(config)
    if args.once:
        service.run_once()
    else:
        service.run_forever()


def _read_task(task: str | None) -> str:
    if not task or task == "-":
        task = sys.stdin.read()
    task = task.strip()
    if not task:
        raise SystemExit("A task prompt is required.")
    return task


if __name__ == "__main__":
    main()
