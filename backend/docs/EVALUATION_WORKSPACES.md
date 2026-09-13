# Sandbox accounts (ENG-1906 / ENG-1907)

A sandbox account is a **real customer-portal account with a simulated Meta connection**, used for
hiring take-homes and customer pilots. The evaluatee uses the real portal and the real Emma with the
real tool surface; only the outbound side effects that could reach a third party are denied, and
(from phase 2) Meta reads and writes are answered by an in-house simulator instead of Graph.

The principal is `eval_<UUID>`. One policy row in `AW-Evaluations` (key `evaluation/<userId>`) is
authoritative: missing, malformed, expired, revoked, or unreadable policy denies access at every
gate. Normal customer behavior is unchanged.

Design of record: `SANDBOX-MODE-DESIGN.md` on Harsha's machine; decisions on ENG-1906.

## What phase 1 delivers

- The `/evaluation` page, the single-shot `runEvaluation`, the generation budget, approved
  materials, private artifacts and the toy simulator are gone. Sandbox principals authenticate
  and use the product like any customer.
- `evaluationPolicy.enforceEvaluationTool` denies **tool classes** from the policy record instead
  of admitting a single tool. Classes: `lifecycle` (`evaluation_workspace`, always denied),
  `connectors` (connect_account, MCP install/configure; `install_skills` stays allowed),
  `sends` (email/Slack/notify/human-eval), `social` (LinkedIn, Twitter, posting, calendar),
  `publish` (landing-page deploy/publish/subdomain, public lead lists), `third_party_writes`
  (Google Ads, HubSpot, Attio, LinkedIn Ads, enrichment, Google Docs/Sheets/Drive, ClickUp),
  `browser` (Playwright, site sign-in, captcha, temp inbox, local agent), `automation`
  (coding agent, scheduled chats and schedules). Every other tool — Meta, generation, search,
  knowledge base, work plans, internal CRM, landing-page generation — runs normally. The check
  runs in all three dispatchers (`mcp/client/toolRegistry`, `mcp/server/registry`,
  `agentModeService.executeTool`), so external MCP and nested calls are covered.
- Provisioning is gated on the `Sandbox` subscription tier row and seeds the account so the
  portal never routes it into onboarding.

## Prerequisite: the Sandbox tier row

`subscriptionType: 'Sandbox'` bounds usage and visibility through the ordinary tier machinery.
An unknown tier name fails open, so `provision` throws `SandboxTierMissing` (HTTP 412) until the
row exists. Create it once per environment:

```
cd backend && NODE_ENV=production npx ts-node scripts/ensure-sandbox-tier.ts
```

The script appends `{ name: 'Sandbox', allowedPages: ['*'], allowedSkills: ['*'],
allowedConnectedAccounts: ['meta'], allowedFeatures: [], monthlyTokenAllowance: 2000000,
monthlyCostAllowance: 25, monthlyExtraCostAllowance: 20 }` with a compare-and-set and never edits an
existing entry. Adjust allowances through the admin settings UI afterwards if a case needs more.

## Operations

Administrators (real, non-delegated) provision through Emma's `evaluation_workspace` tool
(`action: provision`) or `POST /api/admin/evaluations`:

```json
{
  "email": "candidate@example.invalid",
  "displayName": "Candidate name",
  "password": "<fresh temporary password, 12–72 characters>",
  "expiresAt": 1800000000000,
  "brandGuidelines": { "brandName": "Case brand", "website": "https://example.invalid", "description": "One-line brief" },
  "reviewerUserIds": ["<internal user id>"],
  "label": "Sandbox",
  "datasetId": "agentweb-2026q2", "datasetVersion": 1,
  "deniedToolClasses": ["connectors", "sends", "social", "publish", "third_party_writes", "browser", "automation"]
}
```

`expiresAt` must be a future time no more than 30 days away. Provisioning atomically creates the
account (Sandbox tier, `roles: ['customer']`, no organization, seeded brand guidelines, never an
`adAccount`), the policy row and an audit record; an existing email cannot be overwritten. No email
is sent — hand over credentials through a private channel, or open the account with Admin → Access
Portal. `datasetId`/`datasetVersion` pin the frozen dataset the phase-2 simulator serves.

Revoke with `action: revoke` / `POST /api/admin/evaluations/<id>/revoke`: commits the deny state,
bumps the account's session and delegate epochs, then removes API keys, OAuth code/token families,
MCP session metadata and schedules. Cleanup is idempotent and retryable; revocation retains the
policy and audit rows. Review with `action: review` / `GET /api/admin/evaluations/<id>` as the
provisioning admin or an explicitly assigned reviewer: returns status and the audit trail
(bounded to ~1000 events, `truncated` when incomplete). Reviewer access survives revocation.

## Invariants

- The policy is re-read on every request, tool call, MCP token/API-key use and delegate session;
  revocation is immediate.
- Sandbox principals cannot mint or use delegated/service/admin tokens, cannot install
  connectors, and cannot call the lifecycle tool.
- `getAllUsers`-driven fleet sweeps, oncall alerts, reliability telemetry and engagement signals
  exclude sandbox accounts (phase 1, S3 slice).
- Storage: policy and audit rows only, in `${Dev-}AW-Evaluations` (single string hash key
  `evaluationKey`; provisioned by `scripts/provision-evaluation-storage.sh`). Phase 2 adds
  immutable dataset chunks and one per-account overlay item to the same table.

## What the next phases add

2. Sentinel Meta credential, process-level Graph interceptor, read simulator (sync + async
   insights, date-shifted so the last delivery day is always yesterday).
3. Write simulator (create/update/delete, image upload to S3, effective_status, exact read-back,
   launch gate, CAPI, portal-internal management links).
4. Packet → dataset compiler, `case.yaml`, reset/purge, reviewer action timeline.
5. Portal "Sandbox" badge (desktop + mobile), outbound Meta links hidden, analytics opt-out.
6. Production proof with a disposable persona.

## Rollback

Revoke every active sandbox through the admin path first, verify the audit rows, then roll back
application code. Keep the storage table and audit records. Never roll back the auth or policy
code while a sandbox credential exists.
