## ENG-2688: per-list event/property allow-list in tracker ingest (2026-10-26)

Custom events on lists registered in TRACKING_ALLOW_LISTS store allow-listed props as namespaced fields (`event.prop`); other lists keep the single lastCustomProps blob. Registry ships empty (no behaviour change until a list is registered).
