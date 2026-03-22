#!/usr/bin/env python3
"""
prod-log-monitor-scan.py — Downloads EB tail logs, scans for patterns, sends alerts.
Called by prod-log-monitor.sh. Reads log URLs from stdin (JSON from EB retrieve API).
"""

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import smtplib
import sys
import time
import urllib.request
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional

ALERT_EMAIL = "ruiw@agentweb.pro"
SUPPRESS_WINDOW = 7200  # 2 hours
MAX_DOWNLOAD_SIZE = 5 * 1024 * 1024  # 5MB per log file
MAX_MATCH_LINES = 80  # max lines per pattern match to include in email

# ─── Patterns ─────────────────────────────────────────────────────────────────

BUG_PATTERNS = [
    ("UnhandledRejection", r"UnhandledPromiseRejection|unhandledRejection"),
    ("FATAL/OOM/SIGKILL", r"FATAL|OOMKilled|SIGKILL"),
    ("Heap OOM", r"heap out of memory|allocation failed"),
    ("Property/Function Error", r"Cannot read propert|is not a function|is not defined"),
    ("Connection Error", r"ECONNREFUSED|ETIMEDOUT|ENOTFOUND"),
    ("TypeError/ReferenceError", r"TypeError:|ReferenceError:|SyntaxError:"),
]

INTRUSION_PATTERNS = [
    ("SQL Injection", r"UNION\s+SELECT|OR\s+1\s*=\s*1|';\s*DROP"),
    ("Path Traversal", r"\.\./|%2e%2e%2f|%252e%252e"),
]

NGINX_5XX_RE = re.compile(r'" 5\d\d ')


# ─── State management ────────────────────────────────────────────────────────

def load_state(state_file: str) -> dict:
    try:
        with open(state_file) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state_file: str, state: dict):
    now = int(time.time())
    state["lastRun"] = now
    # Prune alerts older than 24h
    alerts = state.get("alerts", {})
    cutoff = now - 86400
    state["alerts"] = {k: v for k, v in alerts.items() if v > cutoff}
    with open(state_file, "w") as f:
        json.dump(state, f, indent=2)


def alert_hash(key: str) -> str:
    return hashlib.md5(key.encode()).hexdigest()[:16]


def is_suppressed(state: dict, h: str) -> bool:
    ts = state.get("alerts", {}).get(h, 0)
    return (int(time.time()) - ts) < SUPPRESS_WINDOW


def record_alert(state: dict, h: str):
    state.setdefault("alerts", {})[h] = int(time.time())


# ─── Email ────────────────────────────────────────────────────────────────────

def load_smtp_config(backend_env: str) -> dict:
    config = {}
    with open(backend_env) as f:
        for line in f:
            line = line.strip()
            if line.startswith("SMTP_USER="):
                config["user"] = line.split("=", 1)[1]
            elif line.startswith("SMTP_PASS="):
                config["pass"] = line.split("=", 1)[1]
            elif line.startswith("FROM_EMAIL="):
                config["from"] = line.split("=", 1)[1]
    if not all(k in config for k in ("user", "pass", "from")):
        raise RuntimeError(f"SMTP config incomplete in {backend_env}")
    return config


def send_email(smtp_config: dict, subject: str, body_html: str):
    msg = MIMEMultipart("alternative")
    msg["From"] = smtp_config["from"]
    msg["To"] = ALERT_EMAIL
    msg["Subject"] = subject
    msg.attach(MIMEText(body_html, "html"))

    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(smtp_config["user"], smtp_config["pass"])
        server.sendmail(smtp_config["from"], ALERT_EMAIL, msg.as_string())
    print(f"  Email sent: {subject}")


def build_alert_html(
    category: str,
    env_label: str,
    env_name: str,
    log_file: str,
    instance_id: str,
    matches: str,
) -> str:
    escaped = html.escape(matches)
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S UTC")
    return f"""<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
  <div style="background-color: #dc3545; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 22px;">[{html.escape(env_label.upper())}] Log Alert: {html.escape(category)}</h1>
  </div>
  <div style="background-color: white; padding: 20px; border-radius: 0 0 8px 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr><td style="padding: 6px 12px; font-weight: bold; color: #666;">Environment</td><td style="padding: 6px 12px;">{html.escape(env_name)}</td></tr>
      <tr><td style="padding: 6px 12px; font-weight: bold; color: #666;">Instance</td><td style="padding: 6px 12px;">{html.escape(instance_id)}</td></tr>
      <tr><td style="padding: 6px 12px; font-weight: bold; color: #666;">Log File</td><td style="padding: 6px 12px;">{html.escape(log_file)}</td></tr>
      <tr><td style="padding: 6px 12px; font-weight: bold; color: #666;">Detected At</td><td style="padding: 6px 12px;">{timestamp}</td></tr>
    </table>
    <h3 style="color: #dc3545; margin-top: 0;">Matching Lines:</h3>
    <pre style="background-color: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 6px; overflow-x: auto; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word;">{escaped}</pre>
  </div>
</div>"""


# ─── Download ─────────────────────────────────────────────────────────────────

def download_logs(log_json: dict, temp_dir: str) -> list[tuple[str, str]]:
    """Download log files, returns list of (instance_id, filepath) tuples."""
    os.makedirs(temp_dir, exist_ok=True)
    # Clean previous run
    for f in Path(temp_dir).glob("*.log"):
        f.unlink()

    infos = log_json.get("EnvironmentInfo", [])
    if not infos:
        print("  No log entries returned")
        return []

    downloaded = []
    for i, info in enumerate(infos):
        instance_id = info.get("Ec2InstanceId", "unknown")
        url = info.get("Message", "")
        if not url:
            continue

        outfile = os.path.join(temp_dir, f"{instance_id}_{i:03d}.log")
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read(MAX_DOWNLOAD_SIZE + 1)
                if len(data) > MAX_DOWNLOAD_SIZE:
                    print(f"  WARNING: Log from {instance_id} (entry {i}) exceeds 5MB, truncating")
                    data = data[:MAX_DOWNLOAD_SIZE]
                with open(outfile, "wb") as f:
                    f.write(data)
                downloaded.append((instance_id, outfile))
        except Exception as e:
            print(f"  WARNING: Failed to download log {i} from {instance_id}: {e}")

    unique_instances = len(set(inst for inst, _ in downloaded))
    print(f"  Downloaded {len(downloaded)} log file(s) from {unique_instances} instance(s)")
    return downloaded


# ─── Scan ─────────────────────────────────────────────────────────────────────

def grep_with_context(content: str, pattern: str, context: int = 3) -> Optional[str]:
    """Search content for pattern (case-insensitive), return matches with context lines."""
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error:
        return None

    lines = content.splitlines()
    match_indices = set()
    for i, line in enumerate(lines):
        if regex.search(line):
            for j in range(max(0, i - context), min(len(lines), i + context + 1)):
                match_indices.add(j)

    if not match_indices:
        return None

    sorted_indices = sorted(match_indices)
    result_lines = []
    for idx, i in enumerate(sorted_indices):
        # Add separator between non-contiguous blocks
        if idx > 0 and sorted_indices[idx - 1] < i - 1:
            result_lines.append("--")
        result_lines.append(lines[i])

    # Truncate
    output = "\n".join(result_lines[:MAX_MATCH_LINES])
    if len(result_lines) > MAX_MATCH_LINES:
        output += f"\n... ({len(result_lines) - MAX_MATCH_LINES} more lines)"
    return output


def scan_logs(
    downloaded: list[tuple[str, str]],
    state: dict,
    smtp_config: dict,
    env_name: str,
    env_label: str,
) -> int:
    alerts_sent = 0

    for instance_id, filepath in downloaded:
        try:
            with open(filepath, errors="replace") as f:
                content = f.read()
        except Exception as e:
            print(f"  WARNING: Cannot read {filepath}: {e}")
            continue

        if not content.strip():
            continue

        # Bug patterns
        for category, pattern in BUG_PATTERNS:
            matches = grep_with_context(content, pattern)
            if not matches:
                continue

            h = alert_hash(f"bug:{pattern}:{instance_id}")
            if is_suppressed(state, h):
                print(f"  Suppressed: {category} on {instance_id}")
                continue

            print(f"  ALERT: {category} on {instance_id}")
            body = build_alert_html(
                f"Bug: {category}", env_label, env_name,
                "tail logs", instance_id, matches,
            )
            try:
                send_email(smtp_config, f"[{env_label.upper()} ALERT] Bug: {category}", body)
                record_alert(state, h)
                alerts_sent += 1
            except Exception as e:
                print(f"  ERROR sending email: {e}")

        # Intrusion patterns
        for category, pattern in INTRUSION_PATTERNS:
            matches = grep_with_context(content, pattern)
            if not matches:
                continue

            h = alert_hash(f"intrusion:{pattern}:{instance_id}")
            if is_suppressed(state, h):
                print(f"  Suppressed: {category} on {instance_id}")
                continue

            print(f"  ALERT: {category} on {instance_id}")
            body = build_alert_html(
                f"Intrusion: {category}", env_label, env_name,
                "tail logs", instance_id, matches,
            )
            try:
                send_email(smtp_config, f"[{env_label.upper()} ALERT] Intrusion: {category}", body)
                record_alert(state, h)
                alerts_sent += 1
            except Exception as e:
                print(f"  ERROR sending email: {e}")

        # Nginx 5xx spike
        fivexx_lines = [line for line in content.splitlines() if NGINX_5XX_RE.search(line)]
        if len(fivexx_lines) >= 10:
            h = alert_hash(f"5xx:{instance_id}:{len(fivexx_lines)}")
            if not is_suppressed(state, h):
                count = len(fivexx_lines)
                print(f"  ALERT: {count} 5xx responses on {instance_id}")
                snippet = "\n".join(fivexx_lines[-20:])
                body = build_alert_html(
                    f"5xx Spike ({count} responses)", env_label, env_name,
                    "nginx access.log", instance_id, snippet,
                )
                try:
                    send_email(smtp_config, f"[{env_label.upper()} ALERT] 5xx spike: {count} errors", body)
                    record_alert(state, h)
                    alerts_sent += 1
                except Exception as e:
                    print(f"  ERROR sending email: {e}")

    return alerts_sent


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-name", required=True)
    parser.add_argument("--env-label", required=True)
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--backend-env", required=True)
    parser.add_argument("--temp-dir", required=True)
    parser.add_argument("--test-email", action="store_true")
    args = parser.parse_args()

    smtp_config = load_smtp_config(args.backend_env)
    state = load_state(args.state_file)

    if args.test_email:
        test_body = build_alert_html(
            "Test Alert", args.env_label, args.env_name,
            "test", "test-instance",
            f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] This is a test alert from prod-log-monitor.\n"
            f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Environment: {args.env_name}\n"
            f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] If you received this, email alerts are working.",
        )
        send_email(smtp_config, f"[{args.env_label.upper()} ALERT] Test alert from prod-log-monitor", test_body)
        return

    # Read EB retrieve JSON from stdin
    log_json = json.load(sys.stdin)

    downloaded = download_logs(log_json, args.temp_dir)
    if not downloaded:
        print("  No logs to scan")
        save_state(args.state_file, state)
        return

    alerts_sent = scan_logs(downloaded, state, smtp_config, args.env_name, args.env_label)
    state["lastRunEnv"] = args.env_label
    save_state(args.state_file, state)

    # Cleanup
    shutil.rmtree(args.temp_dir, ignore_errors=True)
    print(f"  Scan complete. Alerts sent: {alerts_sent}")


if __name__ == "__main__":
    main()
