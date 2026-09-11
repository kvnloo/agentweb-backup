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

The evaluator can inspect approved case material, ask Emma for strategy/analysis,
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
Creative requests require image-only output so the provider cannot satisfy the request with only a text description ([Google image-generation API](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)).
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
