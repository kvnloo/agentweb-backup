# "Get started in Slack" intake (ENG-2782)

Public, unauthenticated onboarding intake that powers the embeddable
`slack-start` widget (S2, `packages/slack-start`) and the hireemma.ai
"Get started in Slack" button (S3). The backend owns all copy, options,
validation and side effects; clients only render config and send answers.

## API — `/api/onboarding/slack-start`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/config` | none | All wizard copy, the six steps and their option ids, public Turnstile site key |
| POST | `/` | `Idempotency-Key` header | `{email, website, utm?, captchaToken}` → `202 {intakeId, intakeToken, status}`; creates the intake, a user, a CRM lead and starts the brand build immediately |
| GET | `/:intakeId` | `Authorization: Bearer <intakeToken>` | Resume: saved answers, furthest step |
| PATCH | `/:intakeId` | bearer | `{answers: {source|role|sector|tools|adSpend: …}, step}` — per-step idempotent save onto intake, user (`onboarding*` fields) and lead (`slackStart*` custom fields) |
| POST | `/:intakeId/complete` | bearer | Requires every answer; calls `provisionOnboardingSlackConnect` (inert while `SLACK_CONNECT_ENABLED` is off) → `{status: pending|invited|processing, slackConnectStatus}` |

Error codes: `invalid_email`, `personal_email`, `invalid_website`, `invalid_utm`,
`idempotency_key_required`, `captcha_failed` (403), `captcha_unavailable` (503),
`rate_limited` (429), `domain_in_progress` (409), `account_exists` (409),
`provisioning_failed` (503, retry with the same Idempotency-Key),
`invalid_answer`, `invalid_step`, `missing_answers` (422), `not_found` (404).

## Security decisions

- **Capability:** `intakeToken = HMAC-SHA256(SLACK_START_TOKEN_SECRET||JWT_SECRET, intakeId + sha256(Idempotency-Key))`.
  Not stored, sent only as a bearer header (never in a URL), compared in constant time.
  Wrong/missing token and unknown intake both return the same 404. No secret → 503 (fail closed).
- **Domain dedupe:** intake + `domain#<email domain>` lock are one DynamoDB TransactWrite
  (`attribute_not_exists`), atomic across instances. A second start for a taken domain gets
  `409 domain_in_progress` with no id/token. Only a retry presenting the same Idempotency-Key
  *and* the same email gets the original response back (captcha is not re-spent on that replay).
- **No account takeover:** an email that already has an account → `409 account_exists`; the
  intake never attaches to or authenticates an existing user. The account the intake creates has a
  non-bcrypt password marker, so it can only be claimed by proving the mailbox (password reset /
  Google sign-in).
- **SSRF:** the website is normalized to `https://<host>`; IP literals, ports, credentials,
  single-label/internal names and hosts resolving to private addresses (`utils/ssrfGuard`) are rejected
  before the brand build ever sees it.
- **Captcha:** Cloudflare Turnstile (`SLACK_START_TURNSTILE_SECRET_KEY`). Unconfigured fails closed unless
  `NODE_ENV` is explicitly `development`/`test`.
- **Rate limits:** DynamoDB fixed-window counters (atomic `ADD` + condition, TTL `expiresAt`) per IP
  (`SLACK_START_RATE_IP_PER_HOUR`, default 10) and per company domain (`SLACK_START_RATE_DOMAIN_PER_DAY`,
  default 5). IPs are stored only as SHA-256.
- **Idempotency:** user id and lead id are minted at intake creation; every side effect is stamped on the
  intake and the brand build is guarded by a conditional stamp (fires once). Completion uses a lease so
  concurrent completes provision once; a later complete retries provisioning until a channel exists.
- **CORS:** handled by the router, not app.ts's credentialed allowlist: AgentWeb's own sites
  (`*.hireemma.ai`, `*.agentweb.pro`) plus exact origins in `SLACK_START_ALLOWED_ORIGINS`; no credentials;
  allowed headers `Content-Type, Authorization, Idempotency-Key`.

## Storage

`AW-SlackStartIntakes` (HASH `pk`, TTL `expiresAt`, PITR on), created at boot by
`ensureCriticalTables`. Items: `intake#<id>`, `domain#<domain>`, `rate#<scope>#<hash>#<window>`.

## Configuration

| Env | Required | Notes |
|---|---|---|
| `SLACK_START_LEAD_LIST_ID` | yes (prod) | CRM list for intakes; missing → lead write fails loudly (logged + `leadWriteError` on intake), visitor continues |
| `SLACK_START_TURNSTILE_SECRET_KEY` / `SLACK_START_TURNSTILE_SITE_KEY` | yes (prod) | captcha; missing secret rejects every start outside dev/test |
| `SLACK_START_TOKEN_SECRET` | recommended | falls back to `JWT_SECRET` |
| `SLACK_START_ALLOWED_ORIGINS` | optional | extra embed origins |
| `SLACK_CONNECT_ENABLED` | unchanged | stays off; completion reports an honest `pending` state |

High budgets (`$5k+`) are stamped `highBudget` / `franciscoAlertEligibleAt` on the intake and
`slackStartHighBudget` on the user; the actual alert is S6 (out of scope).
