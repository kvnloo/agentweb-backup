# Org-wide Analytics Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organization's members share one analytics configuration (the org owner's, admin-toggled) and share user-journey funnels org-wide as a fan-out resource.

**Architecture:** Two independent phases. **Phase 1** adds an admin-controlled `Organization.shareAnalyticsWithOrg` flag and a single async resolver (`resolveAnalyticsConfig`) that every analytics read path calls — when the flag is on, members inherit the org owner's analytics bundle. **Phase 2** adds `funnels` as the 6th toggleable resource in the existing Organization Sharing framework, with fan-out in `/api/funnels` and org-aware funnel-metrics lookup.

**Tech Stack:** Node.js / TypeScript / Express backend, Jest tests, DynamoDB; React (Vite) partner-portal and customer-portal.

**Spec:** `docs/superpowers/specs/2026-05-21-org-wide-analytics-sharing-design.md`

**Conventions:**
- After every `.ts` edit run `cd backend && npx tsc` — must be clean.
- Backend tests: `cd backend && npm test`.
- TDD for backend logic (test first). Frontend UI follows the repo's existing test strategy — implement, then `npx tsc` / `npm test`.
- Commit messages: **no `Co-Authored-By` / AI-attribution trailer.** One logical change per commit.

---

## File Structure

**Phase 1 — Analytics sharing**
- Create `backend/src/services/analyticsConfigResolver.ts` — the resolver; one responsibility: produce a `ResolvedAnalyticsConfig` for a user.
- Create `backend/src/__tests__/analyticsConfigResolver.test.ts`.
- Create `backend/src/__tests__/admin.analyticsSharing.test.ts`.
- Modify `backend/src/services/db.ts` — add `shareAnalyticsWithOrg` to `Organization`.
- Modify `backend/src/routes/admin.ts` — new analytics-sharing route; `isOrgOwner` in the user payload.
- Modify `backend/src/services/seoService.ts` — fetch functions accept/use the resolver.
- Modify `backend/src/routes/seo.ts` — all GA/Product/funnel call sites use the resolver.
- Modify `backend/src/utils/userConfigContext.ts` — use the resolver.
- Modify `backend/src/routes/auth.ts` — `/me` returns `effectiveAnalyticsConfig`.
- Modify `partner-portal/src/pages/AdminDashboard.tsx` — "Share analytics with organization" checkbox.
- Modify `customer-portal/src/pages/SEO.tsx`, `customer-portal/src/pages/Product.tsx`, `customer-portal/src/contexts/AuthContext.tsx` — gating + indicator.
- Modify `backend/src/docs/user-release.ts` — release notes.

**Phase 2 — Funnel sharing**
- Modify `backend/src/services/db.ts` — `OrgShareSettings.funnels`; `pruneEditorListsForUser`.
- Modify `backend/src/services/orgShareService.ts` — `ToggleableFeature` + `TOGGLEABLE_FEATURES`.
- Modify `backend/src/routes/funnel.ts` — fan-out `GET /`; org-aware item routes.
- Modify `backend/src/routes/seo.ts` — org-aware funnel-metrics lookup.
- Modify `backend/src/routes/orgMemberRemoval.ts` — include `funnels`.
- Create `backend/src/__tests__/funnel.orgSharing.test.ts`, `backend/src/__tests__/pruneEditorLists.funnels.test.ts`.
- Modify `customer-portal/src/components/settings/OrgSharingTab.tsx` — Funnels row.
- Modify `customer-portal/src/pages/SEO.tsx` — "Shared by" badges + read-only.
- Modify `backend/src/docs/user-release.ts` — release notes.

---

# PHASE 1 — Analytics Sharing

## Task 1: Add `shareAnalyticsWithOrg` to the `Organization` type

**Files:**
- Modify: `backend/src/services/db.ts` (the `Organization` interface, near line 560)

- [ ] **Step 1: Add the field**

In the `Organization` interface, immediately after the `shareSettings?: OrgShareSettings;` line, add:

```typescript
  /**
   * Admin-controlled: when true, org members inherit the org owner's analytics
   * configuration (GA4 properties, gaFilteredDomains, productDomain, seoDomains,
   * clarityProjects). Set only by the platform admin via
   * PATCH /api/admin/orgs/:orgId/analytics-sharing. Default: undefined/false.
   */
  shareAnalyticsWithOrg?: boolean;
```

- [ ] **Step 2: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/db.ts
git commit -m "feat(crm): add shareAnalyticsWithOrg field to Organization type"
```

---

## Task 2: Create the `resolveAnalyticsConfig` resolver

**Files:**
- Create: `backend/src/services/analyticsConfigResolver.ts`
- Test: `backend/src/__tests__/analyticsConfigResolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/analyticsConfigResolver.test.ts`:

```typescript
import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";
import { orgDb, userDb } from "../services/db";

jest.mock("../services/db", () => ({
  orgDb: { getOrgById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const ownerUser = {
  userId: "owner-1",
  googleAnalyticsProperties: [{ propertyId: "111", label: "Owner GA" }],
  gaFilteredDomains: ["staging.acme.com"],
  productDomain: "app.acme.com",
  seoDomains: ["acme.com"],
  clarityProjects: [{ projectId: "cl-1", label: "Owner Clarity" }],
};

beforeEach(() => jest.clearAllMocks());

test("member in org with flag ON and owner GA4 → owner bundle, source 'org'", async () => {
  const member = { userId: "m-1", orgId: "org-1", googleAnalyticsProperties: [{ propertyId: "999", label: "Member GA" }] };
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true } as any);
  mockUserDb.getUserById.mockResolvedValue(ownerUser as any);

  const r = await resolveAnalyticsConfig(member);

  expect(r.source).toBe("org");
  expect(r.properties).toEqual([{ propertyId: "111", label: "Owner GA" }]);
  expect(r.primaryPropertyId).toBe("111");
  expect(r.gaFilteredDomains).toEqual(["staging.acme.com"]);
  expect(r.productDomain).toBe("app.acme.com");
  expect(r.seoDomains).toEqual(["acme.com"]);
  expect(r.clarityProjects).toEqual([{ projectId: "cl-1", label: "Owner Clarity" }]);
});

test("member in org with flag OFF → own config, source 'self'", async () => {
  const member = { userId: "m-1", orgId: "org-1", googleAnalyticsProperties: [{ propertyId: "999", label: "Member GA" }] };
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: false } as any);

  const r = await resolveAnalyticsConfig(member);

  expect(r.source).toBe("self");
  expect(r.properties).toEqual([{ propertyId: "999", label: "Member GA" }]);
  expect(mockUserDb.getUserById).not.toHaveBeenCalled();
});

test("user with no org → own config, source 'self'", async () => {
  const solo = { userId: "solo-1", googleAnalyticsPropertyId: "777" };
  const r = await resolveAnalyticsConfig(solo);
  expect(r.source).toBe("self");
  expect(r.properties).toEqual([{ propertyId: "777", label: "Main Property" }]);
  expect(r.primaryPropertyId).toBe("777");
  expect(mockOrgDb.getOrgById).not.toHaveBeenCalled();
});

test("flag ON but owner has no GA4 → defensive fallback to self", async () => {
  const member = { userId: "m-1", orgId: "org-1", googleAnalyticsProperties: [{ propertyId: "999", label: "Member GA" }] };
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true } as any);
  mockUserDb.getUserById.mockResolvedValue({ userId: "owner-1" } as any);

  const r = await resolveAnalyticsConfig(member);

  expect(r.source).toBe("self");
  expect(r.properties).toEqual([{ propertyId: "999", label: "Member GA" }]);
});

test("legacy-only owner (googleAnalyticsPropertyId) normalises into properties", async () => {
  const member = { userId: "m-1", orgId: "org-1" };
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true } as any);
  mockUserDb.getUserById.mockResolvedValue({ userId: "owner-1", googleAnalyticsPropertyId: "555" } as any);

  const r = await resolveAnalyticsConfig(member);

  expect(r.source).toBe("org");
  expect(r.properties).toEqual([{ propertyId: "555", label: "Main Property" }]);
  expect(r.primaryPropertyId).toBe("555");
});

test("org owner with flag ON → own bundle, source 'self' (no indicator for the owner)", async () => {
  const owner = { ...ownerUser, orgId: "org-1" }; // ownerUser.userId === "owner-1"
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true } as any);

  const r = await resolveAnalyticsConfig(owner);

  expect(r.source).toBe("self"); // the owner's own data — drives "no indicator" in the UI
  expect(r.properties).toEqual([{ propertyId: "111", label: "Owner GA" }]);
  expect(mockUserDb.getUserById).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- analyticsConfigResolver`
Expected: FAIL — `Cannot find module '../services/analyticsConfigResolver'`.

- [ ] **Step 3: Create the resolver**

Create `backend/src/services/analyticsConfigResolver.ts`:

```typescript
import { orgDb, userDb } from "./db";

export interface ResolvedAnalyticsConfig {
  properties: Array<{ propertyId: string; label: string }>;
  primaryPropertyId: string | null;
  gaFilteredDomains: string[];
  productDomain?: string;
  seoDomains: string[];
  clarityProjects: Array<{ projectId: string; label: string }>;
  source: "org" | "self";
}

/** Normalise GA4 properties (new array form, falling back to legacy single field). */
function normaliseProperties(u: any): Array<{ propertyId: string; label: string }> {
  if (u?.googleAnalyticsProperties && u.googleAnalyticsProperties.length > 0) {
    return u.googleAnalyticsProperties;
  }
  if (u?.googleAnalyticsPropertyId) {
    return [{ propertyId: u.googleAnalyticsPropertyId, label: "Main Property" }];
  }
  return [];
}

/** Normalise Clarity projects (new array form, falling back to legacy single field). */
function normaliseClarity(u: any): Array<{ projectId: string; label: string }> {
  if (u?.clarityProjects && u.clarityProjects.length > 0) return u.clarityProjects;
  if (u?.clarityProjectId) return [{ projectId: u.clarityProjectId, label: "Main Project" }];
  return [];
}

function buildBundle(u: any, source: "org" | "self"): ResolvedAnalyticsConfig {
  const properties = normaliseProperties(u);
  return {
    properties,
    primaryPropertyId: properties[0]?.propertyId ?? null,
    gaFilteredDomains: u?.gaFilteredDomains ?? [],
    productDomain: u?.productDomain,
    seoDomains: u?.seoDomains ?? [],
    clarityProjects: normaliseClarity(u),
    source,
  };
}

/**
 * Resolve the analytics configuration that should drive every analytics surface
 * for `user`. When the user is in an org whose owner has shared analytics AND
 * the owner has at least one GA4 property, the org owner's bundle is returned
 * (`source: 'org'`). Otherwise the user's own bundle is returned (`source: 'self'`).
 */
export async function resolveAnalyticsConfig(user: any): Promise<ResolvedAnalyticsConfig> {
  if (user?.orgId) {
    const org = await orgDb.getOrgById(user.orgId);
    if (org?.shareAnalyticsWithOrg === true && org.ownerUserId) {
      const owner =
        org.ownerUserId === user.userId ? user : await userDb.getUserById(org.ownerUserId);
      if (owner && normaliseProperties(owner).length > 0) {
        // The org owner viewing their own shared config is still "self" — the
        // "Showing organization analytics" indicator is for members only.
        const src = org.ownerUserId === user.userId ? "self" : "org";
        return buildBundle(owner, src);
      }
    }
  }
  return buildBundle(user, "self");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npm test -- analyticsConfigResolver`
Expected: PASS — 6 tests.

- [ ] **Step 5: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/analyticsConfigResolver.ts backend/src/__tests__/analyticsConfigResolver.test.ts
git commit -m "feat(crm): add resolveAnalyticsConfig org-aware analytics resolver"
```

---

## Task 3: Admin route — `PATCH /api/admin/orgs/:orgId/analytics-sharing`

**Files:**
- Modify: `backend/src/routes/admin.ts`
- Test: `backend/src/__tests__/admin.analyticsSharing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/admin.analyticsSharing.test.ts`. Model the supertest/app harness on an existing admin route test (e.g. `backend/src/__tests__/admin.chatSessions.test.ts`) — mirror its imports, app setup, and admin-token helper. The behaviours to assert:

```typescript
// Mirror the harness of admin.chatSessions.test.ts (app, mocks, admin JWT helper).
// Then assert:

test("non-admin caller → 403", async () => {
  const res = await request(app)
    .patch("/api/admin/orgs/org-1/analytics-sharing")
    .set("Authorization", `Bearer ${nonAdminToken}`)
    .send({ enabled: true });
  expect(res.status).toBe(403);
});

test("unknown org → 404", async () => {
  mockOrgDb.getOrgById.mockResolvedValue(null);
  const res = await request(app)
    .patch("/api/admin/orgs/does-not-exist/analytics-sharing")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ enabled: true });
  expect(res.status).toBe(404);
});

test("admin enables → 200 and persists the flag", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "o-1" } as any);
  mockOrgDb.updateOrg.mockResolvedValue({ orgId: "org-1", shareAnalyticsWithOrg: true } as any);
  const res = await request(app)
    .patch("/api/admin/orgs/org-1/analytics-sharing")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ enabled: true });
  expect(res.status).toBe(200);
  expect(mockOrgDb.updateOrg).toHaveBeenCalledWith("org-1", { shareAnalyticsWithOrg: true });
});

test("missing/invalid body.enabled → 400", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "o-1" } as any);
  const res = await request(app)
    .patch("/api/admin/orgs/org-1/analytics-sharing")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({});
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- admin.analyticsSharing`
Expected: FAIL — route returns 404 (Express default) for all cases.

- [ ] **Step 3: Add the route**

In `backend/src/routes/admin.ts`, add this route handler (place it near the other `router.*("/orgs..."` or org-related handlers; `admin.ts` already applies admin authentication to the whole router). `orgDb` is already imported at `admin.ts:7`.

```typescript
// ─── Org analytics sharing (admin-controlled) ────────────────────────────
// PATCH /api/admin/orgs/:orgId/analytics-sharing  { enabled: boolean }
router.patch("/orgs/:orgId/analytics-sharing", async (req, res) => {
  try {
    const { orgId } = req.params;
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ message: "Body field 'enabled' must be a boolean" });
    }
    const org = await orgDb.getOrgById(orgId);
    if (!org) {
      return res.status(404).json({ message: "Organization not found" });
    }
    await orgDb.updateOrg(orgId, { shareAnalyticsWithOrg: enabled });
    return res.json({ orgId, shareAnalyticsWithOrg: enabled });
  } catch (error: any) {
    console.error("Error updating org analytics-sharing:", error.message);
    return res.status(500).json({ message: "Failed to update analytics sharing" });
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npm test -- admin.analyticsSharing`
Expected: PASS — 4 tests.

- [ ] **Step 5: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/admin.ts backend/src/__tests__/admin.analyticsSharing.test.ts
git commit -m "feat(crm): add admin route to toggle org analytics sharing"
```

---

## Task 4: Add `isOrgOwner` and `orgShareAnalyticsWithOrg` to the admin user-list payload

**Files:**
- Modify: `backend/src/routes/admin.ts` (the user-list handler, lines ~521-535)
- Test: `backend/src/__tests__/admin.analyticsSharing.test.ts` (add to the existing file)

The user-list handler currently builds an `orgMap` of `orgId → name` and stamps `user.orgName`. It must also stamp `user.isOrgOwner` **and** `user.orgShareAnalyticsWithOrg`. The latter is required so the partner-portal checkbox (Task 9) is initialised from persisted state — without it, saving the SEO dialog would silently disable analytics sharing.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/__tests__/admin.analyticsSharing.test.ts` a test that calls the admin user-list endpoint and asserts a user whose `userId === org.ownerUserId` comes back with `isOrgOwner: true`, and a non-owner member with `isOrgOwner: false`. Mock `orgDb.getOrgById` to return `{ orgId, name, ownerUserId }`.

```typescript
test("user-list payload stamps isOrgOwner", async () => {
  // two users in org-1: owner u-owner, member u-member
  mockUserDb.getAllUsers.mockResolvedValue([
    { userId: "u-owner", email: "o@x.com", orgId: "org-1" },
    { userId: "u-member", email: "m@x.com", orgId: "org-1" },
  ] as any);
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", name: "Acme", ownerUserId: "u-owner", shareAnalyticsWithOrg: true } as any);

  const res = await request(app)
    .get("/api/admin/users")
    .set("Authorization", `Bearer ${adminToken}`);

  const owner = res.body.find((u: any) => u.userId === "u-owner");
  const member = res.body.find((u: any) => u.userId === "u-member");
  expect(owner.isOrgOwner).toBe(true);
  expect(member.isOrgOwner).toBe(false);
  expect(owner.orgShareAnalyticsWithOrg).toBe(true);
  expect(member.orgShareAnalyticsWithOrg).toBe(true);
});
```

(Adjust `mockUserDb.getAllUsers` / the endpoint path to match the actual user-list method and route used in `admin.ts` — confirm by reading the handler around line 500-540.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- admin.analyticsSharing`
Expected: FAIL — `isOrgOwner` is `undefined`.

- [ ] **Step 3: Modify the user-list handler**

In `backend/src/routes/admin.ts`, the batch-org-fetch block currently reads (lines ~521-534):

```typescript
    // Batch-fetch org names for users who belong to an org
    const orgIds = [...new Set(sanitized.filter((u: any) => u.orgId).map((u: any) => u.orgId as string))];
    const orgMap: Record<string, string> = {};
    await Promise.all(
      orgIds.map(async (orgId) => {
        const org = await orgDb.getOrgById(orgId).catch(() => null);
        if (org) orgMap[orgId] = org.name;
      })
    );
    for (const user of sanitized) {
      if (user.orgId && orgMap[user.orgId]) {
        user.orgName = orgMap[user.orgId];
      }
    }
```

Replace it with (carry `ownerUserId` + `shareAnalyticsWithOrg`, and stamp `isOrgOwner` + `orgShareAnalyticsWithOrg`):

```typescript
    // Batch-fetch org name + owner + analytics-sharing flag for users in an org
    const orgIds = [...new Set(sanitized.filter((u: any) => u.orgId).map((u: any) => u.orgId as string))];
    const orgMap: Record<string, { name: string; ownerUserId: string; shareAnalyticsWithOrg: boolean }> = {};
    await Promise.all(
      orgIds.map(async (orgId) => {
        const org = await orgDb.getOrgById(orgId).catch(() => null);
        if (org) orgMap[orgId] = {
          name: org.name,
          ownerUserId: org.ownerUserId,
          shareAnalyticsWithOrg: !!org.shareAnalyticsWithOrg,
        };
      })
    );
    for (const user of sanitized) {
      const orgInfo = user.orgId ? orgMap[user.orgId] : undefined;
      if (orgInfo) {
        user.orgName = orgInfo.name;
        user.isOrgOwner = orgInfo.ownerUserId === user.userId;
        user.orgShareAnalyticsWithOrg = orgInfo.shareAnalyticsWithOrg;
      }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npm test -- admin.analyticsSharing`
Expected: PASS.

- [ ] **Step 5: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/admin.ts backend/src/__tests__/admin.analyticsSharing.test.ts
git commit -m "feat(crm): expose isOrgOwner and org analytics-sharing flag on admin user-list"
```

---

## Task 5: Route the resolver into `seoService.ts` fetch functions

This makes the agent-mode analytics tools org-aware automatically (they call these functions). Each function gains an optional `resolvedConfig` parameter; when absent it resolves internally.

**Files:**
- Modify: `backend/src/services/seoService.ts`
- Test: `backend/src/__tests__/seoService.orgAnalytics.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/seoService.orgAnalytics.test.ts`:

```typescript
import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";

jest.mock("../services/analyticsConfigResolver");
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn().mockResolvedValue({ userId: "m-1", orgId: "org-1" }) },
}));

const mockResolve = resolveAnalyticsConfig as jest.MockedFunction<typeof resolveAnalyticsConfig>;

test("fetchGoogleAnalyticsMetrics uses resolver output, not raw user fields", async () => {
  mockResolve.mockResolvedValue({
    properties: [{ propertyId: "OWNER-PROP", label: "Owner" }],
    primaryPropertyId: "OWNER-PROP",
    gaFilteredDomains: [],
    seoDomains: [],
    clarityProjects: [],
    source: "org",
  });
  const { fetchGoogleAnalyticsMetrics } = await import("../services/seoService");
  const result = await fetchGoogleAnalyticsMetrics("m-1", "30d");
  // With no GA client configured in tests, it returns an error object — the
  // point is it resolved OWNER-PROP rather than skipping as "not configured".
  expect(mockResolve).toHaveBeenCalled();
  expect(result.message).not.toMatch(/not configured/i);
});

test("fetchClarityProjectInfo with empty resolved clarity → not-configured message", async () => {
  mockResolve.mockResolvedValue({
    properties: [], primaryPropertyId: null, gaFilteredDomains: [],
    seoDomains: [], clarityProjects: [], source: "self",
  });
  const { fetchClarityProjectInfo } = await import("../services/seoService");
  const result = await fetchClarityProjectInfo("m-1");
  expect(result.message).toMatch(/Microsoft Clarity is not configured/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- seoService.orgAnalytics`
Expected: FAIL — the functions still read raw `user.*` and never call `resolveAnalyticsConfig`.

- [ ] **Step 3: Modify `fetchGoogleAnalyticsMetrics`**

In `backend/src/services/seoService.ts`, add the import at the top:

```typescript
import { resolveAnalyticsConfig, ResolvedAnalyticsConfig } from "./analyticsConfigResolver";
```

Change the signature and the property/filter resolution. The function starts at line 469:

```typescript
export async function fetchGoogleAnalyticsMetrics(userId: string, timeframe: string = "30d", filterPropertyId?: string): Promise<any> {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return { error: "User not found" };
  }

  const gaProperties = getGoogleAnalyticsProperties(user);
```

Replace those lines with:

```typescript
export async function fetchGoogleAnalyticsMetrics(userId: string, timeframe: string = "30d", filterPropertyId?: string, resolvedConfig?: ResolvedAnalyticsConfig): Promise<any> {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return { error: "User not found" };
  }

  const resolved = resolvedConfig ?? (await resolveAnalyticsConfig(user));
  const gaProperties = resolved.properties;
```

Then, in the dimension-filter block (lines 497-516), replace `user.gaFilteredDomains` with `resolved.gaFilteredDomains`:

```typescript
  let dimensionFilter: any = undefined;
  if (resolved.gaFilteredDomains && resolved.gaFilteredDomains.length > 0) {
    const notExpressions = resolved.gaFilteredDomains.map((domain: string) => ({
```

- [ ] **Step 4: Modify `fetchSearchConsoleMetrics`**

The function starts at line 184. Change the signature and the `seoDomains` source:

```typescript
export async function fetchSearchConsoleMetrics(userId: string, timeframe: string = "30d", filterDomain?: string, resolvedConfig?: ResolvedAnalyticsConfig): Promise<any> {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return { error: "User not found" };
  }

  const resolved = resolvedConfig ?? (await resolveAnalyticsConfig(user));
  if (!resolved.seoDomains || resolved.seoDomains.length === 0) {
    return { message: "Google Search Console is not configured. Use the search_user_guide tool to find setup instructions and share them with the user." };
  }
```

Then in the body replace every later `user.seoDomains` with `resolved.seoDomains` (the `domainsToFetch` assignment at line 202, the error message at 206, and `configured_domains` at line 218).

- [ ] **Step 5: Modify `fetchClarityProjectInfo`**

The function starts at line 406. Change the signature and the clarity source:

```typescript
export async function fetchClarityProjectInfo(userId: string, filterProjectId?: string, resolvedConfig?: ResolvedAnalyticsConfig): Promise<any> {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return { error: "User not found" };
  }

  const resolved = resolvedConfig ?? (await resolveAnalyticsConfig(user));
  const clarityProjects = resolved.clarityProjects;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && npm test -- seoService.orgAnalytics`
Expected: PASS.

- [ ] **Step 7: Verify compilation and full suite**

Run: `cd backend && npx tsc && npm test -- seoService`
Expected: tsc clean; existing `seoService` tests still pass (update any that broke because they relied on raw `user.seoDomains` — they should mock `resolveAnalyticsConfig` or pass a `resolvedConfig`).

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/seoService.ts backend/src/__tests__/seoService.orgAnalytics.test.ts
git commit -m "feat(crm): route seoService analytics fetchers through the resolver"
```

---

## Task 6: Route the resolver into `seo.ts` call sites

**Files:**
- Modify: `backend/src/routes/seo.ts`
- Test: `backend/src/__tests__/seo.orgAnalytics.test.ts` (create)

This task touches four call sites in `seo.ts`: the configured-gate (line 34), the main GA path (lines 339 + 386), the funnel-metrics property (lines 682/725), and the Product-metrics handler (lines 938/977).

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/seo.orgAnalytics.test.ts`. Model the harness on an existing `seo`/route test if present, otherwise on `admin.chatSessions.test.ts`. Mock `resolveAnalyticsConfig`. Assert:
- `GET /api/seo/metrics` for a member with no own config but `resolved.properties` non-empty does **not** return the 400 "No SEO domains or Google Analytics Property ID configured".
- `GET /api/seo/product-metrics` for a member with `resolved.primaryPropertyId` + `resolved.productDomain` set does **not** return the 400 "Product domain or Google Analytics Property ID not configured".

```typescript
test("GET /metrics: member inherits org analytics — no not-configured 400", async () => {
  mockResolve.mockResolvedValue({
    properties: [{ propertyId: "OWNER-PROP", label: "Owner" }],
    primaryPropertyId: "OWNER-PROP", gaFilteredDomains: [],
    seoDomains: ["acme.com"], clarityProjects: [], source: "org",
  });
  const res = await request(app).get("/api/seo/metrics").set("Authorization", `Bearer ${memberToken}`);
  expect(res.status).not.toBe(400);
});

test("GET /product-metrics: member inherits org productDomain — no not-configured 400", async () => {
  mockResolve.mockResolvedValue({
    properties: [{ propertyId: "OWNER-PROP", label: "Owner" }],
    primaryPropertyId: "OWNER-PROP", gaFilteredDomains: [],
    productDomain: "app.acme.com", seoDomains: [], clarityProjects: [], source: "org",
  });
  const res = await request(app).get("/api/seo/product-metrics").set("Authorization", `Bearer ${memberToken}`);
  expect(res.status).not.toBe(400);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- seo.orgAnalytics`
Expected: FAIL — both routes return 400 because they still read raw `user.*`.

- [ ] **Step 3: Add the import**

At the top of `backend/src/routes/seo.ts`, add:

```typescript
import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";
```

- [ ] **Step 4: Fix the configured-gate (`/metrics` handler, line ~25-37)**

After `const user = await userDb.getUserById(userId);` and its null-check, add a resolver call, then change the gate. Replace lines 30-38:

```typescript
  // Check if user has SEO domains or GA Property ID configured.
  const domainFilterParam = (req.query.domain as string) || null;
  if ((!user.seoDomains || user.seoDomains.length === 0) && !user.googleAnalyticsPropertyId && !domainFilterParam) {
    return res.status(400).json({
      message: "No SEO domains or Google Analytics Property ID configured. Please configure SEO/AEO settings in the admin panel."
    });
  }
```

with:

```typescript
  // Resolve the effective analytics config (org owner's when org sharing is on).
  const resolved = await resolveAnalyticsConfig(user);

  // Check if effective config has SEO domains or a GA property configured.
  const domainFilterParam = (req.query.domain as string) || null;
  if (resolved.properties.length === 0 && resolved.seoDomains.length === 0 && !domainFilterParam) {
    return res.status(400).json({
      message: "No SEO domains or Google Analytics Property ID configured. Please configure SEO/AEO settings in the admin panel."
    });
  }
```

- [ ] **Step 5: Fix the main GA path (line 339) and `gaFilteredDomains` (line 386)**

Line 339 — replace:

```typescript
  let gaProperties = getGoogleAnalyticsProperties(user);
```

with (reuse the `resolved` from Step 4):

```typescript
  let gaProperties = resolved.properties;
```

Line 386 — replace `if (user.gaFilteredDomains && user.gaFilteredDomains.length > 0) {` and the `.map` over `user.gaFilteredDomains` with `resolved.gaFilteredDomains`:

```typescript
          if (resolved.gaFilteredDomains && resolved.gaFilteredDomains.length > 0) {
            filterExpressions.push(
              ...resolved.gaFilteredDomains.map((domain: string) => ({
```

- [ ] **Step 6: Fix the funnel-metrics property (lines 682, 725)**

Line 682 — replace `if (user.googleAnalyticsPropertyId && funnelId) {` with:

```typescript
  if (resolved.primaryPropertyId && funnelId) {
```

Line 725 — replace `user.googleAnalyticsPropertyId,` (the argument to `calculateFunnelMetrics`) with:

```typescript
            resolved.primaryPropertyId,
```

(The funnel *lookup* — `funnels_${userId}` — stays viewer-only here; Phase 2 Task 15 makes it org-aware.)

- [ ] **Step 7: Fix the Product-metrics handler (lines 938, 977)**

In the `/product-metrics` handler, after `const user = await userDb.getUserById(userId);` and its null-check, add:

```typescript
      const resolved = await resolveAnalyticsConfig(user);
```

Replace the gate at line 938:

```typescript
      if (!user.productDomain || !user.googleAnalyticsPropertyId) {
```

with:

```typescript
      if (!resolved.productDomain || !resolved.primaryPropertyId) {
```

Replace line 977 `const propertyId = user.googleAnalyticsPropertyId;` with:

```typescript
      const propertyId = resolved.primaryPropertyId;
```

Also, anywhere in this handler that uses `user.productDomain` as a hostname filter value (the spec lists lines 995, 1048, 1112, 1232 — confirm by reading the handler), replace with `resolved.productDomain`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd backend && npm test -- seo.orgAnalytics`
Expected: PASS.

- [ ] **Step 9: Verify compilation and existing seo tests**

Run: `cd backend && npx tsc && npm test -- seo`
Expected: tsc clean; existing seo tests pass (fix any that mocked raw `user` fields).

- [ ] **Step 10: Commit**

```bash
git add backend/src/routes/seo.ts backend/src/__tests__/seo.orgAnalytics.test.ts
git commit -m "feat(crm): route seo.ts GA/Product/funnel paths through analytics resolver"
```

---

## Task 7: Route the resolver into `userConfigContext.ts`

**Files:**
- Modify: `backend/src/utils/userConfigContext.ts`

`userConfigContext.ts` builds the agent-mode config-context string and currently reads `user.googleAnalyticsProperties` / `user.gaFilteredDomains` directly.

- [ ] **Step 1: Read the current file**

Read `backend/src/utils/userConfigContext.ts` fully. Note whether the context-builder function is sync and who calls it (`grep -rn "userConfigContext\|buildUserConfigContext" backend/src --include=*.ts`).

- [ ] **Step 2: Make the GA section resolver-driven**

Convert the builder function to `async` (or add an `async` variant) and replace the GA-related reads:

```typescript
import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";

// inside the builder, before composing the GA lines:
const resolved = await resolveAnalyticsConfig(user);
if (resolved.properties.length > 0) {
  for (const prop of resolved.properties) {
    // ...existing line composition, using prop.propertyId / prop.label...
  }
}
if (resolved.gaFilteredDomains.length > 0) {
  lines.push(`- Filtered domains (excluded from GA4): ${resolved.gaFilteredDomains.join(", ")}`);
}
```

Update every caller to `await` the now-async builder.

- [ ] **Step 3: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors (all callers updated to `await`).

- [ ] **Step 4: Run any affected tests**

Run: `cd backend && npm test -- userConfigContext`
Expected: PASS (update mocks to stub `resolveAnalyticsConfig` if the test exists).

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/userConfigContext.ts
git commit -m "feat(crm): make agent-mode config context analytics-resolver aware"
```

---

## Task 8: Add `effectiveAnalyticsConfig` to `/api/auth/me`

**Files:**
- Modify: `backend/src/routes/auth.ts` (the `/me` handler, lines 44-159)
- Test: `backend/src/__tests__/auth.effectiveAnalytics.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/auth.effectiveAnalytics.test.ts`. Mock `resolveAnalyticsConfig`; assert `GET /api/auth/me` includes `effectiveAnalyticsConfig` with the resolver's output.

```typescript
test("/me includes effectiveAnalyticsConfig", async () => {
  mockResolve.mockResolvedValue({
    properties: [{ propertyId: "P1", label: "L1" }],
    primaryPropertyId: "P1", gaFilteredDomains: [],
    seoDomains: [], clarityProjects: [], source: "org",
  });
  const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${userToken}`);
  expect(res.status).toBe(200);
  expect(res.body.effectiveAnalyticsConfig).toEqual(
    expect.objectContaining({ source: "org", primaryPropertyId: "P1" })
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- auth.effectiveAnalytics`
Expected: FAIL — `effectiveAnalyticsConfig` is `undefined`.

- [ ] **Step 3: Modify the `/me` handler**

In `backend/src/routes/auth.ts`, add the import:

```typescript
import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";
```

In the `/me` handler, immediately before `res.json(response);` (line 154), add:

```typescript
    // Effective analytics config — drives customer-portal SEO/Product gating.
    try {
      response.effectiveAnalyticsConfig = await resolveAnalyticsConfig(user);
    } catch (e: any) {
      console.error("Error resolving analytics config for /me:", e.message);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npm test -- auth.effectiveAnalytics`
Expected: PASS.

- [ ] **Step 5: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/auth.ts backend/src/__tests__/auth.effectiveAnalytics.test.ts
git commit -m "feat(crm): expose effectiveAnalyticsConfig on /api/auth/me"
```

---

## Task 9: Partner-portal — "Share analytics with organization" checkbox

**Files:**
- Modify: `partner-portal/src/pages/AdminDashboard.tsx`

The checkbox lives in the existing per-user SEO/analytics dialog and is shown only when the edited user `isOrgOwner`. On save it calls `PATCH /api/admin/orgs/:orgId/analytics-sharing`.

- [ ] **Step 1: Add state**

Next to the GA state declarations (lines 841-842), add:

```typescript
const [shareAnalyticsWithOrg, setShareAnalyticsWithOrg] = useState(false);
const [editingUserIsOrgOwner, setEditingUserIsOrgOwner] = useState(false);
const [editingUserOrgId, setEditingUserOrgId] = useState<string | null>(null);
```

- [ ] **Step 2: Seed state when the dialog opens**

In the edit-button `onClick` at line 4398, append to the existing setters:

```typescript
setEditingUserIsOrgOwner(!!user.isOrgOwner);
setEditingUserOrgId(user.orgId || null);
setShareAnalyticsWithOrg(!!user.orgShareAnalyticsWithOrg);
```

`user.orgShareAnalyticsWithOrg` is supplied by the admin user-list payload (Task 4). **Seeding the checkbox from persisted state is required, not optional:** the save handler (Step 4) PATCHes the flag on every save of an org owner's dialog, so a checkbox left at a stale `false` would silently turn analytics sharing **off** the next time an admin edits that owner's SEO settings for any reason.

- [ ] **Step 3: Render the checkbox in the dialog**

In the SEO/analytics dialog JSX, immediately before the "Google Analytics 4 Properties" `<Grid item xs={12}>` block (line 6948), add:

```tsx
            {editingUserIsOrgOwner && (
              <Grid item xs={12}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={shareAnalyticsWithOrg}
                      onChange={(e) => setShareAnalyticsWithOrg(e.target.checked)}
                      disabled={seoDomainsEditLoading}
                    />
                  }
                  label="Share analytics with organization"
                />
                <Typography variant="caption" display="block" sx={{ color: 'text.secondary' }}>
                  When on, every member of this org sees this owner's analytics
                  (GA4, Search Console, Clarity, funnels run against this property).
                </Typography>
              </Grid>
            )}
```

Ensure `FormControlLabel` and `Checkbox` are imported from `@mui/material` at the top of the file (add them to the existing MUI import if missing).

- [ ] **Step 4: Persist the flag on save**

In the save handler (around line 2666, right after the `axios.put(... /seo-aeo ...)` call succeeds), add a second call when the edited user is an org owner:

```typescript
      if (editingUserIsOrgOwner && editingUserOrgId) {
        await axios.patch(
          buildApiUrl(`/api/admin/orgs/${editingUserOrgId}/analytics-sharing`),
          { enabled: shareAnalyticsWithOrg },
          { headers: { Authorization: `Bearer ${token}` } }
        );
      }
```

- [ ] **Step 5: Verify build**

Run: `cd partner-portal && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add partner-portal/src/pages/AdminDashboard.tsx
git commit -m "feat(crm): add Share-analytics-with-organization checkbox to admin SEO dialog"
```

---

## Task 10: Customer-portal — gating + "Showing organization analytics" indicator

**Files:**
- Modify: `customer-portal/src/contexts/AuthContext.tsx` (add the type)
- Modify: `customer-portal/src/pages/SEO.tsx`
- Modify: `customer-portal/src/pages/Product.tsx`

- [ ] **Step 1: Add `effectiveAnalyticsConfig` to the `User` type**

In `customer-portal/src/contexts/AuthContext.tsx`, inside the `User` interface (lines 26-76), add:

```typescript
  effectiveAnalyticsConfig?: {
    properties: Array<{ propertyId: string; label: string }>;
    primaryPropertyId: string | null;
    gaFilteredDomains: string[];
    productDomain?: string;
    seoDomains: string[];
    clarityProjects: Array<{ projectId: string; label: string }>;
    source: "org" | "self";
  };
```

- [ ] **Step 2: Update `SEO.tsx` gating**

In `customer-portal/src/pages/SEO.tsx`, replace the `isSeoConfigured` computation (lines 311-314):

```typescript
  const isSeoConfigured = !!(
    user &&
    ((user.seoDomains && user.seoDomains.length > 0) || user.googleAnalyticsPropertyId)
  );
```

with (prefer the effective config; fall back to legacy fields for safety):

```typescript
  const eac = user?.effectiveAnalyticsConfig;
  const isSeoConfigured = !!(
    user &&
    (
      (eac && (eac.properties.length > 0 || eac.seoDomains.length > 0)) ||
      (user.seoDomains && user.seoDomains.length > 0) ||
      user.googleAnalyticsPropertyId
    )
  );
  const showingOrgAnalytics = eac?.source === "org";
```

- [ ] **Step 3: Add the indicator to `SEO.tsx`**

In the Google Analytics Metrics header block (line ~1544, beside `<h2 className="text-2xl font-semibold">Google Analytics Metrics</h2>`), add:

```tsx
            {showingOrgAnalytics && (
              <span className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-700 border border-blue-200">
                Showing organization analytics
              </span>
            )}
```

- [ ] **Step 4: Update `Product.tsx` gating**

In `customer-portal/src/pages/Product.tsx`, replace line 95:

```typescript
const isConfigured = !!(user?.productDomain && user?.googleAnalyticsPropertyId);
```

with:

```typescript
const eac = user?.effectiveAnalyticsConfig;
const isConfigured = !!(
  (eac && eac.productDomain && eac.primaryPropertyId) ||
  (user?.productDomain && user?.googleAnalyticsPropertyId)
);
```

- [ ] **Step 5: Verify build and tests**

Run: `cd customer-portal && npx tsc && npm test -- SEO`
Expected: tsc clean; SEO tests pass (update snapshots/expectations if the indicator changed rendered output).

- [ ] **Step 6: Commit**

```bash
git add customer-portal/src/contexts/AuthContext.tsx customer-portal/src/pages/SEO.tsx customer-portal/src/pages/Product.tsx
git commit -m "feat(crm): gate customer-portal analytics pages on effectiveAnalyticsConfig"
```

---

## Task 11: Phase 1 release notes

**Files:**
- Modify: `backend/src/docs/user-release.ts`

- [ ] **Step 1: Add an entry**

Follow the existing format in `backend/src/docs/user-release.ts` (newest first). Add an entry dated `2026-05-21`:

> **Organization-wide analytics** — Admins can now share an organization's analytics (Google Analytics, Search Console, Microsoft Clarity) with every member from the owner's configuration, so the whole team sees the same numbers.

- [ ] **Step 2: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/docs/user-release.ts
git commit -m "docs(crm): release note for org-wide analytics sharing"
```

---

# PHASE 2 — Funnel Sharing

## Task 12: Add `funnels` to the org-sharing framework

**Files:**
- Modify: `backend/src/services/db.ts` (`OrgShareSettings` interface; `pruneEditorListsForUser`)
- Modify: `backend/src/services/orgShareService.ts` (`ToggleableFeature`; `TOGGLEABLE_FEATURES`)
- Test: `backend/src/__tests__/pruneEditorLists.funnels.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/pruneEditorLists.funnels.test.ts`. Model AWS mocking on an existing `db`/`orgDb` test (e.g. `orgDb.shareSettings.test.ts`). Assert that `orgDb.pruneEditorListsForUser` removes a userId from `shareSettings.funnels.editors`:

```typescript
test("pruneEditorListsForUser strips the removed user from funnels.editors", async () => {
  // Arrange: org with shareSettings.funnels.editors = ["keep-me", "remove-me"]
  // (mock dynamodb.get to return that org; capture dynamodb.update input)
  // Act: await orgDb.pruneEditorListsForUser("org-1", "remove-me");
  // Assert: the persisted shareSettings.funnels.editors === ["keep-me"]
  expect(persistedSettings.funnels.editors).toEqual(["keep-me"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- pruneEditorLists.funnels`
Expected: FAIL — `funnels` is `undefined` on the rebuilt settings (TypeScript will also flag it once Step 3 lands; before that the test fails at runtime).

- [ ] **Step 3: Add `funnels` to `OrgShareSettings`**

In `backend/src/services/db.ts`, the `OrgShareSettings` interface — add the `funnels` line after `skills`:

```typescript
export interface OrgShareSettings {
  knowledgeBase: { enabled: boolean; editors: string[] };
  htmlTemplates: { enabled: boolean; editors: string[] };
  landingPages: { enabled: boolean; editors: string[] };
  workPlans: { enabled: boolean; editors: string[] };
  skills: { enabled: boolean; editors: string[] };
  funnels: { enabled: boolean; editors: string[] };
  // Always shared with org—only editors are configurable, enabled is implicit
  brandGuidelines: { editors: string[] };
  marketingStrategy: { editors: string[] };
}
```

- [ ] **Step 4: Add `funnels` to `pruneEditorListsForUser`**

In `backend/src/services/db.ts`, the `pruneEditorListsForUser` `next` object — add the `funnels` line after `skills`:

```typescript
    const next: OrgShareSettings = {
      knowledgeBase:     { ...ss.knowledgeBase,     editors: strip(ss.knowledgeBase.editors) },
      htmlTemplates:     { ...ss.htmlTemplates,     editors: strip(ss.htmlTemplates.editors) },
      landingPages:      { ...ss.landingPages,      editors: strip(ss.landingPages.editors) },
      workPlans:         { ...ss.workPlans,         editors: strip(ss.workPlans.editors) },
      skills:            { ...ss.skills,            editors: strip(ss.skills.editors) },
      funnels:           { ...(ss.funnels ?? { enabled: false, editors: [] }), editors: strip((ss.funnels?.editors) ?? []) },
      brandGuidelines:   { editors: strip(ss.brandGuidelines.editors) },
      marketingStrategy: { editors: strip(ss.marketingStrategy.editors) },
    };
```

(The `?? { enabled: false, editors: [] }` guards orgs whose stored `shareSettings` predate this field.)

- [ ] **Step 5: Add `funnels` to the feature registry and the migration defaults**

In `backend/src/services/orgShareService.ts`, extend the `ToggleableFeature` union (line 3-4):

```typescript
export type ToggleableFeature =
  | "knowledgeBase" | "htmlTemplates" | "landingPages" | "workPlans" | "skills" | "funnels";
```

and the `TOGGLEABLE_FEATURES` array (line 86-88):

```typescript
export const TOGGLEABLE_FEATURES: ReadonlyArray<ToggleableFeature> = [
  "knowledgeBase", "htmlTemplates", "landingPages", "workPlans", "skills", "funnels",
];
```

`migrate-org-share-settings.ts` is the **only** other place a full `OrgShareSettings` is constructed (confirmed by grep — `pruneEditorListsForUser` is the other and is handled in Step 4). Its `defaults: OrgShareSettings` literal must gain `funnels`, or `npx tsc` will fail on a missing required field. Update `backend/src/scripts/migrate-org-share-settings.ts`:

```typescript
const defaults: OrgShareSettings = {
  knowledgeBase:     { enabled: false, editors: [] },
  htmlTemplates:     { enabled: false, editors: [] },
  landingPages:      { enabled: false, editors: [] },
  workPlans:         { enabled: true,  editors: [] },
  skills:            { enabled: true,  editors: [] },
  funnels:           { enabled: false, editors: [] },
  brandGuidelines:   { editors: [] },
  marketingStrategy: { editors: [] },
};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && npm test -- pruneEditorLists.funnels`
Expected: PASS.

- [ ] **Step 7: Verify compilation and the org-share suite**

Run: `cd backend && npx tsc && npm test -- orgShare`
Expected: tsc clean. **Note:** `orgShareSettings.ts` `validateSettings` iterates `TOGGLEABLE_FEATURES`, so the PATCH now *requires* `funnels` in the body — any test that PATCHes share-settings with a hand-built object must add `funnels: { enabled: false, editors: [] }`. Fix those tests here.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/db.ts backend/src/services/orgShareService.ts backend/src/scripts/migrate-org-share-settings.ts backend/src/__tests__/pruneEditorLists.funnels.test.ts
git commit -m "feat(crm): register funnels as a toggleable org-shared resource"
```

---

## Task 13: `GET /api/funnels` — fan-out across org members

**Files:**
- Modify: `backend/src/routes/funnel.ts`
- Test: `backend/src/__tests__/funnel.orgSharing.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/funnel.orgSharing.test.ts`. Mock `userDb`, `orgDb`, and the `AW-Settings` DynamoDB reads. Assert:

```typescript
test("GET /api/funnels: sharing ON → caller's funnels + org members' funnels, tagged", async () => {
  // caller m-1 in org-1; org has shareSettings.funnels.enabled = true
  // m-1 has funnel f-a; member m-2 has funnel f-b
  const res = await request(app).get("/api/funnels").set("Authorization", `Bearer ${m1Token}`);
  expect(res.status).toBe(200);
  const ids = res.body.funnels.map((f: any) => f.configId);
  expect(ids).toEqual(expect.arrayContaining(["funnel:f-a", "funnel:f-b"]));
  const own = res.body.funnels.find((f: any) => f.configId === "funnel:f-a");
  const shared = res.body.funnels.find((f: any) => f.configId === "funnel:f-b");
  expect(own.ownerUserId).toBe("m-1");
  expect(shared.ownerUserId).toBe("m-2");
  expect(shared.ownerName).toBeTruthy();
});

test("GET /api/funnels: sharing OFF, plain member → only own funnels", async () => {
  // org shareSettings.funnels.enabled = false; caller m-1 is a plain member
  const res = await request(app).get("/api/funnels").set("Authorization", `Bearer ${m1Token}`);
  const ids = res.body.funnels.map((f: any) => f.configId);
  expect(ids).toEqual(["funnel:f-a"]);
});

test("GET /api/funnels: each funnel carries a server-computed canEdit", async () => {
  // Arrange: org-1 shareSettings.funnels = { enabled: true, editors: ["m-1"] };
  // f-a owned by m-1, f-b owned by m-2.
  const res = await request(app).get("/api/funnels").set("Authorization", `Bearer ${m1Token}`);
  const own = res.body.funnels.find((f: any) => f.configId === "funnel:f-a");
  const shared = res.body.funnels.find((f: any) => f.configId === "funnel:f-b");
  expect(own.canEdit).toBe(true);
  expect(shared.canEdit).toBe(true); // m-1 is a funnels editor → may edit a shared funnel (B3 fix)
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- funnel.orgSharing`
Expected: FAIL — funnels have no `ownerUserId`; sharing produces no fan-out.

- [ ] **Step 3: Rewrite `GET /` in `funnel.ts` using `listOrgVisibleItems`**

Spec §3.3 requires reusing the existing `listOrgVisibleItems` helper — it supplies the established member-fanout and response caps (`MEMBER_FANOUT_CAP` / `PER_SOURCE_CAP` / `ORG_ITEMS_CAP` / `RESPONSE_CAP`) and dedups by id. Do **not** hand-roll the fan-out.

In `backend/src/routes/funnel.ts`, add imports at the top:

```typescript
import { userDb, orgDb } from "../services/db";
import { isFeatureEffectivelyEnabled, canEditItem, listOrgVisibleItems } from "../services/orgShareService";
```

Add this item type near the top of the file (after the existing `FunnelConfig` / `FunnelsSettings` interfaces):

```typescript
interface FunnelListItem {
  configId: string;
  name: string;
  stages: FunnelStage[];
  createdAt: string;
  updatedAt: string;
  ownerUserId: string;
  ownerName: string;
  canEdit: boolean;
}
```

Replace the `GET /` handler (lines 50-73) with:

```typescript
// Get all funnels visible to the caller (own + org-shared), each tagged with
// its owner and a server-computed canEdit flag.
router.get("/", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const user = await userDb.getUserById(userId);
    const ownName = user?.name || user?.email || "You";

    const toItems = (
      funnels: FunnelsSettings,
      ownerUserId: string,
      ownerName: string,
      canEdit: boolean,
    ): FunnelListItem[] =>
      Object.values(funnels).map((f) => ({
        configId: `funnel:${f.id}`,
        name: f.name,
        stages: f.stages,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        ownerUserId,
        ownerName,
        canEdit,
      }));

    // No org → only the caller's own funnels.
    if (!user?.orgId) {
      const own = toItems(await getUserFunnels(userId), userId, ownName, true);
      return res.json({ success: true, funnels: own, truncated: false });
    }

    const org = await orgDb.getOrgById(user.orgId);
    const orgLike = org
      ? { orgId: org.orgId, ownerUserId: org.ownerUserId, shareSettings: org.shareSettings }
      : null;
    const userLike = { userId, orgId: user.orgId, orgRole: user.orgRole };
    // Editors / org owner may edit every org funnel; plain members may not.
    // canEditItem on a non-self item reduces to the caller's editor/admin
    // status, so it is identical for every other member — compute it once.
    const canEditOthers = canEditItem(
      { userId: "__other__" }, userLike, orgLike, user.orgId, "funnels",
    );

    const result = await listOrgVisibleItems<FunnelListItem>({
      callerUserId: userId,
      orgId: user.orgId,
      featureEnabled: isFeatureEffectivelyEnabled(userLike, orgLike, "funnels"),
      getOwnerItems: async () => toItems(await getUserFunnels(userId), userId, ownName, true),
      getMemberIds: async () => (await orgDb.getOrgMembers(user.orgId!)).map((m) => m.userId),
      getItemsForOwner: async (ownerUserId) => {
        const ownerUser = await userDb.getUserById(ownerUserId);
        const name = ownerUser?.name || ownerUser?.email || "Org member";
        return toItems(await getUserFunnels(ownerUserId), ownerUserId, name, canEditOthers);
      },
      getId: (f) => f.configId,
    });

    res.json({ success: true, funnels: result.items, truncated: result.truncated });
  } catch (error: any) {
    console.error("Error fetching funnels:", error);
    res.status(500).json({ success: false, message: "Error fetching funnels", error: error.message });
  }
});
```

(`name`/`email` field access uses `any`-typed users — matches the rest of `funnel.ts`. If `user.name` is not a real field, `email` is the fallback. `listOrgVisibleItems` excludes the caller from `getMemberIds` itself, so `getItemsForOwner` is only ever called for other members — hence `canEditOthers`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npm test -- funnel.orgSharing`
Expected: the two GET tests PASS.

- [ ] **Step 5: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/funnel.ts backend/src/__tests__/funnel.orgSharing.test.ts
git commit -m "feat(crm): fan out GET /api/funnels via listOrgVisibleItems with canEdit"
```

---

## Task 14: `GET / PUT / DELETE /api/funnels/:configId` — org-aware gating

**Files:**
- Modify: `backend/src/routes/funnel.ts`
- Test: `backend/src/__tests__/funnel.orgSharing.test.ts` (extend)

The client passes `?ownerUserId=` (it has it from the list response). When absent, the route falls back to the caller's own funnel map.

- [ ] **Step 1: Write the failing tests**

Extend `backend/src/__tests__/funnel.orgSharing.test.ts`:

```typescript
test("PUT /api/funnels/:id?ownerUserId=other — editor allowed", async () => {
  // m-1 is in shareSettings.funnels.editors; funnel f-b owned by m-2
  const res = await request(app)
    .put("/api/funnels/funnel:f-b?ownerUserId=m-2")
    .set("Authorization", `Bearer ${m1Token}`)
    .send({ name: "Edited" });
  expect(res.status).toBe(200);
});

test("PUT /api/funnels/:id?ownerUserId=other — plain member denied 403", async () => {
  // m-3 is a plain member (not editor); funnel f-b owned by m-2
  const res = await request(app)
    .put("/api/funnels/funnel:f-b?ownerUserId=m-2")
    .set("Authorization", `Bearer ${m3Token}`)
    .send({ name: "Edited" });
  expect(res.status).toBe(403);
});

test("DELETE /api/funnels/:id?ownerUserId=other — editor denied 403 (delete is owner/org-owner only)", async () => {
  const res = await request(app)
    .delete("/api/funnels/funnel:f-b?ownerUserId=m-2")
    .set("Authorization", `Bearer ${m1Token}`); // m-1 is editor, not org owner
  expect(res.status).toBe(403);
});

test("GET /api/funnels/:id?ownerUserId=other — plain member with sharing OFF denied 403", async () => {
  const res = await request(app)
    .get("/api/funnels/funnel:f-b?ownerUserId=m-2")
    .set("Authorization", `Bearer ${m3Token}`);
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npm test -- funnel.orgSharing`
Expected: FAIL — the item routes ignore `ownerUserId` and never gate.

- [ ] **Step 3: Add a shared resolver helper in `funnel.ts`**

Add `canViewItem` to the `orgShareService` import introduced in Task 13, so the line reads:

```typescript
import { isFeatureEffectivelyEnabled, canEditItem, canViewItem, listOrgVisibleItems } from "../services/orgShareService";
```

Add this helper near the top of `funnel.ts` (after `saveUserFunnels`):

```typescript
/**
 * Resolve the funnel-owning user for an item route. Returns the owner userId and
 * the org context, or an HTTP error to send. When `ownerUserId` is absent or
 * equals the caller, the caller owns it.
 */
async function resolveFunnelOwner(
  callerId: string,
  ownerUserIdParam: string | undefined,
): Promise<
  | { error: { status: number; message: string } }
  | { ownerUserId: string; caller: any; org: any; ownerOrgId: string | undefined }
> {
  const caller = await userDb.getUserById(callerId);
  const ownerUserId = ownerUserIdParam && ownerUserIdParam !== callerId ? ownerUserIdParam : callerId;
  if (ownerUserId === callerId) {
    return { ownerUserId, caller, org: null, ownerOrgId: caller?.orgId };
  }
  const owner = await userDb.getUserById(ownerUserId);
  if (!owner || !caller?.orgId || owner.orgId !== caller.orgId) {
    return { error: { status: 403, message: "Funnel not accessible" } };
  }
  const org = await orgDb.getOrgById(caller.orgId);
  return { ownerUserId, caller, org, ownerOrgId: owner.orgId };
}
```

- [ ] **Step 4: Rewrite `GET /:configId`**

Replace the `GET /:configId` handler (lines 76-112) with:

```typescript
// Get a specific funnel (own or org-shared)
router.get("/:configId", async (req, res) => {
  try {
    const callerId = (req as any).user.userId;
    const funnelId = req.params.configId.replace(/^funnel:/, "");
    const resolved = await resolveFunnelOwner(callerId, req.query.ownerUserId as string | undefined);
    if ("error" in resolved) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }

    if (resolved.ownerUserId !== callerId) {
      const orgLike = resolved.org
        ? { orgId: resolved.org.orgId, ownerUserId: resolved.org.ownerUserId, shareSettings: resolved.org.shareSettings }
        : null;
      const userLike = { userId: callerId, orgId: resolved.caller?.orgId, orgRole: resolved.caller?.orgRole };
      if (!canViewItem({ userId: resolved.ownerUserId }, userLike, orgLike, resolved.ownerOrgId, "funnels")) {
        return res.status(403).json({ success: false, message: "Funnel not accessible" });
      }
    }

    const funnels = await getUserFunnels(resolved.ownerUserId);
    const funnel = funnels[funnelId];
    if (!funnel) {
      return res.status(404).json({ success: false, message: "Funnel not found" });
    }
    res.json({
      success: true,
      funnel: {
        configId: `funnel:${funnel.id}`,
        name: funnel.name,
        stages: funnel.stages,
        createdAt: funnel.createdAt,
        updatedAt: funnel.updatedAt,
        ownerUserId: resolved.ownerUserId,
      },
    });
  } catch (error: any) {
    console.error("Error fetching funnel:", error);
    res.status(500).json({ success: false, message: "Error fetching funnel", error: error.message });
  }
});
```

- [ ] **Step 5: Rewrite `PUT /:configId`**

Replace the `PUT /:configId` handler (lines 180-246). Keep the existing name/stages validation; gate access and operate on the owner's funnel map:

```typescript
// Update an existing funnel (own or org-shared, if the caller may edit)
router.put("/:configId", async (req, res) => {
  try {
    const callerId = (req as any).user.userId;
    const funnelId = req.params.configId.replace(/^funnel:/, "");
    const { name, stages } = req.body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return res.status(400).json({ success: false, message: "Funnel name cannot be empty" });
    }
    if (stages !== undefined) {
      if (!Array.isArray(stages)) {
        return res.status(400).json({ success: false, message: "Stages must be an array" });
      }
      const errors = validateFunnelStages(stages);
      if (errors.length > 0) {
        return res.status(400).json({ success: false, message: "Invalid funnel configuration", errors });
      }
    }

    const resolved = await resolveFunnelOwner(callerId, req.query.ownerUserId as string | undefined);
    if ("error" in resolved) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }
    if (resolved.ownerUserId !== callerId) {
      const orgLike = resolved.org
        ? { orgId: resolved.org.orgId, ownerUserId: resolved.org.ownerUserId, shareSettings: resolved.org.shareSettings }
        : null;
      const userLike = { userId: callerId, orgId: resolved.caller?.orgId, orgRole: resolved.caller?.orgRole };
      if (!canEditItem({ userId: resolved.ownerUserId }, userLike, orgLike, resolved.ownerOrgId, "funnels")) {
        return res.status(403).json({ success: false, message: "Not allowed to edit this funnel" });
      }
    }

    const funnels = await getUserFunnels(resolved.ownerUserId);
    if (!funnels[funnelId]) {
      return res.status(404).json({ success: false, message: "Funnel not found" });
    }
    if (name) funnels[funnelId].name = name.trim();
    if (stages) funnels[funnelId].stages = stages;
    funnels[funnelId].updatedAt = new Date().toISOString();
    await saveUserFunnels(resolved.ownerUserId, funnels);

    res.json({ success: true, message: "Funnel updated successfully" });
  } catch (error: any) {
    console.error("Error updating funnel:", error);
    res.status(500).json({ success: false, message: "Error updating funnel", error: error.message });
  }
});
```

- [ ] **Step 6: Rewrite `DELETE /:configId`**

Replace the `DELETE /:configId` handler (lines 249-281). Delete is **owner of the funnel, or org owner** only — editors cannot delete others' funnels:

```typescript
// Delete a funnel (own, or any org funnel if the caller is the org owner)
router.delete("/:configId", async (req, res) => {
  try {
    const callerId = (req as any).user.userId;
    const funnelId = req.params.configId.replace(/^funnel:/, "");

    const resolved = await resolveFunnelOwner(callerId, req.query.ownerUserId as string | undefined);
    if ("error" in resolved) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }
    if (resolved.ownerUserId !== callerId && resolved.caller?.orgRole !== "owner") {
      return res.status(403).json({ success: false, message: "Only the funnel owner or org owner can delete this funnel" });
    }

    const funnels = await getUserFunnels(resolved.ownerUserId);
    if (!funnels[funnelId]) {
      return res.status(404).json({ success: false, message: "Funnel not found" });
    }
    delete funnels[funnelId];
    await saveUserFunnels(resolved.ownerUserId, funnels);

    res.json({ success: true, message: "Funnel deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting funnel:", error);
    res.status(500).json({ success: false, message: "Error deleting funnel", error: error.message });
  }
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && npm test -- funnel.orgSharing`
Expected: all funnel.orgSharing tests PASS.

- [ ] **Step 8: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add backend/src/routes/funnel.ts backend/src/__tests__/funnel.orgSharing.test.ts
git commit -m "feat(crm): org-aware access gating on funnel item routes"
```

---

## Task 15: Org-aware funnel-metrics lookup in `seo.ts`

**Files:**
- Modify: `backend/src/routes/seo.ts` (funnel-metrics block, lines 678-742)
- Test: `backend/src/__tests__/seo.orgAnalytics.test.ts` (extend)

**Depends on Phase 1 Task 6** — this task edits the seo.ts funnel block that Task 6 rewrote (its "before" code below already reads `resolved.primaryPropertyId`). Run Phase 1 before this task.

The funnel block currently reads `funnels_${req.user.userId}` — the viewer's own map. It must resolve a shared funnel for its owner via a `funnelOwnerId` query param.

- [ ] **Step 1: Write the failing test**

Extend `backend/src/__tests__/seo.orgAnalytics.test.ts`:

```typescript
test("GET /metrics looks the funnel up under funnelOwnerId, not the caller", async () => {
  // funnel f-b lives in funnels_m-2; caller is m-1 with view access
  const res = await request(app)
    .get("/api/seo/metrics?funnelId=f-b&funnelOwnerId=m-2")
    .set("Authorization", `Bearer ${m1Token}`);
  expect(res.status).toBe(200);
  // The AW-Settings get must have been keyed funnels_m-2
  expect(awSettingsGetKeys).toContain("funnels_m-2");
});
```

(`awSettingsGetKeys` = a spy collecting the `settingName` values passed to the mocked `dynamodb.get`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npm test -- seo.orgAnalytics`
Expected: FAIL — the lookup is keyed `funnels_m-1`.

- [ ] **Step 3: Modify the funnel-metrics block**

In `backend/src/routes/seo.ts`, in the funnel block (lines 680-694), change the funnel-owner resolution. Replace:

```typescript
  const funnelId = req.query.funnelId as string;

  if (resolved.primaryPropertyId && funnelId) {
    try {
      // Fetch funnel config from AW-Settings
      const AWS = require("aws-sdk");
      const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
      const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";

      const funnelResult = await dynamodb.get({
        TableName: `${TABLE_PREFIX}AW-Settings`,
        Key: { settingName: `funnels_${(req as any).user.userId}` },
      }).promise();
```

with:

```typescript
  const funnelId = req.query.funnelId as string;
  const funnelOwnerId = (req.query.funnelOwnerId as string) || (req as any).user.userId;

  if (resolved.primaryPropertyId && funnelId) {
    try {
      // A shared funnel may belong to another org member — gate the cross-member case.
      if (funnelOwnerId !== (req as any).user.userId) {
        const org = user.orgId ? await orgDb.getOrgById(user.orgId) : null;
        const owner = await userDb.getUserById(funnelOwnerId);
        const orgLike = org
          ? { orgId: org.orgId, ownerUserId: org.ownerUserId, shareSettings: org.shareSettings }
          : null;
        const userLike = { userId: user.userId, orgId: user.orgId, orgRole: user.orgRole };
        if (!owner || owner.orgId !== user.orgId ||
            !canViewItem({ userId: funnelOwnerId }, userLike, orgLike, owner.orgId, "funnels")) {
          throw new Error("Funnel not accessible");
        }
      }

      // Fetch funnel config from AW-Settings (keyed to the funnel's owner)
      const AWS = require("aws-sdk");
      const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
      const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";

      const funnelResult = await dynamodb.get({
        TableName: `${TABLE_PREFIX}AW-Settings`,
        Key: { settingName: `funnels_${funnelOwnerId}` },
      }).promise();
```

Add the required imports at the top of `seo.ts` (extend existing imports):

```typescript
import { orgDb } from "../services/db";
import { canViewItem } from "../services/orgShareService";
```

(`userDb` is already imported at `seo.ts:3`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npm test -- seo.orgAnalytics`
Expected: PASS.

- [ ] **Step 5: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/seo.ts backend/src/__tests__/seo.orgAnalytics.test.ts
git commit -m "feat(crm): resolve shared-funnel metrics under the funnel owner"
```

---

## Task 16: Include `funnels` in member removal

**Files:**
- Modify: `backend/src/routes/orgMemberRemoval.ts`
- Test: `backend/src/__tests__/orgMemberRemoval.test.ts` (extend the existing file)

`orgMemberRemoval.ts` enumerates shareable features for the removal preview (`itemCounts`) and for the transfer/delete logic. Add `funnels`.

- [ ] **Step 1: Read the file**

Read `backend/src/routes/orgMemberRemoval.ts` in full. Identify (a) the `removal-preview` `itemCounts` builder (lines ~33-50) and (b) the `getItemsForFeature` / `getItemId` / transfer / delete switches (lines ~172-224).

- [ ] **Step 2: Write the failing test**

Extend `backend/src/__tests__/orgMemberRemoval.test.ts` with a test asserting the `removal-preview` response `itemCounts` contains a `funnels` key reflecting the member's funnel count. Model the mocking on the existing tests in that file.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && npm test -- orgMemberRemoval`
Expected: FAIL — `itemCounts.funnels` is `undefined`.

- [ ] **Step 4: Add `funnels` to the preview counts**

In the `removal-preview` handler, add a funnels count. Funnels live in `AW-Settings` keyed `funnels_<userId>`; count the keys of that map. Add to the `Promise.all` array and to the `itemCounts` object:

```typescript
    // alongside taskList/templates/landingPages/workPlans/skills:
    const funnelsCount = await getUserFunnelCount(target.userId);
    // ...
    itemCounts: {
      knowledgeBase: taskList,
      htmlTemplates: templates,
      landingPages,
      workPlans,
      skills,
      funnels: funnelsCount,
    },
```

Implement `getUserFunnelCount` in the same file (read the `AW-Settings` `funnels_<userId>` item and return `Object.keys(item?.funnels ?? {}).length`), or import and reuse a counting helper if `funnel.ts` exposes one.

- [ ] **Step 5: Add `funnels` to the transfer/delete switches**

In the per-feature `getItemsForFeature` / `getItemId` / transfer / delete switch statements, add `case "funnels":` arms:
- list a user's funnels → the `funnels_<userId>` map values,
- item id → the funnel `id`,
- transfer → move the funnel entry into the recipient's `funnels_<recipientId>` map,
- delete → remove the entry from the owner's map.

Follow the exact shape of the neighbouring `case "skills":` / `case "workPlans":` arms.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && npm test -- orgMemberRemoval`
Expected: PASS.

- [ ] **Step 7: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/orgMemberRemoval.ts backend/src/__tests__/orgMemberRemoval.test.ts
git commit -m "feat(crm): handle funnels in org member removal"
```

---

## Task 17: `OrgSharingTab` — add the Funnels row

**Files:**
- Modify: `customer-portal/src/components/settings/OrgSharingTab.tsx`

- [ ] **Step 1: Add `funnels` to the `ShareSettings` type**

In `OrgSharingTab.tsx`, find the `ShareSettings` type/interface and add `funnels: { enabled: boolean; editors: string[] }` next to `skills` (matching the backend `OrgShareSettings`).

- [ ] **Step 2: Add the Funnels entry to `TOGGLEABLE`**

In the `TOGGLEABLE` array (lines 36-62), add after the `skills` entry:

```typescript
  {
    key: "funnels",
    label: "Funnels",
    description: "Share org user-journey funnels with all members.",
  },
```

- [ ] **Step 3: Add `funnels` to `defaultSettings()`**

In `defaultSettings()` (lines 77-87), add after `skills`:

```typescript
    funnels: { enabled: false, editors: [] },
```

- [ ] **Step 4: Tolerate missing `funnels` from older orgs**

Where the component loads settings from the API and sets state, merge over defaults so an org whose stored `shareSettings` predates `funnels` still renders. If the load path does `setSettings(loaded)`, change it to `setSettings({ ...defaultSettings(), ...loaded })`.

- [ ] **Step 5: Verify build and tests**

Run: `cd customer-portal && npx tsc && npm test -- OrgSharing`
Expected: tsc clean; tests pass (the `TOGGLEABLE.map` render loop picks up the new row automatically).

- [ ] **Step 6: Commit**

```bash
git add customer-portal/src/components/settings/OrgSharingTab.tsx
git commit -m "feat(crm): add Funnels row to Organization Sharing settings"
```

---

## Task 18: `SEO.tsx` — "Shared by" badges + read-only shared funnels

**Files:**
- Modify: `customer-portal/src/pages/SEO.tsx`

- [ ] **Step 1: Extend the `FunnelConfig` type**

In `SEO.tsx`, the `FunnelConfig` interface (line ~175) — add:

```typescript
  ownerUserId?: string;
  ownerName?: string;
  canEdit?: boolean;
```

- [ ] **Step 2: Show the "Shared by" badge in the funnel selector**

In the funnel selector rendering, for each funnel whose `ownerUserId` is set and **not** the current `user.userId`, render the owner name. Reuse `SharedByBadge` from `customer-portal/src/components/SharedByBadge.tsx` (check its props by reading the file) — render it beside the funnel name when `funnel.ownerUserId && funnel.ownerUserId !== user?.userId`.

- [ ] **Step 3: Pass `funnelOwnerId` when fetching shared-funnel metrics**

Where `SEO.tsx` requests `/api/seo/metrics` with a `funnelId` param (`fetchMetrics` / `fetchFunnelMetricsOnly`, lines ~378-532), also pass `funnelOwnerId` — look up the selected funnel in the `funnels` array and append `params.funnelOwnerId = selectedFunnel.ownerUserId` when it is set.

- [ ] **Step 4: Drive funnel read-only state off the server's `canEdit`**

`GET /api/funnels` returns a server-computed `canEdit` per funnel (Task 13): `true` for the caller's own funnels and for shared funnels the caller may edit (a funnels editor or the org owner), `false` otherwise. The UI must **not** recompute permissions itself.

When opening a funnel in the editor (the `FunnelConfig` editor / edit dialog), pass `readOnly={funnel.canEdit === false}`. This keeps a shared funnel **editable for editors and the org owner** (so E2E FS-13 passes) and read-only only for plain members.

- [ ] **Step 5: Thread `readOnly` into `FunnelConfig.tsx`**

In `customer-portal/src/components/settings/FunnelConfig.tsx`, add an optional `readOnly?: boolean` prop. When true: disable all stage inputs and the name field, and hide/disable the Save button. (`FunnelConfig` currently has no read-only mode — add one.)

- [ ] **Step 6: Verify build and tests**

Run: `cd customer-portal && npx tsc && npm test -- SEO`
Expected: tsc clean; tests pass (update expectations for the new badge/read-only rendering).

- [ ] **Step 7: Commit**

```bash
git add customer-portal/src/pages/SEO.tsx customer-portal/src/components/settings/FunnelConfig.tsx
git commit -m "feat(crm): show shared-funnel badges and read-only state in SEO funnels"
```

---

## Task 19: Phase 2 release notes

**Files:**
- Modify: `backend/src/docs/user-release.ts`

- [ ] **Step 1: Add an entry**

Add, following the existing format, dated `2026-05-21`:

> **Share funnels across your team** — User-journey funnels can now be shared organization-wide. Turn on Funnels sharing in Settings → Organization → Sharing; editors and the org owner can edit shared funnels.

- [ ] **Step 2: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/docs/user-release.ts
git commit -m "docs(crm): release note for org-wide funnel sharing"
```

---

## Final verification

- [ ] **Backend:** `cd backend && npx tsc && npm test` — all green.
- [ ] **Partner portal:** `cd partner-portal && npx tsc` — clean.
- [ ] **Customer portal:** `cd customer-portal && npx tsc && npm test` — clean.
- [ ] Execute the §7 Playwright E2E plan from the spec against a cloud test environment (`./test-env/test-env.sh launch` then `sync`).

---

## Notes on the spec's deferred items

Per the spec §5, these are intentionally **not** in this plan: funnel-blob write
concurrency (#2 — `saveUserFunnels` keeps the whole-blob `put`; E2E test FS-24 is
expected to xfail), the inherent O(members) fan-out scan (#4), and contractor
access policy (#6). Do not "fix" them as part of these tasks.
