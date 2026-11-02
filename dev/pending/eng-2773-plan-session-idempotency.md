## ENG-2773: createSessionWithPlan honours idempotencyKey (2026-11-01)

`POST /api/agent-mode/public/plan/:planTitle/session` now accepts an optional body `idempotencyKey`, using the
same ENG-147 `idem#` submit-lock as `createSession` (AW-AgentRuns, existing rows/attributes only, no schema change).
Dark: active only with `AGENT_RUN_STORE=true` (unset in production), so behaviour is unchanged today.

- Signed-in launchers only. Anonymous callers get a random `anon_` userId per call, so a key could never replay.
- Key = `createSessionIdempotencyKey(userId, "plan|<normalized title>|<clientKey>")`: per user and per plan,
  never colliding with `createSession` keys or another user.
- The winner's sessionId is recorded only after the session is fully built (model, plan, share token). A duplicate
  then gets the original `sessionId`/`redirectUrl`/`conversableToken`/`workPlan` plus `idempotentReplay: true`, and
  the starting message is NOT re-fired. A duplicate during the in-flight window gets 409 `DUPLICATE_SUBMIT`. A
  recorded session owned by another user is never returned.
- Any launch failure releases the claim so a retry can create the session.
