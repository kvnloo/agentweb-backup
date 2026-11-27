## ENG-3196: Pure campaign-change risk classifier for Emma action engine (2026-11-26)

Adds `backend/src/services/campaignChangeRiskPolicy.ts`, a deterministic, fail-closed, tenant-scoped classifier (execute / stage_for_approval / reject). Shadow library only; not wired into any execution path. First slice of ENG-1970.
