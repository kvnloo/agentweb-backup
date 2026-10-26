## ENG-2648: answer/cancel turns are capped at limit x2 (2026-10-23)

Approval-deck answers/cancels and work-plan details answers continue a paused conversation, so the per-user concurrent-chat cap (`max_concurrent_generations_per_user`) admits them above the limit — but now only up to a hard ceiling of limit x2 (`PAUSED_TURN_CEILING_MULTIPLIER`). The slot is taken before the deck / request is consumed, so a 429 at the ceiling leaves it pending for a retry; the turn never gets refused after its writes ran. 0 still means unlimited.
