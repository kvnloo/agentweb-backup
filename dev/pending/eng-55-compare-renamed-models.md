## ENG-55: Compare no longer fails with model_mismatch for a model OpenRouter renamed (2026-10-09)

- Cause: OpenRouter dropped the bare `qwen/qwen3.8-max` id from its public catalog (only `qwen/qwen3.8-max-0902`, canonical `qwen/qwen3.8-max-20260902`, remains) but still routes the old id as an alias. Our registry kept the stale id, so Compare's strict served-model check (a base id must not accept a sibling's MMDD snapshot) refused the response: `model_mismatch`.
- Fix: registry/pricing key renamed to `openrouter/qwen/qwen3.8-max-0902`; the old id is a `LEGACY_MODEL_ALIASES` entry so existing sessions/schedules/settings keep working on the same model. The identity check is unchanged and still strict.
- Why the registry guard missed it: its snapshot comes from `/models/{id}/endpoints`, which follows aliases; it only checked parameters. It now also fails when a registry id resolves to a different id in the snapshot.
- Portal follow-up: add `'openrouter/qwen/qwen3.8-max'` to `LEGACY_MODEL_ALIAS_IDS` in `src/lib/modelUnavailable.ts`.
