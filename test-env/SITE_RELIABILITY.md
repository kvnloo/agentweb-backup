# Site Reliability

## Production Log Monitor

Proactive monitoring of production (or staging) backend logs. Runs on the EC2 dev instance, fetches Elastic Beanstalk tail logs every 15 minutes, scans for bug and intrusion patterns, and emails alerts to `ruiw@agentweb.pro`.

### Prerequisites

- EC2 dev instance running (`~/.test-env-dev-ready` exists)
- IAM role `agentweb-test-env-ec2-role` with S3 permissions on `elasticbeanstalk-us-west-2-*` bucket (`s3:GetObject`, `s3:GetObjectAcl`, `s3:PutObjectAcl`)
- Backend `.env` with `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL` configured

### Quick Start

```bash
# Test email delivery first
bash ~/agentweb/test-env/prod-log-monitor.sh test-email

# Run a single scan manually
bash ~/agentweb/test-env/prod-log-monitor.sh run

# Install cron (every 15 min, monitoring prod)
bash ~/agentweb/test-env/prod-log-monitor.sh install
```

### Commands

| Command | Description |
|---------|-------------|
| `run` | Run a single scan (default if no command given) |
| `install` | Install cron job (every 15 min) |
| `uninstall` | Remove cron job |
| `status` | Show cron status, last run, active alerts |
| `test-email` | Send a test alert email |

### Switching Environments

The `LOG_MONITOR_ENV` variable controls which EB environment is monitored:

| Value | EB Environment |
|-------|---------------|
| `prod` (default) | `Agentweb-backend-env-prod-3` |
| `staging` | `Agentweb-backend-env-1` |

```bash
# Monitor staging instead of prod
LOG_MONITOR_ENV=staging bash ~/agentweb/test-env/prod-log-monitor.sh run

# Install cron for staging
bash ~/agentweb/test-env/prod-log-monitor.sh uninstall
LOG_MONITOR_ENV=staging bash ~/agentweb/test-env/prod-log-monitor.sh install
```

### What It Detects

**Bug patterns:**
- Unhandled promise rejections
- FATAL / OOMKilled / SIGKILL
- Heap out of memory
- TypeError, ReferenceError, SyntaxError
- ECONNREFUSED, ETIMEDOUT, ENOTFOUND
- Property/function errors (`Cannot read properties of`, `is not a function`)

**Intrusion patterns:**
- SQL injection attempts (`UNION SELECT`, `OR 1=1`, `'; DROP`)
- Path traversal (`../`, `%2e%2e%2f`)

**Nginx:**
- 5xx spike (10+ 5xx responses in a single tail log)

### Deduplication

Alerts are suppressed for 2 hours after first firing. State is stored in `/tmp/prod-log-monitor-state.json`. This prevents email spam for recurring errors.

### Logs

Cron output is written to `~/agentweb/logs/prod-log-monitor.log`.

### Files

- `test-env/prod-log-monitor.sh` — bash wrapper and cron management
- `test-env/prod-log-monitor-scan.py` — Python core (download, scan, email)
