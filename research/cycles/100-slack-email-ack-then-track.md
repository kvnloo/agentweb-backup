# Cycle 100 — Slack/email ack HTTP, then `track()`; park A-019

**UTC:** 2026-09-11T22:22:00Z
**Kind:** mapping + new park item
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 99: `chatbotTurn` is a sticky Socket.IO wrap with no
admission. Are Slack and Emma-email the same socket, or a
different ingress — and would fixing them mean editing
`routes/slack.ts` (#2393)?

## Finding

**Different ingress, same missing gate.** Slack and Resend
**ack HTTP 200 first**, then `cronJobRegistry.track()` the agent
turn. That work is already detached from the request, so
`server.close` does not abort it. Cron ticks still have
`isCronEnabled`. HTTP agent turns do not. One `draining` flag
inside `track()` covers Slack, email, GTM, chatbot, and the
future CallTool wrap. Do **not** start at `slack.ts`.

### HTTP already returned

`routes/slack.ts` L448–468: `POST /api/slack/events` sends
`res.status(200)` immediately (“Slack requires response within 3
seconds”). Then `slackAgentTurn` L249 / `slackThreadAgentTurn`
L887 — same ENG-1189 comment as chatbot. **Zero** `isCronEnabled`
in this file. #2393 owns the Slack channel port; cite only.

`webhooks.ts` L346–356: Resend `email.received` is
`void (async () => processInboundEmail)`.
`emmaEmailService.ts` L288–297: `track('emmaEmailAgentTurn',
generateSessionResponse)`. Webhook HTTP has already returned.

`gtmPlan.ts` L1500 is fire-and-forget `track('gtmPlanAgentTurn')`
plus `await import('../server')` (A-017). `admin.ts` L4754 same
shape.

### Three families

| Ingress | Admission today | Dies at |
|---|---|---|
| Cron ticks (`server.ts` L623+) | `isCronEnabled` then `track()` | `disableCron` |
| HTTP agent turns (Slack, email, GTM, verifiedGenerate, …) | `track()` only | `server.close` stops *new* HTTP; in-flight after-ack continues |
| Socket `chatbotTurn` (cycle 99) | `track()` only | `io.close` after `server.close` |

During the four-way wait the listener is still up, so a new Slack
event can ack 200 **and** `track()`, extending live `inFlight`
(cycle 98). After `server.close`, Slack retries hit the new
instance (`IgnoreHealthCheck: false`, cycle 97). Chatbot sockets
outlive that (3600s).

Hermes/OMP: one process, no Slack webhook pair. AgentWeb’s
cutting-edge SDLC is **one closed flag on the registry**, not a
Slack nanoservice and not a fifth `listen()`.

## Queue effect

**Park A-019** (score 27): refuse new `CronJobRegistry.track()`
while draining. Set the flag next to `disableCron()` in
`runDrain`. Do not edit `slack.ts` (#2393). Do not edit
`emma/tools.ts`. After the Q-014 CallTool wrap, not instead.
A-006 stays **discard**. Q-014 stays **ready**. A-013 unchanged
(still must not start at Slack).

## Next

Cycle 101: cheapest remaining. Candidate: `verifiedGenerateTurn`
/ `tryClaimSessionGeneration` on HTTP `/generate` during drain.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
