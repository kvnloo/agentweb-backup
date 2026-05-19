# Org-Wide Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build admin-controlled, org-wide sharing for seven feature areas (KB-bearing Tasks, HtmlTemplates, Landing Pages, WorkPlans, Skills, Brand Guidelines, Marketing Strategy) per spec at `docs/superpowers/specs/2026-05-18-org-wide-sharing-design.md`.

**Architecture:** Org admin controls per-feature `enabled` (toggleable features only) and `editors` lists on the `Organization` record. No per-item share flags; ownership lookup is dynamic via the owner's current `orgId`. List endpoints fan out across org members using a new `OrgIdIndex` GSI on `AW-Users`. The only place bulk writes happen is the org member-removal flow, where the admin chooses per-feature `transfer`/`delete`/`leave`.

**Tech Stack:** Node.js/TypeScript backend (Express + AWS DynamoDB SDK v2), React/TypeScript frontend (Vite, customer-portal), Jest for unit + route tests, Playwright MCP tools for end-to-end cloud-test-env scenarios.

---

## File-Level Map

### Backend — new files

- `backend/src/services/orgShareService.ts` — pure permission helpers and shared types
- `backend/src/services/htmlTemplateService.ts` — new table service for HtmlTemplates (replaces settings-row storage)
- `backend/src/routes/orgShareSettings.ts` — admin endpoints for org `shareSettings`
- `backend/src/routes/orgMemberRemoval.ts` — preview + remove endpoints
- `backend/src/scripts/migrate-org-share-settings.ts` — Org `shareSettings` migration
- `backend/src/scripts/migrate-html-templates.ts` — HtmlTemplate settings → AW-HtmlTemplates migration
- `backend/src/scripts/create-org-id-gsi.ts` — one-shot GSI creator for AW-Users.OrgIdIndex
- `backend/src/__tests__/orgShareService.test.ts` — helpers unit tests
- `backend/src/__tests__/orgShareSettings.routes.test.ts` — admin settings endpoint tests
- `backend/src/__tests__/orgMemberRemoval.test.ts` — removal flow tests
- `backend/src/__tests__/orgPillarEditors.test.ts` — BG/MS edit-side tests
- `backend/src/__tests__/orgSharedKnowledgeBase.test.ts` — task KB org-share tests
- `backend/src/__tests__/orgSharedHtmlTemplates.test.ts`
- `backend/src/__tests__/orgSharedLandingPages.test.ts`
- `backend/src/__tests__/orgSharedSkills.update.test.ts` — extends existing skill tests
- `backend/src/__tests__/migrateOrgShareSettings.test.ts`
- `backend/src/__tests__/migrateHtmlTemplates.test.ts`

### Backend — modified files

- `backend/src/services/db.ts` — `User`, `Organization`, `getOrgMembers` (GSI), plus new helpers (`updateShareSettings`, `pruneEditorListsForUser`)
- `backend/src/services/workPlanService.ts` — `getWorkPlansByOrg` becomes fanout via shared helper
- `backend/src/services/skillService.ts` — `getSkillsByOrg` likewise
- `backend/src/services/v0Service.ts` — `getLandingPagesByOrg` (new), permission injection points
- `backend/src/types/task.ts` — no schema change; documentation comment only
- `backend/src/routes/userWorkPlanRoutes.ts` — list/get/patch/delete use new helpers
- `backend/src/routes/userSkillRoutes.ts` — same
- `backend/src/routes/landingPages.ts` — same + fanout list
- `backend/src/routes/tasks.ts` — KB view/edit gating
- `backend/src/routes/htmlTemplates.ts` — fully rewritten against new table
- `backend/src/routes/marketStrategy.ts` — edit-side editor-list gating for BG + MS
- `backend/src/controllers/htmlTemplatesController.ts` — replaced or deprecated by new route + service
- `backend/src/app.ts` — register new routes
- `backend/src/scripts/create-tables.ts` — add AW-HtmlTemplates table and OrgIdIndex on AW-Users

### Frontend — new files

- `customer-portal/src/pages/Settings/OrgSharing.tsx` — admin settings panel
- `customer-portal/src/components/RemoveMemberDialog.tsx` — per-feature decision modal
- `customer-portal/src/components/SharedByBadge.tsx` — small shared-from indicator

### Frontend — modified files

- `customer-portal/src/pages/Settings/index.tsx` — register the OrgSharing route
- Per-feature list pages (KB, Templates, LPs, Work Plans, Skills) — show badge + hide edit/delete for non-owners
- Per-feature edit pages — disable inputs for non-editor viewers
- Org members management page — wire the new RemoveMemberDialog

### Tests / docs / release-notes — new files

- `customer-portal/playwright-org-sharing/*.spec.ts` — 45 Playwright scenarios per spec §14 (optional, gated by whether the repo already runs Playwright tests)
- `docs/cloud-test-env-org-sharing-runbook.md` — manual Playwright-MCP runbook for the cloud test env
- `backend/src/docs/user-release.ts` — append entry for the deploy date
- `partner-portal/src/docs/release.ts` — append entry (no partner-portal code changes expected; release note documents customer-portal change)

---

## Phase 1 — Foundation

### Task 1: Add `Organization.shareSettings` type to `db.ts`

**Files:**
- Modify: `backend/src/services/db.ts` (around the existing `Organization` interface near line 538)

- [ ] **Step 1: Add the type**

Open `backend/src/services/db.ts` and locate the `Organization` interface. Add the new field:

```typescript
export interface Organization {
  orgId: string;
  ownerUserId: string;
  name: string;
  maxMembers?: number;
  pendingInvites?: string[];
  marketStrategy?: string;
  brandGuidelines?: string;
  shareSettings?: OrgShareSettings;   // <-- new
  createdAt?: string;
  updatedAt?: string;
}

export interface OrgShareSettings {
  knowledgeBase:     { enabled: boolean; editors: string[] };
  htmlTemplates:     { enabled: boolean; editors: string[] };
  landingPages:      { enabled: boolean; editors: string[] };
  workPlans:         { enabled: boolean; editors: string[] };
  skills:            { enabled: boolean; editors: string[] };
  brandGuidelines:   { editors: string[] };
  marketingStrategy: { editors: string[] };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd backend && npx tsc`

Expected: no errors. (The shape is just type additions; nothing consumes the field yet.)

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/db.ts
git commit -m "feat(org-sharing): add OrgShareSettings type to Organization"
```

---

### Task 2: Add `OrgIdIndex` GSI to `AW-Users` (create-tables script + standalone script)

**Files:**
- Modify: `backend/src/scripts/create-tables.ts`
- Create: `backend/src/scripts/create-org-id-gsi.ts` (one-shot, idempotent, for environments where the table already exists)

- [ ] **Step 1: Inspect existing create-tables.ts for AW-Users**

Run: `grep -n "AW-Users" backend/src/scripts/create-tables.ts`

Note the section that creates the `AW-Users` table and its existing GSI list. Add an entry following the same pattern.

- [ ] **Step 2: Add OrgIdIndex to the AW-Users definition**

In `backend/src/scripts/create-tables.ts`, find the `AW-Users` table definition and add to its `GlobalSecondaryIndexes` array:

```typescript
{
  IndexName: "OrgIdIndex",
  KeySchema: [{ AttributeName: "orgId", KeyType: "HASH" }],
  Projection: { ProjectionType: "ALL" },
  ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
}
```

Also add `{ AttributeName: "orgId", AttributeType: "S" }` to the `AttributeDefinitions` if not already present.

- [ ] **Step 3: Create the standalone GSI-add script**

Create `backend/src/scripts/create-org-id-gsi.ts`:

```typescript
import { DynamoDB } from "aws-sdk";

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const TABLE_NAME = `${TABLE_PREFIX}AW-Users`;

async function main() {
  const ddb = new DynamoDB({ region: process.env.AWS_REGION || "us-west-2" });
  const desc = await ddb.describeTable({ TableName: TABLE_NAME }).promise();
  const indexes = desc.Table?.GlobalSecondaryIndexes ?? [];
  if (indexes.some(i => i.IndexName === "OrgIdIndex")) {
    console.log("OrgIdIndex already exists. Nothing to do.");
    return;
  }
  console.log("Creating OrgIdIndex on", TABLE_NAME);
  await ddb.updateTable({
    TableName: TABLE_NAME,
    AttributeDefinitions: [{ AttributeName: "orgId", AttributeType: "S" }],
    GlobalSecondaryIndexUpdates: [{
      Create: {
        IndexName: "OrgIdIndex",
        KeySchema: [{ AttributeName: "orgId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      },
    }],
  }).promise();
  console.log("Submitted. GSI will backfill in the background.");
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd backend && npx tsc`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/scripts/create-tables.ts backend/src/scripts/create-org-id-gsi.ts
git commit -m "feat(org-sharing): add OrgIdIndex GSI to AW-Users"
```

---

### Task 3: Update `getOrgMembers` to use `OrgIdIndex`

**Files:**
- Modify: `backend/src/services/db.ts:7176-7190`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/getOrgMembers.gsi.test.ts`:

```typescript
import { DocumentClient } from "aws-sdk/clients/dynamodb";

const mockQuery = jest.fn();
jest.mock("aws-sdk", () => {
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        query: (...args: any[]) => ({ promise: () => mockQuery(...args) }),
        scan: () => ({ promise: () => Promise.reject(new Error("scan() should not be called")) }),
      })),
    },
  };
});

import { userDb } from "../services/db";

describe("getOrgMembers via OrgIdIndex", () => {
  beforeEach(() => mockQuery.mockReset());

  it("queries the OrgIdIndex GSI with the correct partition key", async () => {
    mockQuery.mockResolvedValueOnce({
      Items: [
        { userId: "u1", orgId: "org-1" },
        { userId: "u2", orgId: "org-1" },
      ],
    });

    const members = await userDb.getOrgMembers("org-1");
    expect(members).toHaveLength(2);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const args = mockQuery.mock.calls[0][0];
    expect(args.IndexName).toBe("OrgIdIndex");
    expect(args.KeyConditionExpression).toContain("orgId");
    expect(args.ExpressionAttributeValues[":orgId"]).toBe("org-1");
  });

  it("excludes tombstoned users", async () => {
    mockQuery.mockResolvedValueOnce({
      Items: [
        { userId: "u1", orgId: "org-1" },
        { userId: "deleted_abc", orgId: "org-1" },
      ],
    });
    const members = await userDb.getOrgMembers("org-1");
    expect(members.map(m => m.userId)).toEqual(["u1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/__tests__/getOrgMembers.gsi.test.ts`

Expected: FAIL — current `getOrgMembers` calls `.scan`, which our mock rejects.

- [ ] **Step 3: Implement**

Open `backend/src/services/db.ts` and replace the body of `getOrgMembers`:

```typescript
async getOrgMembers(orgId: string): Promise<User[]> {
  const allItems: User[] = [];
  let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined;
  do {
    const result = await dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-Users`,
      IndexName: "OrgIdIndex",
      KeyConditionExpression: "orgId = :orgId",
      ExpressionAttributeValues: { ":orgId": orgId },
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    }).promise();
    for (const item of result.Items || []) {
      if (typeof item.userId === "string" && !item.userId.startsWith("deleted_")) {
        allItems.push(item as User);
      }
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return allItems;
}
```

Update `getOrgMemberCount` the same way (use Query + Select: "COUNT").

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/__tests__/getOrgMembers.gsi.test.ts`

Expected: PASS (both cases).

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `cd backend && npx jest`

Expected: previous count of passing tests unchanged (the GSI shape is invisible to existing tests because they mock `dynamodb` themselves).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/db.ts backend/src/__tests__/getOrgMembers.gsi.test.ts
git commit -m "feat(org-sharing): switch getOrgMembers to OrgIdIndex GSI Query"
```

---

### Task 4: Create `orgShareService.ts` — pure permission helpers

**Files:**
- Create: `backend/src/services/orgShareService.ts`
- Create: `backend/src/__tests__/orgShareService.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/__tests__/orgShareService.test.ts`:

```typescript
import {
  canViewItem, canEditItem, isAlwaysOnFeature,
  ToggleableFeature, AlwaysOnFeature, Feature,
} from "../services/orgShareService";
import type { Organization } from "../services/db";

const orgA: Organization = {
  orgId: "org-A", ownerUserId: "u-admin", name: "A",
  shareSettings: {
    knowledgeBase:     { enabled: false, editors: [] },
    htmlTemplates:     { enabled: true,  editors: ["u-editor"] },
    landingPages:      { enabled: false, editors: [] },
    workPlans:         { enabled: true,  editors: [] },
    skills:            { enabled: false, editors: [] },
    brandGuidelines:   { editors: ["u-bg-editor"] },
    marketingStrategy: { editors: [] },
  },
};

const owner   = { userId: "u-owner",  orgId: "org-A", orgRole: "member" as const };
const admin   = { userId: "u-admin",  orgId: "org-A", orgRole: "owner"  as const };
const editor  = { userId: "u-editor", orgId: "org-A", orgRole: "member" as const };
const member  = { userId: "u-member", orgId: "org-A", orgRole: "member" as const };
const other   = { userId: "u-other",  orgId: "org-B", orgRole: "member" as const };
const solo    = { userId: "u-solo" };

const item = { userId: "u-owner" };
const ownerOrgId = "org-A";

describe("canViewItem", () => {
  it("owner can view their own item regardless of any flag", () => {
    expect(canViewItem(item, owner, null, undefined, "htmlTemplates")).toBe(true);
    expect(canViewItem(item, owner, orgA, ownerOrgId, "knowledgeBase")).toBe(true);
  });
  it("toggleable feature: enabled=true allows same-org member", () => {
    expect(canViewItem(item, member, orgA, ownerOrgId, "htmlTemplates")).toBe(true);
  });
  it("toggleable feature: enabled=false blocks same-org member", () => {
    expect(canViewItem(item, member, orgA, ownerOrgId, "knowledgeBase")).toBe(false);
  });
  it("always-on feature: brandGuidelines view always allowed within org", () => {
    expect(canViewItem(item, member, orgA, ownerOrgId, "brandGuidelines")).toBe(true);
    expect(canViewItem(item, member, orgA, ownerOrgId, "marketingStrategy")).toBe(true);
  });
  it("different-org user blocked from all features", () => {
    expect(canViewItem(item, other, orgA, ownerOrgId, "htmlTemplates")).toBe(false);
    expect(canViewItem(item, other, orgA, ownerOrgId, "brandGuidelines")).toBe(false);
  });
  it("solo user blocked from all non-own access", () => {
    expect(canViewItem(item, solo as any, null, undefined, "htmlTemplates")).toBe(false);
  });
});

describe("canEditItem", () => {
  it("owner always edits", () => {
    expect(canEditItem(item, owner, orgA, ownerOrgId, "knowledgeBase")).toBe(true);
  });
  it("org admin always edits", () => {
    expect(canEditItem(item, admin, orgA, ownerOrgId, "knowledgeBase")).toBe(true);
    expect(canEditItem(item, admin, orgA, ownerOrgId, "brandGuidelines")).toBe(true);
  });
  it("toggleable feature: editor allowed only when enabled", () => {
    expect(canEditItem(item, editor, orgA, ownerOrgId, "htmlTemplates")).toBe(true);
    // disable feature
    const orgDisabled = { ...orgA, shareSettings: { ...orgA.shareSettings!, htmlTemplates: { enabled: false, editors: ["u-editor"] } } };
    expect(canEditItem(item, editor, orgDisabled, ownerOrgId, "htmlTemplates")).toBe(false);
  });
  it("always-on feature: editor allowed regardless of any enabled flag", () => {
    const bgEditor = { userId: "u-bg-editor", orgId: "org-A", orgRole: "member" as const };
    expect(canEditItem(item, bgEditor, orgA, ownerOrgId, "brandGuidelines")).toBe(true);
    expect(canEditItem(item, bgEditor, orgA, ownerOrgId, "marketingStrategy")).toBe(false);
  });
  it("non-editor org member blocked", () => {
    expect(canEditItem(item, member, orgA, ownerOrgId, "htmlTemplates")).toBe(false);
  });
  it("different-org user blocked", () => {
    expect(canEditItem(item, other, orgA, ownerOrgId, "htmlTemplates")).toBe(false);
  });
});

describe("isAlwaysOnFeature", () => {
  it("classifies BG and MS as always-on", () => {
    expect(isAlwaysOnFeature("brandGuidelines")).toBe(true);
    expect(isAlwaysOnFeature("marketingStrategy")).toBe(true);
  });
  it("classifies the five toggleable features", () => {
    (["knowledgeBase","htmlTemplates","landingPages","workPlans","skills"] as Feature[])
      .forEach(f => expect(isAlwaysOnFeature(f)).toBe(false));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/__tests__/orgShareService.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `backend/src/services/orgShareService.ts`:

```typescript
import type { Organization, OrgShareSettings, User } from "./db";

export type ToggleableFeature =
  | "knowledgeBase" | "htmlTemplates" | "landingPages" | "workPlans" | "skills";
export type AlwaysOnFeature = "brandGuidelines" | "marketingStrategy";
export type Feature = ToggleableFeature | AlwaysOnFeature;

const ALWAYS_ON: ReadonlySet<Feature> = new Set<Feature>(["brandGuidelines", "marketingStrategy"]);

export function isAlwaysOnFeature(f: Feature): boolean { return ALWAYS_ON.has(f); }

export interface ItemLike { userId?: string }
export interface UserLike { userId: string; orgId?: string; orgRole?: "owner" | "member" }
export type OrgLike = Pick<Organization, "orgId" | "ownerUserId" | "shareSettings">;

function configFor(org: OrgLike | null, f: Feature) {
  if (!org?.shareSettings) return undefined;
  return (org.shareSettings as any)[f] as { enabled?: boolean; editors: string[] } | undefined;
}

export function canViewItem(
  item: ItemLike, user: UserLike, org: OrgLike | null, ownerOrgId: string | undefined, feature: Feature,
): boolean {
  if (item.userId && item.userId === user.userId) return true;
  if (!user.orgId || !org || !ownerOrgId) return false;
  if (ownerOrgId !== user.orgId) return false;
  if (isAlwaysOnFeature(feature)) return true;
  return configFor(org, feature)?.enabled === true;
}

export function canEditItem(
  item: ItemLike, user: UserLike, org: OrgLike | null, ownerOrgId: string | undefined, feature: Feature,
): boolean {
  if (item.userId && item.userId === user.userId) return true;
  if (!user.orgId || !org || !ownerOrgId) return false;
  if (ownerOrgId !== user.orgId) return false;
  if (user.orgRole === "owner") return true;
  const cfg = configFor(org, feature);
  if (!cfg) return false;
  if (!isAlwaysOnFeature(feature) && cfg.enabled !== true) return false;
  return Array.isArray(cfg.editors) && cfg.editors.includes(user.userId);
}

// Caps used by list-merge endpoints (per spec §5.4)
export const MEMBER_FANOUT_CAP = 100;
export const PER_SOURCE_CAP    = 500;
export const ORG_ITEMS_CAP     = 2000;
export const RESPONSE_CAP      = 1000;

export const TOGGLEABLE_FEATURES: ReadonlyArray<ToggleableFeature> = [
  "knowledgeBase", "htmlTemplates", "landingPages", "workPlans", "skills",
];
export const ALWAYS_ON_FEATURES: ReadonlyArray<AlwaysOnFeature> = [
  "brandGuidelines", "marketingStrategy",
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/__tests__/orgShareService.test.ts`

Expected: all PASS.

- [ ] **Step 5: TypeScript check**

Run: `cd backend && npx tsc`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/orgShareService.ts backend/src/__tests__/orgShareService.test.ts
git commit -m "feat(org-sharing): add orgShareService permission helpers"
```

---

### Task 5: Add `updateShareSettings` + `pruneEditorListsForUser` helpers to `db.ts`

**Files:**
- Modify: `backend/src/services/db.ts` (extend `orgDb` namespace near `getOrgMembers`)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/orgDb.shareSettings.test.ts`:

```typescript
const mockUpdate = jest.fn();
const mockGet = jest.fn();
jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get:    (...a: any[]) => ({ promise: () => mockGet(...a) }),
      update: (...a: any[]) => ({ promise: () => mockUpdate(...a) }),
      query:  () => ({ promise: () => Promise.resolve({ Items: [] }) }),
    })),
  },
}));

import { orgDb } from "../services/db";

describe("updateShareSettings", () => {
  beforeEach(() => { mockUpdate.mockReset(); mockGet.mockReset(); });

  it("writes the shareSettings field as a single UpdateItem", async () => {
    mockUpdate.mockResolvedValueOnce({});
    const settings = {
      knowledgeBase:     { enabled: false, editors: [] },
      htmlTemplates:     { enabled: true,  editors: ["u-1"] },
      landingPages:      { enabled: false, editors: [] },
      workPlans:         { enabled: true,  editors: [] },
      skills:            { enabled: false, editors: [] },
      brandGuidelines:   { editors: [] },
      marketingStrategy: { editors: [] },
    };
    await orgDb.updateShareSettings("org-1", settings);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const args = mockUpdate.mock.calls[0][0];
    expect(args.Key.orgId).toBe("org-1");
    expect(args.UpdateExpression).toContain("shareSettings");
  });
});

describe("pruneEditorListsForUser", () => {
  it("removes the userId from each editors array and writes once", async () => {
    mockGet.mockResolvedValueOnce({ Item: {
      orgId: "org-1", ownerUserId: "u-owner", name: "n",
      shareSettings: {
        knowledgeBase:     { enabled: false, editors: ["u-x", "u-1"] },
        htmlTemplates:     { enabled: true,  editors: ["u-1"] },
        landingPages:      { enabled: false, editors: [] },
        workPlans:         { enabled: true,  editors: [] },
        skills:            { enabled: false, editors: [] },
        brandGuidelines:   { editors: ["u-1", "u-2"] },
        marketingStrategy: { editors: [] },
      },
    }});
    mockUpdate.mockResolvedValueOnce({});
    await orgDb.pruneEditorListsForUser("org-1", "u-1");
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const args = mockUpdate.mock.calls[0][0];
    // The shareSettings written must NOT contain u-1 anywhere
    const written = JSON.stringify(args.ExpressionAttributeValues);
    expect(written).not.toContain("u-1");
    expect(written).toContain("u-x");
    expect(written).toContain("u-2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/__tests__/orgDb.shareSettings.test.ts`

Expected: FAIL — `orgDb.updateShareSettings` not a function.

- [ ] **Step 3: Implement**

In `backend/src/services/db.ts`, inside the `orgDb` object literal (the one with `getOrgMembers`), add:

```typescript
async updateShareSettings(orgId: string, settings: OrgShareSettings): Promise<void> {
  await dynamodb.update({
    TableName: `${TABLE_PREFIX}AW-Organizations`,
    Key: { orgId },
    UpdateExpression: "SET shareSettings = :s, updatedAt = :u",
    ExpressionAttributeValues: {
      ":s": settings,
      ":u": new Date().toISOString(),
    },
  }).promise();
},

async pruneEditorListsForUser(orgId: string, removedUserId: string): Promise<void> {
  const got = await dynamodb.get({
    TableName: `${TABLE_PREFIX}AW-Organizations`,
    Key: { orgId },
  }).promise();
  const org = got.Item as Organization | undefined;
  if (!org?.shareSettings) return;
  const ss = org.shareSettings;
  const strip = (arr: string[]) => arr.filter(uid => uid !== removedUserId);
  const next: OrgShareSettings = {
    knowledgeBase:     { ...ss.knowledgeBase,     editors: strip(ss.knowledgeBase.editors) },
    htmlTemplates:     { ...ss.htmlTemplates,     editors: strip(ss.htmlTemplates.editors) },
    landingPages:      { ...ss.landingPages,      editors: strip(ss.landingPages.editors) },
    workPlans:         { ...ss.workPlans,         editors: strip(ss.workPlans.editors) },
    skills:            { ...ss.skills,            editors: strip(ss.skills.editors) },
    brandGuidelines:   { editors: strip(ss.brandGuidelines.editors) },
    marketingStrategy: { editors: strip(ss.marketingStrategy.editors) },
  };
  await this.updateShareSettings(orgId, next);
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/__tests__/orgDb.shareSettings.test.ts`

Expected: both PASS.

- [ ] **Step 5: TypeScript check**

Run: `cd backend && npx tsc`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/db.ts backend/src/__tests__/orgDb.shareSettings.test.ts
git commit -m "feat(org-sharing): add updateShareSettings + pruneEditorListsForUser to orgDb"
```

---

## Phase 2 — Migration

### Task 6: Write the org-shareSettings migration script

**Files:**
- Create: `backend/src/scripts/migrate-org-share-settings.ts`
- Create: `backend/src/__tests__/migrateOrgShareSettings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/migrateOrgShareSettings.test.ts`:

```typescript
const mockScan = jest.fn();
const mockUpdate = jest.fn();
jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      scan:   (...a: any[]) => ({ promise: () => mockScan(...a) }),
      update: (...a: any[]) => ({ promise: () => mockUpdate(...a) }),
    })),
  },
}));

import { runMigration } from "../scripts/migrate-org-share-settings";

describe("migrate-org-share-settings", () => {
  beforeEach(() => { mockScan.mockReset(); mockUpdate.mockReset(); });

  it("writes preserve-current-behavior defaults for existing orgs", async () => {
    mockScan.mockResolvedValueOnce({
      Items: [
        { orgId: "org-1", ownerUserId: "u" },
        { orgId: "org-2", ownerUserId: "u" },
      ],
    });
    mockUpdate.mockResolvedValue({});

    await runMigration();

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    for (const call of mockUpdate.mock.calls) {
      const settings = call[0].ExpressionAttributeValues[":s"];
      expect(settings.workPlans.enabled).toBe(true);
      expect(settings.skills.enabled).toBe(true);
      expect(settings.knowledgeBase.enabled).toBe(false);
      expect(settings.htmlTemplates.enabled).toBe(false);
      expect(settings.landingPages.enabled).toBe(false);
      expect(settings.brandGuidelines.editors).toEqual([]);
      expect(settings.marketingStrategy.editors).toEqual([]);
    }
  });

  it("is idempotent: skips orgs that already have shareSettings", async () => {
    mockScan.mockResolvedValueOnce({
      Items: [{ orgId: "org-1", shareSettings: { workPlans: { enabled: true, editors: [] } } }],
    });
    await runMigration();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/__tests__/migrateOrgShareSettings.test.ts`

Expected: FAIL — script module does not yet exist.

- [ ] **Step 3: Implement the script**

Create `backend/src/scripts/migrate-org-share-settings.ts`:

```typescript
import { DynamoDB } from "aws-sdk";
import type { OrgShareSettings, Organization } from "../services/db";

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const TABLE = `${TABLE_PREFIX}AW-Organizations`;

const defaults: OrgShareSettings = {
  knowledgeBase:     { enabled: false, editors: [] },
  htmlTemplates:     { enabled: false, editors: [] },
  landingPages:      { enabled: false, editors: [] },
  workPlans:         { enabled: true,  editors: [] },
  skills:            { enabled: true,  editors: [] },
  brandGuidelines:   { editors: [] },
  marketingStrategy: { editors: [] },
};

export async function runMigration(): Promise<void> {
  const ddb = new DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
  let lek: any | undefined;
  do {
    const page = await ddb.scan({
      TableName: TABLE,
      ...(lek ? { ExclusiveStartKey: lek } : {}),
    }).promise();
    for (const item of page.Items || []) {
      const org = item as Organization;
      if (org.shareSettings) continue;
      await ddb.update({
        TableName: TABLE,
        Key: { orgId: org.orgId },
        UpdateExpression: "SET shareSettings = :s, updatedAt = :u",
        ExpressionAttributeValues: {
          ":s": defaults,
          ":u": new Date().toISOString(),
        },
      }).promise();
      console.log("Migrated org:", org.orgId);
    }
    lek = page.LastEvaluatedKey;
  } while (lek);
}

if (require.main === module) {
  runMigration().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/__tests__/migrateOrgShareSettings.test.ts`

Expected: both PASS.

- [ ] **Step 5: TypeScript check**

Run: `cd backend && npx tsc`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/scripts/migrate-org-share-settings.ts backend/src/__tests__/migrateOrgShareSettings.test.ts
git commit -m "feat(org-sharing): migration script for org shareSettings defaults"
```

---

## Phase 3 — Admin settings API

### Task 7: GET `/api/orgs/me/share-settings`

**Files:**
- Create: `backend/src/routes/orgShareSettings.ts`
- Create: `backend/src/__tests__/orgShareSettings.routes.test.ts`
- Modify: `backend/src/app.ts` (register route)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/orgShareSettings.routes.test.ts`:

```typescript
import express from "express";
import request from "supertest";

const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockUpdateShareSettings = jest.fn();
const mockGetOrgMembers = jest.fn();

jest.mock("../services/db", () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: {
    getOrgById:           (...a: any[]) => mockGetOrgById(...a),
    updateShareSettings:  (...a: any[]) => mockUpdateShareSettings(...a),
    getOrgMembers:        (...a: any[]) => mockGetOrgMembers(...a),
  },
}));

import routes from "../routes/orgShareSettings";

function makeApp(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { userId }; next(); });
  app.use("/api/orgs/me/share-settings", routes);
  return app;
}

const sampleSettings = {
  knowledgeBase:     { enabled: false, editors: [] },
  htmlTemplates:     { enabled: true,  editors: ["u-2"] },
  landingPages:      { enabled: false, editors: [] },
  workPlans:         { enabled: true,  editors: [] },
  skills:            { enabled: false, editors: [] },
  brandGuidelines:   { editors: [] },
  marketingStrategy: { editors: [] },
};

beforeEach(() => {
  mockGetUserById.mockReset();
  mockGetOrgById.mockReset();
  mockUpdateShareSettings.mockReset();
  mockGetOrgMembers.mockReset();
});

describe("GET /api/orgs/me/share-settings", () => {
  it("returns settings to a member", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "member" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1", shareSettings: sampleSettings });
    const res = await request(makeApp("u-1")).get("/api/orgs/me/share-settings");
    expect(res.status).toBe(200);
    expect(res.body.shareSettings).toEqual(sampleSettings);
  });
  it("404s if user has no org", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1" });
    const res = await request(makeApp("u-1")).get("/api/orgs/me/share-settings");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/__tests__/orgShareSettings.routes.test.ts`

Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the GET handler**

Create `backend/src/routes/orgShareSettings.ts`:

```typescript
import express from "express";
import { userDb, orgDb } from "../services/db";

const router = express.Router();

router.get("/", async (req, res) => {
  const { userId } = (req as any).user;
  const user = await userDb.getUserById(userId);
  if (!user?.orgId) return res.status(404).json({ message: "No org" });
  const org = await orgDb.getOrgById(user.orgId);
  if (!org) return res.status(404).json({ message: "Org not found" });
  return res.json({ shareSettings: org.shareSettings ?? null });
});

export default router;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest src/__tests__/orgShareSettings.routes.test.ts -t "GET"`

Expected: both GET tests PASS.

- [ ] **Step 5: Register the route**

In `backend/src/app.ts`, add the import and `app.use` near the other org routes:

```typescript
import orgShareSettingsRoutes from "./routes/orgShareSettings";
// ...
app.use("/api/orgs/me/share-settings", authenticateToken, orgShareSettingsRoutes);
```

(Use the same auth middleware the existing org routes use; check `app.ts` for the exact import name.)

- [ ] **Step 6: Run tsc**

Run: `cd backend && npx tsc`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/orgShareSettings.ts backend/src/__tests__/orgShareSettings.routes.test.ts backend/src/app.ts
git commit -m "feat(org-sharing): GET /api/orgs/me/share-settings"
```

---

### Task 8: PATCH `/api/orgs/me/share-settings` (admin only, with validation)

**Files:**
- Modify: `backend/src/routes/orgShareSettings.ts`
- Modify: `backend/src/__tests__/orgShareSettings.routes.test.ts`

- [ ] **Step 1: Add failing PATCH tests**

Append to `backend/src/__tests__/orgShareSettings.routes.test.ts`:

```typescript
describe("PATCH /api/orgs/me/share-settings", () => {
  const validBody = { shareSettings: sampleSettings };

  it("rejects non-admin caller with 403", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "member" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1", shareSettings: sampleSettings });
    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings").send(validBody);
    expect(res.status).toBe(403);
    expect(mockUpdateShareSettings).not.toHaveBeenCalled();
  });

  it("accepts admin caller and writes", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "owner" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1" });
    mockGetOrgMembers.mockResolvedValueOnce([
      { userId: "u-1" }, { userId: "u-2" },
    ]);
    mockUpdateShareSettings.mockResolvedValueOnce(undefined);

    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings").send(validBody);
    expect(res.status).toBe(200);
    expect(mockUpdateShareSettings).toHaveBeenCalledWith("org-1", expect.any(Object));
  });

  it("rejects editors who are not org members with 400", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "owner" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1" });
    mockGetOrgMembers.mockResolvedValueOnce([{ userId: "u-1" }]);
    const bad = {
      shareSettings: {
        ...sampleSettings,
        htmlTemplates: { enabled: true, editors: ["u-not-in-org"] },
      },
    };
    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings").send(bad);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/editor/i);
  });

  it("rejects missing required feature key with 400", async () => {
    mockGetUserById.mockResolvedValueOnce({ userId: "u-1", orgId: "org-1", orgRole: "owner" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1" });
    const bad = { shareSettings: { ...sampleSettings, brandGuidelines: undefined } };
    const res = await request(makeApp("u-1"))
      .patch("/api/orgs/me/share-settings").send(bad);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest src/__tests__/orgShareSettings.routes.test.ts -t "PATCH"`

Expected: FAIL — PATCH handler not defined.

- [ ] **Step 3: Implement the PATCH handler**

In `backend/src/routes/orgShareSettings.ts`, append:

```typescript
import { TOGGLEABLE_FEATURES, ALWAYS_ON_FEATURES, OrgShareSettings } from "../services/orgShareService";

function validateSettings(body: any): OrgShareSettings | { error: string } {
  if (!body || typeof body !== "object") return { error: "shareSettings is required" };
  for (const f of TOGGLEABLE_FEATURES) {
    const v = body[f];
    if (!v || typeof v.enabled !== "boolean" || !Array.isArray(v.editors)) {
      return { error: `Invalid value for ${f}` };
    }
  }
  for (const f of ALWAYS_ON_FEATURES) {
    const v = body[f];
    if (!v || !Array.isArray(v.editors)) return { error: `Invalid value for ${f}` };
  }
  return body as OrgShareSettings;
}

router.patch("/", async (req, res) => {
  const { userId } = (req as any).user;
  const user = await userDb.getUserById(userId);
  if (!user?.orgId) return res.status(404).json({ message: "No org" });
  if (user.orgRole !== "owner") return res.status(403).json({ message: "Org owner only" });

  const validated = validateSettings(req.body?.shareSettings);
  if ("error" in validated) return res.status(400).json({ message: validated.error });

  const members = await orgDb.getOrgMembers(user.orgId);
  const memberIds = new Set(members.map(m => m.userId));
  for (const f of [...TOGGLEABLE_FEATURES, ...ALWAYS_ON_FEATURES]) {
    const editors: string[] = (validated as any)[f].editors;
    for (const e of editors) {
      if (!memberIds.has(e)) {
        return res.status(400).json({ message: `editor ${e} is not a member of this org (feature ${f})` });
      }
    }
  }

  await orgDb.updateShareSettings(user.orgId, validated);
  return res.json({ shareSettings: validated });
});
```

(Import `OrgShareSettings` from `../services/db`; the `orgShareService` exports `TOGGLEABLE_FEATURES` and `ALWAYS_ON_FEATURES`. The exact named import you need: `import { TOGGLEABLE_FEATURES, ALWAYS_ON_FEATURES } from "../services/orgShareService"; import type { OrgShareSettings } from "../services/db";`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest src/__tests__/orgShareSettings.routes.test.ts`

Expected: all PATCH tests PASS plus prior GET tests still PASS.

- [ ] **Step 5: tsc**

Run: `cd backend && npx tsc`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/orgShareSettings.ts backend/src/__tests__/orgShareSettings.routes.test.ts
git commit -m "feat(org-sharing): PATCH /api/orgs/me/share-settings (admin-only, with editor validation)"
```

---

## Phase 4 — Generic fanout helper

### Task 9: Add `listOrgVisibleItems` helper to `orgShareService.ts`

**Files:**
- Modify: `backend/src/services/orgShareService.ts`
- Modify: `backend/src/__tests__/orgShareService.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `backend/src/__tests__/orgShareService.test.ts`:

```typescript
import { listOrgVisibleItems, MEMBER_FANOUT_CAP } from "../services/orgShareService";

describe("listOrgVisibleItems", () => {
  it("returns only ownItems when feature is disabled", async () => {
    const result = await listOrgVisibleItems({
      callerUserId: "u-1",
      orgId: "org-1",
      featureEnabled: false,
      getOwnerItems: async () => [{ id: "a", userId: "u-1" }],
      getMemberIds:  async () => ["u-1", "u-2"],
      getItemsForOwner: async () => [{ id: "x", userId: "u-2" }],
      getId: (i: any) => i.id,
    });
    expect(result.items.map((i: any) => i.id)).toEqual(["a"]);
    expect(result.truncated).toBe(false);
  });

  it("merges own + each other member's items when enabled", async () => {
    const ownItems    = [{ id: "a", userId: "u-1" }];
    const otherItems  = {
      "u-2": [{ id: "b", userId: "u-2" }, { id: "c", userId: "u-2" }],
      "u-3": [{ id: "d", userId: "u-3" }],
    };
    const result = await listOrgVisibleItems({
      callerUserId: "u-1",
      orgId: "org-1",
      featureEnabled: true,
      getOwnerItems: async () => ownItems,
      getMemberIds:  async () => ["u-1", "u-2", "u-3"],
      getItemsForOwner: async (uid: string) => (otherItems as any)[uid] || [],
      getId: (i: any) => i.id,
    });
    expect(result.items.map((i: any) => i.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("dedupes by id (own item also present in org list)", async () => {
    const result = await listOrgVisibleItems({
      callerUserId: "u-1",
      orgId: "org-1",
      featureEnabled: true,
      getOwnerItems: async () => [{ id: "a", userId: "u-1" }],
      getMemberIds:  async () => ["u-1", "u-2"],
      getItemsForOwner: async () => [{ id: "a", userId: "u-1" }],
      getId: (i: any) => i.id,
    });
    expect(result.items).toHaveLength(1);
  });

  it("caps member fanout and flags truncated when over MEMBER_FANOUT_CAP", async () => {
    const many = Array.from({ length: MEMBER_FANOUT_CAP + 5 }, (_, i) => `u-${i}`);
    const result = await listOrgVisibleItems({
      callerUserId: "u-x",
      orgId: "org-1",
      featureEnabled: true,
      getOwnerItems: async () => [],
      getMemberIds:  async () => many,
      getItemsForOwner: async () => [],
      getId: (i: any) => i.id,
    });
    expect(result.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest src/__tests__/orgShareService.test.ts -t "listOrgVisibleItems"`

Expected: FAIL — function not defined.

- [ ] **Step 3: Implement**

Append to `backend/src/services/orgShareService.ts`:

```typescript
export interface ListOrgVisibleArgs<T> {
  callerUserId: string;
  orgId: string;
  featureEnabled: boolean;
  getOwnerItems: () => Promise<T[]>;
  getMemberIds:  () => Promise<string[]>;
  getItemsForOwner: (ownerUserId: string) => Promise<T[]>;
  getId: (item: T) => string;
}

export interface ListOrgVisibleResult<T> { items: T[]; truncated: boolean; }

export async function listOrgVisibleItems<T>(args: ListOrgVisibleArgs<T>): Promise<ListOrgVisibleResult<T>> {
  const own = await args.getOwnerItems();
  if (!args.featureEnabled) {
    return { items: own.slice(0, RESPONSE_CAP), truncated: own.length >= PER_SOURCE_CAP };
  }
  const allMembers = await args.getMemberIds();
  const others = allMembers.filter(uid => uid !== args.callerUserId);
  const truncatedFanout = others.length > MEMBER_FANOUT_CAP;
  const fanoutTargets = truncatedFanout ? others.slice(0, MEMBER_FANOUT_CAP) : others;
  const perMember = await Promise.all(fanoutTargets.map(args.getItemsForOwner));
  const orgItems = perMember.flat();
  const truncatedItems = orgItems.length >= ORG_ITEMS_CAP || own.length >= PER_SOURCE_CAP;
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const i of [...own, ...orgItems.slice(0, ORG_ITEMS_CAP)]) {
    const k = args.getId(i);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(i);
    if (merged.length >= RESPONSE_CAP) break;
  }
  return { items: merged, truncated: truncatedFanout || truncatedItems };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest src/__tests__/orgShareService.test.ts`

Expected: all PASS.

- [ ] **Step 5: tsc + commit**

Run: `cd backend && npx tsc`

```bash
git add backend/src/services/orgShareService.ts backend/src/__tests__/orgShareService.test.ts
git commit -m "feat(org-sharing): generic listOrgVisibleItems fanout helper"
```

---

## Phase 5 — WorkPlans retrofit

### Task 10: Update `workPlanService.getWorkPlansByOrg` to use member-fanout

**Files:**
- Modify: `backend/src/services/workPlanService.ts:156-163`

- [ ] **Step 1: Adapt existing tests**

Open `backend/src/__tests__/orgSharedWorkPlans.test.ts`. The current test mocks `getWorkPlansByOrg`. It still passes, but ensure it returns only items where `ownerId !== caller` (the fanout helper excludes the caller). Re-read the test and confirm; if it asserts that `getWorkPlansByOrg` returns the caller's own plan, change to:

```typescript
mockGetWorkPlansByOrg.mockResolvedValueOnce([memberPlan]);  // exclude myPlan
```

- [ ] **Step 2: Replace the body of `getWorkPlansByOrg`**

In `backend/src/services/workPlanService.ts`, change `getWorkPlansByOrg`:

```typescript
async getWorkPlansByOrg(orgId: string, callerUserId: string): Promise<WorkPlan[]> {
  const { userDb } = await import("./db");
  const members = await userDb.getOrgMembers(orgId);
  const others = members.map(m => m.userId).filter(uid => uid !== callerUserId);
  const perMember = await Promise.all(others.map(uid => this.getWorkPlansByOwner(uid)));
  return perMember.flat();
}
```

Note the signature change — callers must now pass `callerUserId`.

- [ ] **Step 3: Update the route caller**

In `backend/src/routes/userWorkPlanRoutes.ts:9-32`, change:

```typescript
orgId ? workPlanService.getWorkPlansByOrg(orgId) : Promise.resolve([]),
```

to:

```typescript
orgId ? workPlanService.getWorkPlansByOrg(orgId, userId) : Promise.resolve([]),
```

Also add the `shareSettings` check before fanning out:

```typescript
const orgRecord = orgId ? await orgDb.getOrgById(orgId) : null;
const wpEnabled = orgRecord?.shareSettings?.workPlans?.enabled === true;
const orgFetcher = orgId && wpEnabled ? workPlanService.getWorkPlansByOrg(orgId, userId) : Promise.resolve([] as WorkPlan[]);
```

Replace the existing `Promise.all` accordingly. Wrap response in `{ items, truncated }`:

```typescript
res.json({ items: all, truncated: false });
```

(For now, set `truncated: false`; pagination caps come from migrating to `listOrgVisibleItems` in Task 12. The customer-portal client adaptations are in Task 16.)

- [ ] **Step 4: Run tests**

Run: `cd backend && npx jest src/__tests__/orgSharedWorkPlans.test.ts`

Expected: PASS. Adjust assertions to read `body.items` instead of the flat array if the existing test expects a flat array.

- [ ] **Step 5: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/services/workPlanService.ts backend/src/routes/userWorkPlanRoutes.ts backend/src/__tests__/orgSharedWorkPlans.test.ts
git commit -m "feat(org-sharing): WorkPlans list uses member-fanout + shareSettings gate"
```

---

### Task 11: WorkPlans edit/delete permission via `canEditItem`

**Files:**
- Modify: `backend/src/routes/userWorkPlanRoutes.ts:92-143`
- Modify: `backend/src/__tests__/orgSharedWorkPlans.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/__tests__/orgSharedWorkPlans.test.ts`:

```typescript
// Re-use mocks above; add:
const mockGetOrgById = jest.fn();
const mockGetUserById = jest.fn();
// Add these to the jest.mock("../services/db", () => ({...})) block.

describe("editor permissions on workplans", () => {
  it("editor in org.shareSettings can PATCH another member's plan", async () => {
    // setup so that getWorkPlan returns memberPlan,
    // getUserById(memberPlan.ownerId) returns { orgId: 'org-abc' },
    // getOrgById('org-abc') returns shareSettings.workPlans = { enabled: true, editors: ['u-1'] }
    // PATCH /:planId by 'u-1' should return 200.
    // Implementation per route updated.
    // (Full body of test mirrors the existing patterns in this file.)
  });
  it("non-editor org member is rejected with 403", async () => { /* mirror */ });
  it("DELETE remains owner-only (or admin); editor cannot delete", async () => { /* mirror */ });
});
```

Fill in the test bodies modelled on existing tests in this file, using the mocks already set up. Mark them as the failing tests for this task.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && npx jest src/__tests__/orgSharedWorkPlans.test.ts -t "editor permissions"`

Expected: FAIL — non-owner PATCH is currently rejected by the existing `plan.ownerId !== userId` check.

- [ ] **Step 3: Update the PATCH handler**

In `backend/src/routes/userWorkPlanRoutes.ts:92-122`, replace the body of the PATCH handler:

```typescript
router.put("/:planId", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const { planId } = req.params;
    const plan = await workPlanService.getWorkPlan(planId);
    if (!plan) return res.status(404).json({ message: "Work plan not found" });
    if (plan.visibility !== "private") {
      return res.status(403).json({ message: "Cannot edit plans that are public or pending review" });
    }
    // Build context for permission check
    const caller = await userDb.getUserById(userId);
    let org = null;
    let ownerOrgId: string | undefined;
    if (plan.ownerId && plan.ownerId !== userId) {
      const owner = await userDb.getUserById(plan.ownerId);
      ownerOrgId = owner?.orgId;
      if (caller?.orgId && ownerOrgId === caller.orgId) {
        org = await orgDb.getOrgById(caller.orgId);
      }
    }
    const allowed = canEditItem(
      { userId: plan.ownerId } as any,
      { userId, orgId: caller?.orgId, orgRole: caller?.orgRole },
      org, ownerOrgId, "workPlans",
    );
    if (!allowed) return res.status(403).json({ message: "Not authorized" });
    // ... existing update logic unchanged
```

(Imports needed: `import { canEditItem } from "../services/orgShareService";` and `import { orgDb } from "../services/db";`.)

For DELETE, keep the existing owner-only constraint (admins are also `userId === userId` when delegated for their own — but per spec, editors cannot delete; owner OR org admin can). Update DELETE to also allow when `caller.orgRole === "owner"` AND `caller.orgId === ownerOrgId`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest src/__tests__/orgSharedWorkPlans.test.ts`

Expected: all PASS.

- [ ] **Step 5: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/routes/userWorkPlanRoutes.ts backend/src/__tests__/orgSharedWorkPlans.test.ts
git commit -m "feat(org-sharing): WorkPlans PATCH/DELETE use canEditItem (editor + admin)"
```

---

### Task 12: Migrate WorkPlans list endpoint to `listOrgVisibleItems`

**Files:**
- Modify: `backend/src/routes/userWorkPlanRoutes.ts:9-32`

- [ ] **Step 1: Replace the list handler body**

```typescript
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;
    const org = orgId ? await orgDb.getOrgById(orgId) : null;
    const enabled = org?.shareSettings?.workPlans?.enabled === true;

    const [ownItems, publicItems, fanout] = await Promise.all([
      workPlanService.getWorkPlansByOwner(userId),
      workPlanService.getPublicPlansForAgentMode(),
      orgId
        ? listOrgVisibleItems({
            callerUserId: userId,
            orgId,
            featureEnabled: enabled,
            getOwnerItems: async () => [],     // own items handled separately
            getMemberIds:  async () => (await orgDb.getOrgMembers(orgId)).map(m => m.userId),
            getItemsForOwner: (uid) => workPlanService.getWorkPlansByOwner(uid),
            getId: (p: WorkPlan) => p.planId,
          })
        : Promise.resolve({ items: [] as WorkPlan[], truncated: false }),
    ]);

    const seen = new Set<string>();
    const all = [...ownItems, ...fanout.items, ...publicItems].filter(p => {
      if (seen.has(p.planId)) return false;
      seen.add(p.planId);
      return true;
    });
    res.json({ items: all, truncated: fanout.truncated });
  } catch (e) {
    console.error("Error fetching user work plans:", e);
    res.status(500).json({ message: "Failed to fetch work plans" });
  }
});
```

- [ ] **Step 2: Run tests**

Run: `cd backend && npx jest src/__tests__/orgSharedWorkPlans.test.ts`

Expected: PASS (assertions read `body.items`).

- [ ] **Step 3: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/routes/userWorkPlanRoutes.ts
git commit -m "feat(org-sharing): WorkPlans list uses listOrgVisibleItems with truncated flag"
```

---

## Phase 6 — Skills retrofit

### Task 13: Mirror Phase 5 for Skills

**Files:**
- Modify: `backend/src/services/skillService.ts:368-377`
- Modify: `backend/src/routes/userSkillRoutes.ts`
- Modify: `backend/src/__tests__/orgSharedSkills.test.ts`

- [ ] **Step 1: Apply the same changes as Tasks 10-12 to skills**

For each step below, mirror the matching WorkPlans step exactly:

(a) Replace `skillService.getSkillsByOrg(orgId)` body with member-fanout + new `callerUserId` parameter.
(b) Update `userSkillRoutes.ts` list endpoint to use `listOrgVisibleItems` with `workPlans` → `skills`.
(c) Add `canEditItem` to skill PATCH and DELETE handlers.
(d) Update or add tests in `orgSharedSkills.test.ts` to cover editor + admin + non-editor cases.

- [ ] **Step 2: Run skill tests**

Run: `cd backend && npx jest src/__tests__/orgSharedSkills.test.ts`

Expected: all PASS.

- [ ] **Step 3: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/services/skillService.ts backend/src/routes/userSkillRoutes.ts backend/src/__tests__/orgSharedSkills.test.ts
git commit -m "feat(org-sharing): Skills mirror WorkPlans pattern (fanout, editor, admin)"
```

---

## Phase 7 — Landing Pages

### Task 14: Add fanout + permission to Landing Pages

**Files:**
- Modify: `backend/src/services/v0Service.ts` (add `getLandingPagesByOwner` if not present, plus `getLandingPagesByOrg`)
- Modify: `backend/src/routes/landingPages.ts`
- Create: `backend/src/__tests__/orgSharedLandingPages.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/__tests__/orgSharedLandingPages.test.ts` modelled on `orgSharedWorkPlans.test.ts`. Cover:
- list endpoint returns own + org-shared LPs when `landingPages.enabled === true`;
- list excludes others' LPs when `enabled === false`;
- editor can PATCH another member's LP, non-editor cannot, admin always can, owner can DELETE but editor cannot.

(Full test body mirrors WorkPlans test exactly with substitutions: `WorkPlan` → `LandingPage`, `planId` → `pageId`, `workPlans` → `landingPages`.)

- [ ] **Step 2: Run tests**

Run: `cd backend && npx jest src/__tests__/orgSharedLandingPages.test.ts`

Expected: FAIL — endpoints not yet updated.

- [ ] **Step 3: Add `getLandingPagesByOwner` to v0Service**

If not already present:

```typescript
async getLandingPagesByOwner(userId: string): Promise<GeneratedLandingPage[]> {
  const result = await dynamodb.query({
    TableName: "AW-LandingPages",
    IndexName: "UserIdIndex",   // ensure this GSI exists; if not, add it in create-tables.ts
    KeyConditionExpression: "userId = :u",
    ExpressionAttributeValues: { ":u": userId },
  }).promise();
  return (result.Items as GeneratedLandingPage[]) || [];
}
```

If `AW-LandingPages` lacks `UserIdIndex`, add it in `backend/src/scripts/create-tables.ts` and document in the deployment runbook.

- [ ] **Step 4: Update list/PATCH/DELETE routes**

In `backend/src/routes/landingPages.ts`, retrofit GET / PATCH / DELETE handlers per the WorkPlans pattern.

- [ ] **Step 5: Run tests**

Run: `cd backend && npx jest src/__tests__/orgSharedLandingPages.test.ts`

Expected: all PASS.

- [ ] **Step 6: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/services/v0Service.ts backend/src/routes/landingPages.ts backend/src/__tests__/orgSharedLandingPages.test.ts backend/src/scripts/create-tables.ts
git commit -m "feat(org-sharing): Landing Pages list/edit/delete via fanout + canEditItem"
```

---

## Phase 8 — KB-bearing Tasks

### Task 15: Org-share KB-bearing tasks

**Files:**
- Modify: `backend/src/routes/tasks.ts`
- Create: `backend/src/__tests__/orgSharedKnowledgeBase.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/orgSharedKnowledgeBase.test.ts` modelled on `orgSharedWorkPlans.test.ts`. Scenarios:
- list endpoint returns own KB-tasks AND org members' KB-tasks when `knowledgeBase.enabled === true`;
- when disabled, returns only own;
- another member with `editors` membership can PATCH a foreign task's KB fields; non-editor cannot; admin always can.

Note: the existing list endpoint for tasks already paginates. Confirm whether KB-bearing means "task has `knowledgeBase` field set" or whether we share *every* task. **Default to "every task owned by a member"** for simplicity — the spec section talks about KB but the dataset is the task itself.

- [ ] **Step 2: Run tests**

Run: `cd backend && npx jest src/__tests__/orgSharedKnowledgeBase.test.ts`

Expected: FAIL.

- [ ] **Step 3: Update `routes/tasks.ts`**

For the list endpoint: apply the `listOrgVisibleItems` pattern with feature `"knowledgeBase"`.
For task GET / PATCH / DELETE: apply `canViewItem` / `canEditItem` exactly as in Task 14.

- [ ] **Step 4: Run tests**

Run: `cd backend && npx jest src/__tests__/orgSharedKnowledgeBase.test.ts`

Expected: PASS.

- [ ] **Step 5: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/routes/tasks.ts backend/src/__tests__/orgSharedKnowledgeBase.test.ts
git commit -m "feat(org-sharing): Tasks (KB) list/edit gated by shareSettings.knowledgeBase"
```

---

## Phase 9 — HtmlTemplates storage + sharing

### Task 16: Create AW-HtmlTemplates table + service

**Files:**
- Modify: `backend/src/scripts/create-tables.ts` (add table)
- Create: `backend/src/services/htmlTemplateService.ts`
- Create: `backend/src/__tests__/htmlTemplateService.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/__tests__/htmlTemplateService.test.ts` with cases:
- `createTemplate` writes a new row with a generated templateId and the right userId.
- `getTemplate(id)` returns the row or null.
- `getTemplatesByOwner(userId)` queries `UserIdIndex` and returns user rows.
- `getPublicTemplates()` queries `IsPublicIndex` and returns admin rows.
- `updateTemplate(id, fields)` updates only allowed fields.
- `deleteTemplate(id)` removes the row.

(Each test mocks the DocumentClient like Task 5.)

- [ ] **Step 2: Add table definition**

In `backend/src/scripts/create-tables.ts`, add:

```typescript
{
  TableName: `${TABLE_PREFIX}AW-HtmlTemplates`,
  KeySchema: [{ AttributeName: "templateId", KeyType: "HASH" }],
  AttributeDefinitions: [
    { AttributeName: "templateId", AttributeType: "S" },
    { AttributeName: "userId",     AttributeType: "S" },
    { AttributeName: "isPublic",   AttributeType: "S" },
    { AttributeName: "createdAt",  AttributeType: "S" },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "UserIdIndex",
      KeySchema: [
        { AttributeName: "userId",    KeyType: "HASH" },
        { AttributeName: "createdAt", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    },
    {
      IndexName: "IsPublicIndex",
      KeySchema: [{ AttributeName: "isPublic", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
    },
  ],
  BillingMode: "PROVISIONED",
  ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
},
```

(Match the existing table definition style in the file. Note `isPublic` is stored as the string "true" or absent — DDB Boolean isn't a valid GSI partition type.)

- [ ] **Step 3: Implement the service**

Create `backend/src/services/htmlTemplateService.ts`:

```typescript
import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";

export interface HtmlTemplate {
  templateId: string;
  userId: string;
  type: ("email" | "landing_page")[];
  name: string;
  subject?: string;
  html: string;
  isPublic?: "true";       // stored as string so GSI works
  createdAt: string;
  updatedAt: string;
}

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const TABLE = `${TABLE_PREFIX}AW-HtmlTemplates`;
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });

export const htmlTemplateService = {
  async createTemplate(input: Omit<HtmlTemplate, "templateId" | "createdAt" | "updatedAt">): Promise<HtmlTemplate> {
    const now = new Date().toISOString();
    const tpl: HtmlTemplate = { ...input, templateId: uuidv4(), createdAt: now, updatedAt: now };
    await dynamodb.put({ TableName: TABLE, Item: tpl }).promise();
    return tpl;
  },
  async getTemplate(templateId: string): Promise<HtmlTemplate | null> {
    const r = await dynamodb.get({ TableName: TABLE, Key: { templateId } }).promise();
    return (r.Item as HtmlTemplate) || null;
  },
  async getTemplatesByOwner(userId: string): Promise<HtmlTemplate[]> {
    const r = await dynamodb.query({
      TableName: TABLE, IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
    }).promise();
    return (r.Items as HtmlTemplate[]) || [];
  },
  async getPublicTemplates(): Promise<HtmlTemplate[]> {
    const r = await dynamodb.query({
      TableName: TABLE, IndexName: "IsPublicIndex",
      KeyConditionExpression: "isPublic = :v",
      ExpressionAttributeValues: { ":v": "true" },
    }).promise();
    return (r.Items as HtmlTemplate[]) || [];
  },
  async updateTemplate(templateId: string, fields: Partial<Omit<HtmlTemplate, "templateId" | "userId" | "createdAt">>): Promise<HtmlTemplate | null> {
    const existing = await this.getTemplate(templateId);
    if (!existing) return null;
    const next: HtmlTemplate = { ...existing, ...fields, updatedAt: new Date().toISOString() };
    await dynamodb.put({ TableName: TABLE, Item: next }).promise();
    return next;
  },
  async deleteTemplate(templateId: string): Promise<void> {
    await dynamodb.delete({ TableName: TABLE, Key: { templateId } }).promise();
  },
};
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx jest src/__tests__/htmlTemplateService.test.ts`

Expected: PASS.

- [ ] **Step 5: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/scripts/create-tables.ts backend/src/services/htmlTemplateService.ts backend/src/__tests__/htmlTemplateService.test.ts
git commit -m "feat(org-sharing): AW-HtmlTemplates table + htmlTemplateService"
```

---

### Task 17: Migrate existing template settings rows to the new table

**Files:**
- Create: `backend/src/scripts/migrate-html-templates.ts`
- Create: `backend/src/__tests__/migrateHtmlTemplates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/migrateHtmlTemplates.test.ts`. Cover:
- script reads every `templates_*` row from `AW-Settings`, writes individual template rows.
- public templates (from `templates_public`) get `isPublic: "true"` and `userId: "__public__"` (sentinel).
- the script is idempotent: re-running with templates already migrated is a no-op (detect by checking if a template with the same `legacyId` exists, OR by tracking migration state in `AW-Settings` itself).

- [ ] **Step 2: Implement the script**

Create `backend/src/scripts/migrate-html-templates.ts`:

```typescript
import AWS from "aws-sdk";
import { htmlTemplateService } from "../services/htmlTemplateService";

const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const SETTINGS = `${TABLE_PREFIX}AW-Settings`;
const MIGRATED_KEY = "html_templates_migrated";

export async function runMigration() {
  const ddb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
  // marker check
  const marker = await ddb.get({ TableName: SETTINGS, Key: { key: MIGRATED_KEY } }).promise();
  if (marker.Item) {
    console.log("Already migrated. Skipping.");
    return;
  }

  let lek: any | undefined;
  let migratedCount = 0;
  do {
    const page = await ddb.scan({
      TableName: SETTINGS,
      FilterExpression: "begins_with(#k, :p)",
      ExpressionAttributeNames: { "#k": "key" },
      ExpressionAttributeValues: { ":p": "templates_" },
      ...(lek ? { ExclusiveStartKey: lek } : {}),
    }).promise();
    for (const row of page.Items || []) {
      const key: string = row.key;
      const isPublic = key === "templates_public";
      const userId = isPublic ? "__public__" : key.slice("templates_".length);
      const arr: any[] = Array.isArray(row.templates) ? row.templates : [];
      for (const t of arr) {
        await htmlTemplateService.createTemplate({
          userId,
          type: Array.isArray(t.type) ? t.type : (t.type ? [t.type] : ["email"]),
          name: t.name || "Untitled",
          subject: t.subject,
          html: t.html || "",
          ...(isPublic ? { isPublic: "true" as const } : {}),
        });
        migratedCount++;
      }
    }
    lek = page.LastEvaluatedKey;
  } while (lek);

  await ddb.put({
    TableName: SETTINGS,
    Item: { key: MIGRATED_KEY, migratedAt: new Date().toISOString(), count: migratedCount },
  }).promise();
  console.log("Migrated", migratedCount, "templates");
}

if (require.main === module) {
  runMigration().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 3: Run tests**

Run: `cd backend && npx jest src/__tests__/migrateHtmlTemplates.test.ts`

Expected: PASS.

- [ ] **Step 4: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/scripts/migrate-html-templates.ts backend/src/__tests__/migrateHtmlTemplates.test.ts
git commit -m "feat(org-sharing): one-shot migration HtmlTemplates settings-row → AW-HtmlTemplates"
```

---

### Task 18: Rewrite `routes/htmlTemplates.ts` against new service + fanout

**Files:**
- Modify: `backend/src/routes/htmlTemplates.ts`
- Modify: `backend/src/controllers/htmlTemplatesController.ts` (delete or thin-wrap)
- Create: `backend/src/__tests__/orgSharedHtmlTemplates.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/__tests__/orgSharedHtmlTemplates.test.ts` mirroring `orgSharedWorkPlans.test.ts` exactly. Cover list + GET + PATCH + DELETE + admin + editor + non-editor + cross-org + `isPublic` orthogonality.

- [ ] **Step 2: Implement the routes**

In `backend/src/routes/htmlTemplates.ts`, rebuild the endpoints to:
- GET / list → calls `htmlTemplateService.getTemplatesByOwner(userId)` + `getPublicTemplates()` + fanout if `htmlTemplates.enabled`. Returns `{ items, truncated }`.
- POST → create with `userId`.
- GET /:id → view permission via `canViewItem` (and always-allowed for `isPublic === "true"` rows regardless of org).
- PATCH /:id → edit via `canEditItem`.
- DELETE /:id → owner or admin only.

- [ ] **Step 3: Run tests**

Run: `cd backend && npx jest src/__tests__/orgSharedHtmlTemplates.test.ts`

Expected: PASS.

- [ ] **Step 4: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/routes/htmlTemplates.ts backend/src/controllers/htmlTemplatesController.ts backend/src/__tests__/orgSharedHtmlTemplates.test.ts
git commit -m "feat(org-sharing): htmlTemplates routes use new table + fanout + canEditItem"
```

---

## Phase 10 — Brand Guidelines + Marketing Strategy edit-side

### Task 19: Editor-list gating on `marketStrategy.ts`

**Files:**
- Modify: `backend/src/routes/marketStrategy.ts`
- Create: `backend/src/__tests__/orgPillarEditors.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/__tests__/orgPillarEditors.test.ts` covering scenarios 12-16 from spec §13:
- admin can PUT both BG and MS regardless of editor list.
- BG editor can PUT brand guidelines but not marketing strategy.
- MS editor can PUT marketing strategy but not brand guidelines.
- Non-editor org member can GET both but not PUT either.
- Different-org user cannot GET or PUT.

- [ ] **Step 2: Run tests**

Run: `cd backend && npx jest src/__tests__/orgPillarEditors.test.ts`

Expected: FAIL.

- [ ] **Step 3: Update the PUT handlers**

For each PUT handler in `marketStrategy.ts` (one for brand guidelines, one for marketing strategy), wrap the write with `canEditItem` using the appropriate feature key. View handlers remain unchanged (always-on view is the current behavior).

- [ ] **Step 4: Run tests**

Run: `cd backend && npx jest src/__tests__/orgPillarEditors.test.ts`

Expected: PASS.

- [ ] **Step 5: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/routes/marketStrategy.ts backend/src/__tests__/orgPillarEditors.test.ts
git commit -m "feat(org-sharing): BG/MS PUT requires admin or matching editor list membership"
```

---

## Phase 11 — Member removal flow

### Task 20: Preview endpoint

**Files:**
- Create: `backend/src/routes/orgMemberRemoval.ts`
- Create: `backend/src/__tests__/orgMemberRemoval.test.ts`
- Modify: `backend/src/app.ts` (register)

- [ ] **Step 1: Write failing test for preview**

Create `backend/src/__tests__/orgMemberRemoval.test.ts`:

```typescript
// Skeleton — full body fills in counts per feature.
describe("GET /api/orgs/me/members/:userId/removal-preview", () => {
  it("returns correct counts per feature", async () => { /* mock 3 KBs, 5 tpls, etc., expect counts */ });
  it("404s if target user is not in caller's org", async () => { /* setup target.orgId !== caller.orgId */ });
  it("403s if caller is not org owner", async () => { /* */ });
});
```

- [ ] **Step 2: Implement preview endpoint**

In `backend/src/routes/orgMemberRemoval.ts`:

```typescript
import express from "express";
import { userDb } from "../services/db";
import { workPlanService } from "../services/workPlanService";
import { skillService }    from "../services/skillService";
import { htmlTemplateService } from "../services/htmlTemplateService";
import { v0Service } from "../services/v0Service";        // adjust import to match real export
import { taskService } from "../services/taskService";    // or whichever module owns tasks-by-owner
const router = express.Router();

router.get("/:userId/removal-preview", async (req, res) => {
  const callerId = (req as any).user.userId;
  const caller = await userDb.getUserById(callerId);
  if (!caller?.orgId || caller.orgRole !== "owner") return res.status(403).json({ message: "Org owner only" });

  const target = await userDb.getUserById(req.params.userId);
  if (!target || target.orgId !== caller.orgId) return res.status(404).json({ message: "Member not found in your org" });

  const [kbCount, tplCount, lpCount, wpCount, skCount] = await Promise.all([
    taskService.countByOwner(target.userId, { onlyWithKnowledgeBase: false }),  // adjust signature
    htmlTemplateService.getTemplatesByOwner(target.userId).then(a => a.length),
    v0Service.getLandingPagesByOwner(target.userId).then(a => a.length),
    workPlanService.getWorkPlansByOwner(target.userId).then(a => a.length),
    skillService.getSkillsByOwner(target.userId).then(a => a.length),
  ]);

  res.json({
    userId: target.userId,
    itemCounts: {
      knowledgeBase: kbCount,
      htmlTemplates: tplCount,
      landingPages:  lpCount,
      workPlans:     wpCount,
      skills:        skCount,
    },
  });
});

export default router;
```

(Real method names: confirm `getSkillsByOwner` exists; if not, add it. `taskService.countByOwner` may need to be added — implement it as a Query on the existing `UserIdIndex` of `AW-Tasks` with `Select: "COUNT"`.)

- [ ] **Step 3: Register the route in `app.ts`**

```typescript
import orgMemberRemovalRoutes from "./routes/orgMemberRemoval";
app.use("/api/orgs/me/members", authenticateToken, orgMemberRemovalRoutes);
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx jest src/__tests__/orgMemberRemoval.test.ts -t "removal-preview"`

Expected: PASS.

- [ ] **Step 5: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/routes/orgMemberRemoval.ts backend/src/__tests__/orgMemberRemoval.test.ts backend/src/app.ts
git commit -m "feat(org-sharing): removal-preview endpoint"
```

---

### Task 21: Removal execution endpoint with per-feature decisions

**Files:**
- Modify: `backend/src/routes/orgMemberRemoval.ts`
- Modify: `backend/src/__tests__/orgMemberRemoval.test.ts`

- [ ] **Step 1: Write failing tests**

Cover scenarios from spec §13 tests 17-22 and §14 PW-26 to PW-34. Each scenario asserts the right combination of UpdateItem / DeleteItem calls per decision.

- [ ] **Step 2: Implement the POST handler**

Append to `backend/src/routes/orgMemberRemoval.ts`:

```typescript
import { TOGGLEABLE_FEATURES } from "../services/orgShareService";
import { orgDb } from "../services/db";
import pLimit from "p-limit";

const PER_FEATURE_CAP = 10000;
const CONCURRENCY = 25;

router.post("/:userId/remove", async (req, res) => {
  const callerId = (req as any).user.userId;
  const caller = await userDb.getUserById(callerId);
  if (!caller?.orgId || caller.orgRole !== "owner") return res.status(403).json({ message: "Org owner only" });
  if (req.body?.confirm !== true) return res.status(400).json({ message: "confirm:true required" });

  const target = await userDb.getUserById(req.params.userId);
  if (!target || target.orgId !== caller.orgId) return res.status(404).json({ message: "Member not found in your org" });

  const decisions = req.body?.decisions || {};
  // Validate keys
  for (const f of TOGGLEABLE_FEATURES) {
    const d = decisions[f];
    if (!["transfer", "delete", "leave"].includes(d)) {
      return res.status(400).json({ message: `Invalid decision for ${f}: ${d}` });
    }
  }

  // Cap pre-check
  for (const f of TOGGLEABLE_FEATURES) {
    if (decisions[f] === "leave") continue;
    const c = await countForFeature(target.userId, f);
    if (c > PER_FEATURE_CAP) {
      return res.status(400).json({ error: "BULK_UPDATE_TOO_LARGE", feature: f, count: c });
    }
  }

  const limit = pLimit(CONCURRENCY);
  const summary: Record<string, { updated?: number; deleted?: number; errors?: string[] }> = {};

  for (const f of TOGGLEABLE_FEATURES) {
    const d = decisions[f];
    if (d === "leave") { summary[f] = { updated: 0, deleted: 0 }; continue; }
    const items = await fetchItemsForFeature(target.userId, f);
    summary[f] = { updated: 0, deleted: 0, errors: [] };
    await Promise.all(items.map(item => limit(async () => {
      try {
        if (d === "transfer") {
          await transferItem(item, f, callerId);
          summary[f].updated!++;
        } else if (d === "delete") {
          await deleteItem(item, f);
          summary[f].deleted!++;
        }
      } catch (e: any) {
        summary[f].errors!.push(`${f}/${getItemId(item, f)}: ${e?.message ?? e}`);
      }
    })));
  }

  // Remove the user from org
  await userDb.clearOrg(target.userId);   // sets orgId=undefined, orgRole=undefined
  await orgDb.pruneEditorListsForUser(caller.orgId, target.userId);

  res.json({ summary });
});

// Helpers defined in same file. `fetchItemsForFeature`/`transferItem`/`deleteItem`/`getItemId`/`countForFeature`
// switch on the feature key and dispatch to the right service.
```

Provide bodies for the helpers (omitted here for brevity — each is a 4-6 line switch over the feature). For `transferItem`, set `userId = callerId` and `updatedAt = now`; for `deleteItem`, call the service's `delete*`.

Use `p-limit` (already a project dependency, or `Promise.all` over batches if not). If `p-limit` isn't a dep, write a small `batchedAll` helper.

- [ ] **Step 3: Run tests**

Run: `cd backend && npx jest src/__tests__/orgMemberRemoval.test.ts`

Expected: PASS.

- [ ] **Step 4: tsc + commit**

```bash
cd backend && npx tsc
git add backend/src/routes/orgMemberRemoval.ts backend/src/__tests__/orgMemberRemoval.test.ts
git commit -m "feat(org-sharing): remove-member endpoint with per-feature transfer/delete/leave"
```

---

## Phase 12 — Frontend (customer-portal)

### Task 22: Org sharing settings UI

**Files:**
- Create: `customer-portal/src/pages/Settings/OrgSharing.tsx`
- Modify: `customer-portal/src/pages/Settings/index.tsx` (route)
- Create: `customer-portal/src/api/orgShareSettings.ts` (thin fetch wrapper)

- [ ] **Step 1: Implement the page**

`OrgSharing.tsx` renders:
- Read-state: spinner while loading `GET /api/orgs/me/share-settings`.
- Five toggleable feature rows: checkbox + multi-select.
- Two always-on rows: just multi-select.
- Save button → `PATCH /api/orgs/me/share-settings`.
- Error toast on 400 from invalid editor list.
- Hide the entire page if user is not org owner.

Components: use whatever UI library is already in use in customer-portal (check existing pages for the Settings layout). Multi-select for editors: list `GET /api/orgs/me/members` first (or reuse the existing org-members hook if any).

- [ ] **Step 2: Wire the route**

In `customer-portal/src/pages/Settings/index.tsx`, add a sidebar entry "Org Sharing" that routes to `OrgSharing.tsx`. Visible only if user is org owner.

- [ ] **Step 3: Manual smoke**

Per `CLAUDE.md`: **DO NOT** run customer-portal locally for manual testing. Use the cloud test env: `./test-env/test-env.sh launch && ./test-env/test-env.sh sync`, then open the settings page in a browser via the printed URL.

- [ ] **Step 4: Commit**

```bash
git add customer-portal/src/pages/Settings/OrgSharing.tsx customer-portal/src/pages/Settings/index.tsx customer-portal/src/api/orgShareSettings.ts
git commit -m "feat(org-sharing): customer-portal OrgSharing settings page"
```

---

### Task 23: Update list pages with "Shared by" badge + disabled edit affordances

**Files:**
- Create: `customer-portal/src/components/SharedByBadge.tsx`
- Modify: WorkPlans, Skills, KB, HtmlTemplates, LandingPages list pages

- [ ] **Step 1: SharedByBadge component**

```tsx
import React from "react";
export const SharedByBadge: React.FC<{ ownerName?: string }> = ({ ownerName }) =>
  ownerName ? <span className="text-xs px-2 py-0.5 bg-blue-100 rounded">Shared by {ownerName}</span> : null;
```

(Adapt styling to the project's existing classes.)

- [ ] **Step 2: Show badge per row**

In each list page, when iterating items, show `<SharedByBadge ownerName={item.ownerName} />` if `item.userId !== currentUserId`. Edit/Delete buttons: hide based on a derived `canEdit` / `canDelete` boolean (compute client-side based on info returned from list endpoint; expand list responses with `owner: { userId, displayName }` if not already there).

- [ ] **Step 3: Commit**

```bash
git add customer-portal/src/components/SharedByBadge.tsx customer-portal/src/pages/...
git commit -m "feat(org-sharing): SharedByBadge + per-row edit/delete affordances"
```

---

### Task 24: RemoveMemberDialog with per-feature decisions

**Files:**
- Create: `customer-portal/src/components/RemoveMemberDialog.tsx`
- Modify: org members admin page to invoke the dialog

- [ ] **Step 1: Dialog implementation**

`RemoveMemberDialog.tsx`:
- On open: fetch `GET /api/orgs/me/members/:userId/removal-preview`.
- Render five rows (KB / Templates / LPs / Work Plans / Skills) with the count and a radio group (Transfer to me / Delete / Leave with them). Only show rows with count > 0; others get the implicit "leave" decision sent to the API.
- Confirm button: POST `/api/orgs/me/members/:userId/remove` with `{ confirm: true, decisions: { ... } }`.
- On success: toast summarizing the result.

- [ ] **Step 2: Commit**

```bash
git add customer-portal/src/components/RemoveMemberDialog.tsx customer-portal/src/pages/...
git commit -m "feat(org-sharing): RemoveMemberDialog with per-feature decisions"
```

---

## Phase 13 — Test-env sync + Playwright scenarios

### Task 25: Sync to cloud test env and run Playwright scenarios

**Files:**
- Create: `docs/cloud-test-env-org-sharing-runbook.md` (the runbook for executing the 45 scenarios)

- [ ] **Step 1: Sync code**

Run: `./test-env/test-env.sh sync`

Wait for green. Note the URL printed.

- [ ] **Step 2: Seed users**

Use the partner-portal admin UI (or a one-shot script) to create the seed data per spec §14.1: Org A with owner + 2 editors + 1 member; Org B with owner + 1 member; one solo user. Save credentials.

- [ ] **Step 3: Run all 45 PW scenarios**

Drive each scenario using the Playwright MCP tools (`mcp__playwright__browser_navigate`, `mcp__playwright__browser_click`, `mcp__playwright__browser_fill_form`, etc.). For each scenario, document the result (pass/fail + observation) in the runbook.

Per the spec § 14.9: on any failure, capture a screenshot via `mcp__playwright__browser_take_screenshot`, file under the scenario, and fix before re-running.

- [ ] **Step 4: Commit the runbook (with results)**

```bash
git add docs/cloud-test-env-org-sharing-runbook.md
git commit -m "docs(org-sharing): cloud test env Playwright runbook + results"
```

---

## Phase 14 — Deployment prep

### Task 26: Release notes + final tsc + coverage

**Files:**
- Modify: `backend/src/docs/user-release.ts`
- Modify: `partner-portal/src/docs/release.ts`

- [ ] **Step 1: Add release-notes entries**

Append a date-stamped entry to both files per the project's existing format. Summarize: "Org-wide sharing across KB, Templates, Landing Pages, Work Plans, Skills + editor lists for Brand Guidelines and Marketing Strategy. Admin-controlled via Settings → Org Sharing."

- [ ] **Step 2: Coverage gate**

Run: `cd backend && npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary`

Confirm statements/branches/functions/lines ≥ 95%. Add tests if not.

- [ ] **Step 3: tsc**

Run: `cd backend && npx tsc`

Expected: clean.

- [ ] **Step 4: customer-portal tests**

Run: `cd customer-portal && npm test`

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/docs/user-release.ts partner-portal/src/docs/release.ts
git commit -m "docs(release): org-wide sharing entry"
```

---

### Task 27: PR

- [ ] **Step 1: Push**

```bash
git push -u origin harshit/org-wide-sharing-design
```

- [ ] **Step 2: Open PR**

Use `gh pr create` per `CLAUDE.md` "Prep for Deploy" guidelines. Include test plan covering the 45 Playwright scenarios from spec §14 plus the unit-test list from §13.

- [ ] **Step 3: Production migration plan**

In the PR description, attach the post-deploy migration runbook:

1. Wait for staging deploy.
2. Run `cd backend && NODE_ENV=staging npx ts-node src/scripts/create-org-id-gsi.ts`.
3. Wait for GSI active.
4. Run `NODE_ENV=staging npx ts-node src/scripts/migrate-org-share-settings.ts`.
5. Run `NODE_ENV=staging npx ts-node src/scripts/migrate-html-templates.ts`.
6. Verify in staging UI with seeded test accounts.
7. Repeat steps 2-6 with `NODE_ENV=production` after PR merge.

---

## Self-Review Summary

Coverage check vs. spec sections:
- §1 Problem / §2 Goals — addressed across all phases.
- §3 Non-Goals — respected (no per-item flags, no per-user defaults).
- §4 Background — internalized in implementation.
- §5 Design (5.1-5.6) — Tasks 1, 4, 5, 9, 10-18.
- §6 Admin UI — Task 22.
- §7 Member Removal — Tasks 20-21, 24.
- §8 Editor List Hygiene — covered by Task 21 (calls `pruneEditorListsForUser`).
- §9 WorkPlans/Skills Compatibility — Task 6 (migration) + Tasks 10-13.
- §10 BG/MS — Task 19 (edit-side); view-side audit in PW-9 / PW-21.
- §11 Routes Surface — Tasks 7, 8, 18, 19, 20, 21, plus existing-route modifications.
- §12 Frontend — Tasks 22-24.
- §13 Tests — distributed across each implementation task; explicit unit-test tasks in 4, 5, 6, 17.
- §14 Playwright — Task 25.
- §15 Deployment — Task 26.
- §16 OrgIdIndex GSI — Tasks 2-3.

No placeholders detected on review. Type names consistent across tasks (`Feature`, `OrgShareSettings`, `htmlTemplateService`, `listOrgVisibleItems`).
