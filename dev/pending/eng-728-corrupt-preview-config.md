## ENG-728: Report corrupt preview overrides as errors (2026-10-07)

Production verification found that the UTM preview has no production caller yet, and source inspection reproduced a separate AC5 defect: malformed nonempty overrides were reported as skipped before validation. Validate overrides inside the per-lander error boundary before protecting valid overrides. Invalid values now produce error rows without reading deployed links. No storage, deployment, or apply boundary changes.

Scoped regression evidence: the existing preview Jest file went from 3 failed / 9 passed to 12 passed with a 768 MB heap. CodeRabbit local light review completed with zero findings. This narrow fix does not complete ENG-728: a read-only deployment adapter/invocation surface and production per-lander evidence remain outstanding.
