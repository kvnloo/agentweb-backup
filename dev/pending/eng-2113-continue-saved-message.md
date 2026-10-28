## ENG-2113: continue a stopped plan turn on AgentWeb credits without storing the message twice (2026-10-28)

When a Claude-plan turn stops after the user's message was saved, the stop response now says what is safe to offer:
- `canUseAgentWebCredits` is no longer withheld for a saved message (it is `true` for the stops where AgentWeb credits are a sensible alternative).
- `userMessageSaved` (existing) and the new `canContinueSavedMessage`: `true` only when the stopped turn is KNOWN to have run no tool at all (no ledger record, no tool event, no call still running; an unmarked error counts as "may have run"). The stop note stored in the chat carries `resumable: true` in that case.
- `POST /agent-mode/generate` accepts `continueSavedMessage: true` (literal `true` only) with the same `userMessage`: the saved message is answered again on the chosen funding (AgentWeb or the plan) and is NOT stored a second time. It is refused with 409 `CONTINUE_NOT_AVAILABLE` unless the chat ends with resumable plan-stop notes directly under that exact plain user message, and never together with attachments, audio, a question/work-plan answer or an approval deck. The turn re-checks this right before it skips the save.
- When a tool may have run, the client offers only "send as a new message" and should say an action may repeat.

No schema change; the only stored addition is `resumable` on the plan-stop note. Rollback: revert (old clients ignore the new fields).
