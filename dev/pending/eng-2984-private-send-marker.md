## ENG-2984: keep draft-send lease tokens out of lead responses (2026-11-14)

- The existing shared CRM response sanitizer now removes `emailDraftSendClaimedAt` for single-lead, list, search and update responses without mutating the stored lead or draft.
- Opslane's internal-marker exposure reproduced as three failing sanitizer regressions (unscoped, allowlisted and ordinary viewers), then passed. Existing concurrency tests remain green.
- No persistence write, lease duration, send eligibility or customer-facing wording changes in this slice. The parent PR remains data-plane approval held; the separate abandoned-claim refusal finding is not addressed here.
