## ENG-3044: Attio and ClickUp pending OAuth sessions use the shared AW-OAuthSessions store (2026-11-27)

Attio and ClickUp /finalize -> /connect sessions moved off module-level Maps onto storeOAuthFlowSession/consumeOAuthFlowSession, so a connect can complete on any backend instance. Provider union widened; per-provider payload validation added. Same existing table/row shape/10-minute TTL; merge gated on ENG-3041.
