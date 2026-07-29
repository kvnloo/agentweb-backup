#!/usr/bin/env bash
# Invoked by systemd's agent-engine-alert@.service (OnFailure= companion unit)
# when agent-engine.service fails to restart/stay up (exhausts
# StartLimitBurst). Sends an email via the same SMTP path already used for
# task-level failures (email_utils.send_oncall_alert), so there's one
# alerting mechanism instead of two — no separate webhook to configure.
set -euo pipefail

FAILED_UNIT="${1:-agent-engine.service}"
CONDA_PYTHON=/opt/agent-engine/miniconda/envs/agent-engine/bin/python
AGENT_ENGINE_DIR=/opt/agent-engine/agentweb/agent-engine

cd "$AGENT_ENGINE_DIR"
AGENT_ENGINE_ENV=production "$CONDA_PYTHON" -c "
import smtplib
from email.mime.text import MIMEText
from datetime import datetime, timezone
import socket
import secrets_manager

host = socket.gethostname()
timestamp = datetime.now(timezone.utc).isoformat()

msg = MIMEText(
    f'agent-engine (${FAILED_UNIT}) failed and exhausted its systemd restart '
    f'limit on {host} at {timestamp}. Scheduled chats are down until this is '
    f'manually restarted (systemctl restart agent-engine).'
)
msg['Subject'] = '[URGENT] agent-engine process failure - auto-restart exhausted'
msg['From'] = secrets_manager.get_smtp_user()
msg['To'] = 'harsha@agentweb.pro'

with smtplib.SMTP('smtp.gmail.com', 587) as server:
    server.starttls()
    server.login(secrets_manager.get_smtp_user(), secrets_manager.get_smtp_pass())
    server.send_message(msg)

print('Sent process-failure alert to harsha@agentweb.pro')
"
