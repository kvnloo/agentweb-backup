# Cycle 027 — Agent-engine already extracted; it still JWT-calls the monolith

UTC: 2026-09-11T19:10Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** `imageGeneration|apiTools|loops/core` on 20 open
   `AgentWebPro/agentweb` PRs: **empty.** Filter including `task_monitor`
   hits stale **#361** (browser-use 0.10.1, updated 2026-07-03) — do not
   compete; this cycle does not edit the engine. A-007 / A-008 unscored.

2. **The one real extract still calls the god object over HTTP.**
   `task_monitor.py` L253–274 polls Dynamo `StatusStartTimeIndex` for
   `pending` (the scale/isolation reason: Playwright / conda cannot live
   on Elastic Beanstalk). It *also* mints `create_jwt_token` (`task_utils.py`
   L84–113, shared `JWT_SECRET`) and `requests.post`s
   `BACKEND_URL` (default `http://localhost:3001`) for HTML revision
   (`/api/tasks/.../revision` L129), scheduled chats
   (`/api/agent-mode/run-scheduled-chats` L303–317, service secret ENG-347),
   and shadow metering (`usage_reporter.py` L8–10, L258
   `POST /api/internal/usage`). Same composition as MCP `mcpFetch`, across
   process and language. Microsoft “extract when isolation forces it”:
   browsers, not `generate_image`.

3. **A-002 oracle (today’s tree passes).** `loops/core` has **18** prod
   `.ts` files, **35** `from`/`import()` specifiers. Specifiers that resolve
   *outside* `loops/core/`: only `orchestrator.ts` L27 and
   `instanceRunner.ts` L22 `../index` (documented). Zero `services/` /
   `emma/` / `db`. First-PR walker can assert exactly that set.

## DISCARD / rank

No rank change. A-006 stays discard: copying agent-engine for images would
add a JWT hop *and* a Dynamo queue (Harsha) for a leaf that already sits
behind `generateImage`. Product READY unchanged.

## Mapping evidence

`COMPOSITION.md` (fourth deploy unit). A-002 sketch oracle. `loops/core`
escape list: two `../index` imports.

## Next

Cycle 28: collision-only on `apiTools.ts` / `imageGeneration.ts` /
`loops/core`. Unsubscribe after `stop_after` (2026-09-12T06:00:00Z).
