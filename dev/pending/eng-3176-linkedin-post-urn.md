## ENG-3176: linkedin_manage_post normalizes post_urn before socialActions calls (2026-11-23)

list_comments/comment/react/repost now accept a post URL or URL-encoded URN and reduce it to `urn:li:(share|ugcPost|activity):<id>`. A bare number or unrecognised value returns a model-facing validation message instead of LinkedIn's "Syntax exception in path variables". delete_post and get_analytics are unchanged. Code: `backend/src/emma/impl/linkedinPostUrn.ts`.
