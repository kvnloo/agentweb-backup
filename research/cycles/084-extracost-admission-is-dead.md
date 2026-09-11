# Cycle 84 — extra-cost admission is a dead API; images do not write it

**UTC:** 2026-09-11T21:55:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not touch:** billing.

## Question

Cycle 82: image `$` lands on `tokenUsage.totalCost` and misses the
default **token** gate. Is there a second, extra-cost cap that
would catch Hermes `generate_image` — `extraCostUsage` /
`checkExtraCostUsage`, whose own comment names “image gen”?

## Finding

**No. `checkExtraCostUsage` has zero production callers. Images do
not write `extraCostUsage`. The live writer is CRM enrichment
only, and even that counter is never read by
`requireEmmaTokenBudget`.**

The file comment (`tokenUsageService.ts` L623–625) says extra
cost “tracks non-token API costs (Google Search, enrichment, image
gen, etc.).” That list is stale for images.

### Writer vs gate vs comment

| API | Production callers | What it does |
|---|---|---|
| `incrementExtraCostUsage` | **only** `crmEnrichmentService.ts` L1958–1960 (`enrichment: …`) | fire-and-forget ADD onto `user.extraCostUsage` via `updateUser` (read-merge-write, L714–749) — not even the atomic TransactWrite the token meter uses |
| `checkExtraCostUsage` | **tests only** (`extraCostUsageService.test.ts`) | would gate on `monthlyExtraCostAllowance` (L663–689) |
| `getUserExtraCostUsage` | only `checkExtraCostUsage` | GSI GET of `user.extraCostUsage` |

`emmaTokenBudget.ts` imports `checkTokenUsage`, not
`checkExtraCostUsage`. `imageGeneration.ts` has zero
`incrementExtraCostUsage` / `extraCostUsage` hits. Image `$` is
`meterUserUsage` → `incrementUserTokenUsage` → `tokenUsage.totalCost`
(cycle 82).

Admin can *see* the field (`admin.ts` L211–212 lists
`extraCostUsage` for export). Seeing is not admitting.

### Why this is not a nanoservice

A fifth image process would either copy the **dead** extra-cost
gate (still unused), invent a new one (Harsha / billing), or
still hit `requireEmmaTokenBudget`’s token GET (cycles 81–82).
Do not wire `checkExtraCostUsage` onto Q-014: that would be a
new admission surface on a counter images do not increment.
Hermes/OMP: one spend instrument in the loop. AgentWeb already
has **three** counters (`totalTokens`, `totalCost`,
`extraCostUsage`) and MCP images only move the middle one, which
is observe-only by default.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready**. Do not add
`checkExtraCostUsage` to `emmaTokenBudget`. Do not “fix” the
stale comment from a research timer (that is a product nit, not
a listing blocker).

## Next

Cycle 85: cheapest remaining mapping. Candidate:
`imageGenerationCostUsd` (`llmPricing.ts` L348–351) vs typical
token allowances — blast radius **if** cost were gated; not a
reason to flip `ENFORCE_COST_CAP`. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
