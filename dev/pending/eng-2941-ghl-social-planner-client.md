## ENG-2941: GoHighLevel Social Planner draft client, dark (2026-11-11)

- Added `backend/src/services/gohighlevel/socialPlannerClient.ts`, a typed client for GHL v2 Social Planner create-post (`POST /social-media-posting/{locationId}/posts`). The HTTP transport is injected.
- It only creates drafts. A non-draft status is refused before any request is built. Inputs are validated (https media, max 3000 chars of text, at least one account id). Errors are typed: auth, validation, rate_limited, retryable, unexpected.
- Dark: `GHL_SOCIAL_PLANNER_ENABLED` defaults to off, and the client is not registered as an Emma tool. OAuth and credential storage, tool registration and enablement stay on ENG-2872.
