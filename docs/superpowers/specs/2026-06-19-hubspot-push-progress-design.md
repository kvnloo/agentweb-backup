# Spec: Live progress for HubSpot full-list push

- **Date:** 2026-06-19
- **Repos:** backend (agentweb) + customer-portal
- **Branch:** `harshit/hubspot-campaign`
- **Status:** Approved direction (push-only, live count + %, floating CRM-page card)

## Problem

When a user pushes a large lead list to HubSpot, they get **no feedback on how
far the sync has gotten, or whether it is still running**. The push is an async
background job that the dialog polls every 3s, but the `PushJob` record only ever
carries a *terminal* state (`running` → `completed`/`error`). So during a
multi-minute push the user stares at a spinner, then sees the final summary
("X new, Y updated") only at the very end — which reads as "stuck / never
completes" on big lists.

Flow today (`externalCrmSyncService.ts`):
- `startPushJob` (`:703`) creates a `PushJob`, persists it, runs `runPush` detached.
- `runPush` (`:794`) paginates leads in 500-lead chunks (`do…while(lastKey)`,
  `:818`), calling `adapter.pushLeads()` per chunk and accumulating counts.
- The job is persisted only at start and at completion — **no per-chunk update**.
- Frontend polls `GET …/push/:listId/:provider/status` every 3s
  (`ExternalCrmSyncDialog.tsx:862`) and shows only terminal state.

## Goal

Surface **live progress** — "Pushing to HubSpot — N / M (P%)" — in a **floating
progress card on the CRM page** (mirroring the enrichment progress popup), not in
the sync dialog. The card floats over the page, stays visible after the dialog is
closed, updates every poll (~3s), and reappears after a page refresh while the
push is still running.

## Scope

- **In:** full-list push (`runPush`), covering **both** the new batched adapter
  path and the per-lead path (progress is measured above the adapter).
- **Out:** pull (`pullAllContacts`). Pull is synchronous (route awaits it,
  `crmSync.ts:453`), has no job/poll, and the adapter's `pullContacts` paginates
  internally with no chunk boundary to report from. Adding pull progress requires
  converting pull to a background `PullJob` + an adapter progress callback — a
  separate, larger effort tracked elsewhere.

## Design

### Backend (`externalCrmSyncService.ts`)

1. **Extend `PushJob`** (`:39`) with two optional progress fields:
   ```ts
   processedCount?: number;  // leads pushed so far (authoritative — sum of real chunk sizes)
   totalCount?: number;      // best-effort denominator from list.leadCount (may drift)
   ```
   Both optional so existing persisted jobs and the synchronous path stay valid.

2. **Seed `totalCount` at the start of `runPush`.** It already fetches the list
   for `listName` (`:797`); reuse that read to grab `list.leadCount` and seed
   progress (`processedCount: 0, totalCount: N`) *before* the chunk loop, so the
   very first poll (within ~3s) already shows `0 / N (0%)`.

3. **Report after each chunk.** Inside the `do…while` loop (`:818`), after each
   `adapter.pushLeads()` returns, increment a local `processed += chunk.length`
   and persist it onto the job via a new private helper
   `reportPushProgress(config, processed)`:
   - Updates `config.pushJob.processedCount` and calls the existing
     `persistPushJob` (`:760`).
   - **No-op unless `config.pushJob` exists and `status === 'running'`** — so the
     synchronous `pushAllLeads()` path (`:689`, calls `runPush` with no job) and
     unit tests stay no-ops and never crash.
   - Cost: ~1 extra config write per 500 leads (a 4,200-lead push ≈ 9 writes) —
     negligible and consistent with how start/completion already persist.

   `runPush` mutates the same `config` object reference held by `startPushJob`;
   the final `done` job (`:729`) is built by spreading the original captured
   `job` (no progress fields), so completion cleanly drops progress. The card
   keys off `status === 'completed'` to switch to the final summary. No conflict.

4. **New provider-agnostic status route** (for refresh-resume — see below):
   `GET /api/crm-sync/push/:listId/status` (no `:provider`).
   - `authenticateToken` + `verifyListOwnership` (mirrors existing routes).
   - New service method
     `getRunningPushJobForList(userId, listId): Promise<{ provider, job } | null>`
     iterates the list's configured providers (`hubspot`, `attio`), returning the
     first whose `pushJob.status === 'running'` and is not stale
     (`isPushJobStale`). Returns `{ status: 'idle' }` when none.
   - Used **once on page load** to discover an in-flight push and its provider;
     the card then polls the existing provider-specific
     `…/push/:listId/:provider/status` endpoint.

### Frontend — floating card (mirrors enrichment's `EmailJobProgressCard`)

The display moves out of the dialog into a page-level floating card, copying the
proven enrichment pattern (`EmailJobProgressCard.tsx` — fixed bottom-right, poll
every ~2–3s, progress bar + %, 3-stat grid, ~30s linger then dismiss).

1. **New `CrmSyncPushProgressCard.tsx`** — near-copy of `EmailJobProgressCard`:
   - Polls `GET …/push/:listId/:provider/status`. Reads `processedCount`,
     `totalCount`, `status`, and on completion `result` (`newCount`,
     `updatedCount`, `errorCount`).
   - Running: header *"Pushing to HubSpot"*, subline `N / M` (or bare `N` when
     `totalCount` absent), progress bar, %.
     - `pct = totalCount ? Math.min(99, Math.floor(processedCount / totalCount * 100)) : 0`
       — clamp to ≤99 while running so counter drift / rounding never shows a
       premature 100%.
   - Completion: 3-stat grid **New / Updated / Errors**, green/red bar, Close
     button; `onCompleted` fires once (parent toast + lead refetch).
   - 404 / `idle` handling reused from `EmailJobProgressCard` (soft error, stop).

2. **`CRM.tsx`** — add `activePushJob: { provider: 'hubspot' | 'attio' } | null`
   state; mount `CrmSyncPushProgressCard` at page level next to
   `EmailJobProgressCard` (`~:10313`), gated on `activePushJob && selectedList &&
   token`. `onCompleted` → summary toast + `fetchLeads(...)`; `onClose` →
   `setActivePushJob(null)`. Mirrors the `activeEmailJob` wiring exactly.

3. **`ExternalCrmSyncDialog.tsx`** — add an `onPushStarted(provider)` prop.
   `handlePush` POSTs to start the job then calls `onPushStarted(provider)`
   instead of polling in-dialog. The card is now the sole progress display, so the
   dialog's `startPushPolling` / `finishPushJob` / resume-on-open (`:931`) /
   stop-on-close (`:951`) and the in-dialog `pushing` progress are removed (keep a
   brief disabled state on the button if desired). `CRM.tsx` passes
   `onPushStarted={(provider) => setActivePushJob({ provider })}`.

### Refresh / resume behavior

The `PushJob` is persisted on the sync config in DynamoDB (shared across org
members on the list). On CRM page load / when a list is selected, the page calls
the new **provider-agnostic** `GET …/push/:listId/status`; if a job is `running`
it sets `activePushJob` with the discovered provider and the card re-mounts and
resumes from the last persisted chunk. This is a deliberate improvement over the
enrichment card, which is in-session only and does **not** survive refresh.

## Behavioral decisions

- **Denominator from `leadCount`:** `list.leadCount` is a maintained counter
  (`db.ts` `incrementLeadCount`, `:4416`) and can drift. It is used for the % only;
  `processedCount` (sum of real chunk sizes) is authoritative. The ≤99% clamp
  hides any drift until completion flips the UI to the final summary.
- **Granularity = 500-lead chunk:** progress advances per page, matching the loop.
  The batched adapter path processes a whole chunk per call, so finer granularity
  isn't available without changing the adapter — out of scope.
- **Older lists without `leadCount`:** `totalCount` undefined → card shows a bare
  count ("N pushed"), no % (bar stays at 0 until done).
- **Polling, not sockets:** reuse the existing poll; the enrichment card being
  copied is itself poll-based. A ~2–3s cadence is ample for a multi-minute push
  and adds no Socket.IO surface.
- **Floating card, not in-dialog:** progress lives on the CRM page (mirroring
  enrichment) so it persists when the dialog is closed; the dialog only triggers
  the push and hands tracking to the card.

## Testing (TDD — backend logic)

Extend `__tests__/externalCrmSync.pushLock.test.ts` (or a sibling service test):
- FAIL→PASS: with `getLeadsByListId` mocked to return 2–3 pages, `persistPushJob`
  is called with **monotonically increasing** `processedCount` (e.g. 500, 1000, …).
- `totalCount` is seeded from `list.leadCount` and visible on the job before/while
  chunks process.
- `runPush` via the synchronous `pushAllLeads` path (no `config.pushJob`) does
  **no** progress writes and does not throw.
- Completion still yields `status: 'completed'` + `result`; error path still yields
  `status: 'error'` + `error`.
- `getRunningPushJobForList`: returns `{ provider, job }` for a list whose config
  has a `running` (non-stale) push job; returns null when none / all stale; picks
  the correct provider when only one of several configs is running.
- Route `GET …/push/:listId/status`: ownership enforced; returns the running job +
  provider, or `{ status: 'idle' }`.

Frontend (existing component test strategy): `CrmSyncPushProgressCard` renders
`N / M` + `P%` when a running job carries `processedCount`/`totalCount`, the
bare-count form when `totalCount` is absent (% clamped ≤99 while running), and the
**New / Updated / Errors** grid on completion. (UI formatting, not backend TDD.)

## Out of scope

- Pull progress (separate PullJob + adapter callback effort).
- Cross-navigation persistence: the card lives on the CRM page; navigating to a
  different route hides it (it re-discovers via resume on returning to CRM). A
  global app-wide indicator is out of scope.
- Sub-chunk (per-lead) granularity within the batched adapter path.
