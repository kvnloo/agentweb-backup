## ENG-2820: Pure per-session turn/spend circuit-breaker evaluator (2026-11-05)

`backend/src/services/sessionSpendBreaker.ts` adds `evaluateSessionSpendBreaker`, which
decides continue / pause_for_confirmation / pause_and_notify (scheduled runs) from session
turns, spend, and caller-supplied caps. A confirmation at turn T suppresses re-trips until the
next cap multiple. Dark: not imported by any live path; caps, copy, and wiring stay with ENG-2812.
