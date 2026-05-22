# Self-Service SEO / GA / Clarity Analytics Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-service customer-portal Settings tab for SEO domains / GA4 properties / Clarity projects, make the Organization record the source of truth for org-shared analytics config, and fix four bugs.

**Architecture:** Org analytics config moves from per-user records to the `Organization` record, resolved by a rewritten `resolveAnalyticsConfig()`. New `/api/seo/config` endpoints back a new Settings tab; `OrgShareSettings` gains an `analytics` feature for the sharing toggle + editors. A one-time migration script copies existing config to Org records.

**Tech Stack:** Node/Express/TypeScript backend (Jest + supertest, DynamoDB), React/TypeScript portals (Vite, customer-portal uses Vitest).

**Spec:** `docs/superpowers/specs/2026-05-22-seo-analytics-config-design.md`

**Deploy order:** Phase 1 (backend) → Phase 2 (migration script run) → Phase 3 (partner portal) → Phase 4 (customer portal) → Phase 5 (release notes).

**Conventions:**
- Run `cd backend && npx tsc` after every backend `.ts` edit (including test files).
- Backend logic is TDD (CLAUDE.md Rule 2): failing test first. Frontend UI components are not TDD — implement, then add a test.
- Commit messages: no `Co-Authored-By` / "Generated with" trailers.
- One logical change per commit.

---

# Phase 1 — Backend

### Task 1: Data model — Organization fields, `OrgShareSettings.analytics`, `TOGGLEABLE_FEATURES`

**Files:**
- Modify: `backend/src/services/db.ts` (`Organization` interface ~536-570, `OrgShareSettings` interface ~572-582)
- Modify: `backend/src/services/orgShareService.ts` (`ToggleableFeature` type ~3-4, `TOGGLEABLE_FEATURES` ~104-106)

This is a type-only change (no behavior), so no test step — `npx tsc` is the verification.

- [ ] **Step 1: Add the new analytics fields to the `Organization` interface**

In `backend/src/services/db.ts`, inside `interface Organization`, the field `googleAnalyticsProperties?` already exists. Immediately after that line, add:

```typescript
  primaryAnalyticsPropertyId?: string; // Explicit primary GA4 property (must be one of googleAnalyticsProperties)
  gaFilteredDomains?: string[]; // Domains to exclude from Google Analytics
  clarityProjects?: Array<{ projectId: string; label: string }>; // Microsoft Clarity projects
  productDomain?: string; // Product site domain for feature usage tracking
  /**
   * Migration marker. Absent → analytics config has never been written to this
   * Organization record; resolveAnalyticsConfig() falls back to the owner's user
   * record. "migrated" → set by the migration script. "self" → set by a
   * self-service or admin save. When present, the Org record is authoritative
   * (including empty arrays).
   */
  analyticsConfigSource?: "migrated" | "self";
```

- [ ] **Step 2: Add the `analytics` feature to `OrgShareSettings`**

In `backend/src/services/db.ts`, inside `interface OrgShareSettings`, add `analytics` right after the `funnels` line:

```typescript
  funnels: { enabled: boolean; editors: string[] };
  analytics: { enabled: boolean; editors: string[] };
```

- [ ] **Step 3: Add `"analytics"` to the toggleable-feature type and list**

In `backend/src/services/orgShareService.ts`, change the `ToggleableFeature` type:

```typescript
export type ToggleableFeature =
  | "knowledgeBase" | "htmlTemplates" | "landingPages" | "workPlans" | "skills" | "funnels" | "analytics";
```

And the `TOGGLEABLE_FEATURES` constant:

```typescript
export const TOGGLEABLE_FEATURES: ReadonlyArray<ToggleableFeature> = [
  "knowledgeBase", "htmlTemplates", "landingPages", "workPlans", "skills", "funnels", "analytics",
];
```

- [ ] **Step 4: Verify compilation**

Run: `cd backend && npx tsc`
Expected: errors. `OrgShareSettings` is now a required-keyed type, so `tsc` flags every place an `OrgShareSettings` literal is built without `analytics` — production factories **and** existing `__tests__` files. Note every flagged file: production factories are fixed in Task 4 Step 5; test-file literals get `analytics: { enabled: false, editors: [] }` added when their owning task runs (or now, if quick). The build is green again after Task 4.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/db.ts backend/src/services/orgShareService.ts
git commit -m "feat(crm): add analytics fields to Organization and OrgShareSettings"
```

---

### Task 2: Shared validator `validateAnalyticsConfig`

**Files:**
- Create: `backend/src/services/analyticsConfigValidator.ts`
- Test: `backend/src/__tests__/analyticsConfigValidator.test.ts`

A pure function validating a partial analytics-config payload. Each field is optional; present fields are validated and returned trimmed/normalized.

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/analyticsConfigValidator.test.ts`:

```typescript
import { validateAnalyticsConfig } from "../services/analyticsConfigValidator";

describe("validateAnalyticsConfig", () => {
  test("empty input → ok with empty value", () => {
    const r = validateAnalyticsConfig({});
    expect(r.ok).toBe(true);
  });

  test("valid GA properties → ok, trimmed", () => {
    const r = validateAnalyticsConfig({
      googleAnalyticsProperties: [{ propertyId: " 123 ", label: " Main " }],
    });
    expect(r).toEqual({ ok: true, value: { googleAnalyticsProperties: [{ propertyId: "123", label: "Main" }] } });
  });

  test("non-numeric GA property id → error", () => {
    const r = validateAnalyticsConfig({ googleAnalyticsProperties: [{ propertyId: "G-ABC", label: "x" }] });
    expect(r.ok).toBe(false);
  });

  test("duplicate GA property id → error", () => {
    const r = validateAnalyticsConfig({
      googleAnalyticsProperties: [
        { propertyId: "1", label: "a" },
        { propertyId: "1", label: "b" },
      ],
    });
    expect(r.ok).toBe(false);
  });

  test("label over 100 chars → error", () => {
    const r = validateAnalyticsConfig({
      googleAnalyticsProperties: [{ propertyId: "1", label: "x".repeat(101) }],
    });
    expect(r.ok).toBe(false);
  });

  test("primaryAnalyticsPropertyId not in properties → error", () => {
    const r = validateAnalyticsConfig({
      googleAnalyticsProperties: [{ propertyId: "1", label: "a" }],
      primaryAnalyticsPropertyId: "999",
    });
    expect(r.ok).toBe(false);
  });

  test("primaryAnalyticsPropertyId in properties → ok", () => {
    const r = validateAnalyticsConfig({
      googleAnalyticsProperties: [{ propertyId: "1", label: "a" }],
      primaryAnalyticsPropertyId: "1",
    });
    expect(r.ok).toBe(true);
  });

  test("invalid Clarity project id → error", () => {
    const r = validateAnalyticsConfig({ clarityProjects: [{ projectId: "no", label: "x" }] });
    expect(r.ok).toBe(false);
  });

  test("valid Clarity project → ok", () => {
    const r = validateAnalyticsConfig({ clarityProjects: [{ projectId: "ul13e4f7fe", label: "Site" }] });
    expect(r.ok).toBe(true);
  });

  test("bad seo domain → error", () => {
    const r = validateAnalyticsConfig({ seoDomains: ["not a domain"] });
    expect(r.ok).toBe(false);
  });

  test("valid seo domain and url-prefix → ok", () => {
    const r = validateAnalyticsConfig({ seoDomains: ["acme.com", "https://blog.acme.com/"] });
    expect(r.ok).toBe(true);
  });

  test("gaFilteredDomains allows localhost and ip → ok", () => {
    const r = validateAnalyticsConfig({ gaFilteredDomains: ["localhost", "10.0.0.1", "app.acme.com"] });
    expect(r.ok).toBe(true);
  });

  test("bad productDomain → error", () => {
    const r = validateAnalyticsConfig({ productDomain: "bad domain" });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest analyticsConfigValidator -- --silent`
Expected: FAIL with "Cannot find module '../services/analyticsConfigValidator'".

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/analyticsConfigValidator.ts`:

```typescript
export interface AnalyticsConfigInput {
  seoDomains?: unknown;
  googleAnalyticsProperties?: unknown;
  primaryAnalyticsPropertyId?: unknown;
  gaFilteredDomains?: unknown;
  clarityProjects?: unknown;
  productDomain?: unknown;
}

export interface AnalyticsConfigValue {
  seoDomains?: string[];
  googleAnalyticsProperties?: Array<{ propertyId: string; label: string }>;
  primaryAnalyticsPropertyId?: string | null;
  gaFilteredDomains?: string[];
  clarityProjects?: Array<{ projectId: string; label: string }>;
  productDomain?: string | null;
}

export type ValidationResult =
  | { ok: true; value: AnalyticsConfigValue }
  | { ok: false; error: string };

const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
const URL_PREFIX_RE = /^https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}\/?$/;
const GA_ID_RE = /^\d+$/;
const CLARITY_ID_RE = /^[a-zA-Z0-9_-]{6,32}$/;

/**
 * Validate a partial analytics-config payload. Every field is optional; only
 * provided fields are validated. Returns trimmed/normalized values on success.
 * Shared by the admin route and the self-service /api/seo/config routes.
 */
export function validateAnalyticsConfig(input: AnalyticsConfigInput): ValidationResult {
  const value: AnalyticsConfigValue = {};

  if (input.seoDomains !== undefined) {
    if (!Array.isArray(input.seoDomains)) return { ok: false, error: "seoDomains must be an array" };
    const out: string[] = [];
    for (const d of input.seoDomains) {
      if (typeof d !== "string") return { ok: false, error: `Invalid domain: ${d}` };
      const t = d.trim();
      if (!DOMAIN_RE.test(t) && !URL_PREFIX_RE.test(t)) {
        return { ok: false, error: `Invalid domain format: ${d}. Use 'example.com' or 'https://example.com/'` };
      }
      out.push(t);
    }
    value.seoDomains = out;
  }

  if (input.googleAnalyticsProperties !== undefined) {
    if (!Array.isArray(input.googleAnalyticsProperties)) {
      return { ok: false, error: "googleAnalyticsProperties must be an array" };
    }
    const out: Array<{ propertyId: string; label: string }> = [];
    const seen = new Set<string>();
    for (const p of input.googleAnalyticsProperties as any[]) {
      if (!p || typeof p !== "object" || typeof p.propertyId !== "string" || typeof p.label !== "string") {
        return { ok: false, error: "Each GA4 property must have string 'propertyId' and 'label'" };
      }
      const id = p.propertyId.trim();
      const label = p.label.trim();
      if (!GA_ID_RE.test(id)) return { ok: false, error: `Invalid GA4 Property ID: ${p.propertyId}. Use the numeric ID.` };
      if (label.length === 0) return { ok: false, error: "Each GA4 property must have a non-empty label" };
      if (label.length > 100) return { ok: false, error: `GA4 label too long (max 100): ${p.label}` };
      if (seen.has(id)) return { ok: false, error: `Duplicate GA4 Property ID: ${id}` };
      seen.add(id);
      out.push({ propertyId: id, label });
    }
    value.googleAnalyticsProperties = out;
  }

  if (input.primaryAnalyticsPropertyId !== undefined) {
    const raw = input.primaryAnalyticsPropertyId;
    if (raw === null || raw === "") {
      value.primaryAnalyticsPropertyId = null;
    } else if (typeof raw !== "string") {
      return { ok: false, error: "primaryAnalyticsPropertyId must be a string" };
    } else {
      const id = raw.trim();
      const props = value.googleAnalyticsProperties;
      if (props && !props.some((p) => p.propertyId === id)) {
        return { ok: false, error: "primaryAnalyticsPropertyId must be one of the submitted GA4 properties" };
      }
      value.primaryAnalyticsPropertyId = id;
    }
  }

  if (input.gaFilteredDomains !== undefined) {
    if (!Array.isArray(input.gaFilteredDomains)) return { ok: false, error: "gaFilteredDomains must be an array" };
    const out: string[] = [];
    for (const d of input.gaFilteredDomains) {
      if (typeof d !== "string") return { ok: false, error: `Invalid filtered domain: ${d}` };
      const t = d.trim();
      const isLocalhost = t === "localhost" || t.startsWith("localhost:");
      const isIp = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(t);
      if (!isLocalhost && !isIp && !DOMAIN_RE.test(t)) {
        return { ok: false, error: `Invalid filtered domain: ${d}. Use app.example.com, localhost, or an IP.` };
      }
      out.push(t);
    }
    value.gaFilteredDomains = out;
  }

  if (input.clarityProjects !== undefined) {
    if (!Array.isArray(input.clarityProjects)) return { ok: false, error: "clarityProjects must be an array" };
    const out: Array<{ projectId: string; label: string }> = [];
    const seen = new Set<string>();
    for (const p of input.clarityProjects as any[]) {
      if (!p || typeof p !== "object" || typeof p.projectId !== "string" || typeof p.label !== "string") {
        return { ok: false, error: "Each Clarity project must have string 'projectId' and 'label'" };
      }
      const id = p.projectId.trim();
      const label = p.label.trim();
      if (!CLARITY_ID_RE.test(id)) return { ok: false, error: `Invalid Clarity Project ID: ${p.projectId}` };
      if (label.length === 0) return { ok: false, error: "Each Clarity project must have a non-empty label" };
      if (label.length > 100) return { ok: false, error: `Clarity label too long (max 100): ${p.label}` };
      if (seen.has(id)) return { ok: false, error: `Duplicate Clarity Project ID: ${id}` };
      seen.add(id);
      out.push({ projectId: id, label });
    }
    value.clarityProjects = out;
  }

  if (input.productDomain !== undefined) {
    const raw = input.productDomain;
    if (raw === null || raw === "") {
      value.productDomain = null;
    } else if (typeof raw !== "string" || !DOMAIN_RE.test(raw.trim())) {
      return { ok: false, error: `Invalid product domain: ${raw}. Use app.example.com` };
    } else {
      value.productDomain = raw.trim();
    }
  }

  return { ok: true, value };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest analyticsConfigValidator -- --silent` → Expected: PASS (13 tests).
Run: `cd backend && npx tsc` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/analyticsConfigValidator.ts backend/src/__tests__/analyticsConfigValidator.test.ts
git commit -m "feat(crm): add shared validateAnalyticsConfig validator"
```

---

### Task 3: Rewrite `resolveAnalyticsConfig` + add `resolveConfigTarget`

**Files:**
- Modify: `backend/src/services/analyticsConfigResolver.ts` (entire file)
- Test: `backend/src/__tests__/analyticsConfigResolver.test.ts` (rewrite — the existing tests assert the old `shareAnalyticsWithOrg` model)

`resolveAnalyticsConfig` now reads the Organization record (with owner-record fallback for un-migrated orgs); `resolveConfigTarget` tells the write endpoints where to save and whether the caller may edit.

- [ ] **Step 1: Replace the test file**

Replace the entire contents of `backend/src/__tests__/analyticsConfigResolver.test.ts`:

```typescript
import { resolveAnalyticsConfig, resolveConfigTarget } from "../services/analyticsConfigResolver";
import { orgDb, userDb } from "../services/db";

jest.mock("../services/db", () => ({
  orgDb: { getOrgById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

beforeEach(() => jest.clearAllMocks());

const migratedOrg = (over: any = {}) => ({
  orgId: "org-1",
  ownerUserId: "owner-1",
  analyticsConfigSource: "migrated",
  googleAnalyticsProperties: [{ propertyId: "111", label: "Org GA" }],
  primaryAnalyticsPropertyId: "111",
  seoDomains: ["acme.com"],
  clarityProjects: [{ projectId: "cl-1", label: "Org Clarity" }],
  gaFilteredDomains: ["staging.acme.com"],
  productDomain: "app.acme.com",
  shareSettings: { analytics: { enabled: true, editors: [] } },
  ...over,
});

describe("resolveAnalyticsConfig", () => {
  test("solo user (no orgId) → own record, source 'self'", async () => {
    const r = await resolveAnalyticsConfig({ userId: "solo-1", googleAnalyticsPropertyId: "777" });
    expect(r.source).toBe("self");
    expect(r.properties).toEqual([{ propertyId: "777", label: "Main Property" }]);
    expect(mockOrgDb.getOrgById).not.toHaveBeenCalled();
  });

  test("org owner, migrated org → org record, source 'self'", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(migratedOrg() as any);
    const r = await resolveAnalyticsConfig({ userId: "owner-1", orgId: "org-1" });
    expect(r.source).toBe("self");
    expect(r.properties).toEqual([{ propertyId: "111", label: "Org GA" }]);
    expect(r.primaryPropertyId).toBe("111");
  });

  test("plain member, sharing ON, migrated → org record, source 'org'", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(migratedOrg() as any);
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1" });
    expect(r.source).toBe("org");
    expect(r.seoDomains).toEqual(["acme.com"]);
  });

  test("plain member, sharing OFF → empty config", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({ shareSettings: { analytics: { enabled: false, editors: [] } } }) as any
    );
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1" });
    expect(r.properties).toEqual([]);
    expect(r.seoDomains).toEqual([]);
  });

  test("editor, sharing OFF → still gets org config (Decision 11)", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({ shareSettings: { analytics: { enabled: false, editors: ["m-1"] } } }) as any
    );
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1" });
    expect(r.source).toBe("org");
    expect(r.properties).toEqual([{ propertyId: "111", label: "Org GA" }]);
  });

  test("un-migrated org → falls back to owner user record; gate reads legacy shareAnalyticsWithOrg", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true,
    } as any);
    mockUserDb.getUserById.mockResolvedValue({
      userId: "owner-1", googleAnalyticsProperties: [{ propertyId: "555", label: "Legacy" }],
    } as any);
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1" });
    expect(r.source).toBe("org");
    expect(r.properties).toEqual([{ propertyId: "555", label: "Legacy" }]);
    expect(mockUserDb.getUserById).toHaveBeenCalledWith("owner-1");
  });

  test("un-migrated org, legacy sharing OFF, plain member → empty", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: false,
    } as any);
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1" });
    expect(r.properties).toEqual([]);
  });

  test("orgId set but Organization record missing → treat as solo", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(null);
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1", googleAnalyticsPropertyId: "9" });
    expect(r.source).toBe("self");
    expect(r.properties).toEqual([{ propertyId: "9", label: "Main Property" }]);
  });

  test("primary falls back to first property when primaryAnalyticsPropertyId unset", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({
        primaryAnalyticsPropertyId: undefined,
        googleAnalyticsProperties: [{ propertyId: "aaa", label: "A" }, { propertyId: "bbb", label: "B" }],
      }) as any
    );
    const r = await resolveAnalyticsConfig({ userId: "owner-1", orgId: "org-1" });
    expect(r.primaryPropertyId).toBe("aaa");
  });
});

describe("resolveConfigTarget", () => {
  test("solo user → kind 'user', canEdit true", async () => {
    const t = await resolveConfigTarget({ userId: "solo-1" });
    expect(t).toEqual({ kind: "user", id: "solo-1", canEdit: true });
  });

  test("org owner → kind 'org', canEdit true", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(migratedOrg() as any);
    const t = await resolveConfigTarget({ userId: "owner-1", orgId: "org-1" });
    expect(t).toEqual({ kind: "org", id: "org-1", canEdit: true });
  });

  test("org editor → kind 'org', canEdit true", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({ shareSettings: { analytics: { enabled: true, editors: ["m-1"] } } }) as any
    );
    const t = await resolveConfigTarget({ userId: "m-1", orgId: "org-1" });
    expect(t).toEqual({ kind: "org", id: "org-1", canEdit: true });
  });

  test("plain member → kind 'org', canEdit false", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(migratedOrg() as any);
    const t = await resolveConfigTarget({ userId: "m-1", orgId: "org-1" });
    expect(t).toEqual({ kind: "org", id: "org-1", canEdit: false });
  });

  test("orgId set but org missing → kind 'user', canEdit true", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(null);
    const t = await resolveConfigTarget({ userId: "m-1", orgId: "org-1" });
    expect(t).toEqual({ kind: "user", id: "m-1", canEdit: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest analyticsConfigResolver -- --silent`
Expected: FAIL — `resolveConfigTarget` is not exported yet and resolver behavior differs.

- [ ] **Step 3: Rewrite the resolver**

Replace the entire contents of `backend/src/services/analyticsConfigResolver.ts`:

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

export interface ConfigTarget {
  kind: "org" | "user";
  id: string;
  canEdit: boolean;
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
  const explicitPrimary =
    typeof u?.primaryAnalyticsPropertyId === "string" &&
    properties.some((p) => p.propertyId === u.primaryAnalyticsPropertyId)
      ? u.primaryAnalyticsPropertyId
      : null;
  return {
    properties,
    primaryPropertyId: explicitPrimary ?? properties[0]?.propertyId ?? null,
    gaFilteredDomains: u?.gaFilteredDomains ?? [],
    productDomain: u?.productDomain,
    seoDomains: u?.seoDomains ?? [],
    clarityProjects: normaliseClarity(u),
    source,
  };
}

const EMPTY_BUNDLE: ResolvedAnalyticsConfig = {
  properties: [], primaryPropertyId: null, gaFilteredDomains: [],
  productDomain: undefined, seoDomains: [], clarityProjects: [], source: "self",
};

/** True when org-wide analytics sharing is on, reading the new location with a legacy fallback. */
function isSharingEnabled(org: any): boolean {
  return org?.shareSettings?.analytics?.enabled ?? org?.shareAnalyticsWithOrg ?? false;
}

/**
 * Resolve the analytics configuration that drives every analytics surface for
 * `user`. Org users read the Organization record (falling back to the owner's
 * user record for un-migrated orgs). Plain members get an empty config when
 * sharing is off; the owner and analytics editors always get the config.
 */
export async function resolveAnalyticsConfig(user: any): Promise<ResolvedAnalyticsConfig> {
  if (!user?.orgId) return buildBundle(user, "self");

  const org = await orgDb.getOrgById(user.orgId);
  if (!org) return buildBundle(user, "self"); // orgId set but no Org record → treat as solo

  const isOwner = org.ownerUserId === user.userId;
  const isEditor =
    Array.isArray(org.shareSettings?.analytics?.editors) &&
    org.shareSettings!.analytics!.editors.includes(user.userId);

  if (!isOwner && !isEditor && !isSharingEnabled(org)) {
    return { ...EMPTY_BUNDLE };
  }

  let configSource: any;
  if (org.analyticsConfigSource) {
    configSource = org;
  } else {
    console.warn(`[resolveAnalyticsConfig] org ${org.orgId} not migrated — using owner-record fallback`);
    configSource = isOwner ? user : await userDb.getUserById(org.ownerUserId);
  }

  return buildBundle(configSource, isOwner ? "self" : "org");
}

/**
 * Resolve where `user`'s analytics config is edited and whether they may edit
 * it. Org users target the Organization record; only the owner and analytics
 * editors may edit. Solo users target their own user record.
 */
export async function resolveConfigTarget(user: any): Promise<ConfigTarget> {
  if (!user?.orgId) return { kind: "user", id: user.userId, canEdit: true };

  const org = await orgDb.getOrgById(user.orgId);
  if (!org) return { kind: "user", id: user.userId, canEdit: true };

  const isOwner = org.ownerUserId === user.userId;
  const isEditor =
    Array.isArray(org.shareSettings?.analytics?.editors) &&
    org.shareSettings!.analytics!.editors.includes(user.userId);

  return { kind: "org", id: org.orgId, canEdit: isOwner || isEditor };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx jest analyticsConfigResolver -- --silent` → Expected: PASS.
Run: `cd backend && npx tsc` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/analyticsConfigResolver.ts backend/src/__tests__/analyticsConfigResolver.test.ts
git commit -m "feat(crm): resolve analytics config from the Organization record"
```

---

### Task 4: Org-share settings — accept `analytics`, tolerate old clients, fix factory/cleanup

**Files:**
- Modify: `backend/src/routes/orgShareSettings.ts`
- Test: `backend/src/__tests__/orgShareSettings.analytics.test.ts` (new)
- Modify: any file `tsc` flagged in Task 1 Step 4 that constructs an `OrgShareSettings` literal (a default factory and the member-removal cleanup).

`TOGGLEABLE_FEATURES` now includes `analytics`, so `validateSettings()` would reject bodies from the not-yet-deployed customer portal. The PATCH handler must default `analytics` from the org's existing settings when the inbound body omits it.

- [ ] **Step 1: Find the OrgShareSettings literals and the member-removal cleanup**

Run: `cd backend && grep -rn "knowledgeBase:" src --include=*.ts | grep -v __tests__`
This finds every place an `OrgShareSettings` object is built (a default factory) — each needs an `analytics:` key. Also run:
Run: `cd backend && grep -rln "shareSettings" src --include=*.ts | grep -v __tests__`
Open each hit; find the member-removal code (it strips a departing member from `shareSettings.*.editors`).

- [ ] **Step 2: Write the failing test**

Create `backend/src/__tests__/orgShareSettings.analytics.test.ts`:

```typescript
import request from "supertest";
import express from "express";
import orgShareRoutes from "../routes/orgShareSettings";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: req.headers["x-uid"] }; next(); },
}));

jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn(), updateShareSettings: jest.fn() },
}));

import { userDb, orgDb } from "../services/db";
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;

const app = express();
app.use(express.json());
app.use("/api/org-share-settings", orgShareRoutes);

const FULL = {
  knowledgeBase: { enabled: false, editors: [] },
  htmlTemplates: { enabled: false, editors: [] },
  landingPages: { enabled: false, editors: [] },
  workPlans: { enabled: false, editors: [] },
  skills: { enabled: false, editors: [] },
  funnels: { enabled: false, editors: [] },
  analytics: { enabled: true, editors: [] },
  brandGuidelines: { editors: [] },
  marketingStrategy: { editors: [] },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: "owner-1", orgId: "org-1", orgRole: "owner" } as any);
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareSettings: FULL } as any);
  mockOrgDb.getOrgMembers.mockResolvedValue([{ userId: "owner-1" }, { userId: "m-1" }] as any);
});

test("owner can save settings including analytics", async () => {
  const res = await request(app).patch("/api/org-share-settings/")
    .set("x-uid", "owner-1").send({ shareSettings: { ...FULL, analytics: { enabled: true, editors: ["m-1"] } } });
  expect(res.status).toBe(200);
  expect(mockOrgDb.updateShareSettings).toHaveBeenCalled();
});

test("body omitting analytics is back-filled from existing org settings (old client)", async () => {
  const { analytics, ...withoutAnalytics } = FULL;
  const res = await request(app).patch("/api/org-share-settings/")
    .set("x-uid", "owner-1").send({ shareSettings: withoutAnalytics });
  expect(res.status).toBe(200);
  const saved = mockOrgDb.updateShareSettings.mock.calls[0][1];
  expect(saved.analytics).toEqual({ enabled: true, editors: [] });
});

test("non-owner editor cannot change settings → 403", async () => {
  mockUserDb.getUserById.mockResolvedValue({ userId: "m-1", orgId: "org-1", orgRole: "member" } as any);
  const res = await request(app).patch("/api/org-share-settings/")
    .set("x-uid", "m-1").send({ shareSettings: FULL });
  expect(res.status).toBe(403);
});

test("analytics editor not in org → 400", async () => {
  const res = await request(app).patch("/api/org-share-settings/")
    .set("x-uid", "owner-1")
    .send({ shareSettings: { ...FULL, analytics: { enabled: true, editors: ["stranger"] } } });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx jest orgShareSettings.analytics -- --silent`
Expected: FAIL (the back-fill test fails — `validateSettings` rejects the missing `analytics` key).

- [ ] **Step 4: Patch the PATCH handler to back-fill `analytics`**

In `backend/src/routes/orgShareSettings.ts`, inside `router.patch("/")`, replace the line:

```typescript
    const validated = validateSettings(req.body?.shareSettings);
```

with:

```typescript
    // Back-fill `analytics` from the org's existing settings when an older client
    // omits it, so the not-yet-deployed customer portal keeps working.
    const incoming = req.body?.shareSettings;
    if (incoming && typeof incoming === "object" && incoming.analytics === undefined) {
      incoming.analytics = org.shareSettings?.analytics ?? { enabled: false, editors: [] };
    }
    const validated = validateSettings(incoming);
```

Note: `org` is already in scope — the handler fetches it via `orgDb.getOrgById(user.orgId)` for the member check. If the current handler does NOT fetch `org` before this point, add `const org = await orgDb.getOrgById(user.orgId);` right after the `user.orgRole !== "owner"` guard.

- [ ] **Step 5: Fix the OrgShareSettings factory and member-removal cleanup**

For each default-factory literal found in Step 1, add the `analytics` key:

```typescript
  analytics: { enabled: false, editors: [] },
```

For the member-removal cleanup found in Step 1: if it iterates `TOGGLEABLE_FEATURES` / `ALWAYS_ON_FEATURES`, no change is needed — `analytics` is already in `TOGGLEABLE_FEATURES` (Task 1). If it hard-codes feature names (e.g. `["knowledgeBase", "funnels", ...]`), add `"analytics"` to that list so a departing member is stripped from `analytics.editors`.

- [ ] **Step 6: Run tests + tsc**

Run: `cd backend && npx jest orgShareSettings.analytics -- --silent` → Expected: PASS (4 tests).
Run: `cd backend && npx tsc` → Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/orgShareSettings.ts backend/src/__tests__/orgShareSettings.analytics.test.ts
git add -A backend/src
git commit -m "feat(crm): wire analytics feature into org share-settings"
```

---

### Task 5: `readAnalyticsConfig` / `writeAnalyticsConfig` store helpers

**Files:**
- Create: `backend/src/services/analyticsConfigStore.ts`
- Test: `backend/src/__tests__/analyticsConfigStore.test.ts`

Read/write the *editable* analytics config against a `ConfigTarget` (Org record or user record).

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/analyticsConfigStore.test.ts`:

```typescript
import { readAnalyticsConfig, writeAnalyticsConfig } from "../services/analyticsConfigStore";
import { orgDb, userDb } from "../services/db";

jest.mock("../services/db", () => ({
  orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() },
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
}));

const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

beforeEach(() => jest.clearAllMocks());

test("readAnalyticsConfig from org target", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({
    orgId: "org-1", seoDomains: ["acme.com"],
    googleAnalyticsProperties: [{ propertyId: "1", label: "A" }],
    primaryAnalyticsPropertyId: "1", clarityProjects: [], gaFilteredDomains: [],
  } as any);
  const cfg = await readAnalyticsConfig({ kind: "org", id: "org-1", canEdit: true });
  expect(cfg.seoDomains).toEqual(["acme.com"]);
  expect(cfg.primaryAnalyticsPropertyId).toBe("1");
});

test("readAnalyticsConfig from user target", async () => {
  mockUserDb.getUserById.mockResolvedValue({ userId: "u-1", seoDomains: ["solo.com"] } as any);
  const cfg = await readAnalyticsConfig({ kind: "user", id: "u-1", canEdit: true });
  expect(cfg.seoDomains).toEqual(["solo.com"]);
  expect(cfg.googleAnalyticsProperties).toEqual([]);
});

test("writeAnalyticsConfig to org target sets analyticsConfigSource='self'", async () => {
  await writeAnalyticsConfig({ kind: "org", id: "org-1", canEdit: true }, { seoDomains: ["x.com"] });
  expect(mockOrgDb.updateOrg).toHaveBeenCalledWith("org-1", { seoDomains: ["x.com"], analyticsConfigSource: "self" });
});

test("writeAnalyticsConfig to user target does NOT set analyticsConfigSource", async () => {
  await writeAnalyticsConfig({ kind: "user", id: "u-1", canEdit: true }, { seoDomains: ["x.com"] });
  expect(mockUserDb.updateUser).toHaveBeenCalledWith("u-1", { seoDomains: ["x.com"] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest analyticsConfigStore -- --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/analyticsConfigStore.ts`:

```typescript
import { orgDb, userDb } from "./db";
import type { ConfigTarget } from "./analyticsConfigResolver";
import type { AnalyticsConfigValue } from "./analyticsConfigValidator";

export interface StoredAnalyticsConfig {
  seoDomains: string[];
  googleAnalyticsProperties: Array<{ propertyId: string; label: string }>;
  primaryAnalyticsPropertyId: string | null;
  gaFilteredDomains: string[];
  clarityProjects: Array<{ projectId: string; label: string }>;
  productDomain: string | null;
}

function shape(rec: any): StoredAnalyticsConfig {
  return {
    seoDomains: rec?.seoDomains ?? [],
    googleAnalyticsProperties: rec?.googleAnalyticsProperties ?? [],
    primaryAnalyticsPropertyId: rec?.primaryAnalyticsPropertyId ?? null,
    gaFilteredDomains: rec?.gaFilteredDomains ?? [],
    clarityProjects: rec?.clarityProjects ?? [],
    productDomain: rec?.productDomain ?? null,
  };
}

/** Read the editable analytics config from the target record (Org or user). */
export async function readAnalyticsConfig(target: ConfigTarget): Promise<StoredAnalyticsConfig> {
  const rec = target.kind === "org"
    ? await orgDb.getOrgById(target.id)
    : await userDb.getUserById(target.id);
  return shape(rec);
}

/**
 * Write the provided fields to the target record. Uses attribute-level updates
 * (orgDb.updateOrg / userDb.updateUser both build per-field UpdateExpressions),
 * so concurrent section saves never clobber each other. Org writes also stamp
 * `analyticsConfigSource: "self"` so the resolver trusts the Org record.
 */
export async function writeAnalyticsConfig(
  target: ConfigTarget,
  fields: Partial<AnalyticsConfigValue>,
): Promise<void> {
  if (target.kind === "org") {
    await orgDb.updateOrg(target.id, { ...fields, analyticsConfigSource: "self" } as any);
  } else {
    await userDb.updateUser(target.id, fields as any);
  }
}
```

- [ ] **Step 4: Run test + tsc**

Run: `cd backend && npx jest analyticsConfigStore -- --silent` → Expected: PASS (4 tests).
Run: `cd backend && npx tsc` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/analyticsConfigStore.ts backend/src/__tests__/analyticsConfigStore.test.ts
git commit -m "feat(crm): add analytics config store helpers"
```

---

### Task 6: `GET /api/seo/config` endpoint

**Files:**
- Modify: `backend/src/routes/seo.ts` (add import + route)
- Create: `backend/src/__tests__/seo.config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/seo.config.test.ts`:

```typescript
import request from "supertest";
import express from "express";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: req.headers["x-uid"] }; next(); },
}));
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock("../services/analyticsConfigResolver", () => ({
  resolveConfigTarget: jest.fn(),
}));
jest.mock("../services/analyticsConfigStore", () => ({
  readAnalyticsConfig: jest.fn(),
  writeAnalyticsConfig: jest.fn(),
}));
jest.mock("../services/seoService", () => ({
  getGoogleAnalyticsDataClient: jest.fn(),
  getGoogleSearchConsoleAccessToken: jest.fn(),
  getTechnicalSeoScore: jest.fn(),
  testGaProperty: jest.fn(),
  getServiceAccountEmail: jest.fn().mockResolvedValue("svc@iam.gserviceaccount.com"),
}));

import { userDb } from "../services/db";
import { resolveConfigTarget } from "../services/analyticsConfigResolver";
import { readAnalyticsConfig } from "../services/analyticsConfigStore";
import seoRoutes from "../routes/seo";

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockResolveTarget = resolveConfigTarget as jest.Mock;
const mockRead = readAnalyticsConfig as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api/seo", seoRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: "u-1" } as any);
  mockRead.mockResolvedValue({ seoDomains: ["acme.com"], googleAnalyticsProperties: [] });
});

test("GET /config returns config, canEdit, scope, serviceAccountEmail", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
  const res = await request(app).get("/api/seo/config").set("x-uid", "u-1");
  expect(res.status).toBe(200);
  expect(res.body.canEdit).toBe(true);
  expect(res.body.scope).toBe("org");
  expect(res.body.config.seoDomains).toEqual(["acme.com"]);
  expect(res.body.serviceAccountEmail).toBe("svc@iam.gserviceaccount.com");
});

test("GET /config for a member returns canEdit false, scope org", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: false });
  const res = await request(app).get("/api/seo/config").set("x-uid", "u-1");
  expect(res.status).toBe(200);
  expect(res.body.canEdit).toBe(false);
  expect(res.body.scope).toBe("org");
});

test("GET /config for a solo user → scope self", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "user", id: "u-1", canEdit: true });
  const res = await request(app).get("/api/seo/config").set("x-uid", "u-1");
  expect(res.body.scope).toBe("self");
});

test("delegation: req.user is the target customer → resolves the target's org config", async () => {
  // Under a delegated session the auth middleware sets req.user to the TARGET
  // customer (CLAUDE.md). The endpoint resolves config for whoever req.user is,
  // so driving x-uid with the target's id is the delegated path.
  mockUserDb.getUserById.mockResolvedValue({ userId: "target-cust", orgId: "org-9" } as any);
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-9", canEdit: true });
  const res = await request(app).get("/api/seo/config").set("x-uid", "target-cust");
  expect(res.status).toBe(200);
  expect(mockResolveTarget).toHaveBeenCalledWith(expect.objectContaining({ userId: "target-cust" }));
  expect(res.body.scope).toBe("org");
});

test("GET /config unknown user → 404", async () => {
  mockUserDb.getUserById.mockResolvedValue(null as any);
  const res = await request(app).get("/api/seo/config").set("x-uid", "ghost");
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest seo.config -- --silent`
Expected: FAIL — `getServiceAccountEmail` is not exported from `seoService` and the route does not exist (404 on a route the test expects 200).

- [ ] **Step 3: Add `getServiceAccountEmail` to seoService**

In `backend/src/services/seoService.ts`, add this exported helper near `getGoogleAnalyticsDataClient` (it factors out the logic the existing `GET /service-account-email` route inlines):

```typescript
/** Returns the shared Google service-account email users must grant access to. */
export async function getServiceAccountEmail(): Promise<string | null> {
  try {
    const secretName = process.env.NODE_ENV === "production"
      ? "prod/AgentWeb/Google/SearchConsole"
      : "dev/AgentWeb/Google/SearchConsole";
    const serviceAccount = JSON.parse(await getSecret(secretName));
    return serviceAccount.client_email || null;
  } catch (error: any) {
    console.error("Error fetching service account email:", error.message);
    return null;
  }
}
```

- [ ] **Step 4: Add the route to seo.ts**

In `backend/src/routes/seo.ts`, extend the import from `../services/analyticsConfigResolver`:

```typescript
import { resolveAnalyticsConfig, resolveConfigTarget } from "../services/analyticsConfigResolver";
```

Add new imports below it:

```typescript
import { readAnalyticsConfig, writeAnalyticsConfig } from "../services/analyticsConfigStore";
import { validateAnalyticsConfig } from "../services/analyticsConfigValidator";
import { getServiceAccountEmail, testGaProperty } from "../services/seoService";
```

(`testGaProperty` is created in Task 8 — adding the import now is harmless; if `tsc` complains before Task 8, complete Task 8's Step 3 first or add a temporary stub. Recommended: do Tasks 6–8 as a unit, committing each.)

Add the route — place it after the `router.use(authenticateToken)` line, before `GET /metrics`:

```typescript
// Get the caller's editable analytics config (self-service Settings tab).
router.get("/config", async (req, res) => {
  try {
    const user = await userDb.getUserById((req as any).user.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    const target = await resolveConfigTarget(user);
    const config = await readAnalyticsConfig(target);
    const serviceAccountEmail = await getServiceAccountEmail();
    res.json({
      config,
      canEdit: target.canEdit,
      scope: target.kind === "org" ? "org" : "self",
      serviceAccountEmail,
    });
  } catch (error: any) {
    console.error("Error fetching analytics config:", error.message);
    res.status(500).json({ message: "Failed to fetch analytics config" });
  }
});
```

- [ ] **Step 5: Run test + tsc**

Run: `cd backend && npx jest seo.config -- --silent` → Expected: the GET tests PASS (PUT/test-endpoint tests added in Tasks 7–8 are not in this file yet).
Run: `cd backend && npx tsc` → Expected: PASS once Task 8 Step 3 is done, else stub `testGaProperty`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/seo.ts backend/src/services/seoService.ts backend/src/__tests__/seo.config.test.ts
git commit -m "feat(crm): add GET /api/seo/config self-service endpoint"
```

---

### Task 7: `PUT /api/seo/config/ga` · `/seo-domains` · `/clarity`

**Files:**
- Modify: `backend/src/routes/seo.ts`
- Modify: `backend/src/__tests__/seo.config.test.ts` (add cases)

- [ ] **Step 1: Add failing tests**

Append to `backend/src/__tests__/seo.config.test.ts` (inside the file, after the existing tests):

```typescript
import { writeAnalyticsConfig } from "../services/analyticsConfigStore";
const mockWrite = writeAnalyticsConfig as jest.Mock;

describe("PUT /api/seo/config sections", () => {
  beforeEach(() => {
    mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
  });

  test("PUT /config/ga saves GA properties + primary", async () => {
    const res = await request(app).put("/api/seo/config/ga").set("x-uid", "u-1").send({
      googleAnalyticsProperties: [{ propertyId: "1", label: "A" }],
      primaryAnalyticsPropertyId: "1",
      gaFilteredDomains: [], productDomain: null,
    });
    expect(res.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(
      { kind: "org", id: "org-1", canEdit: true },
      expect.objectContaining({ googleAnalyticsProperties: [{ propertyId: "1", label: "A" }], primaryAnalyticsPropertyId: "1" }),
    );
  });

  test("PUT /config/ga with primary not in properties → 400", async () => {
    const res = await request(app).put("/api/seo/config/ga").set("x-uid", "u-1").send({
      googleAnalyticsProperties: [{ propertyId: "1", label: "A" }],
      primaryAnalyticsPropertyId: "999",
    });
    expect(res.status).toBe(400);
  });

  test("PUT /config/ga when caller cannot edit → 403", async () => {
    mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: false });
    const res = await request(app).put("/api/seo/config/ga").set("x-uid", "u-1")
      .send({ googleAnalyticsProperties: [] });
    expect(res.status).toBe(403);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("PUT /config/seo-domains saves domains", async () => {
    const res = await request(app).put("/api/seo/config/seo-domains").set("x-uid", "u-1")
      .send({ seoDomains: ["acme.com"] });
    expect(res.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(expect.anything(), { seoDomains: ["acme.com"] });
  });

  test("PUT /config/seo-domains rejects bad domain → 400", async () => {
    const res = await request(app).put("/api/seo/config/seo-domains").set("x-uid", "u-1")
      .send({ seoDomains: ["not a domain"] });
    expect(res.status).toBe(400);
  });

  test("PUT /config/clarity saves projects", async () => {
    const res = await request(app).put("/api/seo/config/clarity").set("x-uid", "u-1")
      .send({ clarityProjects: [{ projectId: "ul13e4f7fe", label: "Site" }] });
    expect(res.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(expect.anything(),
      { clarityProjects: [{ projectId: "ul13e4f7fe", label: "Site" }] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest seo.config -- --silent`
Expected: FAIL — the three PUT routes return 404.

- [ ] **Step 3: Add the three routes to seo.ts**

In `backend/src/routes/seo.ts`, immediately after the `GET /config` route, add:

```typescript
// Shared guard: load the caller, resolve the write target, enforce canEdit.
async function loadEditableTarget(req: any, res: any) {
  const user = await userDb.getUserById(req.user.userId);
  if (!user) { res.status(404).json({ message: "User not found" }); return null; }
  const target = await resolveConfigTarget(user);
  if (!target.canEdit) { res.status(403).json({ message: "Not allowed to edit analytics config" }); return null; }
  return target;
}

// Save GA4 properties, primary, filtered domains, product domain.
router.put("/config/ga", async (req, res) => {
  try {
    const target = await loadEditableTarget(req, res);
    if (!target) return;
    const v = validateAnalyticsConfig({
      googleAnalyticsProperties: req.body.googleAnalyticsProperties,
      primaryAnalyticsPropertyId: req.body.primaryAnalyticsPropertyId,
      gaFilteredDomains: req.body.gaFilteredDomains,
      productDomain: req.body.productDomain,
    });
    if (!v.ok) return res.status(400).json({ message: v.error });
    await writeAnalyticsConfig(target, v.value);
    res.json({ ok: true, config: await readAnalyticsConfig(target) });
  } catch (error: any) {
    console.error("Error saving GA config:", error.message);
    res.status(500).json({ message: "Failed to save GA config" });
  }
});

// Save SEO domains.
router.put("/config/seo-domains", async (req, res) => {
  try {
    const target = await loadEditableTarget(req, res);
    if (!target) return;
    const v = validateAnalyticsConfig({ seoDomains: req.body.seoDomains });
    if (!v.ok) return res.status(400).json({ message: v.error });
    await writeAnalyticsConfig(target, v.value);
    res.json({ ok: true, config: await readAnalyticsConfig(target) });
  } catch (error: any) {
    console.error("Error saving SEO domains:", error.message);
    res.status(500).json({ message: "Failed to save SEO domains" });
  }
});

// Save Clarity projects.
router.put("/config/clarity", async (req, res) => {
  try {
    const target = await loadEditableTarget(req, res);
    if (!target) return;
    const v = validateAnalyticsConfig({ clarityProjects: req.body.clarityProjects });
    if (!v.ok) return res.status(400).json({ message: v.error });
    await writeAnalyticsConfig(target, v.value);
    res.json({ ok: true, config: await readAnalyticsConfig(target) });
  } catch (error: any) {
    console.error("Error saving Clarity config:", error.message);
    res.status(500).json({ message: "Failed to save Clarity config" });
  }
});
```

- [ ] **Step 4: Run tests + tsc**

Run: `cd backend && npx jest seo.config -- --silent` → Expected: PASS for all GET + PUT cases.
Run: `cd backend && npx tsc` → Expected: PASS (after Task 8 Step 3, or with the `testGaProperty` import temporarily removed).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/seo.ts backend/src/__tests__/seo.config.test.ts
git commit -m "feat(crm): add PUT /api/seo/config section endpoints"
```

---

### Task 8: `testGaProperty` + `POST /api/seo/config/ga/test` (with rate limit)

**Files:**
- Modify: `backend/src/services/seoService.ts` (add `testGaProperty`)
- Modify: `backend/src/routes/seo.ts` (add route + tiny rate limiter)
- Modify: `backend/src/__tests__/seo.config.test.ts` (add cases)

- [ ] **Step 1: Add failing tests**

Append to `backend/src/__tests__/seo.config.test.ts`:

```typescript
import { testGaProperty } from "../services/seoService";
const mockTestGa = testGaProperty as jest.Mock;

describe("POST /api/seo/config/ga/test", () => {
  beforeEach(() => mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true }));

  test("valid property, connected → ok true", async () => {
    mockTestGa.mockResolvedValue({ ok: true });
    const res = await request(app).post("/api/seo/config/ga/test").set("x-uid", "u-1")
      .send({ propertyId: "123" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("permission denied → ok false reason permission_denied", async () => {
    mockTestGa.mockResolvedValue({ ok: false, reason: "permission_denied" });
    const res = await request(app).post("/api/seo/config/ga/test").set("x-uid", "u-1")
      .send({ propertyId: "123" });
    expect(res.body).toMatchObject({ ok: false, reason: "permission_denied" });
  });

  test("non-numeric propertyId → 400 reason invalid", async () => {
    const res = await request(app).post("/api/seo/config/ga/test").set("x-uid", "u-1")
      .send({ propertyId: "G-ABC" });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("invalid");
  });

  test("caller cannot edit → 403", async () => {
    mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: false });
    const res = await request(app).post("/api/seo/config/ga/test").set("x-uid", "u-1")
      .send({ propertyId: "123" });
    expect(res.status).toBe(403);
  });

  test("rapid repeat from same user → 429", async () => {
    mockTestGa.mockResolvedValue({ ok: true });
    await request(app).post("/api/seo/config/ga/test").set("x-uid", "rate-u").send({ propertyId: "1" });
    const res = await request(app).post("/api/seo/config/ga/test").set("x-uid", "rate-u").send({ propertyId: "1" });
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx jest seo.config -- --silent`
Expected: FAIL — `testGaProperty` not exported, route 404.

- [ ] **Step 3: Add `testGaProperty` to seoService.ts**

In `backend/src/services/seoService.ts`, add:

```typescript
/**
 * Probe a GA4 property with the shared service account. Used by the
 * "Test connection" button so users see permission problems immediately.
 */
export async function testGaProperty(
  propertyId: string,
): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const client = await getGoogleAnalyticsDataClient();
  if (!client) return { ok: false, reason: "error", message: "GA client unavailable" };
  try {
    await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: "yesterday", endDate: "today" }],
      metrics: [{ name: "sessions" }],
      limit: 1,
    });
    return { ok: true };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (e?.code === 7 || /PERMISSION_DENIED/i.test(msg)) return { ok: false, reason: "permission_denied", message: msg };
    if (e?.code === 5 || e?.code === 3 || /NOT_FOUND|INVALID_ARGUMENT/i.test(msg)) {
      return { ok: false, reason: "not_found", message: msg };
    }
    return { ok: false, reason: "error", message: msg };
  }
}
```

- [ ] **Step 4: Add the route + rate limiter to seo.ts**

In `backend/src/routes/seo.ts`, after the three PUT routes add:

```typescript
// Per-user cooldown for the GA test probe (2s) — prevents property-ID enumeration.
const gaTestCooldown = new Map<string, number>();

// Live-test a GA4 property with the shared service account.
router.post("/config/ga/test", async (req, res) => {
  try {
    const target = await loadEditableTarget(req, res);
    if (!target) return;
    const propertyId = String(req.body.propertyId || "").trim();
    if (!/^\d+$/.test(propertyId)) {
      return res.status(400).json({ ok: false, reason: "invalid", message: "Property ID must be numeric" });
    }
    const uid = (req as any).user.userId;
    const now = Date.now();
    if (now - (gaTestCooldown.get(uid) ?? 0) < 2000) {
      return res.status(429).json({ ok: false, reason: "rate_limited", message: "Please wait before testing again" });
    }
    gaTestCooldown.set(uid, now);
    res.json(await testGaProperty(propertyId));
  } catch (error: any) {
    console.error("Error testing GA property:", error.message);
    res.status(500).json({ ok: false, reason: "error", message: "Failed to test GA property" });
  }
});
```

- [ ] **Step 5: Run tests + tsc**

Run: `cd backend && npx jest seo.config -- --silent` → Expected: PASS (all GET/PUT/test cases).
Run: `cd backend && npx tsc` → Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/seo.ts backend/src/services/seoService.ts backend/src/__tests__/seo.config.test.ts
git commit -m "feat(crm): add GA4 test-connection endpoint"
```

---

### Task 9: Admin routes — read/write the new locations

**Files:**
- Modify: `backend/src/routes/admin.ts` (`GET /users` ~529-587, `PUT /users/:userId/seo-aeo` ~1160-1398, `PATCH /orgs/:orgId/analytics-sharing` ~112-129; add new `GET /users/:userId/seo-aeo`)
- Create: `backend/src/__tests__/admin.seoAeoResolve.test.ts`

The admin "Configure SEO/AEO" dialog must read and write the resolved target (Org record for org users). `PATCH analytics-sharing` must write `shareSettings.analytics.enabled`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/admin.seoAeoResolve.test.ts`:

```typescript
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import adminRoutes from "../routes/admin";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    try { req.user = jwt.verify(token, JWT_SECRET); next(); }
    catch { res.status(401).json({ message: "Unauthorized" }); }
  },
}));
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn(), getAllUsers: jest.fn(), updateUser: jest.fn() },
  taskDb: {}, subscriberDb: {}, crmDb: {},
  orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn(), updateShareSettings: jest.fn() },
}));
jest.mock("../services/settingsService", () => ({
  settingsService: { getSetting: jest.fn().mockResolvedValue(null), setSetting: jest.fn() },
}));
jest.mock("../services/analyticsConfigResolver", () => ({
  resolveConfigTarget: jest.fn(),
}));
jest.mock("../services/analyticsConfigStore", () => ({
  readAnalyticsConfig: jest.fn(),
  writeAnalyticsConfig: jest.fn(),
}));

import { userDb, orgDb } from "../services/db";
import { resolveConfigTarget } from "../services/analyticsConfigResolver";
import { readAnalyticsConfig, writeAnalyticsConfig } from "../services/analyticsConfigStore";

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockResolveTarget = resolveConfigTarget as jest.Mock;
const mockRead = readAnalyticsConfig as jest.Mock;
const mockWrite = writeAnalyticsConfig as jest.Mock;

const adminToken = jwt.sign({ userId: "admin-1", email: "a@x.com", isAdmin: true }, JWT_SECRET);

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: "u-1", orgId: "org-1" } as any);
});

test("GET /users/:id/seo-aeo resolves the target and returns config", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
  mockRead.mockResolvedValue({ seoDomains: ["acme.com"], googleAnalyticsProperties: [] });
  const res = await request(app).get("/api/admin/users/u-1/seo-aeo")
    .set("Authorization", `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.config.seoDomains).toEqual(["acme.com"]);
  expect(res.body.scope).toBe("org");
});

test("GET /users/:id/seo-aeo unknown user → 404", async () => {
  mockUserDb.getUserById.mockResolvedValue(null as any);
  const res = await request(app).get("/api/admin/users/ghost/seo-aeo")
    .set("Authorization", `Bearer ${adminToken}`);
  expect(res.status).toBe(404);
});

test("PUT /users/:id/seo-aeo writes to the resolved target", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
  mockRead.mockResolvedValue({ seoDomains: ["acme.com"] });
  const res = await request(app).put("/api/admin/users/u-1/seo-aeo")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ seoDomains: ["acme.com"], googleAnalyticsProperties: [{ propertyId: "1", label: "A" }] });
  expect(res.status).toBe(200);
  expect(mockWrite).toHaveBeenCalled();
});

test("PATCH /orgs/:id/analytics-sharing writes shareSettings.analytics.enabled", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({
    orgId: "org-1", ownerUserId: "owner-1",
    shareSettings: { analytics: { enabled: false, editors: [] } },
  } as any);
  const res = await request(app).patch("/api/admin/orgs/org-1/analytics-sharing")
    .set("Authorization", `Bearer ${adminToken}`).send({ enabled: true });
  expect(res.status).toBe(200);
  const call = mockOrgDb.updateShareSettings.mock.calls[0];
  expect(call[1].analytics.enabled).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest admin.seoAeoResolve -- --silent`
Expected: FAIL — new `GET /users/:id/seo-aeo` route 404; PATCH still writes the legacy boolean.

- [ ] **Step 3: Add imports to admin.ts**

At the top of `backend/src/routes/admin.ts`, add:

```typescript
import { resolveConfigTarget } from "../services/analyticsConfigResolver";
import { readAnalyticsConfig, writeAnalyticsConfig } from "../services/analyticsConfigStore";
import { validateAnalyticsConfig } from "../services/analyticsConfigValidator";
```

- [ ] **Step 4: Add `GET /users/:userId/seo-aeo`**

In `backend/src/routes/admin.ts`, immediately before the existing `router.put("/users/:userId/seo-aeo", ...)`, add:

```typescript
// Read a user's resolved analytics config (Org record if in an org, else user record).
router.get("/users/:userId/seo-aeo", async (req, res) => {
  try {
    const user = await userDb.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    const target = await resolveConfigTarget(user);
    const config = await readAnalyticsConfig(target);
    res.json({ config, scope: target.kind === "org" ? "org" : "self" });
  } catch (error: any) {
    console.error("Error reading user SEO/AEO config:", error.message);
    res.status(500).json({ message: "Error reading SEO/AEO configuration" });
  }
});
```

- [ ] **Step 5: Rewrite the body of `PUT /users/:userId/seo-aeo`**

Replace the entire handler body of `router.put("/users/:userId/seo-aeo", ...)` (lines ~1161-1397, the code between `try {` and the `catch`) with:

```typescript
    const { userId } = req.params;
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const v = validateAnalyticsConfig({
      seoDomains: req.body.seoDomains,
      googleAnalyticsProperties: req.body.googleAnalyticsProperties,
      primaryAnalyticsPropertyId: req.body.primaryAnalyticsPropertyId,
      gaFilteredDomains: req.body.gaFilteredDomains,
      clarityProjects: req.body.clarityProjects,
      productDomain: req.body.productDomain,
    });
    if (!v.ok) return res.status(400).json({ message: v.error });

    const target = await resolveConfigTarget(user);
    await writeAnalyticsConfig(target, v.value);
    res.json({ config: await readAnalyticsConfig(target), scope: target.kind === "org" ? "org" : "self" });
```

Note: the new self-service page and admin dialog send array fields only. The legacy singular `googleAnalyticsPropertyId` / `clarityProjectId` request fields are no longer accepted here — Task 12 confirms no remaining reader needs them written from this route.

- [ ] **Step 6: Rewrite `PATCH /orgs/:orgId/analytics-sharing`**

Replace the body of `router.patch("/orgs/:orgId/analytics-sharing", ...)` between `try {` and `catch` with:

```typescript
    const { orgId } = req.params;
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ message: "Body field 'enabled' must be a boolean" });
    }
    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ message: "Organization not found" });

    const existing = org.shareSettings?.analytics ?? { enabled: false, editors: [] };
    const shareSettings = {
      ...(org.shareSettings ?? {}),
      analytics: { enabled, editors: existing.editors },
    };
    await orgDb.updateShareSettings(orgId, shareSettings as any);
    return res.json({ orgId, analyticsSharingEnabled: enabled });
```

Note: if `org.shareSettings` is `undefined` (an org with no share settings yet), `updateShareSettings` would persist a partial object. This is acceptable because the migration script (Task 14) backfills a full `shareSettings`, and `validateSettings` back-fills on the next org-sharing PUT. No additional handling needed.

- [ ] **Step 7: Update `GET /users` to read the new sharing location**

In `backend/src/routes/admin.ts` `GET /users`, change the `orgMap` build line:

```typescript
          shareAnalyticsWithOrg: !!org.shareAnalyticsWithOrg,
```

to:

```typescript
          shareAnalyticsWithOrg: !!(org.shareSettings?.analytics?.enabled ?? org.shareAnalyticsWithOrg),
```

- [ ] **Step 8: Run tests + tsc**

Run: `cd backend && npx jest admin.seoAeoResolve admin.analyticsSharing admin.seoAeo -- --silent`
Expected: the new test PASSES. Pre-existing `admin.seoAeo` / `admin.analyticsSharing` tests may now fail because they assert the old shape — update those tests to the new request/response shape (array fields in, `{ config, scope }` out; `analyticsSharingEnabled` from PATCH). Re-run until green.
Run: `cd backend && npx tsc` → Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/routes/admin.ts backend/src/__tests__/admin.seoAeoResolve.test.ts backend/src/__tests__/admin.seoAeo.test.ts backend/src/__tests__/admin.analyticsSharing.test.ts
git commit -m "feat(crm): admin SEO/AEO routes read and write the Organization record"
```

---

### Task 10: `/api/auth/me` — add `canEditAnalyticsConfig`

**Files:**
- Modify: `backend/src/routes/auth.ts` (`GET /me`, near the `effectiveAnalyticsConfig` block ~155-160)
- Create: `backend/src/__tests__/auth.canEditAnalyticsConfig.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/auth.canEditAnalyticsConfig.test.ts`:

```typescript
import request from "supertest";
import express from "express";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: req.headers["x-uid"] }; next(); },
}));
jest.mock("../services/db", () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock("../services/analyticsConfigResolver", () => ({
  resolveAnalyticsConfig: jest.fn().mockResolvedValue({ properties: [], source: "self" }),
  resolveConfigTarget: jest.fn(),
}));

import { userDb } from "../services/db";
import { resolveConfigTarget } from "../services/analyticsConfigResolver";
import authRoutes from "../routes/auth";

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockResolveTarget = resolveConfigTarget as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: "u-1", email: "u@x.com", roles: [] } as any);
});

test("editor → canEditAnalyticsConfig true", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: true });
  const res = await request(app).get("/api/auth/me").set("x-uid", "u-1");
  expect(res.body.canEditAnalyticsConfig).toBe(true);
});

test("plain member → canEditAnalyticsConfig false", async () => {
  mockResolveTarget.mockResolvedValue({ kind: "org", id: "org-1", canEdit: false });
  const res = await request(app).get("/api/auth/me").set("x-uid", "u-1");
  expect(res.body.canEditAnalyticsConfig).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest auth.canEditAnalyticsConfig -- --silent`
Expected: FAIL — `canEditAnalyticsConfig` is `undefined`.

- [ ] **Step 3: Implement**

In `backend/src/routes/auth.ts`, ensure `resolveConfigTarget` is imported alongside `resolveAnalyticsConfig`:

```typescript
import { resolveAnalyticsConfig, resolveConfigTarget } from "../services/analyticsConfigResolver";
```

Then in `GET /me`, find the `effectiveAnalyticsConfig` try/catch block and replace it with:

```typescript
    // Effective analytics config + whether the caller may edit it (drives the
    // customer-portal SEO dashboard gating and the Analytics & SEO Settings tab).
    try {
      response.effectiveAnalyticsConfig = await resolveAnalyticsConfig(user);
      response.canEditAnalyticsConfig = (await resolveConfigTarget(user)).canEdit;
    } catch (e: any) {
      console.error('Error resolving analytics config for /me:', e.message);
      response.canEditAnalyticsConfig = false;
    }
```

- [ ] **Step 4: Run test + tsc**

Run: `cd backend && npx jest auth.canEditAnalyticsConfig -- --silent` → Expected: PASS.
Run: `cd backend && npx tsc` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/auth.ts backend/src/__tests__/auth.canEditAnalyticsConfig.test.ts
git commit -m "feat(crm): expose canEditAnalyticsConfig on /api/auth/me"
```

---

### Task 11: Bug C — verify shared-funnel metrics use the org property

**Files:**
- Modify: `backend/src/routes/seo.ts` (funnel-metrics block ~682-762 — comment only)

Bug C is **fixed by the Task 3 resolver rewrite**: in the org model the caller resolves to the org-level config, and the funnel-metrics block already passes `resolved.primaryPropertyId` to `calculateFunnelMetrics` (`seo.ts:~743`). The funnel owner is always in the same org (funnel sharing is intra-org via `OrgShareSettings.funnels`), so owner and viewer resolve to the *same* org property. The cross-member access gate added by `0ab05b44` (`seo.ts:~689-701`) is a permission check, is correct, and **stays**. There is no separate funnel-owner config resolution to remove.

- [ ] **Step 1: Fix the now-inaccurate comment**

In `backend/src/routes/seo.ts`, in the funnel-metrics block, update the comment above the `calculateFunnelMetrics(...)` call to:

```typescript
            // Funnel metrics run against the caller's resolved analytics config.
            // For org users this is the shared org-level GA4 property, so a
            // shared funnel's owner and viewer always use the same property.
```

- [ ] **Step 2: Verify against the test suite**

Run: `cd backend && npx jest analyticsConfigResolver -- --silent`
Expected: PASS — the resolver matrix tests (Task 3) prove an org member resolves to the org property; the funnel path consumes that value directly. No new behavior to unit-test here.

- [ ] **Step 3: Manual smoke verification (record in dev.md)**

After Phase 1 deploys to the test environment: as an org member with sharing ON, open `/seo`, select a shared funnel, load metrics. Expected: metrics load (no `PERMISSION_DENIED`) provided the org's GA4 property has the service account granted (use the Task 8 Test button to confirm the grant). Record the result in `dev.md`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/seo.ts
git commit -m "fix(crm): clarify shared-funnel metrics use the resolved org property"
```

---

### Task 12: Bug B root-cause audit — reroute direct config readers

**Files:**
- Modify: `backend/src/services/seoService.ts` (`getClarityProjects` ~460-470 and its callers)
- Modify: any other backend/portal file that reads analytics config directly off a user object

- [ ] **Step 1: Find every direct reader**

Run each grep and record the hits:

```bash
cd backend && grep -rn "\.googleAnalyticsPropertyId\|\.clarityProjectId" src --include=*.ts | grep -v __tests__ | grep -v analyticsConfigResolver
cd backend && grep -rn "\.googleAnalyticsProperties\|\.clarityProjects\|\.seoDomains\|\.gaFilteredDomains\|\.productDomain" src --include=*.ts | grep -v __tests__
cd backend && grep -rn "getClarityProjects(" src --include=*.ts | grep -v __tests__
```

For each hit, classify: (a) reads the field off a **user/Org record that came from `resolveAnalyticsConfig`/`readAnalyticsConfig`** → fine, leave it; (b) reads it **directly off a raw user object** for an analytics surface → must be rerouted.

- [ ] **Step 2: Reroute `getClarityProjects` callers**

`getClarityProjects(user)` reads `user.clarityProjects` directly — wrong for org members after the migration. For every caller of `getClarityProjects`, replace it with the resolved config. The transformation:

```typescript
// BEFORE
const projects = getClarityProjects(user);

// AFTER
const resolved = await resolveAnalyticsConfig(user);
const projects = resolved.clarityProjects;
```

Ensure `resolveAnalyticsConfig` is imported in each modified file. Once no caller remains, delete `getClarityProjects` from `seoService.ts`. If a caller already has a `resolved`/`resolvedConfig` in scope (e.g. `fetchClarityProjectInfo` already does), use that instead of resolving again.

- [ ] **Step 3: Reroute any other Category-(b) hits**

For each remaining Category-(b) hit, resolve via `resolveAnalyticsConfig(user)` and read the field off the result (`resolved.properties`, `resolved.seoDomains`, `resolved.gaFilteredDomains`, `resolved.productDomain`, `resolved.clarityProjects`). Leave Category-(a) hits unchanged.

- [ ] **Step 4: Verify + tsc**

Run: `cd backend && npx tsc` → Expected: PASS.
Run: `cd backend && npx jest -- --silent` → Expected: PASS (fix any test that referenced `getClarityProjects`).

- [ ] **Step 5: Commit**

```bash
git add -A backend/src
git commit -m "fix(crm): route analytics config readers through the resolver"
```

---

### Task 13: Phase 1 gate — full suite + coverage

- [ ] **Step 1: Run the whole backend suite**

Run: `cd backend && npx jest -- --silent`
Expected: PASS. Resolver consumers (`/api/seo/metrics`, `/api/seo/product-metrics`, `/api/auth/me`, emma tools, `chatbotService`, `seoAgentModeTools`) have existing tests — any failure here is a real regression from the resolver rewrite; fix the production code, not the test, unless the test asserted the obsolete `shareAnalyticsWithOrg` model.

- [ ] **Step 2: Coverage check**

Run: `cd backend && npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary`
Expected: ≥95% on statements, branches, functions, lines. Add tests for any uncovered branch in the new modules (`analyticsConfigValidator.ts`, `analyticsConfigResolver.ts`, `analyticsConfigStore.ts`, the new `seo.ts` routes).

- [ ] **Step 3: Final compile**

Run: `cd backend && npx tsc` → Expected: PASS.

- [ ] **Step 4: Commit any added coverage tests**

```bash
git add -A backend/src/__tests__
git commit -m "test(crm): cover analytics config branches to 95%"
```

---

# Phase 2 — Migration

### Task 14: One-time migration script

**Files:**
- Create: `backend/src/services/analyticsConfigMigration.ts` (pure `migrateOrg` — testable)
- Create: `backend/src/scripts/migrate-analytics-config.ts` (DynamoDB runner)
- Test: `backend/src/__tests__/analyticsConfigMigration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/analyticsConfigMigration.test.ts`:

```typescript
import { migrateOrg } from "../services/analyticsConfigMigration";

const owner = {
  userId: "owner-1",
  googleAnalyticsProperties: [{ propertyId: "111", label: "Owner GA" }],
  seoDomains: ["acme.com"],
  clarityProjects: [{ projectId: "cl-1", label: "C" }],
};

test("copies owner config onto an un-migrated org and stamps the marker", () => {
  const u = migrateOrg({ orgId: "o", ownerUserId: "owner-1", shareAnalyticsWithOrg: true } as any, owner as any);
  expect(u).not.toBeNull();
  expect(u!.googleAnalyticsProperties).toEqual([{ propertyId: "111", label: "Owner GA" }]);
  expect(u!.seoDomains).toEqual(["acme.com"]);
  expect(u!.analyticsConfigSource).toBe("migrated");
});

test("already-migrated org → null (idempotent)", () => {
  expect(migrateOrg({ orgId: "o", ownerUserId: "owner-1", analyticsConfigSource: "migrated" } as any, owner as any)).toBeNull();
});

test("self-saved org → null (never re-touched)", () => {
  expect(migrateOrg({ orgId: "o", ownerUserId: "owner-1", analyticsConfigSource: "self" } as any, owner as any)).toBeNull();
});

test("does not overwrite an Org field that is already set", () => {
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1", seoDomains: ["already.com"] } as any,
    owner as any,
  );
  expect(u!.seoDomains).toBeUndefined(); // already.com left untouched
  expect(u!.googleAnalyticsProperties).toEqual([{ propertyId: "111", label: "Owner GA" }]);
});

test("seeds shareSettings.analytics from legacy boolean when absent", () => {
  const existing = {
    knowledgeBase: { enabled: false, editors: [] }, htmlTemplates: { enabled: false, editors: [] },
    landingPages: { enabled: false, editors: [] }, workPlans: { enabled: false, editors: [] },
    skills: { enabled: false, editors: [] }, funnels: { enabled: false, editors: [] },
    brandGuidelines: { editors: [] }, marketingStrategy: { editors: [] },
  };
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1", shareAnalyticsWithOrg: true, shareSettings: existing } as any,
    owner as any,
  );
  expect(u!.shareSettings.analytics).toEqual({ enabled: true, editors: [] });
});

test("does NOT clobber a pre-existing shareSettings.analytics", () => {
  const existing = { analytics: { enabled: true, editors: ["x"] } };
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1", shareAnalyticsWithOrg: false, shareSettings: existing } as any,
    owner as any,
  );
  expect(u!.shareSettings).toBeUndefined(); // analytics already present → left alone
});

test("legacy singular owner fields normalise into arrays", () => {
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1" } as any,
    { userId: "owner-1", googleAnalyticsPropertyId: "999", clarityProjectId: "ul99x99x" } as any,
  );
  expect(u!.googleAnalyticsProperties).toEqual([{ propertyId: "999", label: "Main Property" }]);
  expect(u!.clarityProjects).toEqual([{ projectId: "ul99x99x", label: "Main Project" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest analyticsConfigMigration -- --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `migrateOrg`**

Create `backend/src/services/analyticsConfigMigration.ts`:

```typescript
import type { Organization } from "./db";

const CONFIG_FIELDS = [
  "googleAnalyticsProperties", "primaryAnalyticsPropertyId", "gaFilteredDomains",
  "seoDomains", "clarityProjects", "productDomain",
] as const;

/**
 * Compute the Organization update to migrate analytics config off the owner's
 * user record. Returns null when nothing should change (already migrated, or
 * already self-saved). Idempotent and "only if absent" — never clobbers
 * existing Org fields or an existing shareSettings.analytics.
 */
export function migrateOrg(org: Organization, ownerUser: any): Record<string, any> | null {
  if (org.analyticsConfigSource) return null;

  const updates: Record<string, any> = {};
  for (const f of CONFIG_FIELDS) {
    if ((org as any)[f] === undefined && ownerUser?.[f] !== undefined) {
      updates[f] = ownerUser[f];
    }
  }
  // Legacy singular owner fields → array form.
  if (org.googleAnalyticsProperties === undefined && updates.googleAnalyticsProperties === undefined
      && ownerUser?.googleAnalyticsPropertyId) {
    updates.googleAnalyticsProperties = [{ propertyId: ownerUser.googleAnalyticsPropertyId, label: "Main Property" }];
  }
  if (org.clarityProjects === undefined && updates.clarityProjects === undefined
      && ownerUser?.clarityProjectId) {
    updates.clarityProjects = [{ projectId: ownerUser.clarityProjectId, label: "Main Project" }];
  }

  updates.analyticsConfigSource = "migrated";

  // Seed shareSettings.analytics only when shareSettings exists but lacks it.
  if (org.shareSettings && (org.shareSettings as any).analytics === undefined) {
    updates.shareSettings = {
      ...org.shareSettings,
      analytics: { enabled: !!org.shareAnalyticsWithOrg, editors: [] },
    };
  }

  return updates;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest analyticsConfigMigration -- --silent` → Expected: PASS (7 tests).

- [ ] **Step 5: Write the runner script**

Create `backend/src/scripts/migrate-analytics-config.ts`:

```typescript
/**
 * One-time migration: copy each org owner's analytics config onto the
 * Organization record. Idempotent. Run AFTER the Phase 1 backend deploy.
 *
 *   Dry run:  NODE_ENV=production npx ts-node src/scripts/migrate-analytics-config.ts --dry-run
 *   Apply:    NODE_ENV=production npx ts-node src/scripts/migrate-analytics-config.ts
 */
import AWS from "aws-sdk";
import { migrateOrg } from "../services/analyticsConfigMigration";
import { userDb } from "../services/db";

const DRY_RUN = process.argv.includes("--dry-run");
const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";
const ORGS_TABLE = `${TABLE_PREFIX}AW-Organizations`;
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });

async function run() {
  console.log(`[migrate-analytics-config] table=${ORGS_TABLE} dryRun=${DRY_RUN}`);
  let lastKey: any = undefined;
  let scanned = 0, changed = 0, skipped = 0;

  do {
    const page = await dynamodb.scan({ TableName: ORGS_TABLE, ExclusiveStartKey: lastKey }).promise();
    for (const org of page.Items || []) {
      scanned++;
      const owner = org.ownerUserId ? await userDb.getUserById(org.ownerUserId) : null;
      const updates = migrateOrg(org as any, owner);
      if (!updates) { skipped++; continue; }
      changed++;
      console.log(`[org ${org.orgId}] ${Object.keys(updates).join(", ")}`);
      if (!DRY_RUN) {
        const names: Record<string, string> = {}, values: Record<string, any> = {};
        const sets: string[] = [];
        for (const [k, v] of Object.entries(updates)) {
          names[`#${k}`] = k; values[`:${k}`] = v; sets.push(`#${k} = :${k}`);
        }
        names["#u"] = "updatedAt"; values[":u"] = new Date().toISOString(); sets.push("#u = :u");
        await dynamodb.update({
          TableName: ORGS_TABLE, Key: { orgId: org.orgId },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ExpressionAttributeNames: names, ExpressionAttributeValues: values,
        }).promise();
      }
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  console.log(`[migrate-analytics-config] done — scanned=${scanned} changed=${changed} skipped=${skipped}`);
}

run().catch((e) => { console.error("Migration failed:", e); process.exit(1); });
```

Note: confirm the orgs table name — `grep -rn "ORGS_TABLE" backend/src/services/db.ts` and match the constant used there (the plan assumes `AW-Organizations`; adjust if it differs).

- [ ] **Step 6: tsc + commit**

Run: `cd backend && npx tsc` → Expected: PASS.

```bash
git add backend/src/services/analyticsConfigMigration.ts backend/src/scripts/migrate-analytics-config.ts backend/src/__tests__/analyticsConfigMigration.test.ts
git commit -m "feat(crm): add analytics config migration script"
```

- [ ] **Step 7: Run order (operational — after Phase 1 deploy)**

After the Phase 1 backend is deployed: run with `--dry-run` first, review the per-org log, then run for real. The resolver's owner-record fallback means this can run any time after deploy without downtime.

---

# Phase 3 — Partner Portal

### Task 15: Bug A — Configure SEO/AEO dialog loads from the resolved endpoint

**Files:**
- Modify: `partner-portal/src/pages/AdminDashboard.tsx` (`User` interface ~220-289; dialog state ~840-851; dialog-open handler ~4407-4411; `handleSaveSeoDomains` ~2527-2725)
- Modify: `partner-portal/src/contexts/AdminContext.tsx` (`User` interface ~21-92)

Frontend UI work — not TDD. Implement, then verify with `npx tsc` and a build.

- [ ] **Step 1: Add the array fields to both `User` interfaces**

In `partner-portal/src/pages/AdminDashboard.tsx`, in the `User` interface, find `googleAnalyticsPropertyId?: string;` and add after it:

```typescript
  googleAnalyticsProperties?: Array<{ propertyId: string; label: string }>;
  primaryAnalyticsPropertyId?: string;
  clarityProjects?: Array<{ projectId: string; label: string }>;
```

Make the identical addition in `partner-portal/src/contexts/AdminContext.tsx`'s `User` interface (after its `googleAnalyticsPropertyId?` line).

- [ ] **Step 2: Add a `primaryAnalyticsPropertyId` + loading state**

In `AdminDashboard.tsx`, next to the existing SEO/AEO dialog state declarations (~840-851), add:

```typescript
  const [primaryAnalyticsPropertyId, setPrimaryAnalyticsPropertyId] = useState("");
  const [seoAeoDialogLoading, setSeoAeoDialogLoading] = useState(false);
```

- [ ] **Step 3: Replace the inline dialog-open handler with a fetch-on-open function**

In `AdminDashboard.tsx`, add this function near `handleSaveSeoDomains`:

```typescript
  const openSeoAeoDialog = async (user: User) => {
    setEditingSeoDomainsUserId(user.userId);
    setEditingUserIsOrgOwner(!!user.isOrgOwner);
    setEditingUserOrgId(user.orgId || null);
    setShareAnalyticsWithOrg(!!user.orgShareAnalyticsWithOrg);
    // Reset fields, then load the resolved config (Org record if the user is in an org).
    setSeoDomainsText(""); setGoogleAnalyticsProperties([]); setPrimaryAnalyticsPropertyId("");
    setGaFilteredDomainsText(""); setClarityProjects([]); setProductDomain("");
    setGoogleAnalyticsPropertyId(""); setClarityProjectId("");
    setSeoDomainsDialogOpen(true);
    setSeoAeoDialogLoading(true);
    try {
      const { data } = await axios.get(
        buildApiUrl(`/api/admin/users/${user.userId}/seo-aeo`),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const c = data.config || {};
      setSeoDomainsText((c.seoDomains || []).join("\n"));
      setGoogleAnalyticsProperties(c.googleAnalyticsProperties || []);
      setPrimaryAnalyticsPropertyId(c.primaryAnalyticsPropertyId || "");
      setGaFilteredDomainsText((c.gaFilteredDomains || []).join("\n"));
      setClarityProjects(c.clarityProjects || []);
      setProductDomain(c.productDomain || "");
    } catch (e: any) {
      setError(e.response?.data?.message || "Failed to load SEO/AEO config");
    } finally {
      setSeoAeoDialogLoading(false);
    }
  };
```

Then replace the inline `onClick={() => { setEditingSeoDomainsUserId(...); ... setSeoDomainsDialogOpen(true); }}` on the edit `IconButton` (~line 4411) with:

```typescript
onClick={() => openSeoAeoDialog(user)}
```

- [ ] **Step 4: Update `handleSaveSeoDomains` payload**

In `handleSaveSeoDomains`, change the `axios.put` body sent to `/api/admin/users/:id/seo-aeo` to send array fields + primary (drop the legacy singular fields). Replace the request-body object with:

```typescript
        {
          seoDomains: domains,
          googleAnalyticsProperties: validatedGaProperties,
          primaryAnalyticsPropertyId:
            validatedGaProperties.some(p => p.propertyId === primaryAnalyticsPropertyId)
              ? primaryAnalyticsPropertyId
              : null,
          gaFilteredDomains: filteredDomains,
          clarityProjects: validatedClarityProjects,
          productDomain: prodDomain || null,
        },
```

The `primaryAnalyticsPropertyId` is sent only when it is still one of the submitted properties (otherwise `null`), satisfying the validator. The response is now `{ config, scope }` — update the local-state merge to read from `response.data.config` (e.g. `googleAnalyticsProperties: response.data.config.googleAnalyticsProperties || []`). The existing `shareAnalyticsWithOrg` PATCH call to `/api/admin/orgs/:orgId/analytics-sharing` stays unchanged.

- [ ] **Step 5: Add an org-wide note + clear the new state on dialog close**

In the "Configure SEO/AEO" dialog JSX, under `<DialogTitle>`, add a note shown when the user is in an org:

```tsx
          {editingUserOrgId && (
            <Typography variant="caption" display="block" sx={{ px: 3, color: 'text.secondary' }}>
              This is the organization-wide analytics config — shared by all members.
            </Typography>
          )}
```

Add `setPrimaryAnalyticsPropertyId("")` to each of the dialog's close/cancel handlers alongside the other reset calls. Use `seoAeoDialogLoading` to disable the Save button while the config loads (`disabled={seoDomainsEditLoading || seoAeoDialogLoading}`).

- [ ] **Step 6: Verify**

Run: `cd partner-portal && npx tsc` → Expected: PASS.
Run: `cd partner-portal && npm run build` → Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add partner-portal/src/pages/AdminDashboard.tsx partner-portal/src/contexts/AdminContext.tsx
git commit -m "fix(crm): load Configure SEO/AEO dialog from the resolved config endpoint"
```

---

# Phase 4 — Customer Portal

All Phase 4 tasks are frontend UI — not TDD. Implement, then add a test. Verify each with `cd customer-portal && npx tsc` and `npm test`.

### Task 16: AuthContext — `canEditAnalyticsConfig` on the `User` type

**Files:**
- Modify: `customer-portal/src/contexts/AuthContext.tsx` (`User` interface ~26-85)

- [ ] **Step 1: Add the field**

In `customer-portal/src/contexts/AuthContext.tsx`, in the `User` interface, immediately after the `effectiveAnalyticsConfig?: { ... };` block, add:

```typescript
  canEditAnalyticsConfig?: boolean; // true → user may open the Analytics & SEO Settings tab
```

- [ ] **Step 2: Verify + commit**

Run: `cd customer-portal && npx tsc` → Expected: PASS.

```bash
git add customer-portal/src/contexts/AuthContext.tsx
git commit -m "feat(crm): add canEditAnalyticsConfig to the customer-portal user type"
```

---

### Task 17: `GaPropertiesCard` component

**Files:**
- Create: `customer-portal/src/components/settings/analytics/GaPropertiesCard.tsx`
- Create: `customer-portal/src/components/settings/analytics/types.ts`

- [ ] **Step 1: Create the shared types file**

Create `customer-portal/src/components/settings/analytics/types.ts`:

```typescript
export interface GaProperty { propertyId: string; label: string }
export interface ClarityProject { projectId: string; label: string }

export interface AnalyticsConfig {
  seoDomains: string[];
  googleAnalyticsProperties: GaProperty[];
  primaryAnalyticsPropertyId: string | null;
  gaFilteredDomains: string[];
  clarityProjects: ClarityProject[];
  productDomain: string | null;
}
```

- [ ] **Step 2: Create the component**

Create `customer-portal/src/components/settings/analytics/GaPropertiesCard.tsx`:

```tsx
import { useState } from "react";
import axios from "axios";
import { buildApiUrl } from "@/config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/use-toast";
import { Plus, Trash2, Loader2, CheckCircle2, XCircle, Star } from "lucide-react";
import type { AnalyticsConfig, GaProperty } from "./types";

type TestState = "idle" | "testing" | "ok" | "denied" | "error";

export function GaPropertiesCard({
  config, canEdit, serviceAccountEmail, token, onSaved,
}: {
  config: AnalyticsConfig;
  canEdit: boolean;
  serviceAccountEmail: string | null;
  token: string | null;
  onSaved: (c: AnalyticsConfig) => void;
}) {
  const [properties, setProperties] = useState<GaProperty[]>(config.googleAnalyticsProperties);
  const [primaryId, setPrimaryId] = useState<string>(config.primaryAnalyticsPropertyId || "");
  const [filtered, setFiltered] = useState(config.gaFilteredDomains.join("\n"));
  const [productDomain, setProductDomain] = useState(config.productDomain || "");
  const [tests, setTests] = useState<Record<number, TestState>>({});
  const [saving, setSaving] = useState(false);

  const update = (i: number, patch: Partial<GaProperty>) =>
    setProperties((p) => p.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const testRow = async (i: number) => {
    const id = properties[i].propertyId.trim();
    if (!/^\d+$/.test(id)) { setTests((t) => ({ ...t, [i]: "error" })); return; }
    setTests((t) => ({ ...t, [i]: "testing" }));
    try {
      const { data } = await axios.post(
        buildApiUrl("/api/seo/config/ga/test"), { propertyId: id },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setTests((t) => ({ ...t, [i]: data.ok ? "ok" : data.reason === "permission_denied" ? "denied" : "error" }));
    } catch {
      setTests((t) => ({ ...t, [i]: "error" }));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const cleaned = properties
        .map((p) => ({ propertyId: p.propertyId.trim(), label: p.label.trim() }))
        .filter((p) => p.propertyId || p.label);
      const { data } = await axios.put(
        buildApiUrl("/api/seo/config/ga"),
        {
          googleAnalyticsProperties: cleaned,
          primaryAnalyticsPropertyId: cleaned.some((p) => p.propertyId === primaryId) ? primaryId : null,
          gaFilteredDomains: filtered.split(/[\n,]+/).map((d) => d.trim()).filter(Boolean),
          productDomain: productDomain.trim() || null,
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      onSaved(data.config);
      toast({ title: "Google Analytics settings saved" });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.response?.data?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const testIcon = (s: TestState) => {
    if (s === "testing") return <Loader2 className="h-4 w-4 animate-spin" />;
    if (s === "ok") return <CheckCircle2 className="h-4 w-4 text-green-600" />;
    if (s === "denied" || s === "error") return <XCircle className="h-4 w-4 text-destructive" />;
    return null;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Analytics 4</CardTitle>
        <CardDescription>
          GA4 properties for your analytics dashboard.
          {serviceAccountEmail && (
            <> Grant <strong>Viewer</strong> access in GA4 to: <code>{serviceAccountEmail}</code></>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {properties.map((p, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input className="flex-1 min-w-[140px]" placeholder="Label (e.g. Main Site)"
              value={p.label} disabled={!canEdit} onChange={(e) => update(i, { label: e.target.value })} />
            <Input className="flex-1 min-w-[140px]" placeholder="Property ID (e.g. 123456789)"
              value={p.propertyId} disabled={!canEdit} onChange={(e) => update(i, { propertyId: e.target.value })} />
            <Button type="button" variant={primaryId === p.propertyId ? "default" : "outline"} size="sm"
              disabled={!canEdit || !p.propertyId.trim()} onClick={() => setPrimaryId(p.propertyId)}>
              <Star className="h-4 w-4 mr-1" />{primaryId === p.propertyId ? "Primary" : "Set primary"}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={!canEdit || tests[i] === "testing"}
              onClick={() => testRow(i)}>
              {testIcon(tests[i] || "idle") || "Test"}
            </Button>
            {canEdit && (
              <Button type="button" variant="ghost" size="icon"
                onClick={() => setProperties((ps) => ps.filter((_, idx) => idx !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            {tests[i] === "denied" && <p className="w-full text-xs text-destructive">Permission denied — grant the service account Viewer access.</p>}
          </div>
        ))}
        {canEdit && (
          <Button type="button" variant="outline" size="sm"
            onClick={() => setProperties((p) => [...p, { propertyId: "", label: "" }])}>
            <Plus className="h-4 w-4 mr-1" />Add property
          </Button>
        )}
        <div className="space-y-2">
          <Label htmlFor="ga-filtered">Filtered domains (excluded from GA)</Label>
          <Textarea id="ga-filtered" rows={2} value={filtered} disabled={!canEdit}
            placeholder="internal.acme.com" onChange={(e) => setFiltered(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="product-domain">Product domain</Label>
          <Input id="product-domain" value={productDomain} disabled={!canEdit}
            placeholder="app.acme.com" onChange={(e) => setProductDomain(e.target.value)} />
        </div>
      </CardContent>
      {canEdit && (
        <CardFooter>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save Google Analytics
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
```

- [ ] **Step 3: Verify**

Run: `cd customer-portal && npx tsc` → Expected: PASS. If `@/components/ui/textarea` or an icon import is missing, match the import to a sibling component that uses it (`MemoryTab.tsx` imports `Textarea`).

- [ ] **Step 4: Commit**

```bash
git add customer-portal/src/components/settings/analytics/
git commit -m "feat(crm): add GaPropertiesCard for self-service analytics config"
```

---

### Task 18: `SeoDomainsCard` component

**Files:**
- Create: `customer-portal/src/components/settings/analytics/SeoDomainsCard.tsx`

- [ ] **Step 1: Create the component**

Create `customer-portal/src/components/settings/analytics/SeoDomainsCard.tsx`:

```tsx
import { useState } from "react";
import axios from "axios";
import { buildApiUrl } from "@/config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/use-toast";
import { Plus, Trash2, Loader2 } from "lucide-react";
import type { AnalyticsConfig } from "./types";

export function SeoDomainsCard({
  config, canEdit, token, onSaved,
}: {
  config: AnalyticsConfig;
  canEdit: boolean;
  token: string | null;
  onSaved: (c: AnalyticsConfig) => void;
}) {
  const [domains, setDomains] = useState<string[]>(
    config.seoDomains.length ? config.seoDomains : [""],
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const cleaned = domains.map((d) => d.trim()).filter(Boolean);
      const { data } = await axios.put(
        buildApiUrl("/api/seo/config/seo-domains"),
        { seoDomains: cleaned },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      onSaved(data.config);
      toast({ title: "SEO domains saved" });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.response?.data?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>SEO Domains</CardTitle>
        <CardDescription>
          Domains tracked for Search Console metrics. Use <code>example.com</code> for a
          Domain property or <code>https://example.com/</code> for a URL-prefix property.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {domains.map((d, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input className="flex-1" placeholder="acme.com" value={d} disabled={!canEdit}
              onChange={(e) => setDomains((arr) => arr.map((v, idx) => (idx === i ? e.target.value : v)))} />
            {canEdit && (
              <Button type="button" variant="ghost" size="icon"
                onClick={() => setDomains((arr) => arr.filter((_, idx) => idx !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        {canEdit && (
          <Button type="button" variant="outline" size="sm" onClick={() => setDomains((d) => [...d, ""])}>
            <Plus className="h-4 w-4 mr-1" />Add domain
          </Button>
        )}
      </CardContent>
      {canEdit && (
        <CardFooter>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save SEO Domains
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Verify + commit**

Run: `cd customer-portal && npx tsc` → Expected: PASS.

```bash
git add customer-portal/src/components/settings/analytics/SeoDomainsCard.tsx
git commit -m "feat(crm): add SeoDomainsCard for self-service analytics config"
```

---

### Task 19: `ClarityProjectsCard` component

**Files:**
- Create: `customer-portal/src/components/settings/analytics/ClarityProjectsCard.tsx`

- [ ] **Step 1: Create the component**

Create `customer-portal/src/components/settings/analytics/ClarityProjectsCard.tsx`:

```tsx
import { useState } from "react";
import axios from "axios";
import { buildApiUrl } from "@/config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/use-toast";
import { Plus, Trash2, Loader2, ExternalLink } from "lucide-react";
import type { AnalyticsConfig, ClarityProject } from "./types";

export function ClarityProjectsCard({
  config, canEdit, token, onSaved,
}: {
  config: AnalyticsConfig;
  canEdit: boolean;
  token: string | null;
  onSaved: (c: AnalyticsConfig) => void;
}) {
  const [projects, setProjects] = useState<ClarityProject[]>(config.clarityProjects);
  const [saving, setSaving] = useState(false);

  const update = (i: number, patch: Partial<ClarityProject>) =>
    setProjects((p) => p.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const save = async () => {
    setSaving(true);
    try {
      const cleaned = projects
        .map((p) => ({ projectId: p.projectId.trim(), label: p.label.trim() }))
        .filter((p) => p.projectId || p.label);
      const { data } = await axios.put(
        buildApiUrl("/api/seo/config/clarity"),
        { clarityProjects: cleaned },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      onSaved(data.config);
      toast({ title: "Microsoft Clarity settings saved" });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.response?.data?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Microsoft Clarity</CardTitle>
        <CardDescription>Clarity projects — used to link to your Clarity dashboards.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {projects.map((p, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input className="flex-1 min-w-[140px]" placeholder="Label (e.g. Main Site)"
              value={p.label} disabled={!canEdit} onChange={(e) => update(i, { label: e.target.value })} />
            <Input className="flex-1 min-w-[140px]" placeholder="Project ID (e.g. ul13e4f7fe)"
              value={p.projectId} disabled={!canEdit} onChange={(e) => update(i, { projectId: e.target.value })} />
            {p.projectId.trim() && (
              <a className="text-sm text-primary inline-flex items-center gap-1"
                href={`https://clarity.microsoft.com/projects/view/${p.projectId.trim()}/dashboard`}
                target="_blank" rel="noreferrer">
                Dashboard <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {canEdit && (
              <Button type="button" variant="ghost" size="icon"
                onClick={() => setProjects((ps) => ps.filter((_, idx) => idx !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        {canEdit && (
          <Button type="button" variant="outline" size="sm"
            onClick={() => setProjects((p) => [...p, { projectId: "", label: "" }])}>
            <Plus className="h-4 w-4 mr-1" />Add project
          </Button>
        )}
      </CardContent>
      {canEdit && (
        <CardFooter>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save Microsoft Clarity
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Verify + commit**

Run: `cd customer-portal && npx tsc` → Expected: PASS.

```bash
git add customer-portal/src/components/settings/analytics/ClarityProjectsCard.tsx
git commit -m "feat(crm): add ClarityProjectsCard for self-service analytics config"
```

---

### Task 20: `AnalyticsSeoTab` container + Settings.tsx wiring

**Files:**
- Create: `customer-portal/src/components/settings/AnalyticsSeoTab.tsx`
- Create: `customer-portal/src/components/settings/__tests__/AnalyticsSeoTab.test.tsx`
- Modify: `customer-portal/src/pages/Settings.tsx` (`VALID_TABS` ~87, imports ~55-65, `TabsList` ~1014, `TabsContent` area)

- [ ] **Step 1: Create the container component**

Create `customer-portal/src/components/settings/AnalyticsSeoTab.tsx`:

```tsx
import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { buildApiUrl } from "@/config";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import { GaPropertiesCard } from "./analytics/GaPropertiesCard";
import { SeoDomainsCard } from "./analytics/SeoDomainsCard";
import { ClarityProjectsCard } from "./analytics/ClarityProjectsCard";
import type { AnalyticsConfig } from "./analytics/types";

const EMPTY: AnalyticsConfig = {
  seoDomains: [], googleAnalyticsProperties: [], primaryAnalyticsPropertyId: null,
  gaFilteredDomains: [], clarityProjects: [], productDomain: null,
};

export function AnalyticsSeoTab({ token }: { token: string | null }) {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<AnalyticsConfig>(EMPTY);
  const [canEdit, setCanEdit] = useState(false);
  const [serviceAccountEmail, setServiceAccountEmail] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const { data } = await axios.get(buildApiUrl("/api/seo/config"), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setConfig({ ...EMPTY, ...data.config });
      setCanEdit(!!data.canEdit);
      setServiceAccountEmail(data.serviceAccountEmail || null);
    } catch {
      toast({ title: "Failed to load analytics config", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const onSaved = (c: AnalyticsConfig) => setConfig({ ...EMPTY, ...c });

  if (loading) return <div className="space-y-4">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-48 w-full" />)}</div>;

  return (
    <div className="space-y-4">
      <GaPropertiesCard config={config} canEdit={canEdit} serviceAccountEmail={serviceAccountEmail}
        token={token} onSaved={onSaved} />
      <SeoDomainsCard config={config} canEdit={canEdit} token={token} onSaved={onSaved} />
      <ClarityProjectsCard config={config} canEdit={canEdit} token={token} onSaved={onSaved} />
    </div>
  );
}
```

- [ ] **Step 2: Wire into Settings.tsx**

In `customer-portal/src/pages/Settings.tsx`:

(a) Add to `VALID_TABS` (line 87) — insert `"analytics-seo"` after `"org-sharing"`:

```typescript
const VALID_TABS = ["profile", "accounts", "preferences", "subscription", "api-keys", "memory", "organization", "org-sharing", "analytics-seo", "skills", "work-plans", "test-accounts", "login-credentials"];
```

(b) Add the import alongside the other tab imports (~line 57):

```typescript
import { AnalyticsSeoTab } from "@/components/settings/AnalyticsSeoTab";
```

(c) Add a `TabsTrigger` inside `TabsList` — place it after the `organization` trigger. Reuse the exact long `className` string from a sibling `TabsTrigger`. Gate it on `canEditAnalyticsConfig`:

```tsx
          {user?.canEditAnalyticsConfig && (
            <TabsTrigger
              value="analytics-seo"
              className="data-[state=active]:tab-gradient data-[state=active]:text-primary-foreground data-[state=active]:font-semibold data-[state=active]:shadow-md data-[state=inactive]:bg-black/10 data-[state=inactive]:dark:bg-black/20 data-[state=inactive]:text-foreground/70 data-[state=inactive]:dark:text-white/50 hover:data-[state=inactive]:bg-black/20 hover:data-[state=inactive]:dark:hover:bg-black/30 hover:data-[state=inactive]:text-foreground/90 hover:data-[state=inactive]:dark:hover:text-white/70 rounded-full whitespace-nowrap px-4 py-2 transition-all duration-200 focus-visible:ring-0 focus-visible:ring-offset-0"
            >
              Analytics &amp; SEO
            </TabsTrigger>
          )}
```

(d) Add the `TabsContent` next to the other `TabsContent` blocks:

```tsx
        <TabsContent value="analytics-seo" className="space-y-4">
          <AnalyticsSeoTab token={token} />
        </TabsContent>
```

(e) Guard direct navigation: a member who hits `/settings/analytics-seo` by URL must not get a blank tab. Where `Settings.tsx` validates `activeTab` against `VALID_TABS`, also redirect to `profile` when `activeTab === "analytics-seo" && !user?.canEditAnalyticsConfig`. Add to the existing tab-validation `useEffect`:

```typescript
    if (activeTab === "analytics-seo" && user && !user.canEditAnalyticsConfig) {
      navigate("/settings/profile", { replace: true });
    }
```

- [ ] **Step 3: Add a component test**

Create `customer-portal/src/components/settings/__tests__/AnalyticsSeoTab.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import axios from "axios";
import { AnalyticsSeoTab } from "../AnalyticsSeoTab";

vi.mock("axios");
vi.mock("@/components/ui/use-toast", () => ({ toast: vi.fn() }));

const mockedAxios = axios as unknown as { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  mockedAxios.get = vi.fn().mockResolvedValue({
    data: {
      config: { seoDomains: ["acme.com"], googleAnalyticsProperties: [{ propertyId: "1", label: "A" }],
        primaryAnalyticsPropertyId: "1", gaFilteredDomains: [], clarityProjects: [], productDomain: null },
      canEdit: true, scope: "org", serviceAccountEmail: "svc@iam.gserviceaccount.com",
    },
  });
});

test("renders the three section cards after loading", async () => {
  render(<AnalyticsSeoTab token="t" />);
  await waitFor(() => expect(screen.getByText("Google Analytics 4")).toBeInTheDocument());
  expect(screen.getByText("SEO Domains")).toBeInTheDocument();
  expect(screen.getByText("Microsoft Clarity")).toBeInTheDocument();
  expect(screen.getByText(/svc@iam\.gserviceaccount\.com/)).toBeInTheDocument();
});

test("hides Save buttons when canEdit is false", async () => {
  mockedAxios.get = vi.fn().mockResolvedValue({
    data: { config: { seoDomains: [], googleAnalyticsProperties: [], primaryAnalyticsPropertyId: null,
      gaFilteredDomains: [], clarityProjects: [], productDomain: null },
      canEdit: false, scope: "org", serviceAccountEmail: null },
  });
  render(<AnalyticsSeoTab token="t" />);
  await waitFor(() => expect(screen.getByText("Google Analytics 4")).toBeInTheDocument());
  expect(screen.queryByText("Save Google Analytics")).not.toBeInTheDocument();
});
```

- [ ] **Step 4: Verify**

Run: `cd customer-portal && npx tsc` → Expected: PASS.
Run: `cd customer-portal && npm test -- AnalyticsSeoTab` → Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add customer-portal/src/components/settings/AnalyticsSeoTab.tsx customer-portal/src/components/settings/__tests__/AnalyticsSeoTab.test.tsx customer-portal/src/pages/Settings.tsx
git commit -m "feat(crm): add Analytics & SEO self-service Settings tab"
```

---

### Task 21: Organization Sharing tab — analytics row

**Files:**
- Modify: the customer-portal component backing the `org-sharing` tab (find it: `grep -rln "org-share-settings\|shareSettings" customer-portal/src`)

The Org Sharing tab renders the `OrgShareSettings` features. Once the backend includes `analytics` in `TOGGLEABLE_FEATURES`, the tab must render a row for it.

- [ ] **Step 1: Locate the tab component and its feature list**

Run: `cd customer-portal && grep -rln "org-share-settings\|knowledgeBase" src --include=*.tsx`
Open the component. Find where it lists toggleable features (an array of feature keys, or a label map).

- [ ] **Step 2: Add the analytics row**

If the component maps over a local feature-key array, add `"analytics"` to it. If it uses a label map, add:

```typescript
  analytics: "Analytics",
```

with a description such as "Members can view shared SEO/GA/Clarity analytics." The save payload already round-trips the whole `shareSettings` object, so no save-logic change is needed — the `analytics` key flows through. Confirm the editors-picker UI for the new row lists org members the same way the other features do.

- [ ] **Step 3: Verify + commit**

Run: `cd customer-portal && npx tsc` → Expected: PASS.
Run: `cd customer-portal && npm test` → Expected: PASS (update any org-sharing snapshot/test that enumerates features).

```bash
git add customer-portal/src
git commit -m "feat(crm): add analytics row to the Organization Sharing tab"
```

---

### Task 22: Bugs B & D — `/seo` dashboard gating

**Files:**
- Modify: `customer-portal/src/pages/SEO.tsx` (funnel section ~2052; `isSeoConfigured` ~316; default domain selection)

- [ ] **Step 1: Bug B — gate the funnel section on `effectiveAnalyticsConfig`**

In `customer-portal/src/pages/SEO.tsx`, change the User Journey Funnel conditional (line ~2052):

```tsx
      {user?.googleAnalyticsPropertyId && (
```

to:

```tsx
      {(eac?.primaryPropertyId || eac?.properties?.length) && (
```

`eac` is already defined (`const eac = user?.effectiveAnalyticsConfig;`). This makes the funnel section appear for org members whose org has GA configured.

- [ ] **Step 2: Bug D — confirm `isSeoConfigured` and fix the default domain**

`isSeoConfigured` (line ~316) already references `eac` — leave it. The remaining Bug D gap is the default domain: when `domainParam` is null, the page must default to a domain from `effectiveAnalyticsConfig` so a member lands on a working dashboard without `?domain=`. Find where the page picks the active domain/property when `domainParam` is null. Ensure the fallback chain is: `domainParam` → first of `eac?.seoDomains` → first of `user?.seoDomains`. If the page currently only reads `user?.seoDomains`, add `eac?.seoDomains` ahead of it. Concretely, where a default domain is computed, use:

```typescript
const defaultSeoDomain = domainParam
  || eac?.seoDomains?.[0]
  || user?.seoDomains?.[0]
  || null;
```

and use `defaultSeoDomain` wherever the page currently used the `user?.seoDomains?.[0]` default.

- [ ] **Step 3: Verify**

Run: `cd customer-portal && npx tsc` → Expected: PASS.
Run: `cd customer-portal && npm test` → Expected: PASS.

- [ ] **Step 4: Manual smoke (record in dev.md)**

In the test environment, as an org member with sharing ON and no `?domain=`: open `/seo`. Expected: the dashboard loads (not the "Not Configured" screen) and the "User Journey Funnel" section is visible.

- [ ] **Step 5: Commit**

```bash
git add customer-portal/src/pages/SEO.tsx
git commit -m "fix(crm): gate /seo funnel section and default domain on effectiveAnalyticsConfig"
```

---

# Phase 5 — Release Notes

### Task 23: Release notes

**Files:**
- Modify: `backend/src/docs/user-release.ts`
- Modify: the customer-portal release-notes file (find it: `grep -rln "release" customer-portal/src/docs 2>/dev/null` or check `customer-portal/src/docs/`)

- [ ] **Step 1: Add the backend release-notes entry**

In `backend/src/docs/user-release.ts`, add a `2026-05-22` entry following the existing format in that file, with bullets:
- "Self-service analytics setup — configure your SEO domains, Google Analytics 4 properties, and Microsoft Clarity projects yourself under Settings → Analytics & SEO."
- "Test GA4 connections — a Test button shows immediately whether the analytics service account has access to each property."
- "Organization-wide analytics — org admins can share analytics with their whole team and appoint analytics editors from Settings → Organization Sharing."

- [ ] **Step 2: Add the customer-portal release-notes entry**

Add an equivalent `2026-05-22` entry to the customer-portal release-notes file, matching its existing format.

- [ ] **Step 3: Verify + commit**

Run: `cd backend && npx tsc` → Expected: PASS.

```bash
git add backend/src/docs/user-release.ts customer-portal/src/docs
git commit -m "docs(crm): release notes for self-service analytics config"
```

---

# Done

All 23 tasks complete. Verify the full picture:
- `cd backend && npx tsc && npx jest -- --silent` → PASS
- `cd backend && npm run test:coverage -- --coverageReporters=text` → ≥95% all metrics
- `cd customer-portal && npx tsc && npm test` → PASS
- `cd partner-portal && npx tsc && npm run build` → PASS

Then follow the **deploy order**: Phase 1 backend → run the migration script (Task 14 Step 7) → Phase 3 partner portal → Phase 4 customer portal. Open the two PRs (this repo + customer-portal) per CLAUDE.md.

