## ENG-2540: Pure per-step drip-sequence performance aggregator (2026-10-19)

`backend/src/services/dripSequenceStats.ts` adds `aggregateSequenceStats(definition, events)`: it returns per-step and total counts and rates. Opens and clicks are deduplicated and filtered for bots, rates are null when the denominator is zero, and events for unknown steps are counted as orphans. Pure, with no wiring.
