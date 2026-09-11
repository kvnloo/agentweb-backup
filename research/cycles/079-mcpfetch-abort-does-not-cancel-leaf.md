# Cycle 79 — mcpFetch abort does not cancel the leaf or skip the meter

**UTC:** 2026-09-11T21:32:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not touch billing.**

## Question

Cycle 78: MCP aborts at 5 min while the leaf may run 8. When
mcpFetch’s AbortController fires, does `POST /api/emma/generate-image`
stop — or does the vendor call continue and still meter?

## Finding

**The route does not listen for client close. `generateImage`
takes no AbortSignal. Meter is in the leaf after success. A 5 min
MCP abort can still produce an 8 min billed generation Hermes
never sees. A fifth `listen()` would make cancel a distributed
protocol. Aligning `timeoutMs` (cycle 78) is the in-process fix.**

### No cancel path on the hop

`emmaApi.ts` L174–187: `await svc.generateImage(...)` then
`res.json(result)`. No `req.on('close')`, no `req.aborted`, no
`AbortSignal`. Routes grep for those on `src/routes` is
essentially empty for this handler.

`ImageService.generateImage` / `agentModeService.generateImage`
(L28857) have no abort parameter. `withTimeout` (L89–102) is a
`Promise.race` that **does not abort** the losing promise — the
vendor call continues even after the 8 min reject, and certainly
after a 5 min HTTP client abort.

Meter (`imageGeneration.ts` L546–562) runs **after** success, at
the source, “every caller (agent-mode and non-agent)”. MCP is a
caller. If the loopback fetch is already aborted, Express still
finishes the handler; `res.json` may fail; the meter `void` still
fires. That is the one-charge-per-success invariant applied to a
success the MCP client did not receive.

Hermes/OMP: aborting `execute()` is aborting the same promise the
vendor is on. AgentWeb’s mcpFetch hop split the abort from the
work. A-006 would add a hop whose cancel story this tree does not
have (no AbortSignal through `generateImage`). Do not thread
cancel through the 40k file to “fix” Q-014. Do not un-ready
listing. `timeoutMs: 8 min` on mcpFetch makes abort and leaf
agree so this race shrinks; it does not add a process.

## Queue effect

A-006 stays **discard** (new citation: no AbortSignal; meter after
success; extra hop cannot cancel). Q-014 stays **ready**. A-017
stays park. Do not file a billing change.

## Next

Cycle 80: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
