## ENG-2945: ConsumedTokenStore port for Zoma preview tokens (2026-11-12)

Zoma Meta + Google write toolkits now claim preview tokens through one shared `ConsumedTokenStore` (in-memory default, `backend/src/mcp/zomaWriteGuard.ts`), so a token confirmed through one toolkit cannot be replayed through another in-process. Durable cross-instance store stays gated on ENG-2862. No persistence added.
