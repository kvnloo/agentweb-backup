# Security Audit Report

Date: 2026-01-30
Repository: /Users/ruiwang/Documents/GitHub/agentweb3
Auditor: Codex (static review)

## Executive Summary
- **Overall risk posture:** Moderate–High
- **Primary concerns:** Agent-engine code execution isolation, token storage/handling in portals, and remaining public SSRF surface.
- **Strengths:** Passwords are bcrypt-hashed for standard registration; authorization checks are present on many task routes; reset flow avoids user enumeration.

## Codebase Metrics
- **Total files (tracked in audit scope):** 598
- **Total lines of code (all files in audit scope):** 1,808,656
- **Backend only:** 380 files / 1,593,049 lines
- **Agent engine:** 49 files / 24,167 lines
- **Customer portal:** 256 files / 104,719 lines
- **Partner portal:** 157 files / 178,885 lines
- **Exclusions:** `node_modules`, `dist`, `build`, `.next`, `coverage`, `.git`, `audits`

## Scope
- Backend services: `backend/src/**`
- Agent engine service: `agent-engine/**`
- Customer portal: `customer-portal/**`
- Partner portal: `partner-portal/**`

## Methodology
- Static source review and targeted grep for authentication, authorization, file handling, secrets management, code execution, and network access patterns.
- No dependency vulnerability scanning, dynamic testing, or infrastructure review performed.

## Findings Summary
| Severity | Count |
| --- | --- |
| Critical | 1 |
| High | 3 |
| Medium | 5 |
| Low | 2 |

## Detailed Findings

### 1) Hardcoded JWT secret fallback enables token forgery if misconfigured
**Severity:** Critical
**Status:** Resolved (production configured with a random 32-byte JWT_SECRET)

**Evidence:**
- `backend/src/controllers/auth.ts:96-99` and `168-171` and `373-376`
- `backend/src/middleware/auth.ts:47-51`
- `backend/src/server.ts:58-60`
- `backend/src/routes/admin.ts:468-471`

**Description:** JWTs are signed/verified using `process.env.JWT_SECRET || "your-secret-key"`. If `JWT_SECRET` is missing or misconfigured in any environment, the system accepts a known, weak secret. An attacker can forge tokens and fully impersonate users (including admin if they can set `isAdmin` in payloads accepted by downstream logic).

**Impact:** Authentication bypass and privilege escalation across the API and WebSocket channels.

**Recommendation:**
- Fail fast on startup if `JWT_SECRET` is unset or too weak.
- Remove the fallback value entirely.
- Rotate secrets and revoke existing tokens after the fix.

---

### 2) Access tokens are issued without expiration
**Severity:** High
**Status:** Resolved (auth tokens now issued with 90d expiration)

**Evidence:**
- `backend/src/controllers/auth.ts:95-99`, `168-171`, `373-376`

**Description:** JWTs created in registration, login, and Google OAuth flows do not include `expiresIn`, resulting in effectively permanent access tokens. Compromised tokens can be reused indefinitely.

**Impact:** Long‑lived stolen tokens increase the blast radius of account compromise and make incident response harder.

**Recommendation:**
- Add short-lived access tokens (`expiresIn`), and introduce refresh tokens with rotation.
- Enforce token expiration in `authenticateToken` and WebSocket auth (already done by `jwt.verify` once exp is added).

---

### 3) Public SSRF-capable endpoints for arbitrary URL fetching
**Severity:** High
**Status:** Partially resolved (removed `/api/files/view-external`; `/api/files/content` remains public)

**Evidence:**
- `backend/src/controllers/filesController.ts:30-160`
- `backend/src/app.ts:136-140` (public routes)

**Description:** `/api/files/view-external` and `/api/files/content` accept arbitrary `http(s)` URLs and fetch them server-side without authentication or allowlisting. This is a classic SSRF pattern (e.g., metadata services, internal hosts, or private APIs). There are no IP/hostname blocklists or size limits for responses.

**Impact:** Potential data exfiltration from internal services, lateral movement, or abuse of server network access.

**Recommendation:**
- Require authentication and authorization for these endpoints.
- Enforce a strict allowlist of domains or buckets.
- Block private IP ranges and link-local metadata endpoints.
- Add response size caps and timeouts for streaming.

---

### 4) OAuth users store plaintext placeholder passwords
**Severity:** Medium

**Evidence:**
- `backend/src/controllers/auth.ts:220-231` and `276-288`

**Description:** Google OAuth user creation passes a `placeholderPassword` directly to `userDb.createUser` without hashing. This value is stored in the `password` field and is not bcrypt-hashed like standard registrations.

**Impact:** Password field contains plaintext data at rest for OAuth users. If the database is compromised, this increases sensitive data exposure and complicates audit expectations.

**Recommendation:**
- Hash the placeholder password before storing, or store `null` and ensure code paths tolerate `password` absence for OAuth users.
- Consider splitting OAuth credentials into a separate field to avoid confusion.

---

### 5) Password reset tokens stored in plaintext
**Severity:** Medium

**Evidence:**
- `backend/src/controllers/auth.ts:418-426`, `514-516`

**Description:** Reset tokens are stored as cleartext in the database and matched directly on reset. Anyone with DB access can reset user passwords by replaying tokens.

**Impact:** Increases impact of DB compromise.

**Recommendation:**
- Store a hash (e.g., SHA-256) of the reset token and compare hashes.
- Rotate/expire tokens promptly after use.

---

### 6) In-memory file uploads with large limits can cause memory exhaustion
**Severity:** Medium

**Evidence:**
- `backend/src/routes/tasks.ts:27-31`
- `backend/src/routes/tasks.ts:1324-1378` (multiple files)

**Description:** Multer is configured with `memoryStorage` and a 100MB per-file limit. The knowledge base endpoint accepts up to 100 files per request, creating a worst-case memory load that can exceed process capacity and lead to DoS.

**Impact:** Potential denial-of-service via large multipart uploads.

**Recommendation:**
- Switch to streaming uploads (disk or cloud direct-to-bucket) with strict per-request caps.
- Apply global rate limits and request size limits for multipart endpoints.

---

### 7) Execution logs served as HTML without sanitization
**Severity:** Low

**Evidence:**
- `backend/src/controllers/tasks.ts:826-828`

**Description:** Execution logs are returned with `Content-Type: text/html` and raw log content. If logs contain attacker-controlled HTML/JS (e.g., from scraped pages), a viewer opening the log URL could execute scripts.

**Impact:** Token-bound reflected XSS against users who view logs; lower severity due to token requirement and narrower audience.

**Recommendation:**
- Serve logs as `text/plain` or apply strict HTML sanitization.
- Add `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` if HTML is required.

---

### 8) Auth tokens stored in localStorage (XSS exfiltration risk)
**Severity:** Medium

**Evidence:**
- `customer-portal/src/contexts/AuthContext.tsx:78-89`, `214-216`
- `partner-portal/src/contexts/AuthContext.tsx:45-46`, `52-53`, `106`

**Description:** Both portals persist bearer tokens in `localStorage`. Any XSS in the frontend can read and exfiltrate these tokens.

**Impact:** Account takeover if a script executes in the portal origin.

**Recommendation:**
- Move tokens to HttpOnly, Secure cookies or keep them in memory with short-lived access tokens.
- Add a strict CSP and reduce XSS surface (avoid unsafe HTML).

---

### 9) Tokens embedded in URLs (referrer/log leakage risk)
**Severity:** Low

**Evidence:**
- `customer-portal/src/pages/OAuthCallback.tsx:23-41` (OAuth token in query string)
- `partner-portal/src/App.tsx:63` and `partner-portal/src/pages/ExecutionDetails.tsx:275-282` (share token in path)

**Description:** Tokens are passed via URL parameters/paths. These can leak via browser history, server logs, or `Referer` headers to third-party origins.

**Impact:** Accidental token exposure and unauthorized access if leaked.

**Recommendation:**
- Prefer `POST` or `fragment` (`#`) for client-side token handoff, then immediately scrub URL.
- Add `Referrer-Policy: no-referrer` or `strict-origin` on pages that handle tokens.

---

### 10) Agent-engine “sandbox” is not OS‑level isolation for arbitrary code
**Severity:** High

**Evidence:**
- `agent-engine/task_utils.py:1535-1642`

**Description:** `run_python_code_in_sandbox` executes provided Python code via `subprocess.run` with limited environment variables, but without OS‑level sandboxing (namespaces, seccomp, container isolation, or a separate VM).

**Impact:** If untrusted code reaches this path, it can access the host filesystem/network within the agent runtime, leading to data exfiltration or service compromise.

**Recommendation:**
- Run code execution in a hardened container/VM with strict filesystem and network policies.
- Enforce allowlists for packages and outbound destinations; set CPU/memory quotas.

---

### 11) Decrypted credentials returned to agent responses
**Severity:** Medium

**Evidence:**
- `agent-engine/web_agent.py:714-722`

**Description:** Decrypted usernames/passwords are placed directly into `ActionResult.extracted_content`, which may be logged, stored, or shown to users depending on downstream handling.

**Impact:** Credential exposure in logs or UI, especially if sessions are shared or logged for analytics.

**Recommendation:**
- Avoid returning raw secrets; instead, use credentials internally and return success metadata only.
- Redact secrets in logs and tool outputs.

---
## Additional Observations
- The system lacks visible rate-limiting for authentication-related endpoints (e.g., `/api/auth/login`, `/api/auth/forgot-password`). Consider adding IP-based throttling and account lockout logic.
- Tokens are included in URLs (e.g., delegate access callback). URLs can leak via logs/referrers; consider passing tokens in fragments or postMessage instead.

## Recommended Next Steps
1. Remove JWT secret fallbacks and enforce strong secrets at startup.
2. Add token expiration and refresh token rotation.
3. Lock down SSRF endpoints with auth + allowlist + IP filtering.
4. Hash all passwords and reset tokens; review OAuth user records.
5. Migrate large file uploads to streaming and add rate limits.
6. Change log response content type to `text/plain`.

## Appendix: Files Reviewed (non-exhaustive)
- `backend/src/controllers/auth.ts`
- `backend/src/middleware/auth.ts`
- `backend/src/controllers/filesController.ts`
- `backend/src/controllers/tasks.ts`
- `backend/src/routes/tasks.ts`
- `backend/src/app.ts`
- `backend/src/server.ts`
- `backend/src/routes/admin.ts`
