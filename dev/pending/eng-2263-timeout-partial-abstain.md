## ENG-2263: a "continue" after a REAL time-limit partial no longer logs a false total (2026-10-12)

A preview run with AGENT_MODE_GENERATION_TIMEOUT_MS=25000 showed that a real time-limit partial (`kind: generation-timeout-continuation`) persists neither
`toolCalls` nor `crmEvidence`, although CRM tools ran in that turn. The next "continue" restated the totals the timed-out turn had fetched and the log-only
detector flagged them (`continuation:false`, `echoesEarlier:0`). The earlier note's claim that these partials are credited was only true for messages that carry
evidence. `crmEvidenceFromEarlierInvocations` now treats an earlier timeout message WITHOUT persisted evidence as incomplete, so the total check abstains for that
"continue" (the tag check still runs). A timeout message that does carry evidence is still credited, and a plain follow-up after a timeout is still fully checked.
Log-only; the reply is never edited. No controller change.
