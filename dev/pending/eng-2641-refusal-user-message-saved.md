## ENG-2641: refused sends say whether the user message was stored (2026-10-23)

- Every refusal of `/generate`, `/ishare|share/:id/generate` and `/verified-generate` (422 `model_unavailable`, 409 `SESSION_BUSY`, 429 `TOO_MANY_CONCURRENT_RUNS` / usage paused) now carries `userMessageSaved: boolean`.
- It is `false` everywhere except two refusals raised after the message was written: the Work Plan step-model refusal in `generateSessionResponse` (the message is saved, then `resolveWorkPlanStepModelForTurn` throws) and a `/verified-generate` refusal on a later attempt (attempt 1 saved the starting message).
- Those errors are marked where they are raised (`markRaisedAfterUserMessageSaved`, a WeakSet keyed by the error) and read where the 422 is answered. A new post-save refusal must be marked the same way, or it would answer `false`.
- The step-model refusal was not moved before the save: Slack, transports, approval resume and scheduled runs depend on the saved message plus the recorded refusal ("never an unanswered message").
- `/compare/select` is not covered: its 409 is before the write, and a repeated select is answered as a replay, so it cannot duplicate.
