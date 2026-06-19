# Spec: Change deal pipeline after push (with migration of existing deals)

- **Date:** 2026-06-18
- **Repos:** backend (agentweb) + customer-portal
- **Branch:** `harshit/hubspot-campaign`
- **Status:** Approved direction (migrate existing deals)

## Problem

The HubSpot deal pipeline for a lead list is **locked once any sync has occurred**:
- UI renders a read-only locked field when `hasSynced` (`ExternalCrmSyncDialog.tsx:1473`).
- Frontend omits `externalPipelineId` from the save payload when `hasSynced` (`:760`).
- Backend ignores the update when `alreadySynced` (`externalCrmSyncService.ts:252`).

Users need to change the pipeline after the first push, and move already-synced
deals into the new pipeline.

## Goal

Add a dedicated "Change pipeline" action (a button in the CRM sync settings) that:
1. Re-points the list's sync config to a different existing HubSpot pipeline.
2. Migrates existing deals into the new pipeline.

## Design

### Backend

1. **`externalCrmSyncService.changePipeline(userId, listId, provider, newPipelineId)`**
   - HubSpot-only (Attio has no pipelines) → throw otherwise.
   - Throw if no config exists for the list.
   - Validate `newPipelineId` exists via `svc.listDealPipelines()` → throw `Pipeline not found` otherwise.
   - Set `config.externalPipelineId = newPipelineId`, clear `config.hubspotDealStageMap`
     (force rebuild for the new pipeline), bump `updatedAt`, persist via
     `crmDb.setLeadListCrmSyncConfig` (bypasses the `alreadySynced` lock in `saveConfig`).
   - Return the updated config.

2. **Adapter fix — move existing deals on update** (`hubspotAdapter.syncDeal`, ~`:410`)
   - The deal **update** path currently calls `updateDeal(existingDealId, dealProps)` —
     `dealProps` omits `pipeline`, so existing deals never move pipeline.
   - Change to include `pipeline: config.externalPipelineId` when set (alongside the
     already-stage-mapped `dealstage`). HubSpot requires a deal's `dealstage` to belong
     to its `pipeline`; the recomputed `hubspotDealStageMap` guarantees a valid stage.

3. **Route** `PUT /api/crm-sync/config/:listId/:provider/pipeline`
   - `authenticateToken` + `verifyListOwnership` (mirrors existing crmSync routes).
   - Body `{ externalPipelineId }`. 400 if missing. 400 for non-hubspot.
   - Calls `changePipeline`, returns the updated config.
   - The migration re-push reuses the existing push-job flow
     (`POST /api/crm-sync/push/:listId/:provider`) triggered by the frontend after the
     pipeline change, so progress polling is shared.

### Frontend (`ExternalCrmSyncDialog.tsx`)

- Deal Pipeline section, when `hasSynced` + provider === 'hubspot':
  - Keep the current-pipeline display.
  - Add a **"Change pipeline"** button → reveals a `Select` of existing pipelines
    (reuses `fetchExternalPipelines` / `availableExternalPipelines`) plus a
    **"Move deals to this pipeline"** button and a one-line note: *"This re-points the
    list and moves existing deals into the selected pipeline."*
  - On apply: `PUT …/pipeline` with the chosen id → then call the existing push
    (`handlePush`) to migrate → poll → `fetchConfig()` to refresh.
  - Disable the button while the selected pipeline equals the current one or none chosen.

## Behavioral decisions

- **Migrate existing deals:** chosen semantics (re-push moves all deals).
- **Stage remap:** `hubspotDealStageMap` cleared on change; the migration push's
  `syncHubSpotStatusOptions` rebuilds it for the new pipeline (creating stages if needed).
- **Adapter sends pipeline on update (not just create):** keeps synced deals aligned to
  the configured pipeline. Tradeoff: a manual HubSpot pipeline move on a synced deal is
  reverted on the next sync (AgentWeb is system of record).
- **Single-pipeline HubSpot tiers:** only one pipeline exists → nothing to change to;
  the picker simply lists the one pipeline. Not an error.

## Testing (TDD — backend logic)

Backend (`__tests__/externalCrmSync.service.test.ts` + `crmSync.routes.test.ts` +
`hubspotAdapter.*`):
- FAIL: `changePipeline` for a non-hubspot provider throws.
- FAIL: `changePipeline` when no config exists throws.
- FAIL: `changePipeline` with an unknown `newPipelineId` throws (`Pipeline not found`).
- SUCCESS: `changePipeline` sets `externalPipelineId`, clears `hubspotDealStageMap`,
  persists, even when `lastPushSyncAt` is set (lock bypass).
- Adapter: `syncDeal` update path sends `pipeline` when `config.externalPipelineId` is set.
- Route: 400 for missing `externalPipelineId`; 400 for non-hubspot; success path returns
  updated config; ownership enforced.

Frontend (existing component test strategy):
- When `hasSynced`, a "Change pipeline" button is shown; clicking reveals the picker and
  the "Move deals" button; applying calls `PUT …/pipeline` then the push endpoint.

## Out of scope

- Creating a brand-new pipeline from the change flow (pick existing only for now).
- Per-lead/per-contact pipeline routing.
- Attio (no pipelines).
