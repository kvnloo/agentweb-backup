# Org-Wide Sharing for KB, Templates, Landing Pages, WorkPlans, and Skills

**Status:** Draft — pending user review
**Author:** Harshit (with Claude)
**Date:** 2026-05-18 (revised 2026-05-19)
**Driver:** xCures customer feature request (relayed by Filipe Dinis); confirmed opt-in default by Filipe in Slack 2026-05-18 9:35 AM.

## 1. Problem

xCures (and similar org customers) need work products created by one team member to be discoverable, reusable, and editable by other members of the same organization. Today, most user-created entities are scoped strictly to a single `userId` with no org-aware access path.

Specifically requested:
- Knowledge Base (treated as the 3-pillar context for Emma: Brand Guidelines, Marketing Strategy, task-attached KB files)
- Templates (interpreted as HtmlTemplate — email + landing-page templates)
- Landing Pages (with their CRM-list links visible to org members)
- WorkPlans (with org-wide tags)

Existing partial implementations (WorkPlans, Skills) use an **implicit, auto-share** model: if your user has an `orgId`, every item you create is automatically visible to every org member. There is no opt-in flag, no admin control, and no editor concept beyond owner-only edits.

This design moves access control from the **per-user, per-item** model to a **per-org, per-feature admin-controlled** model: the org admin (owner) decides which features are shared and who can edit. Item owners do not choose; admins do.

## 2. Goals

1. Add admin-controlled, org-wide sharing for five entity types: KB-bearing Tasks, HtmlTemplates, Landing Pages, WorkPlans, and Skills.
2. Replace ownership-of-orgId-on-items with **dynamic lookup**: an item belongs to whichever org its owner currently belongs to.
3. Per-feature editor lists on the Organization record, assigned by the admin.
4. When a member is removed from an org, the admin chooses per-feature what happens to their items (transfer to admin, delete, or let them leave with the user).
5. Preserve current visibility behavior for WorkPlans and Skills (existing orgs continue to see each other's plans / skills post-migration).
6. Audit Brand Guidelines and Marketing Strategy (the other two "pillars" xCures mentioned) to confirm they org-share as expected; fix only if broken.

## 3. Non-Goals

- No per-user sharing settings. The org admin is the sole decision-maker.
- No per-item share flags. Every item by an org member is either visible to the whole org (when the feature is enabled) or only to its owner (when the feature is disabled).
- No per-item co-editor lists. Editors are assigned per feature on the org record, not per item.
- No new CRM list / lead list sharing changes. `canAccessCrmList()` in `routes/crm.ts:10` already permits org members to access each other's lead lists.
- No changes to the Landing Page GitHub deployment model. LP repos live in the shared `AgentWebPro` GitHub org under a company token (`secretsManager.ts:396-418`), so there is no per-user GitHub auth barrier to remove.
- No changes to the `visibility` field on WorkPlans and Skills. That field tracks the platform-wide marketplace pipeline (`private → pending_review → public → system`) and is orthogonal to org sharing.
- No new shared/generic `AW-OrgShares` table or polymorphic ACL.
- No async job infrastructure. The only place bulk writes happen is user-removal item transfer; that path runs synchronously with a 10k-item cap, concurrency 25, mirroring the constraints documented in §7.
- No new `orgId` field on KB-Tasks, HtmlTemplates, or Landing Pages. Ownership comes from the owner's current `orgId`, looked up at read time.
- No GSI on `orgId` in v1.

## 4. Background: Existing Patterns

### 4.1 WorkPlan / Skill org-share (today)

Source: `backend/src/services/workPlanService.ts:42-64`, `backend/src/services/skillService.ts`.

Today's behavior:
- At create time (`userWorkPlanRoutes.ts:65-82`): owner's `orgId` is stamped onto the plan if present.
- List endpoint (`userWorkPlanRoutes.ts:9-32`): merges `getWorkPlansByOwner(userId)` + `getWorkPlansByOrg(orgId)` + `getPublicPlansForAgentMode()`, deduped by `planId`.
- `getWorkPlansByOrg(orgId)` is a full-table scan with `FilterExpression: 'orgId = :orgId'`.
- Edit / delete: owner-only, and only when `visibility === 'private'`.
- **No opt-in flag, no admin control, no editor concept.**

In this design, the existing `orgId` field on WorkPlan/Skill **stays** (so we don't break old data), but it is no longer consulted for permission decisions. List endpoints use the member-fanout pattern in §5.4.

### 4.2 Brand Guidelines + Marketing Strategy (today)

Source: `backend/src/routes/marketStrategy.ts:56-64`.

These live on either the User or the Organization record. If the user has an `orgId`, Emma reads from `org.marketStrategy` / `org.brandGuidelines`; otherwise from the user's own record. This is automatic, not opt-in.

This design **does not change** this behavior. §10 (Audit) verifies it works as xCures expects.

### 4.3 HtmlTemplates (today)

Source: `backend/src/controllers/htmlTemplatesController.ts`.

Stored in a DynamoDB settings row keyed by `templates_${userId}` (private) or `templates_public` (admin-managed). Each template has `type: ['email' | 'landing_page']` and an `isPublic: boolean` flag (admin-only).

The current storage shape (settings rows, not its own table) makes per-user listing and member-fanout impractical. This design migrates HtmlTemplate storage to a dedicated table — see §5.5.

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

KB is not a standalone entity; it's a set of fields on `Task`. Access to a task's KB is gated by `task.userId === userId` (`routes/tasks.ts:68-69`). No org-aware path today.

## 5. Design

### 5.1 Organization-level share settings

Add a new field on `Organization` (in `AW-Organizations`):

```typescript
interface Organization {
  // existing fields: orgId, ownerUserId, name, maxMembers, pendingInvites, marketStrategy, brandGuidelines, ...
  shareSettings?: {
    knowledgeBase:  { enabled: boolean; editors: string[] };
    htmlTemplates:  { enabled: boolean; editors: string[] };
    landingPages:   { enabled: boolean; editors: string[] };
    workPlans:      { enabled: boolean; editors: string[] };
    skills:         { enabled: boolean; editors: string[] };
  };
}
```

`editors` is an array of `userId` strings. Every entry must be a current member of the org (`user.orgId === this.orgId`). The server validates on write and rejects entries that fail this check.

The org owner is **implicitly** always an editor of every feature. They do not need to appear in any `editors` list. This is enforced in the permission helper, not in the data.

Default value for new orgs and orgs without the field: all five features `{ enabled: false, editors: [] }`. This implements Filipe's opt-out default.

### 5.2 No per-item sharing fields

KB-Tasks, HtmlTemplates, and Landing Pages **do not** get an `orgId` or `shareToOrg` field. WorkPlans and Skills keep their existing `orgId` field for back-compat but no longer use it for permission decisions.

Ownership is derived dynamically: an item belongs to whichever org `userDb.getUserById(item.userId).orgId` resolves to at the time of the request. This avoids:

- A migration to backfill `orgId` onto pre-existing items.
- The "owner moved orgs" drift problem.
- A separate bulk-update endpoint to keep item state in sync with user state.

It trades that simplicity for read-time lookups (one `getUserById` per non-owned item in non-list paths). For list endpoints, see §5.4 — no extra lookups are needed because the fanout already iterates known org members.

### 5.3 Centralized permission helpers

Create `backend/src/services/orgShareService.ts`:

```typescript
type Feature = 'knowledgeBase' | 'htmlTemplates' | 'landingPages' | 'workPlans' | 'skills';

interface ItemLike { userId?: string; }  // each entity exposes the owner's userId
interface UserLike { userId: string; orgId?: string; orgRole?: 'owner' | 'member'; }
interface OrgLike { orgId: string; ownerUserId: string; shareSettings?: ... }

// Required: callers pass ownerOrgId — pre-resolved to keep the helper synchronous.
export function canViewItem(
  item: ItemLike,
  user: UserLike,
  org: OrgLike | null,
  ownerOrgId: string | undefined,
  feature: Feature
): boolean {
  if (item.userId === user.userId) return true;
  if (!user.orgId || !org || !ownerOrgId) return false;
  if (ownerOrgId !== user.orgId) return false;
  return org.shareSettings?.[feature]?.enabled === true;
}

export function canEditItem(
  item: ItemLike,
  user: UserLike,
  org: OrgLike | null,
  ownerOrgId: string | undefined,
  feature: Feature
): boolean {
  if (item.userId === user.userId) return true;
  if (!user.orgId || !org || !ownerOrgId) return false;
  if (ownerOrgId !== user.orgId) return false;
  if (org.shareSettings?.[feature]?.enabled !== true) return false;
  if (user.orgRole === 'owner') return true;                          // org admin: implicit editor
  return org.shareSettings[feature].editors.includes(user.userId);
}
```

Helpers are pure / synchronous; the caller is responsible for pre-loading `org` and `ownerOrgId`. This keeps them unit-testable without DDB mocks.

Delete permission uses `canEditItem` plus an extra constraint: only the original `userId` owner OR the org admin can DELETE. Editors can edit but cannot delete. This is encoded directly in each route's DELETE handler, not in the helper, because the rule is short.

### 5.4 List endpoints: member-fanout pattern

For each shareable entity, the list endpoint follows the same shape:

```typescript
const user = await userDb.getUserById(userId);
const orgId = user?.orgId;
const org = orgId ? await orgDb.getOrgById(orgId) : null;
const featureEnabled = org?.shareSettings?.<feature>?.enabled === true;

let orgItems: Item[] = [];
if (orgId && featureEnabled) {
  const members = await userDb.getOrgMembers(orgId);   // GSI-backed query after §15
  const memberUserIds = members.map(m => m.userId);    // includes owner; excludes caller below
  const otherMembers = memberUserIds.filter(uid => uid !== userId);
  const perMember = await Promise.all(
    otherMembers.slice(0, MEMBER_FANOUT_CAP).map(uid => service.getXByOwner(uid))
  );
  orgItems = perMember.flat();
}

const ownItems = await service.getXByOwner(userId);

const seen = new Set<string>();
const all = [...ownItems, ...orgItems].filter(i => {
  if (seen.has(i.id)) return false;
  seen.add(i.id);
  return true;
});
res.json({
  items: all.slice(0, RESPONSE_CAP),
  truncated: ownItems.length >= PER_SOURCE_CAP || orgItems.length >= ORG_ITEMS_CAP,
});
```

Constants (define in `orgShareService.ts`):
- `MEMBER_FANOUT_CAP = 100` — max org members fanned out per request. Orgs over this size receive a partial result with `truncated: true`.
- `PER_SOURCE_CAP = 500` — per-member item cap (each `getXByOwner` is capped).
- `ORG_ITEMS_CAP = 2000` — total items across all members.
- `RESPONSE_CAP = 1000` — max items in the final response.

These caps are generous for xCures' scale (5-10 members, hundreds of items per member) and bounded for safety. v2 (cursor pagination) will lift them.

The fanout is `Promise.all` over `getXByOwner(uid)` per member. Each is a single GSI query on `UserIdIndex`. For a 10-member org, that's 11 parallel queries (10 members + 1 for the caller). For a 100-member org, 101 parallel queries. DynamoDB handles this fine at on-demand capacity, but we'll watch the metrics.

**API response shape change:** The current `GET /api/user-work-plans` returns a flat array. The new shape is `{ items: [...], truncated: boolean }`. This is a breaking change for every list endpoint touched here. Customer-portal callers must be updated in the same PR; staging deploy verifies no orphaned consumers.

### 5.5 HtmlTemplate storage migration

HtmlTemplates currently live in `AW-Settings` rows keyed by `templates_${userId}`. To support per-user listing and the fanout pattern, we migrate them to their own table `AW-HtmlTemplates`:

```typescript
interface HtmlTemplate {
  templateId: string;       // primary key
  userId: string;           // owner — used for ownership + fanout
  type: ('email' | 'landing_page')[];
  name: string;
  subject?: string;
  html: string;
  isPublic?: boolean;       // admin-managed public templates (preserved)
  createdAt: string;
  updatedAt: string;
}
```

GSIs at launch:
- `UserIdIndex` (partition: userId, sort: createdAt) — for listing user's own templates and for the member-fanout
- `IsPublicIndex` (partition: isPublic) — for listing admin-published public templates

A one-shot migration script reads every `AW-Settings` row matching key prefix `templates_`, flattens its `templates` array into individual `AW-HtmlTemplates` rows. Original settings rows are kept until the migration is verified, then deleted in a follow-up.

### 5.6 Get / Patch / Delete on a single item

For any non-list endpoint:

```typescript
const item = await service.getX(itemId);
if (!item) return res.status(404).json(...);

let owner: User | null = null;
let org: Organization | null = null;
if (item.userId !== userId) {
  owner = await userDb.getUserById(item.userId);
  org = (user.orgId && owner?.orgId === user.orgId)
    ? await orgDb.getOrgById(user.orgId)
    : null;
}

if (!canViewItem(item, user, org, owner?.orgId, '<feature>')) return res.status(403).json(...);
// or canEditItem for PATCH
// or: canEditItem + (item.userId === userId || user.orgRole === 'owner') for DELETE
```

For owner accessing their own item, the extra `getUserById` and `getOrgById` round-trips are skipped (early return on the ownership check).

For non-owner access, the read path costs one extra `getUserById` (owner) plus one `getOrgById`. This is acceptable for single-item operations.

## 6. Admin UI

New section in the org-management area (only visible to users where `user.orgRole === 'owner'`):

```
Org-wide Sharing
─────────────────────────────────────
☐ Knowledge Bases         Editors: [+ Add]
☐ HtmlTemplates           Editors: [+ Add]
☐ Landing Pages           Editors: [+ Add]
☑ Work Plans              Editors: [Alice ×] [Bob ×] [+ Add]
☑ Skills                  Editors: [+ Add]
```

Each row:
- Toggle to enable / disable sharing for that feature in this org.
- Multi-select of org members for the editor list. Org owner is shown as an implicit editor (greyed-out chip) and cannot be removed.

Saves call `PATCH /api/orgs/me/share-settings`. Changes take effect immediately — no bulk update to items is needed.

## 7. Member Removal Flow

When the org admin removes a member from the org:

### 7.1 Preview step

`GET /api/orgs/me/members/:userId/removal-preview` returns:
```typescript
{
  userId: string;
  itemCounts: {
    knowledgeBase:  number;  // = number of Tasks owned by user with knowledgeBase set
    htmlTemplates:  number;
    landingPages:   number;
    workPlans:      number;
    skills:         number;
  };
}
```

### 7.2 Decision UI

For each feature with `count > 0`, admin picks:
- **Transfer to me** — bulk update sets `userId = currentAdminUserId` on each matching item.
- **Delete** — bulk delete.
- **Leave with them** — no change; items follow the user out of the org.

### 7.3 Execute

`POST /api/orgs/me/members/:userId/remove` with body:
```typescript
{
  decisions: {
    knowledgeBase:  'transfer' | 'delete' | 'leave';
    htmlTemplates:  'transfer' | 'delete' | 'leave';
    landingPages:   'transfer' | 'delete' | 'leave';
    workPlans:      'transfer' | 'delete' | 'leave';
    skills:         'transfer' | 'delete' | 'leave';
  };
}
```

Server flow:
1. Validate caller is `orgRole === 'owner'` for this org.
2. For each feature with `transfer` or `delete`: query items owned by the target user. If item count exceeds 10000 for any feature, refuse with 400 and `{ error: 'BULK_UPDATE_TOO_LARGE', feature, count }`.
3. For each item, issue `UpdateItem` (transfer) or `DeleteItem` (delete) with concurrency 25.
4. After all per-feature updates complete: remove the user from the org (`orgId` cleared, removed from any editor lists they appear in — see §8).
5. Return `{ updated: {<feature>: count}, deleted: {...}, errors: [...] }`.

**Why synchronous, not async:** DynamoDB has no SQL-style `UPDATE ... WHERE`. Bulk update is always N round-trips. For 10000 items at ~20ms each with concurrency 25, total ≈ 8s — within ALB / nginx 60s idle timeout. Async + job infrastructure is not justified.

The endpoint requires a `confirm: true` flag in the body so a stray PATCH cannot accidentally rewrite thousands of items.

## 8. Editor List Hygiene

When a user is removed from an org (via the §7 flow or otherwise), the server also:
- Scans the org's `shareSettings` and removes the user's `userId` from every `editors` array.
- This is one `UpdateItem` on the org row; cheap.

If a user's `orgId` is changed by any other path (admin re-assignment, migration), the same cleanup runs.

This avoids stale editor entries that would otherwise accumulate over time.

## 9. WorkPlans / Skills Compatibility

WorkPlans and Skills currently auto-share to org if the owner has `orgId`. After this change, sharing requires `org.shareSettings.workPlans.enabled === true` (or `.skills.enabled`). Migration preserves current behavior:

**Step 1 — Migrate org records:**
```
For each existing Organization:
  SET shareSettings.workPlans = { enabled: true,  editors: [] }
  SET shareSettings.skills    = { enabled: true,  editors: [] }
  SET shareSettings.knowledgeBase = { enabled: false, editors: [] }
  SET shareSettings.htmlTemplates = { enabled: false, editors: [] }
  SET shareSettings.landingPages  = { enabled: false, editors: [] }
```

New orgs created post-deploy: all five default to `{ enabled: false, editors: [] }`.

**Step 2 — Update list endpoints:**

Replace `workPlanService.getWorkPlansByOrg(orgId)` and `skillService.getSkillsByOrg(orgId)` with the member-fanout pattern from §5.4. The existing `orgId` field on WorkPlan/Skill stays in place (no schema change), but it is no longer consulted.

**Step 3 — Update edit/delete checks:**

`userWorkPlanRoutes.ts:92-122` and the equivalent skill route currently allow only `plan.ownerId === userId`. After migration, they also allow:
- Caller is org admin in the same org as the owner, OR
- Caller is in `org.shareSettings.workPlans.editors` AND in the same org as the owner.

DELETE remains owner-or-admin only.

The migration runs as `backend/src/scripts/migrate-org-share-settings.ts`, executed manually post-deploy by an admin. Idempotent — skips orgs where `shareSettings` is already set.

## 10. Brand Guidelines + Marketing Strategy Audit

Before merge, a two-user test in staging:
1. User A in Org X sets Brand Guidelines + Marketing Strategy via existing UI.
2. User B (same Org X) loads Emma and uses `read_brand_guidelines` and `read_market_strategy` tools (`agentModeService.ts:4330,4349`).
3. Confirm User B receives User A's content.

If audit passes: no changes needed; xCures' "three pillars" request is satisfied by this design + existing behavior.
If audit fails: file as a separate bug, fix in a follow-up PR (out of scope for this design).

## 11. Routes Surface

### 11.1 New endpoints

| Route | Method | Purpose |
|---|---|---|
| `/api/orgs/me/share-settings` | GET | Returns the caller's org `shareSettings` (any member can read) |
| `/api/orgs/me/share-settings` | PATCH | Updates one or more entries (org owner only) |
| `/api/orgs/me/members/:userId/removal-preview` | GET | Returns item counts per feature for the target member (org owner only) |
| `/api/orgs/me/members/:userId/remove` | POST | Executes member removal with per-feature decisions (org owner only) |
| `/api/orgs/me/members` | GET | Returns list of users in caller's org (used for editor multi-select) — if it doesn't already exist |

### 11.2 Modified endpoints

For each of the five entity types:

| Existing route | Change |
|---|---|
| `GET /api/<entities>` (list) | Member-fanout merge per §5.4. Response shape change to `{items, truncated}` |
| `POST /api/<entities>` (create) | No change (no per-item share fields) |
| `GET /api/<entities>/:id` | Permission via `canViewItem` per §5.6 |
| `PATCH /api/<entities>/:id` | Permission via `canEditItem` per §5.6 |
| `DELETE /api/<entities>/:id` | Owner OR org admin only |

The five entities: KB-bearing Tasks, HtmlTemplates, LandingPages, WorkPlans, Skills.

For HtmlTemplates specifically, the route surface in `routes/htmlTemplates.ts` is rebuilt against the new `AW-HtmlTemplates` table per §5.5.

## 12. Frontend Changes

### 12.1 Org admin settings page

New page or section under org management (visible to `orgRole === 'owner'` only). UI per §6. Calls `PATCH /api/orgs/me/share-settings`.

### 12.2 Member removal modal

When admin clicks "Remove member" in the existing member-list UI, a modal appears:
1. Loading state: fetch `removal-preview` to get item counts.
2. For each feature with `count > 0`: a row with the feature name, count, and a radio group (`Transfer to me` / `Delete` / `Leave with them`).
3. Confirm button calls `POST /api/orgs/me/members/:userId/remove`.
4. On success: toast summarizing what happened per feature.

### 12.3 List screens

Items shared by other org members appear in the same list as the user's own items, with a "Shared by [name]" badge. Sort order: own items first, then org-shared (matches dedupe order in §5.4).

### 12.4 Per-item edit affordances

For items the caller can edit but doesn't own (i.e. caller is org admin or in editor list): show a "Shared with [Org Name]" indicator. DELETE button is hidden for editors (only owner / admin can delete).

## 13. Tests

For each of the five entity types, a `backend/src/__tests__/orgShared<Entity>.test.ts` modeled on `orgSharedWorkPlans.test.ts`:

1. Owner can GET, PATCH, DELETE their own item regardless of `shareSettings`.
2. With `shareSettings.<feature>.enabled = false`, another org member cannot GET the item (returns 403).
3. With `shareSettings.<feature>.enabled = true`, another org member can GET, cannot PATCH or DELETE.
4. With user in `editors` list, member can PATCH but cannot DELETE.
5. Org admin (`orgRole === 'owner'`) can always PATCH and DELETE, regardless of editor list.
6. User in a different org cannot GET, PATCH, or DELETE.
7. List endpoint: owner sees own + shared org items. Org member sees own + shared org items. Different-org user sees only their own.
8. List endpoint: when `enabled` flips from true to false (admin disables sharing), the next list request immediately excludes other members' items — without any bulk write.
9. Item ownership follows the owner: if Alice moves from Org X to Org Y, her items appear in Org Y's lists and disappear from Org X's.

For `services/orgShareService.ts`:

10. Unit tests for `canViewItem` and `canEditItem` covering all combinations of owner / admin / editor / non-editor org member / different-org user / no-org user, with `enabled` true and false.

For the member-removal flow (`backend/src/__tests__/orgMemberRemoval.test.ts`):

11. Preview returns correct counts per feature.
12. Decisions `transfer` change item ownership; `delete` removes items; `leave` is a no-op.
13. Caller without `orgRole === 'owner'` is rejected.
14. Removed user is also pruned from every `shareSettings.<feature>.editors` array.
15. Member with >10000 items in any feature: removal request fails with `BULK_UPDATE_TOO_LARGE`.
16. Removal request without `confirm: true` is rejected with 400.

For the migration (`backend/src/__tests__/migrateOrgShareSettings.test.ts`):

17. Existing orgs receive `workPlans.enabled = true, skills.enabled = true` and the other three features `false`.
18. Re-running the migration is a no-op (idempotent).

## 14. Deployment

Standard backend + customer-portal PR flow per `CLAUDE.md` "Prep for Deploy" section. Migration scripts (§5.5 HtmlTemplate move and §9 org settings) are executed manually post-deploy in production. HtmlTemplate settings-row cleanup is a separate follow-up commit after one production deploy cycle.

## 15. AW-Users `OrgIdIndex` GSI (included in this scope)

Resolved during spec review: today's `userDb.getOrgMembers(orgId)` (`db.ts:7176`) is a **full Scan** of `AW-Users` with `FilterExpression: 'orgId = :orgId'`. Existing callers use it sparingly (e.g. once per session). After this design, every list endpoint for the five shared entities calls it on every hit. At platform scale (tens of thousands of users), that's prohibitive.

This design **adds a GSI** `OrgIdIndex` on `AW-Users` (partition: `orgId`) and replaces the Scan inside `getOrgMembers` with a Query against that GSI. One-time table change; backwards-compatible. Both the new flows and the existing callers benefit.

The GSI also makes the §7 member-removal cleanup of editor lists more efficient.

`getOrgMembers` returns Users with `orgId === <given>`. Org owners have `orgId` set on their User row, so they are included naturally — no special-casing needed for the fanout.

## 16. Open Questions

- **HtmlTemplate `isPublic` interaction:** Some HtmlTemplates today are admin-published with `isPublic: true`. The new model treats `isPublic` as orthogonal — those templates remain visible to all platform users regardless of org settings. Tests cover the combination.
- **Editor list size:** No explicit cap on `editors` arrays. The implicit ceiling is `org.maxMembers` (only current org members are valid). No additional cap needed.

## 17. Future Work

- Cursor-paginated list endpoints with a new `OwnerIdCreatedAtIndex` GSI per table, replacing the per-source caps in §5.4.
- Per-item sharing override for users who need to keep a specific item private even when their feature is enabled org-wide.
- Granular per-feature roles beyond the binary `enabled` + `editors` (e.g., "view only", "comment only").
- Audit log for sharing changes: which admin enabled/disabled which feature, when, who they added to editor lists.
- Item-level transfer of ownership (move a single item from one org member to another) without removing the original owner.
