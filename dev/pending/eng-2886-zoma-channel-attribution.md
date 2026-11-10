## ENG-2886: Zoma launch channel attribution helpers (2026-11-09)

Adds `backend/src/services/zomaChannelAttribution.ts`: canonical launch channels, per-channel tracked-link builder, utm/ref/referrer classifier (one channel per visit), and a first-touch funnel reducer. Pure; not yet wired to signup persistence (follow-up, data-plane gated with ENG-2880).
