## ENG-2532: Pure CSV lead-import parser for drip enrollment (2026-10-18)

Added `backend/src/services/dripSequenceCsvImport.ts` (`parseEnrollmentCsv`): header-mapped, normalized, deduped, suppression- and row-capped candidates. Pure; no persistence or wiring.
