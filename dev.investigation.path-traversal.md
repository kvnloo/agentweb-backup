# Path Traversal Attack Investigation — 2026-03-23

## Summary

Production nginx logs show **1,114 malicious requests** across 4 days (Mar 19–23) from automated vulnerability scanners. **All attacks returned 404** — no successful exploitation detected. The backend code has **no filesystem-based path traversal vulnerabilities**.

## Attack Evidence from Production Logs

### Attack Types (by volume)
| Type | Count | Description |
|------|-------|-------------|
| PHPUnit/eval-stdin | 949 | Probing for exposed PHP test suites (`/vendor/phpunit/.../eval-stdin.php`) |
| .env probe | 67 | Attempting to read environment variables (`GET /.env`) |
| Path traversal (LFI) | 47 | PHP Local File Inclusion via `index.php?lang=../../../../usr/local/lib/php/pearcmd` |
| Spring actuator | 7 | Probing for Java Spring endpoints (`/actuator/health`) |
| Other | 44 | Mixed scanner fingerprinting |

### Key Attacker IPs (sample)
- `110.35.80.116` — PHPUnit + path traversal (Mar 22)
- `75.119.137.153` — PHPUnit + path traversal (Mar 20)
- `82.24.64.32` — PHPUnit scanner (Mar 20)
- `118.196.74.89` — PHPUnit scanner (Mar 19)
- `165.154.232.244` — PHPUnit scanner (Mar 19)
- `34.158.79.105` — .env probe (recurring)
- `145.223.47.104` — .env probe (Mar 20)
- `45.39.7.12` — .env probe (Mar 22)
- `20.163.2.150`, `20.64.106.28` — Spring actuator probe (Azure IPs)

### Scanner Fingerprints
- **User-Agent:** `libredtail-http` — automated vulnerability scanner
- **User-Agent:** `Mozilla/5.0 zgrab/0.x` — zgrab network scanner
- **User-Agent:** Spoofed Chrome/Firefox for .env probes

### Example Attack Requests
```
GET /index.php?lang=../../../../../../../../usr/local/lib/php/pearcmd&+config-create+/&/<?echo(md5("hi"));?>+/tmp/index1.php
GET /index.php?lang=../../../../../../../../tmp/index1
GET /vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php
GET /.env
GET /actuator/health
```

### Response Analysis
- **All 404** — nginx correctly returned "not found" for all attack paths
- **One 499** (client closed connection) on `.env` probe — no data served
- **No 200/301/302** responses to any attack request

## Code Audit Findings

### No Filesystem Path Traversal Vulnerabilities

1. **No `express.static` serving** — backend doesn't serve static files from the filesystem
2. **No `res.sendFile` / `res.download`** — no file download endpoints using filesystem paths
3. **No user-input in `path.join`** — all `fs.readFileSync` calls use hardcoded paths:
   - `app.ts:246` — reads `docs/AGENT_API.md` (hardcoded)
   - `app.ts:259` — reads `docs/skill.md` (hardcoded)
   - `books.ts:1265` — reads font files from hardcoded `fonts/` directory
   - `videoGeneration.ts:120` — reads temp files with UUID-generated names
4. **Asset serving via S3** — `/asset/:assetHash` decodes a hash to S3 bucket/key, not filesystem paths
5. **File uploads go to S3** — no local filesystem storage of user uploads

### Landing Page GitHub File Operations — Low Severity

4 endpoints in `landingPageGeneration.ts` accept user-supplied file paths that are passed to GitHub API calls. They have path traversal checks, but the validation could be stronger:

**Affected endpoints:**
- `GET /api/landing-pages/v0/generated/:id/file-content` (line 629)
- `PUT /api/landing-pages/v0/generated/:id/github-edit` (line 415)
- `GET /api/landing-pages/v0/generated/:id/commits` (line 681)
- `GET /api/landing-pages/v0/generated/:id/file-at-commit` (line 726)

**Current validation:**
```typescript
if (filePath.includes('..') || filePath.startsWith('.github/') || filePath.startsWith('.github\\')) {
  return res.status(400).json({ error: "Invalid file path" });
}
```

**Risk assessment: LOW**
- Express's `qs` query parser auto-decodes `%2e%2e` → `..`, so URL-encoded bypasses don't work
- Double-encoding (`%252e`) would only bypass if there's an extra `decodeURIComponent()` call — none exists in these routes
- These endpoints require authentication + userId ownership of the landing page
- The paths are passed to GitHub API, not the local filesystem
- Scope limited to landing page repos only

**Improvement opportunity:** Use `path.normalize()` and case-insensitive `.github` check for defense-in-depth:
```typescript
const normalized = path.normalize(filePath).replace(/\\/g, '/');
if (normalized.includes('..') || normalized.startsWith('/') ||
    normalized.toLowerCase().startsWith('.github/')) {
  return res.status(400).json({ error: "Invalid file path" });
}
```

### Defense Posture
- **nginx** returns 404 for unknown routes (good)
- **Express routes** are explicitly defined — no wildcard file-serving
- **No PHP, Java, or Python** on the backend — all scanned vulnerabilities are for wrong tech stacks
- **`.env` is not in the web root** — env vars are in EB environment config and Secrets Manager
- **File upload sanitization** — `uploadFileToS3()` normalizes filenames, removes non-ASCII, replaces dangerous chars

## Recommendations

1. **Consider AWS WAF** — managed rule groups (e.g., `AWSManagedRulesCommonRuleSet`) would block most scanner noise automatically
2. **Consider rate limiting** — 949 requests from a single scanner in one session is noisy; nginx rate limit on 404s would help
3. **Harden landing page path validation** — use `path.normalize()` for defense-in-depth (low priority, current checks are functional)
4. **Monitor for new patterns** — the current attack surface is well-defended, but keep checking logs periodically

## Conclusion

The production attacks are **automated internet background noise** targeting PHP/Java/Python stacks. Since the backend is Node.js/Express with no filesystem file serving, these attacks have zero chance of success. All requests correctly return 404.

One area for improvement: the landing page GitHub file endpoints have basic `..` checks that work but could be hardened with `path.normalize()`. This is low priority since the paths go to GitHub API (not filesystem) and require authenticated ownership.
