# Org-Wide Sharing for KB, Templates, Landing Pages, WorkPlans, and Skills

**Status:** Draft — pending user review
**Author:** Harshit (with Claude)
**Date:** 2026-05-18
**Driver:** xCures customer feature request (relayed by Filipe Dinis); confirmed opt-in default by Filipe in Slack 2026-05-18 9:35 AM.

## 1. Problem

xCures (and similar org customers) need work products created by one team member to be discoverable, reusable, and editable by other members of the same organization. Today, most user-created entities are scoped strictly to a single `userId` with no org-aware access path.

Specifically requested:
- Knowledge Base (treated as the 3-pillar context for Emma: Brand Guidelines, Marketing Strategy, task-attached KB files)
- Templates (interpreted as HtmlTemplate — email + landing-page templates)
- Landing Pages (with their CRM-list links visible to org members)
- WorkPlans (with org-wide tags)

Existing partial implementations (WorkPlans, Skills) use an **implicit, auto-share** model: if your user has an `orgId`, every item you create is automatically visible to every org member. There is no opt-in flag and no co-editor concept. xCures' need — and Filipe's explicit guidance — is the opposite default: **share only if I opt in**.

## 2. Goals

1. Add explicit, opt-in org-wide sharing to five entity types: KB-bearing Tasks, HtmlTemplates, Landing Pages, WorkPlans, and Skills.
2. Introduce a per-user "share defaults" settings panel that controls behavior per entity type, with optional per-type co-editor lists.
3. When a user toggles a share default ON or OFF, retroactively apply the change to all of that user's existing items of that type.
4. Preserve current visibility behavior for WorkPlans and Skills during migration (no surprise un-sharing for users who already rely on the implicit-share model).
5. Audit Brand Guidelines and Marketing Strategy (the other two "pillars" xCures mentioned) to confirm they org-share as expected and fix only if broken.

## 3. Non-Goals

- No new CRM list / lead list sharing changes. `canAccessCrmList()` in `routes/crm.ts:10` already permits org members to access each other's lead lists.
- No changes to the Landing Page GitHub deployment model. LP repos live in the shared `AgentWebPro` GitHub org under a company token (`secretsManager.ts:396-418`), so there is no per-user GitHub auth barrier to remove.
- No changes to the `visibility` field on WorkPlans and Skills. That field tracks the platform-wide marketplace pipeline (`private → pending_review → public → system`) and is orthogonal to org sharing.
- No new shared/generic `AW-OrgShares` table or polymorphic ACL. Each entity carries its own share fields.
- No async job infrastructure for the retroactive bulk update. Synchronous update with a 2000-item cap per flip.
- No GSI on `orgId` in v1. Initial implementation uses Scan + FilterExpression, matching the current WorkPlans pattern. GSI is a v2 upgrade if scale demands it.
- No retroactive backfill of `orgId` onto items owned by users who never opt in. Items only get `orgId` stamped when a user creates them (current behavior) or when they flip a share toggle ON (new behavior, per §6.2).

## 4. Background: Existing Patterns

### 4.1 WorkPlan / Skill org-share (today)

Source: `backend/src/services/workPlanService.ts:42-64`, `backend/src/services/skillService.ts`.

Data model:
```typescript
interface WorkPlan {
  planId: string;
  ownerId?: string;
  orgId?: string;        // snapshot of owner's orgId at creation
  visibility: 'private' | 'pending_review' | 'public' | 'system';
  // ...
}
```

Behavior:
- At create time (`userWorkPlanRoutes.ts:65-82`): owner's `orgId` is stamped onto the plan if present.
- List endpoint (`userWorkPlanRoutes.ts:9-32`): merges `getWorkPlansByOwner(userId)` + `getWorkPlansByOrg(orgId)` + `getPublicPlansForAgentMode()`, deduped by `planId`.
- `getWorkPlansByOrg(orgId)` is a **full-table scan** with `FilterExpression: 'orgId = :orgId'` (`workPlanService.ts:156-163`).
- Edit / delete: owner-only, and only when `visibility === 'private'`.
- **No opt-in flag; no co-editor concept.**

### 4.2 Brand Guidelines + Marketing Strategy (today)

Source: `backend/src/routes/marketStrategy.ts:56-64`.

These live on either the User or the Organization record. If the user has an `orgId`, Emma reads from `org.marketStrategy` / `org.brandGuidelines`; otherwise from the user's own record. This is automatic, not opt-in.

This design **does not change** this behavior. §10 (Audit) verifies it works as xCures expects.

### 4.3 HtmlTemplates (today)

Source: `backend/src/controllers/htmlTemplatesController.ts`.

Stored in a DynamoDB settings row keyed by `templates_${userId}` (private) or `templates_public` (admin-managed). Each template has `type: ['email' | 'landing_page']` and an `isPublic: boolean` flag (admin-only).

The current storage shape (settings rows, not its own table) makes per-item org sharing awkward. This design migrates HtmlTemplate storage to a dedicated table — see §5.3.

### 4.4 Landing Pages (today)

Source: `backend/src/services/v0Service.ts:96-121`.

```typescript
interface GeneratedLandingPage {
  pageId: string;
  userId: string;
  leadListId?: string;
  deployedUrl?: string;
  customDomainUrl?: string;
  // ...
}
```

Stored in table `AW-LandingPages`. No `orgId` or share flag today. Repos live in the shared `AgentWebPro` GitHub org under a company token.

### 4.5 Tasks with KB (today)

Source: `backend/src/types/task.ts:28-31`.

```typescript
interface Task {
  taskId: string;
  userId: string;
  knowledgeBase?: string;          // GCS URL
  knowledgeBaseSize?: number;
  knowledgeBaseType?: 'public' | 'private';
  knowledgeBaseUpdatedAt?: string;
  // ...
}
```

KB is not a standalone entity; it's a set of fields on `Task`. Access to a task's KB is gated by `task.userId === userId` (`routes/tasks.ts:68-69`). No org-aware path today.

## 5. Design

### 5.1 User settings: per-type share defaults

Add a new field on `User`:

```typescript
interface User {
  // ...existing fields...
  shareDefaults?: {
    knowledgeBase:  { share: boolean; coEditors: string[] };
    htmlTemplates:  { share: boolean; coEditors: string[] };
    landingPages:   { share: boolean; coEditors: string[] };
    workPlans:      { share: boolean; coEditors: string[] };
    skills:         { share: boolean; coEditors: string[] };
  };
}
```

Default value for new users (and users without the field) is treated as all `share: false`, `coEditors: []`. This implements Filipe's opt-out default.

`coEditors` is an array of `userId` strings. Each entry must be a user who shares the owner's `orgId` at the time of write. Server validates this on save.

UI: new section in the customer-portal account settings page titled "Org-wide sharing." Five subsections (one per entity type), each with:
- A toggle: "Share my [Knowledge Bases / Templates / Landing Pages / Work Plans / Skills] with my organization"
- A multi-select dropdown: "Co-editors who can also edit these items" — populated from org members

The settings page is shown only if the user has an `orgId`. Users with no org see nothing.

### 5.2 Per-entity share fields

Add three fields to each shareable entity. The semantics are identical across all five entity types.

```typescript
shareToOrg?: boolean;   // explicit opt-in; default falsy
orgId?: string;         // snapshot at the time shareToOrg becomes true (or at create-time for already-org users; see §6)
coEditors?: string[];   // userIds in same org who can edit; default []
```

Apply to:

| Entity | File | Notes |
|---|---|---|
| Task (KB) | `backend/src/types/task.ts` | Adds the 3 fields alongside existing `knowledgeBase*` fields |
| WorkPlan | `backend/src/services/workPlanService.ts:42-64` | Adds `shareToOrg` and `coEditors`; `orgId` already exists |
| Skill | `backend/src/services/skillService.ts:57-58` (approx) | Adds `shareToOrg` and `coEditors`; `orgId` already exists |
| GeneratedLandingPage | `backend/src/services/v0Service.ts:96-121` | Adds all 3 fields |
| HtmlTemplate | `backend/src/controllers/htmlTemplatesController.ts:12-23` | Adds all 3 fields; storage migration — see §5.3 |

### 5.3 HtmlTemplate storage migration

HtmlTemplates currently live in `AW-Settings` rows keyed by `templates_${userId}`. To support per-item org sharing and querying by orgId, we migrate them to their own table `AW-HtmlTemplates`:

```typescript
interface HtmlTemplate {
  templateId: string;       // primary key
  userId: string;           // owner
  orgId?: string;
  shareToOrg?: boolean;
  coEditors?: string[];
  type: ('email' | 'landing_page')[];
  name: string;
  subject?: string;
  html: string;
  isPublic?: boolean;       // admin-managed public templates (preserved)
  createdAt: string;
  updatedAt: string;
}
```

GSIs on launch:
- `UserIdIndex` (partition: userId, sort: createdAt) — for listing user's own templates
- `IsPublicIndex` (partition: isPublic) — for listing public templates

A one-shot migration script reads every `AW-Settings` row matching key prefix `templates_`, flattens its `templates` array into individual `AW-HtmlTemplates` rows, and stamps `orgId` from the owner's current `orgId`. Original settings rows are kept until the migration is verified, then deleted in a follow-up.

### 5.4 Centralized permission helpers

Create a new module `backend/src/services/orgShareService.ts` exporting:

```typescript
interface OrgShareable {
  userId?: string;        // or ownerId — adapter per entity
  orgId?: string;
  shareToOrg?: boolean;
  coEditors?: string[];
}

export function canViewSharedItem(item: OrgShareable, user: { userId: string; orgId?: string }): boolean;
export function canEditSharedItem(item: OrgShareable, user: { userId: string; orgId?: string }): boolean;
```

Semantics:
- `canViewSharedItem`: true if `item.userId === user.userId` OR (`item.shareToOrg === true` AND `item.orgId` is non-empty AND `item.orgId === user.orgId`).
- `canEditSharedItem`: true if `item.userId === user.userId` OR (`item.coEditors?.includes(user.userId)` AND `item.orgId === user.orgId` AND `item.shareToOrg === true`).

Note: co-editor edit rights require sharing to actually be on. Removing share access also revokes co-editor edit rights, by construction.

Each entity's existing service routes (e.g. `userWorkPlanRoutes.ts`, `landingPages.ts`, etc.) replace inline `userId !== ownerId` checks with calls to these helpers. The helpers are pure functions and unit-testable in isolation.

### 5.5 List endpoints: merge pattern

Each entity's list endpoint follows the WorkPlans shape (`userWorkPlanRoutes.ts:9-32`):

```typescript
const user = await userDb.getUserById(userId);
const orgId = user?.orgId;

const [ownItems, orgItems] = await Promise.all([
  service.getXByOwner(userId),
  orgId ? service.getXByOrg(orgId) : Promise.resolve([]),
]);

const seen = new Set<string>();
const all = [...ownItems, ...orgItems].filter(i => {
  if (seen.has(i.id)) return false;
  seen.add(i.id);
  return true;
});

// Cap: 500 from each source. If either query returns more, slice and set a "truncated" flag in response.
res.json({ items: all.slice(0, 1000), truncated: ownItems.length >= 500 || orgItems.length >= 500 });
```

`getXByOrg(orgId)` filters by `orgId === user.orgId AND shareToOrg === true` using Scan + FilterExpression. This adds one new filter clause vs. the WorkPlans implementation.

**API response shape change:** The current `GET /api/user-work-plans` returns a flat array (`res.json(all)` at `userWorkPlanRoutes.ts:27`). The new shape is `{ items: [...], truncated: boolean }`. This is a breaking change for clients of every list endpoint touched here. Customer-portal callers must be updated in the same PR; staging deploy verifies no orphaned consumers.

**Known v1 limitations** (documented for future spec):
- Server-side sort, search, and cursor pagination across the merged set are not supported. The 500/source cap is the safety net.
- For orgs that exceed the cap, items are non-deterministically truncated (first N returned by the scan). This is acceptable for xCures' team size; v2 introduces an `OrgIdCreatedAtIndex` GSI per table for cursor pagination.

### 5.6 Create flow

At create time, each entity's POST route reads the user's `shareDefaults` and stamps the new item:

```typescript
const user = await userDb.getUserById(userId);
const defaults = user.shareDefaults?.<entityKey>;
const share = defaults?.share ?? false;
const coEditors = share ? (defaults?.coEditors ?? []) : [];

const item = await service.create({
  ...body,
  userId,
  ...(user.orgId && { orgId: user.orgId }),
  shareToOrg: share,
  coEditors,
});
```

The `orgId` stamp is unconditional when the user has one (current WorkPlan behavior), but is only meaningful when `shareToOrg === true`.

### 5.7 Per-item override

Each entity exposes a PATCH endpoint that accepts:
```typescript
{
  shareToOrg?: boolean;
  coEditors?: string[];
}
```

Authorized only for the item's owner (`userId === item.userId`). Sets `orgId` from owner's current `orgId` if not already set.

Co-editors cannot modify share fields. They can only modify the item's content fields.

## 6. Retroactive Bulk Update

This is the only mechanism that backfills `orgId`, `shareToOrg`, and `coEditors` onto pre-existing items.

### 6.1 Trigger

User PATCHes `/api/users/me/share-defaults` with a new value for any of the 5 entity-type entries. For each entry where `share` or `coEditors` has changed, the server kicks off a bulk update for that entity type.

### 6.2 Behavior

**When `share` flips ON for entity type T:**
1. Query the items owned by the user via the existing `UserIdIndex` (each of the 5 entities has one).
2. If item count exceeds 2000, refuse with HTTP 400: `{ error: 'BULK_UPDATE_TOO_LARGE', count }` — user contacts support.
3. For each item, issue an `UpdateItem` with:
   - `SET shareToOrg = :true`
   - `SET orgId = :userOrgId` (only if missing)
   - `SET coEditors = :defaultCoEditors`
4. Run with concurrency 10. Wait for all to complete before responding.

**When `share` flips OFF for entity type T:**
1. Query as above.
2. For each item: `SET shareToOrg = false, coEditors = []`. `orgId` is left in place (harmless when `shareToOrg = false`).

**When only `coEditors` changes (share stays ON):**
1. Query as above.
2. For each item where `shareToOrg === true`: `SET coEditors = :newDefaults`.

**Per-item overrides are not preserved.** A user who flips the master toggle accepts that all their items of that type will be reset. The UI must show a confirmation modal: *"This will update sharing for N items you own. Continue?"*

### 6.3 Safety

- The bulk-update endpoint enforces the 2000-item cap before any writes.
- Each `UpdateItem` is independent; a partial failure leaves some items updated and some not. The endpoint returns `{ updated: N, failed: M, errors: [...] }`. UI shows a summary toast. Users can re-trigger the flip to retry failed items.
- Concurrency is bounded (10 parallel `UpdateItem` calls) to avoid DDB throttling.

### 6.4 Why synchronous, not async

DynamoDB has no SQL-style `UPDATE ... WHERE` (PartiQL `UPDATE` still requires a primary-key match). Bulk update is always N round-trips. For 200 items at ~20ms each with concurrency 10, total ≈ 400ms. For 2000 items, ≈ 4s. This is acceptable as a synchronous request. Async + job-status infrastructure is not justified for the expected workloads.

## 7. WorkPlans + Skills Migration

WorkPlans and Skills currently auto-share to org if owner has `orgId`. After this change, only items with `shareToOrg === true` are visible to org members. A one-shot migration preserves current visibility:

**Step 1 — Migrate items:**
```
For each WorkPlan where orgId IS SET:
  SET shareToOrg = true
For each Skill where orgId IS SET:
  SET shareToOrg = true
```
(Items with no `orgId` are left as-is — they were already invisible to orgs.)

**Step 2 — Migrate user defaults:**
```
For each User where orgId IS SET:
  SET shareDefaults.workPlans = { share: true, coEditors: [] }
  SET shareDefaults.skills    = { share: true, coEditors: [] }
```
This preserves the implicit-auto-share semantic users have grown accustomed to: their **new** WorkPlans and Skills continue to auto-share.

For the three new entity types (KB, Templates, LPs), the default in `shareDefaults` is `{ share: false, coEditors: [] }` — Filipe's opt-out semantic.

Existing org-shared items keep their `coEditors: []` (empty) post-migration — no one inherits edit rights on items the original owner didn't choose to share with them. This is the conservative migration: visibility is preserved, but edit rights are not expanded.

**Step 3 — Update list-merging logic:**
`getWorkPlansByOrg()` and `getSkillsByOrg()` add `FilterExpression: 'orgId = :orgId AND shareToOrg = :true'`. Pre-migration items without `shareToOrg` would be silently invisible — Step 1 prevents that.

**Migration runs as a script in `backend/src/scripts/migrate-share-defaults.ts`**, executed manually post-deploy by an admin. Idempotent (skips items where `shareToOrg` is already set).

## 8. Routes Surface

### 8.1 New endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/users/me/share-defaults` | GET | Returns user's `shareDefaults` |
| `/api/users/me/share-defaults` | PATCH | Updates one or more entries; triggers retroactive bulk update per §6 |
| `/api/users/me/org-members` | GET | Returns list of users in caller's org (for co-editor dropdown) — if it doesn't already exist |

### 8.2 Modified endpoints

For each of the 5 entity types:

| Existing route | Change |
|---|---|
| `GET /api/<entities>` (list) | Merge own + org-shared as in §5.5 |
| `POST /api/<entities>` (create) | Inherit from `shareDefaults` per §5.6 |
| `PATCH /api/<entities>/:id` | Allow updating `shareToOrg` and `coEditors` (owner only); allow content edits by owner OR co-editor via `canEditSharedItem` |
| `DELETE /api/<entities>/:id` | Owner-only (co-editors cannot delete) |

The 5 entities are: Tasks (KB-bearing), HtmlTemplates, LandingPages, WorkPlans, Skills.

For HtmlTemplates specifically, the route surface in `routes/htmlTemplates.ts` is rebuilt against the new `AW-HtmlTemplates` table. The old settings-based storage is read-only during the transition period (one deploy), then removed.

## 9. Frontend Changes

### 9.1 Settings page

New section in `customer-portal/src/pages/Settings/...` (exact path determined during implementation): five toggles + co-editor multi-selects as described in §5.1. Submitting changes calls `PATCH /api/users/me/share-defaults`. On success, a toast shows the per-entity result counts. On the 2000-item-cap error, an inline message tells the user to contact support.

### 9.2 Per-item share controls

Each entity's edit page gets a small "Sharing" panel:
- Read-only "Shared with org: yes/no" for non-owners
- "Shared by [owner name]" badge on non-owned items
- For owners: a checkbox and co-editor multi-select that PATCHes the item

### 9.3 List screens

Items shared by other org members appear in the same list as the user's own items, with a "Shared by [name]" badge. Sort order: own items first, then org-shared (matches dedupe order in §5.5).

## 10. Brand Guidelines + Marketing Strategy Audit

Before merge, a two-user test in staging:
1. User A in Org X sets Brand Guidelines + Marketing Strategy via existing UI.
2. User B (same Org X) loads Emma and uses `read_brand_guidelines` and `read_market_strategy` tools (referenced in `agentModeService.ts:4330,4349`).
3. Confirm User B receives User A's content.

If audit passes: no changes needed; xCures' "three pillars" request is satisfied by this design + existing behavior.
If audit fails: file as a separate bug, fix in a follow-up PR (out of scope for this design).

## 11. Tests

For each of the 5 entity types, a `backend/src/__tests__/orgShared<Entity>.test.ts` modeled on `orgSharedWorkPlans.test.ts`:

1. Owner creates item with `shareToOrg = true` → owner can GET, PATCH, DELETE.
2. Owner creates item with `shareToOrg = false` → other org member cannot GET.
3. Owner shares item → other org member can GET, cannot PATCH or DELETE.
4. Owner adds another user as co-editor → co-editor can PATCH but not DELETE.
5. User in different org cannot GET, PATCH, or DELETE.
6. Co-editor list contains user from different org → server rejects PATCH with 400.

For the bulk update flow, a `backend/src/__tests__/shareDefaultsBulkUpdate.test.ts`:

7. Flipping `share: true` updates all owned items of that type to `shareToOrg = true` and backfills `orgId`.
8. Flipping `share: false` updates all to `shareToOrg = false`.
9. Updating co-editors propagates to all shared items of that type.
10. User with >2000 items of a type receives 400 on flip; no writes occur.
11. Migration script (Step 1 of §7): existing WorkPlans with `orgId` get `shareToOrg = true`; those without `orgId` do not.

For permission helpers (`orgShareService.ts`), a unit test file:

12. `canViewSharedItem` and `canEditSharedItem` cover all owner / co-editor / same-org / different-org / no-org / share-off combinations.

## 12. Deployment

Standard backend + customer-portal PR flow per `CLAUDE.md` "Prep for Deploy" section. Migration script (§7) executed manually post-deploy in production. HtmlTemplate settings-row cleanup (§5.3 final paragraph) is a separate follow-up commit after one production deploy cycle.

## 13. Open Questions

- **Owner-leaves-org edge case:** If a user is removed from their org, their items keep the old `orgId` stamp and become invisible to both the old and new org. The current spec accepts this as the expected behavior (items stay with their original sharing context until the owner re-shares). If product wants different behavior (transfer ownership, transfer to org, etc.), it's a follow-up.
- **HtmlTemplate `isPublic` interaction:** Some HtmlTemplates today are admin-published with `isPublic: true`. The new `shareToOrg` is orthogonal — public templates remain visible to all platform users regardless of `orgId`. Implementation should preserve this and write tests for the combination.

## 14. Future Work

- Add `OrgIdCreatedAtIndex` GSI to each of the 5 tables and switch list endpoints to cursor-paginated merge. Unlocks server-side sort and pagination for large orgs.
- Cross-org transfer of items when an owner moves orgs (today, the orgId stays stamped to the old org, making items invisible).
- Granular role system beyond owner/member (e.g., `editor` role at org level) — would replace per-item co-editor lists.
- Org-level audit log: who shared what, when, with whom.
