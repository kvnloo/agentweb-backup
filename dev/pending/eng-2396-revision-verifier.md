## ENG-2396: Agent Mode image-revision post-merge verifier (2026-10-10)

`backend/scripts/verify-agent-mode-revision.mjs` drives revisionService image revision end to end via
batch-review (create -> needs_changes -> poll readback) on a verifier-owned fixture only: QA account
(`qa-*@agentweb.pro`), a QA-owned Agent Mode session (`VERIFY_SESSION_ID`), a QA-generated source image
(`VERIFY_SOURCE_IMAGE_URL`), and an internal QA Slack channel (`VERIFY_SLACK_CHANNEL`). One revision
(one image-provider call) per run. Offline test: `node --test backend/scripts/verify-agent-mode-revision.test.mjs`.
Negative confirmation-gate classification stays covered by `revisionService.confirmGate.test.ts`.
Approval-state checks retry until the deadline (the new asset lands before the source approval
updates). The new asset's `pending` status is a status check only: GET /batch-review defaults a missing
approval row to pending, so it cannot prove row persistence. No new persisted fields.
