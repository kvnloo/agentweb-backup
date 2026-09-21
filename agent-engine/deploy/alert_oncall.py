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

Runs as its own dedicated OS user (agentengine-alert, not agentengine) and
its own dedicated GCP service account (agentengine-alerter@..., not the VM's
shared instance identity) — see ALERTER_KEY_PATH below. agentengine must
NOT have read access to the key file; that's what stops a compromised main
workload from forging or suppressing its own failure alert.
"""
import smtplib
import socket
import sys
from datetime import datetime, timezone
from email.mime.text import MIMEText

from google.cloud import secretmanager
from google.oauth2 import service_account

GCP_PROJECT_ID = "agent-engine-460619"
SMTP_SECRET_ID = "agentengine-prod-alert-smtp"
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587
ALERT_RECIPIENT = "harsha@agentweb.pro"

# Key file for the dedicated agentengine-alerter@... GCP service account —
# NOT the VM's own instance identity. GCP allows only one attached SA per
# VM, and that SA (shared with the main agent-engine.service workload) has
# no access to agentengine-prod-alert-smtp. Using an explicit key here
# rather than ambient compute_engine.Credentials() is what actually gives
# this script its own, separate identity — Greptile's finding was that a
# compromised main process could otherwise read the same SMTP secret used
# for its own failure alert. Readable only by the alert-oncall OS user
# (not agentengine) — see RUNBOOK.md's Provisioning section.
ALERTER_KEY_PATH = "/opt/agent-engine-alert/alerter-sa-key.json"


def get_smtp_credentials() -> dict:
    import json

    credentials = service_account.Credentials.from_service_account_file(
        ALERTER_KEY_PATH,
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )
    client = secretmanager.SecretManagerServiceClient(credentials=credentials)
    name = f"projects/{GCP_PROJECT_ID}/secrets/{SMTP_SECRET_ID}/versions/latest"
    response = client.access_secret_version(request={"name": name})
    return json.loads(response.payload.data.decode("UTF-8"))


def main():
    failed_unit = sys.argv[1] if len(sys.argv) > 1 else "agent-engine.service"
    host = socket.gethostname()
    timestamp = datetime.now(timezone.utc).isoformat()

    creds = get_smtp_credentials()
    smtp_host = creds.get("host", SMTP_HOST)
    smtp_port = int(creds.get("port", SMTP_PORT))

    msg = MIMEText(
        f"agent-engine ({failed_unit}) failed and exhausted its systemd "
        f"restart limit on {host} at {timestamp}. Scheduled chats are down "
        f"until this is manually restarted (systemctl restart agent-engine)."
    )
    msg["Subject"] = "[URGENT] agent-engine process failure - auto-restart exhausted"
    msg["From"] = creds.get("from", creds["user"])   # "resend" isn't a valid From
    msg["To"] = ALERT_RECIPIENT

    with smtplib.SMTP(smtp_host, smtp_port) as server:
        server.starttls()
        server.login(creds["user"], creds["pass"])
        server.send_message(msg)

    print(f"Sent process-failure alert to {ALERT_RECIPIENT}")


if __name__ == "__main__":
    main()
