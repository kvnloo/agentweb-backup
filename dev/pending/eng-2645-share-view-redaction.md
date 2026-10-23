## ENG-2645: Share views drop the system prompt and private reasoning fields (2026-10-23)

`GET /api/agent-mode/share/:id` and `/ishare/:id` no longer return `role:system` rows or `reasoning`/`reasoning_details`/`usage`/`refusal`/`llm` message keys. The anonymous view-only share also drops `supportNote`, `skills`, `slackThread` and `pendingWorkPlanInput` (not rendered by ShareConversation.tsx); the token-holding interactive share keeps them for the agent-mode UI.
