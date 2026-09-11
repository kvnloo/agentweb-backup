# Cycle 81 — MCP quota is check-then-act, not a reservation

**UTC:** 2026-09-11T21:40:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not touch:** billing / `meterUserUsage` / ENG-1250 admission.

## Question

Cycle 80: MCP `POST /generate-image` has no `tryClaimSessionGeneration`;
`requireEmmaTokenBudget` is the brake. Is that check atomic (Dynamo
conditional / reserve-then-settle) or check-then-act (two parallel
Hermes `CallTool`s can both pass, both generate, both meter past the cap)?

## Finding

**Check-then-act. Two in-flight MCP image gens can both read
`allowed: true`, both hit the vendor, both ADD. The increment is
atomic at apply time but it does not refuse overshoot, and it
runs after the vendor succeeds.**

### The gate is a GET, then `next()`

`requireEmmaTokenBudget` (`emmaTokenBudget.ts` L152–196):

1. Classify the route (`POST /generate-image` is `'metered'`, L58).
2. `await checkTokenUsage(user.userId)` (L172).
3. If `!usageStatus.allowed`, 429. Else `next()`.

No increment. No `reserveSpend`. No hold on remaining quota.

`checkTokenUsage` (`tokenUsageService.ts` L278+) reads
`getUserTokenUsage` → `userDb.getUserById` (`db.ts` L1175–1186:
**UserIdIndex GSI**, not `getUserByIdConsistent`). Then compares
tokens/cost to the allowance and returns `{ allowed }`. The charge
path later uses `getUserByIdConsistent` because that GSI is
eventually consistent (`tokenUsageService.ts` L556–566). The
gate does not.

### The charge is later, fire-and-forget, fail-open

`emmaApi.ts` L174–182 then `svc.generateImage`. The leaf meters
**after** success (`imageGeneration.ts` L546–562
`void meterUserUsage(...)`).

`meterUserUsage` (`usageRecorderService.ts` L482–531) is `void`:
“metering must never fail or slow an LLM response.” It lazy-requires
`incrementUserTokenUsage`.

`incrementUserTokenUsage` (`tokenUsageService.ts` L468–616)
`applyMonthlyChargeAtomic` (`db.ts` L1930+) is a TransactWrite:
counter ADD + audit `counterAppliedAt`. Conditions are **userId +
month** (`db.ts` L1878 / L1952–1953), **not**
`totalCost < allowance`. Two successful gens both ADD. Exhausted
retries **fail open** (L607–615): counter not incremented, vendor
already paid.

### The reservation API is a different rail, unused here

`spendChargingService.ts` L1–20 is ENG-1250’s reserve → execute →
settle. **Step 5 (admission) is deliberately absent** and reserved
for Harsha behind shadow-reconciliation. `chargeForCall` /
`reserveSpend` have **zero** imports from `imageGeneration.ts`,
`emmaApi.ts`, or `agentModeService.ts`. Cycle 79 already: do not
touch billing. Wiring reservation onto Q-014 would be that gate.

### Why this is not a nanoservice

Express admits concurrent `POST /generate-image`. Each mcpFetch is
its own hop. A fifth `listen()` would **copy the GET** onto another
heap (worse TOCTOU), or it would invent a reservation Dynamo write —
Harsha / data-plane, not A-006. Hermes/OMP bound concurrency in the
**agent loop**; AgentWeb MCP is a **server** that lists the tool
(Q-014). Listing does not add a lock or a reservation. Keep the hop;
keep quota on the route; do not Redis-ify; do not copy
`tryClaimSessionGeneration` (wrong lock, cycle 80).

## Queue effect

A-006 stays **discard** (new citation: quota is TOCTOU; a fifth
process is not an atomic cap). Q-014 stays **ready**. A-017 stays
park. Do not add a remaining-quota `ConditionExpression` in a
research turn. Do not un-ready Q-001 / Q-014 / Q-003.

## Next

Cycle 82: cheapest remaining mapping. Candidate: Agent Mode /
chatbot `checkTokenUsage` faces share this GET (cycle 40), still
no `reserveSpend`. Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
