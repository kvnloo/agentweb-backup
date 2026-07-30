#!/opt/agent-engine-alert/venv/bin/python
"""
Standalone process-failure alert for agent-engine.service.

Deliberately self-contained — does NOT import secrets_manager.py or anything
else from /opt/agent-engine/agentweb (the agentengine-owned checkout).
If agentengine is ever compromised, it must not be able to tamper with the
one thing that's supposed to report that. This script, its interpreter, and
its venv live under /opt/agent-engine-alert, root-owned and read/execute-only
for agentengine (see deploy/RUNBOOK.md's Provisioning section). Duplicating
~15 lines of secret-fetch logic here is the deliberate cost of that
isolation — do not "simplify" this by importing secrets_manager.py.
"""
import smtplib
import socket
import sys
from datetime import datetime, timezone
from email.mime.text import MIMEText

from google.cloud import secretmanager

GCP_PROJECT_ID = "agent-engine-460619"
SMTP_SECRET_ID = "agentengine-prod-smtp"
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587
ALERT_RECIPIENT = "harsha@agentweb.pro"


def get_smtp_credentials() -> dict:
    import json

    client = secretmanager.SecretManagerServiceClient()
    name = f"projects/{GCP_PROJECT_ID}/secrets/{SMTP_SECRET_ID}/versions/latest"
    response = client.access_secret_version(request={"name": name})
    return json.loads(response.payload.data.decode("UTF-8"))


def main():
    failed_unit = sys.argv[1] if len(sys.argv) > 1 else "agent-engine.service"
    host = socket.gethostname()
    timestamp = datetime.now(timezone.utc).isoformat()

    creds = get_smtp_credentials()

    msg = MIMEText(
        f"agent-engine ({failed_unit}) failed and exhausted its systemd "
        f"restart limit on {host} at {timestamp}. Scheduled chats are down "
        f"until this is manually restarted (systemctl restart agent-engine)."
    )
    msg["Subject"] = "[URGENT] agent-engine process failure - auto-restart exhausted"
    msg["From"] = creds["user"]
    msg["To"] = ALERT_RECIPIENT

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.starttls()
        server.login(creds["user"], creds["pass"])
        server.send_message(msg)

    print(f"Sent process-failure alert to {ALERT_RECIPIENT}")


if __name__ == "__main__":
    main()
