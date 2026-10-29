## ENG-2712: Delete unmounted webAgent service + marketResearch/guide routes (2026-10-28)

- Removed `backend/src/services/webAgent.ts`, `backend/src/routes/marketResearch.ts`, `backend/src/routes/guide.ts` (zero importers/mounts on main; guide.ts was a deprecation stub). Slice of ENG-1761. No data-plane changes.
