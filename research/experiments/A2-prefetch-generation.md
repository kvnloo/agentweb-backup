# A2 — Prefetch generation fence

Hypothesis: generation IDs plus bounded admission prevent stale asynchronous prefetch from committing after newer user intent.

Falsify if stale work can still commit, or the fence materially changes valid current-generation results.

Metrics: stale commits, rejected oversize results, cancellation/admission rate.
