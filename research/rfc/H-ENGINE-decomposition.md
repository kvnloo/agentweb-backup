# RFC-H-ENGINE — Agent engine improvements (decomposed)

**Status:** planning · **Issue:** [#9](https://github.com/kvnloo/agentweb/issues/9) · **Epic:** [#4](https://github.com/kvnloo/agentweb/issues/4)

| ID | Issue | PR |
|----|-------|-----|
| A-002 | #22 | [#3](https://github.com/kvnloo/agentweb/pull/3) |
| A-019 | #23 | [origin #3104](https://github.com/AgentWebPro/agentweb/pull/3104) |
| H-JEV | #6 | — |
| H-LEARN | #8 | — |
| Q-003 | #24 | parked |

Avoid `emma/tools.ts` (#2832) and `toolErrorClassifier.ts` (#2862).

Sequence: PR #2 → PR #3 → H-JEV → H-VOICE → H-LEARN → A-019

## A-019 drain boundary

New external `tools/call` requests receive HTTP 503 with their JSON-RPC request
IDs while draining. Authenticated internal continuations remain admitted;
initialize/session recovery and GET/SSE retain their existing behavior.
Admission tracking starts after authorization/scope checks but before any session
lookup, and releases in `finally`; core tracking separately covers tool execution.

`backend/src/__tests__/mcp.drain.test.ts` exercises the real HTTP SDK, core/tool
registry and cron registry with deferred lookup/execution gates, including
success, lookup/ownership failures, tool rejection and continuation siblings.
These bounded local diagnostics do not establish Atem execution, full application
bootstrap/seed or hosted CI acceptance. The private canonical queue is
[fork #107](https://github.com/kvnloo/agentweb/issues/107); updating the origin
feature branch remains held until the required test plane is available.
