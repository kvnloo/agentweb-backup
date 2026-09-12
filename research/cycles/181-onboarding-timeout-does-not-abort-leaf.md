# Cycle 181 — onboarding 180s race does not abort the 8 min leaf

**Date:** 2026-09-12T01:32:00Z
**Question:** Cycle 180 next: `generateWithTimeout`
`Promise.race` L487–507 does not abort the leaf at 180s.
Does a timed-out variant still meter?

**Answer:** Yes, if the vendor returns after 180s and
before the leaf’s own **8 min** race. Caller timeout is
a second `Promise.race` with no `AbortSignal`.
`AdImageGeneratorDep` has no cancel. Meter L551 runs
only after the leaf race *succeeds*, then S3. The UI
already stored a placeholder. Nested races, not a
nanoservice. Do not patch billing.

## Evidence

```487:514:backend/src/services/onboardingAdImageService.ts
    return await Promise.race([
      gen.generateImage({ ... }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({
          success: false,
          error: `image generation timed out after ${Math.round(timeoutMs / 1000)}s`,
        }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
```

`PER_VARIANT_TIMEOUT_MS` L81 is **180_000**. Leaf
`IMAGE_GENERATION_TIMEOUT_MS` L78–79 is **8 * 60 * 1000**
(env override or 8 min). Leaf `withTimeout` L89–102 is
the same race shape: it **rejects** the wrapper, it does
not abort `generationPromise`.

Meter is **after** that inner race succeeds (`imageGeneration.ts`
L538–551). A Gemini return at t=4 min: caller already
patched `placeholder://ad-image-failed` (L676–677);
leaf still `meterUserUsage` + S3. Three variants
`Promise.all` L663–673, so up to three orphan vendor
calls after the run “shipped.”

`AdImageGeneratorDep` L446–468 has prompt / filename /
userId / size / imageModel / logoImage — **no signal**.
Onboarding grep of AbortController/AbortSignal is empty.

Test L375–408: fake variant 2 hangs **5s** then returns
`https://s3/late.png`. `timeoutMs: 50`. Asserts elapsed
< 2000 and one placeholder. It does **not** assert the
hang was cancelled; `late.png` is discarded. The test
blesses the race.

Cycle 104: MCP mcpFetch default 5 min < leaf 8 min, and
Q-014’s hop does not cancel the leaf either. Same
contract hole, different caller.

Hermes `_prepare_fal_request` fail-closed is not a
timeout story. Cutting-edge 2026 cancel is
`AbortSignal` on the leaf, not a fifth HTTP hop that
would still need the same signal.

## What this is not

Not a product patch. Do not add `AbortSignal` on a
research turn. Do not change `meterUserUsage`. Do not
add A-021.

Not a Q-014 / Q-001 / Q-003 status change. Listing MCP
`generate_image` does not cancel onboarding variants.
Q-003 mapper still Matt-gated.

Not A-006. HTTP-splitting would copy two races unless
the port grows a signal.

## Relation to A-002 / A-007 / A-008

A-008 leaf should accept `AbortSignal` and pass it to
vendor HTTP. A-007 schema does not need it for Q-014
list. After #2, not instead of Q-014.

## Next cycle candidate

Late success after the 180s race still **S3-uploads**
(L564+) to a URL nobody stores. Orphan objects, billed.
File-level. Do not add A-021.
