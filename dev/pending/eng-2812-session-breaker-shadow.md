## ENG-2953: Shadow-wire session turn/spend breaker into the agent loop (2026-11-12)

- New `backend/src/services/sessionBreakerShadow.ts`, called once per agent-loop LLM turn in `agentModeService.ts`. DARK: no-op unless `SESSION_BREAKER_SHADOW=true` (caps `SESSION_BREAKER_SHADOW_MAX_TURNS`, default 40; `SESSION_BREAKER_SHADOW_MAX_SPEND_USD`, default 5).
- When on, logs one `session_breaker_would_pause` JSON line per cap multiple crossed. Never pauses, alters responses, writes tables, or notifies. Accumulators are in-memory per instance.
