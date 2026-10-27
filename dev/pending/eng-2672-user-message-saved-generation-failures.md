## ENG-2672: generation failures after the save now say `userMessageSaved` (2026-10-26)

- `POST /api/agent-mode/generate`, `/share/:id/generate` / `/ishare/:id/generate` (and the conversable generate) answer 503 `PROVIDER_UNAVAILABLE` (both branches), 503 `SERVER_RESTARTING`, 413 `CONTEXT_LIMIT_EXCEEDED` and 504 `GENERATION_TIMEOUT` with an added `userMessageSaved` boolean. It is `true` only when the turn's user message was already stored in the chat (the ENG-2641 mark set by `generateSessionResponse`; `withGenerationTimeout` marks its own timeout error from the turn it races), else `false`. Status codes, codes and the other body fields are unchanged.
- The duplicate-send 409 `SESSION_BUSY` (idempotency claim lost) is `true` only when the chat already holds a user message with this request's `clientId`; no `clientId`, a read failure, or a first copy that has not stored it yet stays `false`.
- Portal: `GENERATION_TIMEOUT` and `SERVER_RESTARTING` honour the flag (companion portal PR).
- `/verified-generate` is untouched (server-side callers, no composer draft).
