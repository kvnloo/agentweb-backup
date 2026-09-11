# Evaluation workspaces (ENG-1870)

An evaluation is a dedicated `eval_<UUID>` principal with Pro tier and no organization.
Its single policy record is authoritative: missing, malformed, expired, revoked, or
unreadable policy denies access. Normal customer behavior is unchanged.

## Operations

A real, non-delegated administrator can use Emma's `evaluation_workspace` tool with
`action: provision` and a `provision` object, or POST `/api/admin/evaluations` with
the same object under an authenticated admin app session. HTTP MCP lifecycle mutations
are refused because that transport does not preserve app delegation provenance;
in-process Emma and the admin REST API are the supported controller paths:

```json
{
  "email": "synthetic@example.invalid",
  "displayName": "Synthetic evaluation",
  "password": "<fresh temporary password, 12–72 characters>",
  "generationBudget": 5,
  "expiresAt": 1800000000000,
  "materials": [{"title": "Approved case", "text": "Sanitized facts only", "approved": true}]
}
```

Supply an actual future expiry no more than 30 days away. Provisioning atomically
creates the account, policy, and actor-stamped audit record; an existing email
cannot be overwritten. No invitation or email is sent. Give the evaluator the
backend's `/evaluation` URL and temporary credentials through an approved private
channel. Never include credentials in logs, issue comments, or PR evidence.

The evaluator can inspect approved case material, query the frozen campaign dataset,
create and update simulated campaigns/ad sets/ads/creatives, change budgets and schedules,
and simulate publish/pause/activate. They can also ask Emma for strategy/analysis,
generate an image, upload an opaque artifact, and download their own artifacts.
The page holds its app token only in memory. The API is `/api/evaluation`; artifact
downloads use `/api/evaluation/artifacts/<id>`. Generic chat, production tools,
connectors, credential imports, and organization routes are unavailable.

Revoke with Emma's `evaluation_workspace` tool (`action: revoke`,
`evaluation_user_id: <id>`) or POST `/api/admin/evaluations/<id>/revoke`.
Revocation commits the deny state and invalidates account session/delegation epochs
before cleaning up stored API keys, OAuth code/token families, MCP session metadata,
and schedules. The response includes audit identifiers and cleanup counts. Retry
revoke if cleanup fails: access remains denied and cleanup is idempotent. Cleanup failure receives its own audit event after the deny
commit; incomplete cleanup is never reported as success. Revocation
retains the policy, audit, and private artifacts; it is not a data-erasure operation.

## Connector-free Meta simulation

The product name is **Evaluation workspace**. Every simulator result includes
**Simulation complete — not sent to Meta**. Publishing sets a simulated object to
published/paused; activation changes its requested status. Effective status accounts
for paused parents and future/ended schedules. It creates no delivery or scheduling job,
spend, Meta review, or real object. Meta connectors/read/write APIs, org resources,
production ad tables, credentials, and remote URL retrieval are never used.

Provisioning accepts an optional `simulationPacket` containing the candidate packet's
**explicitly approved, sanitized** snapshot. The operator supplies data inline; the
server never retrieves packet links or imports raw Meta responses. For example:

```json
{
  "approved": true,
  "objects": [
    {"key":"campaign","kind":"campaign","name":"Approved acquisition","objective":"LEADS","budget":5000,"budgetType":"daily","metrics":{"impressions":1000,"clicks":30,"spend":1200,"conversions":3}},
    {"key":"audience","kind":"adset","name":"Approved audience","parentKey":"campaign","targeting":"Sanitized B2B audience"},
    {"key":"creative","kind":"creative","name":"Approved message","text":"Sanitized creative copy"},
    {"key":"ad","kind":"ad","name":"Approved ad","parentKey":"audience","creativeKey":"creative"}
  ]
}
```

This is the value of `simulationPacket` alongside the existing provisioning fields,
not a separate provisioning endpoint. Up to 30 seed objects / 50 KB are accepted.
Local packet keys become `sim_<evaluation-user-id>_seed_<key>` IDs; new objects receive
`sim_<evaluation-user-id>_<UUID>` IDs. Raw account/object IDs, unknown properties,
invalid relationships, unapproved packets, malformed metrics, and URL/credential
fields are rejected before account creation. Optional seed `status` is DRAFT,
PAUSED, or ACTIVE (default DRAFT); metrics are frozen nonnegative integer counts,
with spend in USD cents. Without a packet, the starting simulation is empty.
No candidate identity, email, campaign, or external URL is embedded in the feature.

Use Emma's `evaluation_workspace` tool or POST `/api/evaluation` with:

```json
{"action":"simulate","command":{"operation":"query","source":"approved","kind":"campaign"}}
```

The same `command` supports:

| Operation | Inputs | Result |
|---|---|---|
| `query` | optional `source` approved/current; optional `kind` | Frozen or current object list |
| `inspect` | `id`; optional `source` | Object state and effective status |
| `create` | `kind`, `fields` | New synthetic object |
| `update` | `id`, `fields` | Updated object; immutable IDs and metrics |
| `publish` / `activate` / `pause` | `id` | Validation, warnings, resulting delivery state |
| `reset` | none | Restore the frozen seed and remove disposable artifacts |

Editable fields: `name`; campaign `objective` AWARENESS/TRAFFIC/LEADS/SALES;
campaign/ad set `budget` (100–100000000 integer USD cents) with `budgetType`
(daily/lifetime); paired `startTime`/`endTime` in UTC ISO format with `.000Z`;
ad set `parentId` (campaign) and sanitized `targeting` text; ad `parentId` (ad set)
and `creativeId`; creative `text`, owned `artifactId`, or `upload: {mime,base64}`.
Lifetime budgets require a schedule. Delivery requires an inherited or local budget;
activation requires simulated publication. A paused ancestor yields a warning and
`PARENT_PAUSED`, never a claim of delivery. No Meta API parity is claimed beyond
these documented simulation rules.

Inline uploads accept canonical base64 up to 24 KB with inert text/plain, image/png,
image/jpeg, or application/octet-stream MIME types. For larger/generated images,
use the existing private artifact upload and reference its returned ID. Uploaded
bytes are never executed or fetched. The current simulation is capped at 50 objects;
seed plus current state is capped at 150 KB. Validation failures return `ok:false`,
`errors`, `warnings`, disclosure, and the unchanged existing object when available.
Authorization/foreign destination overrides fail closed rather than being simulated.
All mutations and rejected domain validations have actor-stamped revision audits,
including resulting object fields (inline upload audit contains MIME/byte count).

Reset is idempotent in resulting state and does not refund generation spend, extend
expiry, restore grants, or reactivate a revoked evaluation. It atomically restores
seed objects, clears artifact access, increments the artifact epoch, and records
cleanup intent. Bounded conditional batches delete old bytes; a failed cleanup is
retryable by repeating reset. Uploads are denied while cleanup is pending. Generation
pins its starting epoch, so pre-reset output cannot repopulate the workspace. Audits
and approved materials are retained. Revision checks prevent lost updates and reset
races; a conflicting command is rejected and can be resubmitted after inspection.

## Assigned review

Provisioning may include up to five `reviewerUserIds` (internal user IDs, not emails).
The provisioning administrator and these explicitly assigned, currently active,
non-delegated users can inspect the evaluation. Being in the same organization or
being an unrelated administrator grants no review access. Existing legacy evaluations
without recorded assignment fail closed for review; disposable cases should be
reprovisioned through the normal operation.

Review through the same `/evaluation` page after reviewer login, through Emma with
`{"action":"review","evaluation_user_id":"eval_..."}`, or GET
`/api/admin/evaluations/<evaluation-user-id>`. Results include the frozen/current
simulation, materials, private artifact manifest, and audit events. The audit scan is
bounded to 100 pages / approximately 1000 events and reports `truncated` when incomplete;
it never returns another evaluation's rows or a cross-evaluation cursor. Artifacts use
GET `/api/admin/evaluations/<evaluation-user-id>/artifacts/<artifact-id>` or Emma review
with `artifact_id`; bytes stay authenticated, attachment-only, and without public URLs.
Reviewer inspection remains available after candidate revocation. Candidate access
remains denied. Provision/revoke still require the existing current administrator gate.

## Security and spend invariants

- HTTP has an explicit evaluation-route allowlist. JWT OAuth state cannot bypass
  it. Evaluation identities cannot mint or use delegated/service/admin tokens.
- Both tool registries and the agent executor enforce the same policy before mock,
  indirect, dynamic, or extra-context tool execution. The only admitted tool is
  `evaluation_workspace`; its evaluator actions cannot specify another user.
- MCP authenticates credentials on every request, binds local/durable sessions to
  their owner, and rechecks the active policy before every evaluation tool call.
  Old in-memory sessions cannot recover revoked access.
- Scheduled chat/social work refuses evaluation owners before execution and removes
  only a conditionally matching evaluation-owned schedule. No production provider
  is invoked by a denied action.
- Generation admits 1–100 calls per evaluation with an atomic decrement. There are
  no refunds or automatic retries. Inputs are limited to 8,000 prompt characters
  plus 30,000 characters of approved material; one candidate and 2,048 output tokens
  use fixed `gemini-3.6-flash` / `gemini-3.1-flash-image` models. Failed/in-flight calls consume budget. Revocation cannot
  unsend an already-admitted provider request, but its result is not stored/returned
  after revocation. The runtime receives no connector, browser, URL-fetch, org,
  conversation, or production-tool capability.
- At most 10 approved text materials, 100 artifacts, and 240,000 bytes per artifact.
  Uploads are opaque bytes, never executable/imported assets. Generated images are
  decoded with a pixel cap and re-encoded. Downloads require current authorization,
  use attachment/no-store/nosniff/sandbox headers, and never yield public URLs.

Model choice is verified against the provider: staging reproduced HTTP 404 for
`gemini-2.5-flash` (unavailable to new projects), whose response directs callers to
`gemini-3.6-flash`. The image model uses the maintained GA release listed in
[Google’s lifecycle documentation](https://ai.google.dev/gemini-api/docs/deprecations).
Creative requests use image-only output and an explicit image-rendering task; staging reproduced `NO_IMAGE` when the broad shared task permitted a written concept ([Google image-generation API](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)).
There is no fallback chain or user-selected model.

## Storage and deployment

`backend/scripts/provision-evaluation-storage.sh dev|prod` provisions the dedicated
`Dev-AW-Evaluations` / `AW-Evaluations` DynamoDB table (string `evaluationKey` hash,
on-demand billing, encryption, deletion protection, PITR). Runtime uses the existing
backend AWS identity. Policies, audit records, and artifact bytes live only here;
no S3, client asset table, ad account, or connector credential is an artifact target.
Dev/prod table selection follows the existing `NODE_ENV` convention. Provisioning
pins the same region as runtime (`AWS_REGION`, default `us-west-2`).

Harsha explicitly authorized the required production auth/security/data-plane and
persistence changes in the ENG-1870 implementation request. Dev and production
storage must exist before enabling the routes. No actual candidate account is
created by deployment or by the provisioning script.

Credential cleanup deliberately uses strongly consistent, owner-filtered primary
scans with key/owner projection and conditional deletes. Several grant tables have
no owner index; eventually consistent GSIs cannot prove complete revocation. This
is a rare administrative lifecycle operation, not a request hot path. The policy
barrier—not cleanup timing—is the authorization invariant.

## Verification and rollback

Before release: production build/typecheck, acceptance/security regressions,
exact-head GitHub merge evidence, and staging provision/use/deny/revoke with fresh
synthetic principals. Verify analysis, creative generation, binary round-trip,
foreign artifact denial, production/connector denial, exhausted budget, and old
JWT/API/OAuth/MCP access after revoke. Never use real client accounts or log tokens.
Repeat this non-destructive lifecycle on production after observing deployment.

Rollback must preserve the deny boundary while evaluation credentials exist.
First revoke every active evaluation using the shipped admin path and verify
cleanup/audit evidence. Then roll back application code; retain the dedicated
storage and audit records. Do not drop tables or revert auth protection while an
evaluation remains active. A forward fix that disables provision/generation while
retaining policy/revocation is the preferred emergency response.

Complexity: one authoritative policy and tool, one dedicated table, one small
server-rendered page; no second frontend runtime, new dependencies, generalized
permission matrix, shared asset pipeline, or candidate-specific configuration.
