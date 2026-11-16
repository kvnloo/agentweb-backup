# Prompt/model A/B testing: build vs buy (ENG-1348)

Status: investigation / recommendation. No spend or vendor commitment is made here.

## Current state (origin/main, 2026-10-20)

- No experimentation or flag vendor is integrated: `git grep -i "growthbook|launchdarkly|statsig|unleash"` over `backend/src` returns nothing.
- `backend/src/services/settingsService.ts` (`SettingsService.getSetting/getSettings/setSetting`) is a flat key/value store. Per-user behavior uses key names such as `templates_${userId}`. It has no cohorts, rollout percentages, variants, or exposure logging.
- The only way to compare two arms today is a manual canary via ad-hoc per-user settings keys.

## Use cases beyond ENG-1309

1. Model default changes (ENG-759 shipped without a staged rollout).
2. Prompt and system-instruction experiments (the ENG-1309/1310/1311 class).
3. Tier-gated model routing (ENG-669): choosing a router arm per cohort.
4. Pricing/UX experiments. These touch money and customer copy, so they stay human-gated either way.

What every case needs: deterministic sticky assignment per org/user, a rollout percentage, a kill switch, and an exposure tag on the session/judge records so ENG-1312 judge dimensions can be split by variant. Statistical analysis is needed rarely. Our volume is low, so most decisions are ship-and-watch with a bounded canary.

## Options

| | Build: minimal cohort layer | GrowthBook OSS (self-host) | GrowthBook Cloud Pro | Statsig / LaunchDarkly |
|---|---|---|---|---|
| Cost | engineering time only | $0 license; we run infra (container + Mongo) | ~$40/seat/mo | Statsig Pro ~$150/mo flat + events; LD higher, seat/MAU |
| Assignment | `hash(experimentKey:orgId) % 100 < pct` | SDK, sticky bucketing | same | same |
| Analysis | none (judge scores grouped by tag) | warehouse-native; needs a SQL source we don't have | same | hosted |
| Integration | ~1 service + tag on session records | SDK + new infra + data source | SDK + vendor data flow | SDK + vendor data flow |
| Risk | we maintain targeting rules | ops burden for a low-volume need | per-seat cost growth | Statsig changed owners twice (OpenAI 2025, Amplitude 2026) |

Pricing from vendor/G2 pages as of 2026-10; confirm before purchasing.

## Recommendation

Build the minimal layer now. Adopt GrowthBook (OSS first) only when a real need for statistical analysis shows up.

- Our requirement is sticky assignment, a percentage, a kill switch, and variant tags. That is about one small service, not a platform. The vendor value is in analysis, and that needs a warehouse source AgentWeb doesn't have.
- Keep the interface vendor-shaped (`getVariant(experimentKey, subject) -> {variant, inExperiment}`). Swapping in the GrowthBook SDK later is then a single-file change.
- Revisit when either happens: more than 2 concurrent experiments, or a decision needs significance testing instead of judge-score deltas.

Estimate for the build: Complexity Medium, about 1-2 PRs.
1. `experimentService` over `SettingsService`: config key `experiment_<key>` holds `{pct, variants, enabled}`; assignment is sha256-based and sticky by org; a unit-tested pure function.
2. Stamp `experimentVariants` on session/trace metadata so judge results (ENG-1312) can be grouped by arm. The service needs no schema change. Stamping the session records is additive metadata, but treat it as a data-plane change and get Harsha's approval before merging.

Gates: adopting any paid tier is new spend, and so is the infra for self-hosting GrowthBook. Both need Harsha's decision.
