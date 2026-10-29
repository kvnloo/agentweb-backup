## ENG-590: Loop attribution comment adds How to verify from linked PR (2026-10-28)

- `recordLoopAttributionOutcome` reads the issue's GitHub PR attachments (Linear API, no GitHub token) and appends a "How to verify" section inside the existing idempotent loop-attribution comment.
- AC3 warn log for shipped mutations without a linked issue is now asserted.
