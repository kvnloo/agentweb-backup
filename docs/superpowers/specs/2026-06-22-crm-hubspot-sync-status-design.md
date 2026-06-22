# CRM per-lead HubSpot sync status — mark + filter

- **Date:** 2026-06-22
- **Branch:** harshit/hubspot-campaign
- **Status:** Approved design (pending spec review)

## Goal

In the customer-portal CRM, when a lead list is connected to an external CRM
(HubSpot for now):

1. Show a per-lead **mark** indicating the lead is connected to / in sync with
   the external CRM, including its sync state.
2. Provide a **filter** by sync state: `synced` / `sync_pending` /
   `update_pending` / `sync_failed`.

Both the mark and the filter appear **only when the list is connected to
HubSpot**. Provider-agnostic in shape, HubSpot-only in this version.

## Decisions (from brainstorming)

- **Mark form:** a small chip beside the contact name (like the existing
  attribution badge), not a dedicated column.
- **Source of truth:** persist sync state **on the lead**, written by the
  sync/auto-sync/edit paths. Authoritative when present; derived for legacy
  leads on read.
- **Never-synced leads (list connected):** shown as `sync_pending`.
- **v1 scope:** display + filter only. No per-row "retry / push now" action.
- **Filtering mechanism:** in-memory load-then-filter over loaded candidates
  (same pattern as the attribution/owner filters). **No new GSI, no backfill,
  no DynamoDB migration.** A `listId-syncStatus-index` GSI + backfill is the
  documented scale-up path if a single list grows large enough that
  load-then-filter becomes slow — easy to add later since the field is already
  persisted.
- **`update_pending` trigger:** only when an edit changes a **HubSpot-mapped
  field** (a field present as an enabled, push-direction `agentwebField` in the
  list's contact/deal/custom mappings). Edits to unmapped fields do not flip a
  synced lead to `update_pending`.

## Current state (what exists today)

- Leads live in `AW-Leads` (`backend/src/services/db.ts`). The only per-lead
  external-CRM signal today is `lead.syncMetadata.hubspot_contact_id` (present ⇒
  was pushed at least once). No per-lead status, failure, or "needs re-push"
  signal exists.
- Failures and last-sync timestamps are tracked only at the **list level** on
  `ExternalCrmSyncConfig` (`lastSyncStatus`, `lastSyncError`, `pushJob`).
- `hubspotAdapter.pushLeads` already writes `hubspot_contact_id` back per lead
  (per-lead path and batch path); `splitAndRetry`
  (`backend/src/utils/hubspotBatchRetry.ts`) already isolates a single failing
  record. These are the natural hook points for per-lead status writes.
- `externalCrmSyncService.autoSyncLead` does fire-and-forget single-lead sync on
  create/update when `autoSyncEnabled`.
- `FieldMapping = { agentwebField, crmProperty, direction, enabled }`; mappings
  live on the config as `contactFieldMapping`, `dealFieldMapping`,
  `customFieldMapping`. Defaults in `externalCrmSyncService.ts`
  (`DEFAULT_HUBSPOT_CONTACT_MAPPING`, etc.).
- CRM UI: `customer-portal/src/pages/CRM.tsx` (leads fetched via
  `GET /api/crm/lists/:listId/leads`, `fetchLeads()`). Server-side filters:
  `status`, `engagedOnly`, `linkedInConnected`; client-side: `search`,
  attribution, owner. All filters persist to URL. Lead rows render colored
  badges via Tailwind color-maps (status, attribution). Existing sync UI:
  `ExternalCrmSyncDialog`, `CrmSyncStatusBanner`, `CrmSyncPushProgressCard`.

## Data model

Add three fields under `lead.syncMetadata` (kept nested so it stays grouped with
`hubspot_contact_id`):

```ts
lead.syncMetadata = {
  hubspot_contact_id?: string,   // existing
  hubspot_deal_id?: string,      // existing
  crmRemovedAt?: string,         // existing
  syncStatus?: 'synced' | 'sync_pending' | 'update_pending' | 'sync_failed',
  lastSyncedAt?: string,         // ISO — last successful per-lead sync (tooltip)
  syncError?: string,            // last per-lead failure message (tooltip)
}
```

`syncStatus` represents the lead's state with the list's connected provider
(one provider per list in practice). No per-provider fan-out in v1.

## State machine

`resolveSyncStatus(lead, isConnected)` (read-time helper):
- If not connected → `null` (no chip, no filter).
- If `lead.syncMetadata.syncStatus` set → return it (authoritative).
- Else derive (legacy fallback): `hubspot_contact_id` present → `synced`,
  otherwise `sync_pending`.

Write transitions:

| Event | Condition | New `syncStatus` | Other writes |
|---|---|---|---|
| Lead created | list connected | `sync_pending` | — |
| Lead updated | connected, auto-sync **off**, was `synced`, a **mapped** field changed | `update_pending` | — |
| Push / auto-sync success (per lead) | — | `synced` | `lastSyncedAt = now`, clear `syncError` |
| Push / auto-sync failure (per lead) | — | `sync_failed` | `syncError = message` |
| Never pushed, no field yet | connected | (derived) `sync_pending` | — |

Notes:
- When auto-sync is **on**, an edit triggers `autoSyncLead`, which sets
  `synced`/`sync_failed` shortly after; we don't pre-set `update_pending` in that
  case (avoids flicker). When auto-sync is **off**, the edit path sets
  `update_pending` so the lead surfaces as "needs re-push" until the next manual
  push.
- "Mapped field changed" = the set of changed lead keys intersects the set of
  `agentwebField`s from `contactFieldMapping ∪ dealFieldMapping ∪
  customFieldMapping` where `enabled === true` and `direction ∈ {push, both}`.
  Use the config's mappings, falling back to the `DEFAULT_HUBSPOT_*` mappings
  when the config has none.
- Over-marking is safe (worst case: one unnecessary re-push); under-marking is
  not — when in doubt about a mapped-field change, mark `update_pending`.

## Backend changes

1. **Types** — extend the lead `syncMetadata` shape (wherever leads are typed in
   `db.ts`) with `syncStatus`, `lastSyncedAt`, `syncError`. Export a
   `LeadSyncStatus` union and the `resolveSyncStatus` helper (new small module,
   e.g. `backend/src/utils/leadSyncStatus.ts`) so backend and tests share one
   definition.
2. **Push adapter** (`hubspotAdapter.ts`) — at the points that already persist
   `hubspot_contact_id`:
   - per-lead path: on success set `synced` + `lastSyncedAt`, clear `syncError`;
     on caught per-lead error set `sync_failed` + `syncError`.
   - batch path: mark the contacts that succeeded `synced`; use the
     `splitAndRetry` single-item failure isolation to mark the specific failed
     lead `sync_failed`. Map failures back to leads by email.
3. **Auto-sync** (`externalCrmSyncService.autoSyncLead`) — same success/failure
   status writes for the single lead.
4. **Lead create/update path** (`crm.ts` POST/PUT leads and/or `db.ts`
   create/update) — set `sync_pending` on create and `update_pending` on a
   mapped-field edit, per the state machine, gated on "list connected & auto-sync
   off". Reuse the already-loaded sync config (the auto-sync path already fetches
   it) to avoid an extra read.
5. **List endpoint** (`GET /api/crm/lists/:listId/leads`) — accept a
   `syncStatus` query param. When present, filter in-memory over loaded
   candidates using `resolveSyncStatus` (so legacy leads filter correctly). Each
   returned lead carries its resolved `syncStatus` (+ `lastSyncedAt`/`syncError`)
   so the UI can render the chip without extra calls.

## Frontend changes (`customer-portal`)

- **Connected gate:** expose `isConnected` for the active list (HubSpot config
  with `accountId` or `apiKeyEncrypted`). The CRM page already loads sync config;
  derive the boolean there.
- **Chip:** beside the contact name (mirrors the attribution badge), rendered
  only when `isConnected`. Color-map: `synced`=green, `sync_pending`=gray/amber,
  `update_pending`=blue, `sync_failed`=red. Tooltip: `lastSyncedAt` ("Last synced
  …") or `syncError` for failures. Reuse the existing Tailwind color-map +
  `Badge`/tooltip patterns.
- **Filter:** add to the existing Filters popover, shown only when `isConnected`:
  All / Synced / Sync pending / Update pending / Sync failed. Persist to URL like
  the other filters; pass `syncStatus` to `fetchLeads()` / the leads endpoint.

## Out of scope (v1)

- Per-row "retry sync" / "push this lead now" action.
- `listId-syncStatus-index` GSI + backfill (documented scale-up path only).
- Multi-provider per-lead status fan-out (Attio etc.). Shape is provider-neutral
  but only HubSpot is wired up.
- Pull-side status semantics beyond the existing `crmRemovedAt`.

## Testing plan (TDD — backend tests first)

Extend the already-touched suites and add cases:

- **Adapter** (`hubspotAdapter.pushLeads.batch.test.ts`,
  `hubspotBatchRetry.test.ts`, `hubspotService.batch.test.ts`): push success sets
  per-lead `synced` + `lastSyncedAt`; an isolated batch failure marks exactly the
  failing lead `sync_failed` with `syncError`, others `synced`.
- **Service** (`externalCrmSync.service.test.ts`): `autoSyncLead` success →
  `synced`; failure → `sync_failed`.
- **Lifecycle** (service/route test): create → `sync_pending`; mapped-field edit
  (auto-sync off, was synced) → `update_pending`; unmapped-field edit → status
  unchanged.
- **Filter + fallback** (`crm.ts` route test): `syncStatus` param returns the
  right leads, including legacy leads with no `syncStatus` field resolving via
  `resolveSyncStatus` (`hubspot_contact_id` ⇒ `synced`, else `sync_pending`).

Run `npx tsc` after every `.ts` edit (including tests) and `npm test` before
commit, per project rules. Frontend chip/filter follow the existing
customer-portal testing strategy.

## Rollout

No migration. Persisted fields populate going forward; legacy leads resolve via
`resolveSyncStatus` at read time, so the mark and filter are correct from day one
without a backfill.
