## ENG-2686: emit logout lifecycle signal via POST /api/auth/logout (2026-10-29)

Authenticated `POST /api/auth/logout` emits the `logout` app signal fire-and-forget (skipped for delegated sessions) and always returns 204. JWT remains client-discarded; portal wiring follows.
