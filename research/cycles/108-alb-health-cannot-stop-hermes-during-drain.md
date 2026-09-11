# Cycle 108 — ALB health cannot stop Hermes during drain

**UTC:** 2026-09-11T22:50:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 107: after `server.close`, nginx 502s new `/mcp`. Cycle 97:
`/` and `/health` stay 200 until that close. Does ALB then fail
those health checks and stop routing Hermes — so A-019 is
unnecessary — or does this tree never even declare a health path?

## Finding

**ALB health is not the Hermes-stop, and this tree never sets a
health path.** Zero `HealthCheckPath` /
`UnhealthyThresholdCount` / `HealthCheckInterval` hits in the
repo (same class as cycle 95’s unset `MCP_SESSION_STORE`). Live
AWS console unverified. What *is* git-proven: `/` and `/health`
always 200 with **no drain case** (`healthEndpoint.test.ts`
L51–75; `app.ts` L547–553). During the four-way wait they stay
200 so the target stays healthy. Hermes still lands on the dying
instance. That is A-019’s window.

### Why `/health` must stay 200 until close

ENG-1189 (`server.ts` L404–413): mcpFetch is `localhost:${PORT}`.
Close the listen before in-flight self-calls finish and they
`fetch failed` for the rest of the process’s life. Failing
`/health` during that wait would tell ALB to yank the instance
*while* loopback still needs the listen. The always-200 health
is not an oversight; it is the drain’s load-balancer face.

After close, nginx 502s `/health` too (cycle 107). That is a
**side effect**. The ASG hook awaits `onTerminating()` then
`CompleteLifecycleAction` (`asgLifecycleGuard.ts` L262–288:
“drained — lifecycle action completed, instance may terminate”).
`deploy.yml` L217 `EB_DEREGISTRATION_DELAY_SECONDS: '600'` then
holds *existing* connections (`eb-deploy.sh` L796–860). New
Hermes POSTs stop because the target is deregistering, not
because a health threshold finally tripped.

`IgnoreHealthCheck: false` (`rolling.config` L4) waits for the
**new** instance to be Green before removing the old one. It does
not fail the old target on drain.

Do not add `HealthCheckPath` from this cycle. Do not 503
`/health` during drain (that fights ENG-1189). A-019 refuse at
`disableCron` is the only admission that leaves the listen up for
mcpFetch. A fifth `listen()` would need its own health and would
still have to keep it green until *its* loopbacks finish.

Hermes/OMP: process exit *is* the health fail. AgentWeb’s
cutting-edge SDLC is in-process refuse, not an ALB threshold.

## Queue effect

A-006 stays **discard**. Q-001 stays **ready**. Q-014 stays
**ready**. A-019 stays **park** (this is why health is not the
gate).

## Next

Cycle 109: cheapest remaining. Candidate: enhanced health vs
target-group health lag (`eb-deploy.sh` `underlying_health_verdict`
L249–270) — deploy-verify only, not drain. Do not un-ready
Q-001 / Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
