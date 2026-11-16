## ENG-3048: the agent run store is ON in production and on staging (2026-11-15)

Correction to three older entries. They say `AGENT_RUN_STORE` is unset in production. That is no longer true.

- ENG-2773 (2026-11-01): "Dark: active only with `AGENT_RUN_STORE=true` (unset in production)".
- ENG-112 (2026-10-08): "The run store is OFF in production today (`AGENT_RUN_STORE` unset), so only the in-process layer is live there."
- ENG-110 (2026-10-13), accepted risk: "AW-AgentRuns / AGENT_RUN_STORE is not provisioned".

Read from Elastic Beanstalk on 2026-11-15: `Agentweb-backend-env-prod-3` has `AGENT_RUN_STORE=true`. So in production the `idem#` submit locks (session create, plan session, chat branch, interactive submit) and the `run#` records are live. The ENG-112 note about a 409 `DUPLICATE_SUBMIT` on a retry that lands on another instance describes real production behaviour, not a dark path. The same stale sentence is in a comment at `backend/src/services/agentMode/chatBranching.ts:659`; it was not changed here.

Staging now matches. `AGENT_RUN_STORE=true` was set as an environment property on `Agentweb-backend-env-1` (the environment `staging-backend.yml` deploys, `NODE_ENV=development`) on 2026-11-16 UTC. It is an EB property, not repo config: no file in the repo owns staging environment variables, and `.github/scripts/staging-env-override.sh` is for temporary overrides only. Rollback: remove the property from the environment (the app restarts).

Things to know when testing on staging:

- Table is `Dev-AW-AgentRuns` (us-west-2), hash key `pk`.
- TTL is disabled on `Dev-AW-AgentRuns` (enabled on `ttl` in production). Locks still expire, because `claimIdempotency` treats an expired row as free. Rows are never deleted on dev, so the table only grows. Enabling TTL is a retention decision tracked on ENG-3050.
- The backend reaches DynamoDB with the `aw_backend_user` access key from the environment, not the instance role.
- Session create with a repeated `idempotencyKey` now returns the first session with `idempotentReplay: true` (200) instead of a second session (201). Checked on staging 2026-11-16 00:26Z: before the change two calls with one key gave two sessions; after it they gave one session and one `idem#` row.
