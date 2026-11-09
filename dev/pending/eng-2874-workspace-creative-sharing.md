## ENG-2874: Workspace-wide creative library (2026-11-09)

Images/videos/HTML-report library endpoints now aggregate assets across same-org members (`backend/src/utils/workspaceAssets.ts`), stamping `createdBy`; org-less users see own assets; cross-org members filtered by orgId re-check. UI attribution and per-asset S3 authz are follow-ups.
