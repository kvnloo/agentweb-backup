## ENG-2871: Delete retired Growth Genius backend route/controller/service (2026-11-09)

Removed `/api/growth-genius` (routes/growthGenius.ts, growthGeniusController, growthGeniusService and their tests). Prod nginx showed 0 requests to the path in 30 days. ENG-1761 slice; `GROWTH_GENIUS_CHAT_URL` OAuth redirect untouched.
