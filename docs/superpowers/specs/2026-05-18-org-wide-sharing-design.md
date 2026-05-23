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
4. Add editor-list controls for the two existing "pillars" — Brand Guidelines and Marketing Strategy — which remain always viewable by the org (no enable toggle) but gain admin-controlled edit permissions.
5. When a member is removed from an org, the admin chooses per-feature what happens to their items (transfer to admin, delete, or let them leave with the user).
6. Preserve current visibility behavior for WorkPlans and Skills (existing orgs continue to see each other's plans / skills post-migration).
7. Audit Brand Guidelines and Marketing Strategy view-sharing today; fix only if broken.

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
    // Toggleable features: view is granted to org members only when enabled === true.
    knowledgeBase:     { enabled: boolean; editors: string[] };
    htmlTemplates:     { enabled: boolean; editors: string[] };
    landingPages:      { enabled: boolean; editors: string[] };
    workPlans:         { enabled: boolean; editors: string[] };
    skills:            { enabled: boolean; editors: string[] };

    // Always-on features: view is always shared with org members. Admin only controls editors.
    brandGuidelines:   { editors: string[] };
    marketingStrategy: { editors: string[] };
  };
}
```

`editors` is an array of `userId` strings. Every entry must be a current member of the org (`user.orgId === this.orgId`). The server validates on write and rejects entries that fail this check.

The org owner is **implicitly** always an editor of every feature. They do not need to appear in any `editors` list. This is enforced in the permission helper, not in the data.

**Toggleable features** (`knowledgeBase`, `htmlTemplates`, `landingPages`, `workPlans`, `skills`) have an `enabled` flag controlling whether org members can view items of that type at all.

**Always-on features** (`brandGuidelines`, `marketingStrategy`) have **no `enabled` flag** because their view sharing is already org-wide today and the customer relies on that behavior. Admins only control who can *edit*.

Default value for new orgs and orgs without the field:
- All five toggleable features: `{ enabled: false, editors: [] }` — Filipe's opt-out default.
- Both always-on features: `{ editors: [] }` — visible to all org members; only org owner can edit.

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
type ToggleableFeature = 'knowledgeBase' | 'htmlTemplates' | 'landingPages' | 'workPlans' | 'skills';
type AlwaysOnFeature   = 'brandGuidelines' | 'marketingStrategy';
type Feature           = ToggleableFeature | AlwaysOnFeature;

interface ItemLike { userId?: string; }  // each entity exposes the owner's userId
interface UserLike { userId: string; orgId?: string; orgRole?: 'owner' | 'member'; }
interface OrgLike { orgId: string; ownerUserId: string; shareSettings?: ... }

const ALWAYS_ON: ReadonlySet<Feature> = new Set<Feature>(['brandGuidelines', 'marketingStrategy']);

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
  if (ALWAYS_ON.has(feature)) return true;                       // BG/MS: view always granted to org
  return (org.shareSettings as any)?.[feature]?.enabled === true;
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
  if (user.orgRole === 'owner') return true;                     // org admin: implicit editor for every feature
  const cfg = (org.shareSettings as any)?.[feature];
  if (!cfg) return false;
  // Toggleable features require enabled === true for edit too; always-on don't.
  if (!ALWAYS_ON.has(feature) && cfg.enabled !== true) return false;
  return Array.isArray(cfg.editors) && cfg.editors.includes(user.userId);
}
```

Helpers are pure / synchronous; the caller is responsible for pre-loading `org` and `ownerOrgId`. This keeps them unit-testable without DDB mocks.

Delete permission uses `canEditItem` plus an extra constraint: only the original `userId` owner OR the org admin can DELETE. Editors can edit but cannot delete. This is encoded directly in each route's DELETE handler, not in the helper, because the rule is short.

Brand Guidelines and Marketing Strategy are not "items" in the same per-row sense; they're single fields on the Organization. Their edit permission uses `canEditItem` with an `item.userId = org.ownerUserId` shim (the org owner is the de-facto author), `feature = 'brandGuidelines'` / `'marketingStrategy'`, and `ownerOrgId = org.orgId`. View is always allowed to org members (already the case today; see §10).

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
Toggleable (admin chooses to share + who edits)
  ☐ Knowledge Bases       Editors: [+ Add]
  ☐ HtmlTemplates         Editors: [+ Add]
  ☐ Landing Pages         Editors: [+ Add]
  ☑ Work Plans            Editors: [Alice ×] [Bob ×] [+ Add]
  ☑ Skills                Editors: [+ Add]

Always shared with org (admin only chooses who edits)
  • Brand Guidelines      Editors: [+ Add]
  • Marketing Strategy    Editors: [+ Add]
```

Each toggleable row: toggle to enable / disable sharing + a multi-select of org members for the editor list. Each always-on row: just the multi-select. Org owner is shown as an implicit editor (greyed-out chip) and cannot be removed in either kind of row.

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
  SET shareSettings.workPlans         = { enabled: true,  editors: [] }
  SET shareSettings.skills            = { enabled: true,  editors: [] }
  SET shareSettings.knowledgeBase     = { enabled: false, editors: [] }
  SET shareSettings.htmlTemplates     = { enabled: false, editors: [] }
  SET shareSettings.landingPages      = { enabled: false, editors: [] }
  SET shareSettings.brandGuidelines   = { editors: [] }   // always shared with org
  SET shareSettings.marketingStrategy = { editors: [] }   // always shared with org
```

New orgs created post-deploy: all five toggleable features default to `{ enabled: false, editors: [] }`; both always-on features default to `{ editors: [] }`.

**Step 2 — Update list endpoints:**

Replace `workPlanService.getWorkPlansByOrg(orgId)` and `skillService.getSkillsByOrg(orgId)` with the member-fanout pattern from §5.4. The existing `orgId` field on WorkPlan/Skill stays in place (no schema change), but it is no longer consulted.

**Step 3 — Update edit/delete checks:**

`userWorkPlanRoutes.ts:92-122` and the equivalent skill route currently allow only `plan.ownerId === userId`. After migration, they also allow:
- Caller is org admin in the same org as the owner, OR
- Caller is in `org.shareSettings.workPlans.editors` AND in the same org as the owner.

DELETE remains owner-or-admin only.

The migration runs as `backend/src/scripts/migrate-org-share-settings.ts`, executed manually post-deploy by an admin. Idempotent — skips orgs where `shareSettings` is already set.

## 10. Brand Guidelines + Marketing Strategy

These are always shared with the org (read-side). This design adds **edit-side** control: the org admin picks who can modify them via the per-feature `editors` arrays on `shareSettings.brandGuidelines` and `shareSettings.marketingStrategy`.

### 10.1 View-side audit

Before merge, confirm current org-wide read works as expected. Two-user test in staging:
1. User A (in Org X) sets Brand Guidelines + Marketing Strategy via existing UI.
2. User B (same Org X) loads Emma and uses `read_brand_guidelines` and `read_market_strategy` tools (`agentModeService.ts:4330,4349`).
3. Confirm User B receives User A's content.

If audit passes: no view-side changes needed.
If audit fails: file a follow-up bug; this spec does not redesign read sharing for those two pillars.

### 10.2 Edit-side changes

Update the existing edit routes for Brand Guidelines and Marketing Strategy (`marketStrategy.ts` and equivalent) to:
- Allow PUT/PATCH if caller is the org owner.
- Allow PUT/PATCH if caller is in `org.shareSettings.brandGuidelines.editors` (or `.marketingStrategy.editors` respectively) and in the same org as the resource owner.
- Reject otherwise.

These two features have no `enabled` flag (view is always on); only the editor list gates writes.

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
11. Coverage of always-on features (`brandGuidelines`, `marketingStrategy`): view is always granted to same-org members regardless of any flag; edit requires admin OR membership in the corresponding `editors` array.

For Brand Guidelines + Marketing Strategy edit (`backend/src/__tests__/orgPillarEditors.test.ts`):

12. Org admin can PUT brand guidelines and marketing strategy regardless of editor list.
13. User in `editors.brandGuidelines` can PUT brand guidelines but not marketing strategy.
14. User in `editors.marketingStrategy` can PUT marketing strategy but not brand guidelines.
15. Non-editor org member can GET both but not PUT either.
16. Different-org user can neither GET nor PUT.

For the member-removal flow (`backend/src/__tests__/orgMemberRemoval.test.ts`):

17. Preview returns correct counts per feature.
18. Decisions `transfer` change item ownership; `delete` removes items; `leave` is a no-op.
19. Caller without `orgRole === 'owner'` is rejected.
20. Removed user is also pruned from every `shareSettings.<feature>.editors` array, including `brandGuidelines.editors` and `marketingStrategy.editors`.
21. Member with >10000 items in any feature: removal request fails with `BULK_UPDATE_TOO_LARGE`.
22. Removal request without `confirm: true` is rejected with 400.

For the migration (`backend/src/__tests__/migrateOrgShareSettings.test.ts`):

23. Existing orgs receive `workPlans.enabled = true, skills.enabled = true`, the three new toggleable features `false`, and `brandGuidelines.editors = [], marketingStrategy.editors = []`.
24. Re-running the migration is a no-op (idempotent).

## 14. Playwright Scenarios (cloud test environment)

Run after every `./test-env/test-env.sh sync` during implementation, and as the final acceptance gate before merge. Uses the Playwright MCP tools (`mcp__playwright__browser_*`) against the cloud test env URL printed by the test-env script. All scenarios use the standard test accounts (`test@example.com` / `Test123!` as admin and `test1@example.com` / `Test123!` as basic user) plus dynamically seeded users where multi-tenant testing is needed.

### 14.1 Seed data prerequisites

Before any scenario, create the following via UI or API (admin-delegated):

- **Org A** with owner `ownerA@test.local`, members `editorA1@test.local`, `editorA2@test.local`, `memberA@test.local`.
- **Org B** with owner `ownerB@test.local`, member `memberB@test.local`.
- **Solo user** `solo@test.local` (no org).

Each user has at least one item of every entity type pre-created so the multi-tenant view paths can be exercised.

### 14.2 Admin settings panel (Scenarios PW-1 to PW-6)

PW-1. **Owner-only access.** Sign in as `memberA@test.local`. Navigate to org settings. Confirm the "Org-wide Sharing" panel is not visible. Sign out, sign in as `ownerA@test.local`, confirm it is visible.

PW-2. **Toggleable features render with toggles + editor pickers.** As owner of Org A, confirm five toggleable rows (Knowledge Bases / HtmlTemplates / Landing Pages / Work Plans / Skills) each have a checkbox + editor multi-select.

PW-3. **Always-on features render without toggles.** Confirm Brand Guidelines and Marketing Strategy rows show only an editor multi-select — no checkbox.

PW-4. **Org owner shown as implicit editor.** In every editor multi-select, the owner appears as a non-removable chip.

PW-5. **Editor multi-select restricts to org members.** Open any editor dropdown. Confirm `memberB@test.local` (Org B) is not listed; `solo@test.local` is not listed; only Org A members appear.

PW-6. **Save persists.** Toggle `knowledgeBase.enabled = true`, add `editorA1@test.local` as a Templates editor, save. Refresh the page. Both states persist.

### 14.3 Toggle behavior is immediate (PW-7 to PW-10)

PW-7. **Toggle ON → org members see items.** As `memberA@test.local`, navigate to the templates list. Note count N. As `ownerA@test.local`, enable HtmlTemplates sharing. Switch back to `memberA@test.local` (use Playwright tab/session switching), reload the templates list. Confirm count is N + (owner's templates count). Each foreign template shows the "Shared by ownerA" badge.

PW-8. **Toggle OFF → org members lose visibility.** From the above state, switch to `ownerA@test.local`, disable HtmlTemplates sharing. Switch to `memberA@test.local`, reload. Confirm count drops back to N. No bulk write delay — change is instant.

PW-9. **Always-on features ignore the toggle.** As `memberA@test.local`, confirm Brand Guidelines and Marketing Strategy values from `ownerA@test.local` are always visible in Emma's context, regardless of any toggle state.

PW-10. **Cross-org isolation.** As `memberB@test.local`, confirm none of Org A's items ever appear regardless of Org A's toggle states.

### 14.4 Editor permission paths per feature (PW-11 to PW-25)

For each of the 7 features, run a 3-scenario set proving:
- editor in the feature's `editors` list can PATCH but not DELETE;
- non-editor org member can GET but not PATCH or DELETE;
- non-org user is denied all three.

Concretely (using HtmlTemplates as the worked example, repeated for each feature):

PW-11. **Owner creates a template** as `ownerA@test.local`. Note `templateId`.
PW-12. **Owner adds `editorA1@test.local` to Templates editors.**
PW-13. **Editor can PATCH.** As `editorA1@test.local`, open the template, edit `name`, save. Confirm 200 + persisted change.
PW-14. **Editor cannot DELETE.** As `editorA1@test.local`, attempt DELETE. Confirm UI hides the button; direct DELETE via API returns 403.
PW-15. **Non-editor org member can GET, cannot PATCH.** As `memberA@test.local`, can open the template (read-only UI). Edit form fields are disabled. PATCH via API returns 403.
PW-16. **Non-org user denied.** As `memberB@test.local`, the template is not in the list and direct GET by id returns 403.

Repeat the pattern for KB-Tasks (PW-17), Landing Pages (PW-18), Work Plans (PW-19), Skills (PW-20). For Brand Guidelines (PW-21) and Marketing Strategy (PW-22), there is no `enabled` toggle — the same editor-vs-non-editor distinction applies to the PUT/PATCH endpoint while GET is always available to org members. PW-23 verifies that org owner (`ownerA@test.local`) can always PATCH and DELETE regardless of editor list across every feature. PW-24 verifies that when a feature's `enabled` flag is false, even an explicit editor cannot view or edit (except the owner of the item itself). PW-25 verifies the "Shared by" badge appears only on foreign items, never on the caller's own items.

### 14.5 Member removal flow (PW-26 to PW-34)

PW-26. **Removal preview shows correct counts.** As `ownerA@test.local`, seed `memberA@test.local` with 3 KBs, 5 templates, 2 LPs, 1 workplan, 0 skills. Open the remove dialog. Confirm the preview shows exactly those counts.

PW-27. **`transfer` decision moves ownership.** Pick `transfer` for KBs only, `delete` for templates, `leave` for everything else. Confirm. Sign in as `ownerA@test.local`, confirm 3 KBs now show up in own list with owner = owner. Sign in as the (now removed) `memberA@test.local`, confirm KBs are gone from their account.

PW-28. **`delete` decision removes items.** From the same removal run, confirm the 5 templates no longer exist via any path (admin can't see them; ex-member can't see them; direct GET returns 404).

PW-29. **`leave` decision keeps ownership.** The 2 LPs and 1 workplan: confirm they remain owned by `memberA@test.local`, but with `memberA.orgId` now cleared, neither Org A admin nor any Org A member sees them. The ex-member sees them in their own list still.

PW-30. **Removed user is pruned from editor lists.** Before removal, add `memberA@test.local` to `editors.htmlTemplates` and `editors.brandGuidelines`. After removal, reload org settings; confirm both editor lists no longer contain that userId.

PW-31. **Caller must be org owner.** Attempt removal as `editorA1@test.local`. Confirm 403 from API; UI shows no "Remove" button.

PW-32. **`confirm: true` required.** Issue the removal POST without `confirm: true` via direct API call. Confirm 400.

PW-33. **Cap enforcement.** Use a seeded user with >10000 items in a feature (created via a fixture script). Confirm removal request returns 400 `BULK_UPDATE_TOO_LARGE` and the user is NOT removed.

PW-34. **Mixed feature decisions in one request.** Verify `decisions = { knowledgeBase: 'transfer', htmlTemplates: 'delete', landingPages: 'leave', workPlans: 'transfer', skills: 'leave' }` are all applied independently and atomically per feature.

### 14.6 Ownership-follows-owner (PW-35 to PW-38)

PW-35. **Move user between orgs.** As platform admin, move `editorA2@test.local` from Org A to Org B. As `memberA@test.local` (still in Org A), confirm `editorA2`'s items vanish from Org A views. As `memberB@test.local`, confirm those items appear (if Org B has the matching feature enabled).

PW-36. **No item-level migration needed.** Run PW-35 within a single page reload of each user — confirm the change appears without any background-task delay.

PW-37. **Editor list grooms across org moves.** If `editorA2@test.local` was in Org A's `editors.workPlans`, confirm the move strips that entry from Org A's `editors.workPlans`.

PW-38. **Solo user has no org behavior.** Confirm `solo@test.local` sees only their own items in every feature list and cannot access any settings panel.

### 14.7 HtmlTemplate migration (PW-39 to PW-42)

Run these immediately after deploying the migration script.

PW-39. **Pre-existing private templates visible.** Sign in as a pre-migration user. Confirm all templates from the old settings row appear in the new list. Each is editable, deletable, and creatable.

PW-40. **Pre-existing public templates visible.** Sign in as any user. Confirm admin-published public templates (with `isPublic: true`) appear alongside the user's own templates. `isPublic` interaction unaffected by org settings.

PW-41. **New template creation writes to new table.** As `ownerA@test.local`, create a template. Verify (via admin debugging tool / DDB console) the row exists in `AW-HtmlTemplates` with the correct `userId` and no `orgId` field.

PW-42. **Old settings rows untouched post-migration.** Confirm the original `templates_${userId}` row in `AW-Settings` is unchanged (cleanup is a follow-up commit, not part of this migration).

### 14.8 Performance + caps (PW-43 to PW-45)

PW-43. **List endpoint within latency budget.** With Org A populated to ~100 templates per member and ~10 members, time the templates list response. Target: under 2s p95 in the test environment.

PW-44. **Caps trigger truncated flag.** Seed an org member with >500 of any item type. Trigger the list endpoint as another org member. Confirm response includes `truncated: true` and items are capped.

PW-45. **Fanout cap.** Seed an org with >100 members (or simulate via test fixture). Confirm list endpoint completes within timeout and signals `truncated: true`.

### 14.9 Acceptance gate

Every scenario above must pass on the cloud test environment before the PR is marked ready for review. Use the Playwright MCP tools to drive interactions; capture screenshots of any failure (`mcp__playwright__browser_take_screenshot`). On any unexpected console error (`mcp__playwright__browser_console_messages`), file it under the scenario that triggered it and fix before re-running.

The "Prep for Deploy" workflow in `CLAUDE.md` is unchanged — Playwright runs are an addition, not a replacement.

## 15. Deployment

Standard backend + customer-portal PR flow per `CLAUDE.md` "Prep for Deploy" section. Migration scripts (§5.5 HtmlTemplate move and §9 org settings) are executed manually post-deploy in production. HtmlTemplate settings-row cleanup is a separate follow-up commit after one production deploy cycle.

## 16. AW-Users `OrgIdIndex` GSI (included in this scope)

Resolved during spec review: today's `userDb.getOrgMembers(orgId)` (`db.ts:7176`) is a **full Scan** of `AW-Users` with `FilterExpression: 'orgId = :orgId'`. Existing callers use it sparingly (e.g. once per session). After this design, every list endpoint for the five shared entities calls it on every hit. At platform scale (tens of thousands of users), that's prohibitive.

This design **adds a GSI** `OrgIdIndex` on `AW-Users` (partition: `orgId`) and replaces the Scan inside `getOrgMembers` with a Query against that GSI. One-time table change; backwards-compatible. Both the new flows and the existing callers benefit.

The GSI also makes the §7 member-removal cleanup of editor lists and the §14 Playwright multi-tenant scenarios more efficient.

`getOrgMembers` returns Users with `orgId === <given>`. Org owners have `orgId` set on their User row, so they are included naturally — no special-casing needed for the fanout.

## 17. Open Questions

- **HtmlTemplate `isPublic` interaction:** Some HtmlTemplates today are admin-published with `isPublic: true`. The new model treats `isPublic` as orthogonal — those templates remain visible to all platform users regardless of org settings. Tests cover the combination.
- **Editor list size:** No explicit cap on `editors` arrays. The implicit ceiling is `org.maxMembers` (only current org members are valid). No additional cap needed.

## 18. Future Work

- Cursor-paginated list endpoints with a new `OwnerIdCreatedAtIndex` GSI per table, replacing the per-source caps in §5.4.
- Per-item sharing override for users who need to keep a specific item private even when their feature is enabled org-wide.
- Granular per-feature roles beyond the binary `enabled` + `editors` (e.g., "view only", "comment only").
- Audit log for sharing changes: which admin enabled/disabled which feature, when, who they added to editor lists.
- Item-level transfer of ownership (move a single item from one org member to another) without removing the original owner.
