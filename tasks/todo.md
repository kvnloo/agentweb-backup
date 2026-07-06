# Project TODO

## Follow-ups

### ENG-182 (partial): pre-invite LinkedIn dedup cross-check — NOT YET DONE

ENG-182 has two suggested fixes. Only fix (b) — the per-recipient retry breaker
scoping — is implemented on branch
`autofix/eng-182-crm-linkedin-invite-dedup-gap-newly-park`
(see `backend/src/services/agentToolGatewayService.ts`, `failureScope` /
`clearToolFailures`). **ENG-182 is therefore NOT fully resolved.**

Fix (a) is still open and must be tracked as its own follow-up ticket:

- **What:** Before parking/inviting Dream-100 candidates, cross-check each
  candidate against `list-sent-invitations` on the connected LinkedIn account
  (Unipile), not just against the CRM list.
- **Why:** The user's primary symptom — send-invite to profiles that look
  net-new in CRM still returns "Cannot resend yet" and burns a run's invite
  quota — persists without this. The breaker-scoping fix only stops one
  already-invited recipient from blocking *unrelated* recipients; it does not
  prevent the wasted invite attempts themselves.
- **Where:** LinkedIn outreach path in
  `backend/src/services/agentModeService.ts` (`send-invite` case) and/or the
  parking flow; reconcile CRM "already-invited" state against pending
  LinkedIn invitations before attempting a send.
