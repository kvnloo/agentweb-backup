## ENG-2835: post-payment feedback ask trigger decision (2026-11-09)

Pure `decideFeedbackAsk` (backend/src/services/postPaymentFeedbackTrigger.ts): asks on the 2nd consecutive paid invoice of an app-generated custom subscription link, once per org per 90 days, idempotent on invoice id. Not wired; storage table and email copy are gated follow-ups.
