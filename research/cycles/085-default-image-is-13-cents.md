# Cycle 85 — Default image is $0.134; cost gate is Dynamo, not the leaf

**UTC:** 2026-09-11T21:58:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not touch:** billing / `ENFORCE_COST_CAP`.

## Question

Cycle 82: image `$` misses the default token gate. If cost *were*
gated, what is the blast radius of Q-014 listing `generate_image`
without an `image_model` — and does a nanoservice own that number?

## Finding

**Hermes that omits `image_model` hits the leaf hardcoded default
`gemini-3-pro-image-preview` at $0.134 (`IMAGE_GENERATION_PRICING_USD`).
Already-supported `gpt-image-2` is $0.04 (Q-003). Cost caps live in
Dynamo subscription types, not in git. A fifth process would copy
the book or drift. Q-014 lists; it does not pick the model.**

### Price book (in-process, one file)

`llmPricing.ts` L297–307:

| Model | USD / image |
|---|---|
| `gpt-image-1` / `gpt-image-2` | 0.04 |
| `gemini-2.5-flash-image` / `gemini-3.1-flash-image` | 0.039 |
| **`gemini-3-pro-image-preview`** | **0.134** |
| `gen4_image` | 0.05 |
| unknown (function fallback L351) | 0.04 |

Video is a different book (`VIDEO_GENERATION_PRICING_USD_PER_CLIP`
L313–322: $1.40–$3.20 / `seedance-2.0` $1.55) — Q-016 parked.

### Default chain when MCP omits `image_model`

`apiTools.ts` L2090 / L2103: `image_model` is optional; mcpFetch
forwards `args.image_model` (may be undefined).
`emmaApi.ts` L178–181 passes it through.
`generateImage` (`agentModeService.ts` L28970–28986): if unset,
`getImageApiDefaultModel()` (`agent_mode_image_api_default_model`
setting, L1576 / L2208–2222). Unsupported or missing → **undefined**,
and the leaf hardcodes `gemini-3-pro-image-preview`
(`imageGeneration.ts` L492–494 / L1542).

Admin can already flip that setting without Q-003. Q-003 is a
fail-open DesignArena mapper for the **hardcoded** fallback (live:
`gpt-image-2` image #3 / $0.04 vs default #22 / $0.134). Do not
un-ready Q-003; do not do it instead of Q-014; Matt before a
prod default flip.

### What “if cost were gated” means in this tree

- Authenticated `checkTokenUsage`: cost is a gate only when
  `llmUsagePolicy.enforcementState !== "observe"` **or**
  `ENFORCE_COST_CAP=true` (`tokenUsageService.ts` L351–396).
  Tier numbers are **admin Dynamo** (`subscriptionService.ts`
  L34–37). In-repo `FREE_TIER_FALLBACK` (L39–43) has **no**
  `monthlyTokenAllowance` and **no** `monthlyCostAllowance` →
  null = unlimited if DB is unreachable.
- Test fixtures use $60 / $150 / $200 hard thresholds
  (`60_000_000` micro-USD). Those are test shapes, not live
  prod. Arithmetic on them: $60 / $0.134 ≈ **447** default
  images vs $60 / $0.04 = **1500** `gpt-image-2`.
- `ANONYMOUS_SESSION_COST_CAP_USD = 2` (`tokenUsageService.ts`
  L182) **does** cost-gate `anon_*`. $2 / $0.134 ≈ 14 default
  images. Q-014 Hermes is OAuth/API-key (cycle 50: leaked
  anonymous CallTool dies at `lookupUser` before the leaf).

### Why this is not a nanoservice

The meter already reads this book in the leaf (cycle 36 / 82).
HTTP-splitting `generateImage` would need a second copy of
`IMAGE_GENERATION_PRICING_USD` or it would bill $0 (the
`isPerGenerationPriced` trap, `llmPricing.ts` L330–338).
Hermes/OMP: one price table in the package. AgentWeb already
has that table — in-process. Q-014 listing + Q-003 mapper
are the composition moves; not a fifth `listen()`.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready** (listing does not
change the default or the book). Q-003 stays **ready** (the
$0.134 vs $0.04 gap is why Matt-gated default flip exists).
Do not flip `ENFORCE_COST_CAP`. Do not invent git-hardcoded
tier dollars.

## Next

Cycle 86: cheapest remaining mapping. Candidate: `POST
/generate-video` is the same `metered` emmaApi face (L59 /
L189) with $1.40–$3.20 clips — same TOCTOU + token-gate miss,
Q-016 stays parked. Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
