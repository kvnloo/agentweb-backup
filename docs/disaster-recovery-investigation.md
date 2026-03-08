# Disaster Recovery Readiness Investigation

**Investigation date:** 2026-03-08
**Method:** Codebase analysis + live production AWS environment checks
**Branch:** `rui/disaster-readiness-investigation`

---

## Executive Summary

**Overall DR Readiness: POOR — The platform has near-zero production-grade disaster recovery capabilities.**

The system relies on single-region AWS infrastructure with no infrastructure-as-code, no documented backup policies, no cross-region replication, and no incident response runbooks. A serious breach or regional outage could result in **permanent data loss** and **extended downtime** with no automated recovery path.

### Key Numbers (all verified against live production)

| Metric | Value |
|--------|-------|
| Production DynamoDB tables | **29** — deletion protection DISABLED on ALL 29; PITR enabled on 22/29, disabled on 7 |
| DynamoDB on-demand backups | **0** |
| AWS Backup plans | **0** for production tables |
| S3 buckets | **5** — only 1 (`agentweb-internal`) has versioning enabled |
| S3 buckets publicly accessible | **2** (`agentweb-user-files`, `agentweb-execution-gifs`) — public access block DISABLED |
| Elastic Beanstalk environments | **5** — all Green/Ready, single region us-west-2 |
| Secrets Manager secrets | **51** — ZERO have rotation enabled, none ever rotated |
| IAM users | **13** — includes vendor access (`vendor-argusoft-access`), last used Feb 2026 |
| CloudTrail trails | **0** |
| CloudWatch Log Groups | **0** (log streaming disabled on EB) |
| Route53 health checks / failover records | **0** — all DNS is simple routing |
| Infrastructure as Code | **0** — no Terraform, CloudFormation, or CDK |
| Incident response runbooks | **0** |

---

## Findings by Area

### 1. Database (DynamoDB) — CRITICAL

**29 production tables verified:** AW-Users, AW-Tasks, AW-TaskExecutions, AW-ChatSessions, AW-ChatMessages, AW-Configs, AW-TaskSchedules, AW-EmailEvents, AW-Subscribers, AW-AgentApiKeys, AW-Workflows, AW-WorkflowExecutions, AW-Books, AW-BookContents, AW-Leads, AW-LeadLists, AW-GTMPlan, AW-LandingPages, AW-Settings, AW-Skills, AW-TaskTemplates, AW-TaskLeadList, AW-ConnectedAccountPosts, AW-AssetApprovals, AW-BenchmarkTests, AW-Waitlist, AW-MCPOAuthClients, AW-MCPOAuthCodes, AW-MCPOAuthTokens

| Finding | Verified Status |
|---------|----------------|
| Point-in-Time Recovery (PITR) | ENABLED on 22/29 tables, DISABLED on 7 (see breakdown below) |
| Deletion protection | DISABLED on ALL 29 tables (`None` = disabled) |
| DynamoDB Streams | NOT configured — no CDC or cross-region replication |
| Global Tables (cross-region replication) | NOT configured — all tables `Replicas: null` |
| On-demand backups | ZERO on-demand backups exist for any production table |
| AWS Backup | No backup plans configured. Default vault has only 3 recovery points: 2x `Dev-AW-Configs` (Mar 2025) and 1x `Books` (Sep 2024) — none for production tables |
| Encryption at rest | DEFAULT (AWS-owned key) — no customer-managed KMS keys |
| Billing mode | PAY_PER_REQUEST on most tables (AW-Configs uses provisioned) |
| Data export/import scripts | NONE — no bulk export, no seed scripts, no migration tools |
| Transactional writes | NOT used — partial write failures could cause data inconsistency |

#### PITR Breakdown

**ENABLED (22):** AW-AssetApprovals, AW-BenchmarkTests, AW-ChatMessages, AW-ChatSessions, AW-Configs, AW-EmailEvents, AW-GTMPlan, AW-LeadLists, AW-Leads, AW-Settings, AW-Skills, AW-Subscribers, AW-TaskExecutions, AW-TaskLeadList, AW-TaskSchedules, AW-TaskTemplates, AW-Tasks, AW-Users, AW-Waitlist, AW-WorkflowExecutions, AW-Workflows

**DISABLED (7):** AW-AgentApiKeys, AW-BookContents, AW-Books, AW-ConnectedAccountPosts, AW-LandingPages, AW-MCPOAuthClients, AW-MCPOAuthCodes, AW-MCPOAuthTokens

**Impact:** Deletion protection is DISABLED on ALL tables — any IAM user with `dynamodb:DeleteTable` can destroy tables instantly. While PITR is enabled on most critical tables, 7 tables have no recovery capability at all. Zero on-demand backups and no AWS Backup plans mean there is no secondary backup mechanism beyond PITR's 35-day window.

---

### 2. File Storage (S3) — CRITICAL

**5 agentweb S3 buckets verified:**

| Bucket | Versioning | Encryption | Public Access Block | Lifecycle | Replication |
|--------|-----------|------------|--------------------|-----------|----|
| `agentweb-user-files` | DISABLED | AES256 | ALL DISABLED (public!) | NONE | NONE |
| `agentweb-internal` | ENABLED | AES256 | ALL ENABLED (private) | NONE | NONE |
| `agentweb-execution-gifs` | DISABLED | AES256 | ALL DISABLED (public!) | NONE | NONE |
| `agentweb-bedrock-logs` | DISABLED | AES256 | N/A | NONE | N/A |
| `agentweb-cost` | DISABLED | AES256 | N/A | NONE | N/A |

**Critical findings:**
- `agentweb-user-files` has NO versioning and NO public access block — user files (task results, screenshots, cookies, credentials) are stored in a bucket that allows public access and has no version history
- `agentweb-execution-gifs` also has NO public access block — execution recordings publicly accessible
- Only `agentweb-internal` is properly configured (versioning + public access blocked)
- Zero lifecycle policies on any bucket — no archival, no expiration, unbounded storage growth
- Zero cross-region replication on any bucket

**Impact:** File deletion is unrecoverable on 4 of 5 buckets. Two buckets containing user data allow public access, meaning objects could be accessed without authentication if object URLs are known or guessed.

---

### 3. Infrastructure as Code — CRITICAL

| Finding | Verified Status |
|---------|----------------|
| Terraform / CloudFormation / CDK | NONE found anywhere in repo |
| EB environment definitions | Manual — 5 environments created via AWS Console |
| GCP VM configuration | Manual — no config management |
| DynamoDB table recreation | Partial — `create-tables.ts` can recreate schema but not data |

**Production environments verified (all in us-west-2):**
- `Agentweb-backend-env-prod-3` (production backend) — Green/Ready
- `Agentweb-backend-env-1` (staging backend) — Green/Ready
- `Agentweb-genius-portal-env` — Green/Ready
- `Agentweb-customer-portal-env` — Green/Ready
- `Agentweb-frontend-env` (partner portal) — Green/Ready

**Impact:** If resources are deleted, the entire infrastructure must be manually recreated. No automated rebuild path exists. EB environment configurations (env vars, scaling, security groups) are not captured in code.

---

### 4. Multi-Region / High Availability — CRITICAL

| Finding | Verified Status |
|---------|----------------|
| Multi-AZ deployment | EB ASG set to `Availability Zones: Any` (multi-AZ within us-west-2) |
| Auto-scaling | Configured: MinSize=1, MaxSize=4, trigger on NetworkOut |
| Multi-region failover | NOT configured — single region (us-west-2), no DynamoDB Global Tables |
| DNS failover (Route53) | NOT configured — all DNS records use simple routing, zero health checks, zero failover policies |
| Agent engine redundancy | Single GCP VM (e2-standard-4) — complete SPOF |

**EB prod backend details:**
- Instance type: `t3.large`
- IMDSv1 disabled (good security practice)
- IAM role: `aws-elasticbeanstalk-ec2-role`
- Enhanced health reporting: enabled with 4xx monitoring
- CloudWatch log streaming: DISABLED (`StreamLogs: false`)
- CloudWatch Log Groups: ZERO — no log groups exist
- Log retention setting: 7 days (but streaming is off, so logs only accessible via EB `request-environment-info`)
- Monitoring interval: 5 minutes
- One custom alarm: `AgentWebBackendUnhealthy` on EnvironmentHealth (OK status)

**Route53 verified records (agentweb.pro):**

| Record | Target | Type |
|--------|--------|------|
| `api.agentweb.pro` | `agentweb-backend6.us-west-2.elasticbeanstalk.com` | Simple alias, no failover |
| `app.agentweb.pro` | `agentweb-customer-portal.us-west-2.elasticbeanstalk.com` | Simple alias |
| `partner.agentweb.pro` | `agentweb-frontend.us-west-2.elasticbeanstalk.com` | Simple alias |
| `genius.agentweb.pro` | `agentweb-genius-portal.us-west-2.elasticbeanstalk.com` | Simple alias |
| `api-stage.agentweb.pro` | `agentweb-backend-staging-env.us-west-2.elasticbeanstalk.com` | Simple alias |

**Impact:** A us-west-2 regional outage takes down the entire platform with zero mitigation — no failover DNS, no secondary region, no health checks. Within the region, the ASG provides some resilience (multi-AZ), but DynamoDB and S3 are single-region with no replication.

---

### 5. Authentication & Token Management After Breach — HIGH

| Finding | Status |
|---------|--------|
| JWT token revocation | IMPOSSIBLE — stateless JWTs with no blacklist table |
| Token expiration | 90 days — compromised tokens valid for months |
| Force logout capability | NONE — only option is rotating `JWT_SECRET` (logs out ALL users) |
| Selective account suspension | NOT implemented — no auto-disable on breach indicators |
| Refresh token rotation | NOT implemented |
| MFA/2FA | NOT implemented |

**Impact:** After a breach, compromised user tokens cannot be selectively revoked. The only option (JWT_SECRET rotation) is a nuclear option that invalidates every session globally.

---

### 6. Credential & Secrets Management — HIGH

| Finding | Status |
|---------|--------|
| AWS Secrets Manager usage | YES — used for third-party API keys |
| Secret rotation policy | NONE — all manual rotation |
| Secret access audit trail | Not documented (CloudTrail available but no runbook) |
| Agent engine credential exposure | Decrypted passwords visible in Python memory; cookies stored unencrypted in S3 |
| Password reset tokens | Stored in PLAINTEXT in DynamoDB |
| OAuth placeholder passwords | Stored in PLAINTEXT |

**Impact:** An attacker with AWS access could retrieve all third-party credentials from Secrets Manager. Agent engine cookies in S3 (`dev/cookies/{userId}/`) are unencrypted. No rotation automation means manual response to every compromised credential.

---

### 7. Monitoring, Alerting & Audit Trail — HIGH

| Finding | Status |
|---------|--------|
| Centralized logging | NONE — `console.log()` to stdout, captured by EB/CloudWatch |
| Structured logging | NONE — no request IDs, no correlation |
| Breach detection / anomaly alerting | NONE |
| Admin action audit trail | NONE — delegation, role changes, data access not logged |
| Authentication attempt logging | NOT centralized |
| Health check endpoint | YES — `GET /health` on backend |
| Agent engine health check | NONE |
| Alerting | Email-only for agent-mode failures (`agentModeAlerts.ts`) |

**Impact:** After a breach, there is minimal forensic capability. Cannot determine: who accessed what data, which credentials were stolen, scope of exfiltration, or timeline of unauthorized access.

---

### 8. Network Security — MEDIUM

Some controls exist, but gaps remain.

| Finding | Verified Status |
|---------|----------------|
| CORS | Properly configured with domain allowlist (includes ngrok for dev — acceptable) |
| Socket.IO auth | JWT required on handshake |
| Rate limiting | Custom in-memory limiter EXISTS but NOT on auth endpoints |
| Security headers (CSP, HSTS, X-Frame) | MISSING from Nginx config (`.platform/nginx/`) |
| WAF | NOT configured |
| TLS | Delegated to EB/ALB — HTTPS endpoints verified (`https://api.agentweb.pro`) |
| S3 public access | `agentweb-user-files` and `agentweb-execution-gifs` have public access block DISABLED |
| IMDSv1 | DISABLED on EB instances (good — prevents SSRF-based credential theft) |

---

### 9. CI/CD & Deployment Recovery — MEDIUM

| Finding | Verified Status |
|---------|----------------|
| Automated deployment | YES — GitHub Actions on merge to main |
| Staging deployment | YES — on PR test pass (auto-deploys to `Agentweb-backend-env-1`) |
| Rollback mechanism | NONE — no EB version rollback automation |
| Canary/blue-green deployment | NONE |
| Post-deploy health checks | NONE (EB enhanced health exists but no custom post-deploy validation) |
| Build artifact retention | S3-based (`elasticbeanstalk-us-west-2-992382574572`), versioned with date+PR |
| CloudWatch log streaming | DISABLED on prod (`StreamLogs: false`) — logs only available via EB `request-environment-info` |

---

### 10. Incident Response — NONE

| Finding | Status |
|---------|--------|
| Incident response runbook | DOES NOT EXIST |
| RTO/RPO targets | NOT DEFINED |
| Breach notification procedure | NOT DOCUMENTED |
| Emergency contact list | NOT DOCUMENTED |
| DR drill schedule | NONE |

---

## Breach Scenario Analysis

### Scenario: Attacker gains admin account access

1. Can access ALL user data (no fine-grained admin roles)
2. Can impersonate any user via delegation system
3. Existing tokens cannot be revoked
4. No audit trail of what data was accessed
5. **Recovery:** Rotate JWT_SECRET (nuclear), manually review all accounts

### Scenario: AWS account compromise

1. All DynamoDB data accessible (no field-level encryption for PII)
2. All S3 files accessible (cookies, credentials, user uploads)
3. All Secrets Manager secrets accessible (third-party API keys)
4. Infrastructure cannot be recreated from code
5. **Recovery:** Manual rebuild of everything; data potentially lost permanently

### Scenario: us-west-2 regional outage

1. Entire platform goes offline — no multi-region failover
2. DynamoDB data inaccessible (no cross-region replication)
3. S3 data inaccessible (no cross-region replication)
4. **Recovery:** Wait for AWS to restore region; no mitigation possible

---

## IAM & Access Control Findings (Verified)

### IAM Users (13 total)

| User | Created | Console Login |
|------|---------|---------------|
| agent_user | Dec 2024 | Never (programmatic) |
| aw_backend_user | Jan 2025 | Never (programmatic) |
| aw_engine_user | Jan 2025 | Never (programmatic) |
| BedrockAPIKey-1n47 | Nov 2025 | Never (programmatic) |
| cloud_claude_code_agentweb | Mar 2026 | Never (programmatic) |
| facetoon_image_user | Jun 2024 | Never (programmatic) |
| gift_user | Jan 2025 | Never (programmatic) |
| github-actions-deploy | Aug 2025 | Never (programmatic) |
| github-actions-deploy-backend | Sep 2025 | Never (programmatic) |
| **harsha** | Apr 2025 | **Mar 6, 2026** (active console user) |
| storywithai_backend | Sep 2025 | Never (programmatic) |
| **vendor-argusoft-access** | Dec 2025 | **Feb 20, 2026** (active vendor access) |
| video_creator | Oct 2024 | Never (programmatic) |

**Findings:**
- No MFA enforcement visible — console users (`harsha`, `vendor-argusoft-access`) may not have MFA
- Vendor access active — `vendor-argusoft-access` last logged in Feb 20, 2026 — review if still needed
- No IAM password policy visible (need Console verification)
- 5 IAM roles for EB/AgentWeb services
- CloudTrail: ZERO trails configured — no API audit logging at all
- CloudWatch: ZERO log groups — no centralized application logging

### Secrets Manager (Verified)

**51 secrets total, ZERO with rotation enabled, NONE ever rotated.**

| Category | Count |
|----------|-------|
| Google APIs (Search, SearchConsole, PageSpeed, Share, Image, Video, Gmail, GCS, Gemini) | 16 |
| Meta/Instagram | 4 |
| LinkedIn (Personal, Company) | 4 |
| Resend (email) | 4 |
| Azure (Image) | 2 |
| Webflow (incl. 2 user-specific) | 4 |
| Runway (Image) | 2 |
| Unipile | 2 |
| OpenAI (Image) | 2 |
| BaseHub | 2 |
| Test environment | 5 |
| Others | 4 |

All 51 secrets show `RotationEnabled: None` and `LastRotated: None`.

### CloudWatch Alarms (Verified)

**11 alarms total — all EB auto-generated, mostly NetworkOut scaling triggers:**
- 5x NetworkOut High/Low per EB environment (auto-scaling triggers)
- 1x `AgentWebBackendUnhealthy` (EnvironmentHealth) — currently OK
- 5 "Low" alarms in ALARM state — these trigger scale-down, expected for low-traffic periods
- ZERO custom alarms for application errors, auth failures, 5xx rates, latency, etc.

---

## Remediation Plan

### P0 — Immediate (Week 1) — Prevent data loss today

| # | Action | Details |
|---|--------|---------|
| 1 | Enable DynamoDB deletion protection | ALL 29 tables currently have deletion protection DISABLED |
| 2 | Enable DynamoDB PITR on remaining 7 tables | AW-AgentApiKeys, AW-BookContents, AW-Books, AW-ConnectedAccountPosts, AW-LandingPages, AW-MCPOAuthClients, AW-MCPOAuthCodes, AW-MCPOAuthTokens |
| 3 | Enable S3 versioning | On `agentweb-user-files`, `agentweb-execution-gifs`, `agentweb-bedrock-logs`, `agentweb-cost` |
| 4 | Enable S3 public access block | On `agentweb-user-files` and `agentweb-execution-gifs` — user data and execution recordings are currently potentially publicly accessible via object URLs |
| 5 | Enable CloudTrail | ZERO trails configured — no API audit logging at all |
| 6 | Enable CloudWatch log streaming | On prod EB environment (verified `StreamLogs: false`, zero log groups exist) |
| 7 | Review vendor IAM access | `vendor-argusoft-access` has console access, last used Feb 20. Verify if still needed and disable if not. |

### P1 — Urgent (Weeks 2-4) — Breach response capability

| # | Action |
|---|--------|
| 1 | Implement JWT token blacklist table for selective revocation |
| 2 | Add rate limiting to `/api/auth/*` endpoints |
| 3 | Add security headers to Nginx (CSP, HSTS, X-Frame-Options, X-Content-Type-Options) |
| 4 | Define RTO/RPO targets |
| 5 | Create incident response runbook (breach playbook) |
| 6 | Implement automated DynamoDB backups via AWS Backup (currently zero backup plans, zero on-demand backups) |
| 7 | Create a dedicated IAM role for operations/DR with appropriate permissions |
| 8 | Enforce MFA on console-access IAM users (`harsha`, `vendor-argusoft-access`) |
| 9 | Begin secrets rotation — prioritize most-accessed secrets (Google, Resend, GCS keys accessed daily) |

### P2 — Short-term (Month 2) — Operational maturity

| # | Action |
|---|--------|
| 1 | Set up cross-region S3 replication for critical buckets |
| 2 | Create secrets rotation policy and automation |
| 3 | Add audit logging for admin actions, delegation, data access |
| 4 | Deploy centralized structured logging (CloudWatch Logs Insights) |
| 5 | Set up CloudWatch alarms (error rates, auth failures, 5xx spikes) |
| 6 | Add S3 lifecycle policies (archival to Glacier for old execution data) |
| 7 | Encrypt agent engine cookies in S3 |
| 8 | Create deployment rollback automation |

### P3 — Medium-term (Months 3-4) — Infrastructure resilience

| # | Action |
|---|--------|
| 1 | Convert infrastructure to Terraform/CDK (IaC) |
| 2 | Implement refresh token rotation (short-lived access tokens) |
| 3 | Architect multi-region failover (DynamoDB Global Tables, S3 CRR) |
| 4 | Containerize agent engine (Docker/GKE) for isolation and redundancy |
| 5 | Implement MFA for admin accounts |
| 6 | Add fine-grained admin roles (read-only support, etc.) |
| 7 | Schedule quarterly DR drills |
