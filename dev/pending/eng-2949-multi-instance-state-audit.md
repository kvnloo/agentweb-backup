## ENG-2949: Multi-instance in-memory state audit script + report (2026-11-12)

`backend/scripts/multi-instance-state-audit.mjs` statically inventories module-level Map/Set stores, Socket.IO without adapter and MemoryStore in `backend/src`, classifies them, and proves already-ported stores (ENG-301, ENG-114, ENG-2945, JWT login, DB password reset). Report: `docs/multi-instance-state-audit.{md,json}`. No runtime change.
