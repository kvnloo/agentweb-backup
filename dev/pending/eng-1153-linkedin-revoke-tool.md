## ENG-1153: Emma inspect/revoke LinkedIn Outreach account tools (2026-10-20)

New Emma tools `inspect_linkedin_account` and `revoke_linkedin_account` (backend/src/emma/linkedInAccountRevokeTools.ts). Revoke requires confirm=true, honours the org-shared owner guard, pauses queued social_engagement_action schedules, deletes at Unipile and locally, and reports what could not be cancelled.
