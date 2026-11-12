## ENG-2956: Typed deterministic scheduled-action contract + validator (2026-11-12)

- New pure module `backend/src/mcp/scheduledActionContract.ts`: `ScheduledAction` type and
  `validateScheduledAction(action, registry)` returning `{ ok: true } | { ok: false, reason, detail }`.
- Rejects agent-execution tools (ENG-2948 `isAgentExecutionTool`), unknown, internalOnly, admin-only,
  and scope-gated tools, plus `client_id`/`userId` identity overrides in args. Never throws.
- Not wired anywhere: no scheduler, persistence, or tool-registration changes. Scheduler wiring is a
  later data-plane (Requires: Me) child of ENG-2847.
