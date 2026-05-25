# Landing Page Custom Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add UI + backend gate so users on a paid tier can attach their own custom domain to a deployed landing page, replacing the existing "Coming Soon" placeholder.

**Architecture:** Frontend lives in a new `CustomDomainPanel` inside the existing Domain Settings panel of `LandingPages.tsx`. Tier gating uses a new `allowedFeatures: string[]` field on the admin-managed `SubscriptionType`, surfaced via `/api/auth/me`. Backend route additions enforce the gate, validate landing-page ownership via the existing `authorizeLandingPageAccess` helper, and persist/clear `customDomainUrl` on the landing page in sync with the Vercel domain lifecycle.

**Tech Stack:** Backend — Node.js/TypeScript, Express, AWS SDK (DynamoDB), Jest. Frontend — React 18, TypeScript, Vitest, React Testing Library, Tailwind, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-05-25-landing-page-custom-domain-design.md`

---

## File Structure

### Backend (new)
- `backend/src/__tests__/subscriptionService.test.ts` — extended with `getAllowedFeatures` + `userHasFeature` tests

### Backend (modified)
- `backend/src/services/subscriptionService.ts` — add `allowedFeatures?: string[]` to `SubscriptionType`, add `getAllowedFeatures` and `userHasFeature` exports
- `backend/src/services/customDomainService.ts` — add `landingPageId?: string` to `CustomDomainRecord`; `addCustomDomain` accepts and stores it; `verifyDomain` returns the full updated record
- `backend/src/__tests__/services.customDomainService.test.ts` — test landingPageId propagation
- `backend/src/routes/landingPageGeneration.ts` — `export` `authorizeLandingPageAccess` (one-keyword change)
- `backend/src/routes/domains.ts` — tier gate + ownership check on POST /custom; persist URL on verify; clear URL on delete
- `backend/src/__tests__/routes.domains.test.ts` — gate, ownership, persist, clear tests
- `backend/src/routes/auth.ts` — include `allowedFeatures` in `/api/auth/me` response
- `backend/src/__tests__/auth.subscription.test.ts` — assert `allowedFeatures` present in response

### Frontend (new)
- `customer-portal/src/components/landing-pages/CustomDomainPanel.tsx`
- `customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx`

### Frontend (modified)
- `customer-portal/src/contexts/AuthContext.tsx` — add `allowedFeatures?: string[]` to user type
- `customer-portal/src/pages/LandingPages.tsx` — replace "Coming Soon" card at L939-949 with `<CustomDomainPanel>`, add `hasCustomDomainAccess` helper

### Docs
- `backend/src/docs/user-release.ts` — release entry for 2026-05-25 (or merge date)
- `customer-portal/src/docs/release.ts` — release entry for 2026-05-25

---

## Task 1: Add `getAllowedFeatures` + `userHasFeature` to subscriptionService

**Files:**
- Modify: `backend/src/services/subscriptionService.ts`
- Modify: `backend/src/__tests__/subscriptionService.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/__tests__/subscriptionService.test.ts` (inside the existing `describe('subscriptionService', ...)` block — the file already mocks `settingsService.getSetting` and `userDb.getUserById`):

```ts
describe('getAllowedFeatures', () => {
  it('returns empty array when tier has no allowedFeatures field', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ subscriptionType: 'Legacy' });
    (settingsService.getSetting as jest.Mock).mockResolvedValueOnce({
      settingValue: JSON.stringify([
        { name: 'Legacy', allowedPages: ['*'], allowedSkills: ['*'] },
      ]),
    });
    const result = await getAllowedFeatures('user-1');
    expect(result).toEqual([]);
  });

  it('returns the configured allowedFeatures array', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ subscriptionType: 'Pro' });
    (settingsService.getSetting as jest.Mock).mockResolvedValueOnce({
      settingValue: JSON.stringify([
        { name: 'Pro', allowedPages: ['*'], allowedSkills: ['*'], allowedFeatures: ['custom-domain'] },
      ]),
    });
    const result = await getAllowedFeatures('user-1');
    expect(result).toEqual(['custom-domain']);
  });

  it('returns empty array when tier config is missing', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ subscriptionType: 'Ghost' });
    (settingsService.getSetting as jest.Mock).mockResolvedValueOnce({
      settingValue: JSON.stringify([{ name: 'Pro', allowedPages: ['*'], allowedSkills: ['*'] }]),
    });
    const result = await getAllowedFeatures('user-1');
    expect(result).toEqual([]);
  });
});

describe('userHasFeature', () => {
  it('returns true when feature is listed', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ subscriptionType: 'Pro' });
    (settingsService.getSetting as jest.Mock).mockResolvedValueOnce({
      settingValue: JSON.stringify([
        { name: 'Pro', allowedPages: ['*'], allowedSkills: ['*'], allowedFeatures: ['custom-domain'] },
      ]),
    });
    expect(await userHasFeature('user-1', 'custom-domain')).toBe(true);
  });

  it('returns true when allowedFeatures includes wildcard', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ subscriptionType: 'Admin' });
    (settingsService.getSetting as jest.Mock).mockResolvedValueOnce({
      settingValue: JSON.stringify([
        { name: 'Admin', allowedPages: ['*'], allowedSkills: ['*'], allowedFeatures: ['*'] },
      ]),
    });
    expect(await userHasFeature('user-1', 'anything')).toBe(true);
  });

  it('returns false when feature is not listed', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ subscriptionType: 'Basic' });
    (settingsService.getSetting as jest.Mock).mockResolvedValueOnce({
      settingValue: JSON.stringify([
        { name: 'Basic', allowedPages: ['*'], allowedSkills: ['*'], allowedFeatures: [] },
      ]),
    });
    expect(await userHasFeature('user-1', 'custom-domain')).toBe(false);
  });

  it('returns false when tier has no allowedFeatures field (default-deny)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValueOnce({ subscriptionType: 'Legacy' });
    (settingsService.getSetting as jest.Mock).mockResolvedValueOnce({
      settingValue: JSON.stringify([
        { name: 'Legacy', allowedPages: ['*'], allowedSkills: ['*'] },
      ]),
    });
    expect(await userHasFeature('user-1', 'custom-domain')).toBe(false);
  });
});
```

Also extend the existing import line at the top of the test file to include the new exports:

```ts
import {
  getUserSubscriptionType,
  getSubscriptionTypeConfig,
  getAllAvailableFunctionCalls,
  getAllAvailablePages,
  getAllowedFunctionCalls,
  getAllowedPages,
  filterFunctionCalls,
  getAllAvailableSkills,
  getAllowedSkills,
  getPublicAllowedSkills,
  resolveSkillsToToolNames,
  getAllowedFeatures,
  userHasFeature,
} from '../services/subscriptionService';
```

- [ ] **Step 2: Run failing tests**

Run: `cd backend && npm test -- subscriptionService.test.ts`
Expected: 5 new tests fail (`getAllowedFeatures is not a function` / `userHasFeature is not a function`).

- [ ] **Step 3: Implement**

In `backend/src/services/subscriptionService.ts`, extend the interface near line 6:

```ts
export interface SubscriptionType {
  name: string;
  allowedPages: string[];
  hiddenPages?: string[];
  allowedSkills: string[];
  allowedConnectedAccounts?: string[];
  allowedFunctionCalls?: string[];
  allowedFeatures?: string[]; // e.g., ["custom-domain"] or ["*"] for all
  monthlyTokenAllowance?: number | null;
  monthlyExtraCostAllowance?: number | null;
}
```

Append the new functions at the end of the file (after `filterFunctionCalls`):

```ts
/**
 * Get allowed feature flags for a user based on their subscription tier.
 * Returns the raw array from tier config; ["*"] means "all features."
 * Defaults to [] when no tier or no allowedFeatures (default-deny).
 */
export async function getAllowedFeatures(userId: string): Promise<string[]> {
  try {
    const tierName = await getUserSubscriptionType(userId);
    const tier = await getSubscriptionTypeConfig(tierName);
    return tier?.allowedFeatures || [];
  } catch (error) {
    console.error("Error getting allowed features:", error);
    return [];
  }
}

/**
 * Check whether a user's subscription tier grants a specific feature flag.
 * Honors the "*" wildcard.
 */
export async function userHasFeature(userId: string, feature: string): Promise<boolean> {
  const features = await getAllowedFeatures(userId);
  return features.includes("*") || features.includes(feature);
}
```

- [ ] **Step 4: Run tests until they pass**

Run: `cd backend && npm test -- subscriptionService.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Verify TypeScript**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/subscriptionService.ts backend/src/__tests__/subscriptionService.test.ts
git commit -m "feat(subscription): add allowedFeatures field + userHasFeature gate"
```

---

## Task 2: Export `authorizeLandingPageAccess` for reuse

**Files:**
- Modify: `backend/src/routes/landingPageGeneration.ts:66`

Rationale: `domains.ts` needs to call this helper for the landing-page ownership check. The function is already self-contained service logic; only the `export` keyword is missing.

- [ ] **Step 1: Add export keyword**

In `backend/src/routes/landingPageGeneration.ts`, change line 66 from:

```ts
async function authorizeLandingPageAccess(
```

to:

```ts
export async function authorizeLandingPageAccess(
```

- [ ] **Step 2: Verify TypeScript and existing tests**

Run: `cd backend && npx tsc && npm test -- routes.landingPageGeneration`
Expected: no errors, all existing tests pass (no behavior change).

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/landingPageGeneration.ts
git commit -m "refactor(domains): export authorizeLandingPageAccess for cross-route reuse"
```

---

## Task 3: Add `landingPageId` to `CustomDomainRecord` + propagate through service

**Files:**
- Modify: `backend/src/services/customDomainService.ts`
- Modify: `backend/src/__tests__/services.customDomainService.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/__tests__/services.customDomainService.test.ts` (inside the existing `describe('customDomainService', ...)` block — adjust to match the actual block name in the file):

```ts
describe('addCustomDomain with landingPageId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores landingPageId on the record when provided', async () => {
    const mockAxiosPost = jest.fn().mockResolvedValueOnce({
      data: { verified: false, verification: [{ type: 'TXT', domain: '_vercel.example.com', value: 'vc-domain-verify=abc' }] },
    });
    require('axios').default.post = mockAxiosPost;

    const result = await addCustomDomain('user-1', 'prj_123', 'landing.example.com', 'lp-42');

    expect(result.landingPageId).toBe('lp-42');
    expect(mockPut).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: expect.objectContaining({ landingPageId: 'lp-42' }),
      })
    );
  });

  it('omits landingPageId when not provided', async () => {
    const mockAxiosPost = jest.fn().mockResolvedValueOnce({
      data: { verified: false, verification: [] },
    });
    require('axios').default.post = mockAxiosPost;

    const result = await addCustomDomain('user-1', 'prj_123', 'landing.example.com');

    expect(result.landingPageId).toBeUndefined();
  });
});

describe('verifyDomain returns updated record', () => {
  it('returns the updated record with landingPageId on successful verification', async () => {
    mockGet.mockReturnValueOnce({
      promise: () => Promise.resolve({
        Item: {
          id: 'dom-1',
          userId: 'user-1',
          domain: 'landing.example.com',
          type: 'custom',
          status: 'pending_verification',
          vercelProjectId: 'prj_123',
          landingPageId: 'lp-42',
          verificationRecords: [{ type: 'TXT', domain: '_vercel.landing.example.com', value: 'vc-domain-verify=abc' }],
          createdAt: '2026-05-25T00:00:00Z',
          updatedAt: '2026-05-25T00:00:00Z',
        },
      }),
    });

    const mockAxiosGet = jest.fn().mockResolvedValueOnce({ data: { verified: true } });
    require('axios').default.get = mockAxiosGet;

    const result = await verifyDomain('dom-1', 'user-1');

    expect(result.verified).toBe(true);
    expect(result.record).toMatchObject({
      id: 'dom-1',
      landingPageId: 'lp-42',
      domain: 'landing.example.com',
      status: 'active',
    });
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd backend && npm test -- services.customDomainService.test.ts`
Expected: new tests fail — `result.landingPageId is undefined`, `result.record is undefined`, or type errors.

- [ ] **Step 3: Implement in `customDomainService.ts`**

Update the `CustomDomainRecord` interface (around line 26):

```ts
export interface CustomDomainRecord {
  id: string;
  userId: string;
  domain: string;
  type: "subdomain" | "custom";
  status: "active" | "pending_verification" | "error";
  vercelProjectId: string;
  landingPageId?: string;
  verificationRecords?: VerificationRecord[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
```

Update `addCustomDomain` signature (around line 181) and store the field:

```ts
export async function addCustomDomain(
  userId: string,
  vercelProjectId: string,
  domain: string,
  landingPageId?: string
): Promise<CustomDomainRecord> {
  const cleanDomain = domain.toLowerCase().trim();
  validateDomain(cleanDomain);

  const headers = await getVercelHeaders();

  const response = await axios.post(
    `${VERCEL_API_BASE}/v10/projects/${vercelProjectId}/domains`,
    { name: cleanDomain },
    { headers }
  );

  const vercelData = response.data as any;
  const isVerified = vercelData.verified === true;

  const now = new Date().toISOString();
  const record: CustomDomainRecord = {
    id: uuidv4(),
    userId,
    domain: cleanDomain,
    type: "custom",
    status: isVerified ? "active" : "pending_verification",
    vercelProjectId,
    ...(landingPageId ? { landingPageId } : {}),
    verificationRecords: isVerified
      ? undefined
      : vercelData.verification?.map((v: any) => ({
          type: v.type,
          domain: v.domain,
          value: v.value,
        })),
    createdAt: now,
    updatedAt: now,
  };

  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();

  return record;
}
```

Update `verifyDomain` return type and body (around line 321) to also return the updated record:

```ts
export async function verifyDomain(
  domainId: string,
  userId: string
): Promise<{
  verified: boolean;
  status: string;
  verificationRecords?: VerificationRecord[];
  record: CustomDomainRecord;
}> {
  const result = await dynamodb
    .get({ TableName: TABLE_NAME, Key: { id: domainId } })
    .promise();

  const record = result.Item as CustomDomainRecord | undefined;
  if (!record || record.userId !== userId) {
    throw new Error("Domain not found");
  }

  const headers = await getVercelHeaders();

  const response = await axios.get(
    `${VERCEL_API_BASE}/v9/projects/${record.vercelProjectId}/domains/${record.domain}`,
    { headers }
  );

  const vercelData = response.data as any;
  const isVerified = vercelData.verified === true;
  const now = new Date().toISOString();

  if (isVerified && record.status !== "active") {
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id: domainId },
        UpdateExpression:
          "SET #status = :status, updatedAt = :updatedAt REMOVE verificationRecords",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "active",
          ":updatedAt": now,
        },
      })
      .promise();
    record.status = "active";
    record.updatedAt = now;
    delete record.verificationRecords;
  }

  return {
    verified: isVerified,
    status: isVerified ? "active" : "pending_verification",
    verificationRecords: isVerified
      ? undefined
      : vercelData.verification?.map((v: any) => ({
          type: v.type,
          domain: v.domain,
          value: v.value,
        })),
    record,
  };
}
```

- [ ] **Step 4: Run tests until they pass**

Run: `cd backend && npm test -- services.customDomainService.test.ts`
Expected: all tests pass. If existing tests fail because callers don't read `result.record`, this is fine — they continue to work.

- [ ] **Step 5: Verify TypeScript**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/customDomainService.ts backend/src/__tests__/services.customDomainService.test.ts
git commit -m "feat(customDomain): add landingPageId field; verifyDomain returns updated record"
```

---

## Task 4: Tier gate + ownership check on `POST /api/domains/custom`

**Files:**
- Modify: `backend/src/routes/domains.ts`
- Modify: `backend/src/__tests__/routes.domains.test.ts`

- [ ] **Step 1: Write failing tests**

Append a new `describe` block to `backend/src/__tests__/routes.domains.test.ts`. First add the new mocks at the top of the file (alongside the existing `mockAddCustomDomain` etc.):

```ts
const mockUserHasFeature = jest.fn();
jest.mock("../services/subscriptionService", () => ({
  userHasFeature: (...args: any[]) => mockUserHasFeature(...args),
}));

const mockAuthorizeLandingPageAccess = jest.fn();
jest.mock("../routes/landingPageGeneration", () => ({
  authorizeLandingPageAccess: (...args: any[]) => mockAuthorizeLandingPageAccess(...args),
}));
```

Then add tests:

```ts
describe("POST /api/domains/custom — tier gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 403 when user lacks custom-domain feature", async () => {
    mockUserHasFeature.mockResolvedValueOnce(false);

    const res = await request(app)
      .post("/api/domains/custom")
      .send({ vercelProjectId: "prj_123", domain: "landing.example.com" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/higher-tier/i);
    expect(mockAddCustomDomain).not.toHaveBeenCalled();
  });

  it("proceeds when user has custom-domain feature", async () => {
    mockUserHasFeature.mockResolvedValueOnce(true);
    mockAddCustomDomain.mockResolvedValueOnce({
      id: "dom-1",
      userId: "test-user-123",
      domain: "landing.example.com",
      type: "custom",
      status: "pending_verification",
      vercelProjectId: "prj_123",
      verificationRecords: [],
      createdAt: "now",
      updatedAt: "now",
    });

    const res = await request(app)
      .post("/api/domains/custom")
      .send({ vercelProjectId: "prj_123", domain: "landing.example.com" });

    expect(res.status).toBe(201);
    expect(mockAddCustomDomain).toHaveBeenCalledWith("test-user-123", "prj_123", "landing.example.com", undefined);
  });
});

describe("POST /api/domains/custom — landingPageId ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserHasFeature.mockResolvedValue(true);
  });

  it("returns 403 when caller does not own the landing page", async () => {
    mockAuthorizeLandingPageAccess.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Not authorized to edit this landing page",
    });

    const res = await request(app)
      .post("/api/domains/custom")
      .send({ vercelProjectId: "prj_123", domain: "landing.example.com", landingPageId: "lp-other" });

    expect(res.status).toBe(403);
    expect(mockAddCustomDomain).not.toHaveBeenCalled();
  });

  it("passes landingPageId to addCustomDomain when ownership check passes", async () => {
    mockAuthorizeLandingPageAccess.mockResolvedValueOnce({
      ok: true,
      page: { id: "lp-42", userId: "test-user-123", slug: null },
    });
    mockAddCustomDomain.mockResolvedValueOnce({
      id: "dom-1",
      userId: "test-user-123",
      domain: "landing.example.com",
      type: "custom",
      status: "pending_verification",
      vercelProjectId: "prj_123",
      landingPageId: "lp-42",
      createdAt: "now",
      updatedAt: "now",
    });

    const res = await request(app)
      .post("/api/domains/custom")
      .send({ vercelProjectId: "prj_123", domain: "landing.example.com", landingPageId: "lp-42" });

    expect(res.status).toBe(201);
    expect(mockAddCustomDomain).toHaveBeenCalledWith("test-user-123", "prj_123", "landing.example.com", "lp-42");
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd backend && npm test -- routes.domains.test.ts`
Expected: 4 new tests fail (`mockUserHasFeature.mockResolvedValueOnce` is set but the route doesn't call it; ownership check missing).

- [ ] **Step 3: Implement**

In `backend/src/routes/domains.ts`, update imports near the top:

```ts
import { userHasFeature } from "../services/subscriptionService";
import { authorizeLandingPageAccess } from "./landingPageGeneration";
```

Replace the `POST /custom` handler (lines 124-144) with:

```ts
router.post("/custom", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Tier gate
    const ok = await userHasFeature(userId, "custom-domain");
    if (!ok) {
      return res.status(403).json({ error: "Custom domains require a higher-tier subscription" });
    }

    const { vercelProjectId, domain, landingPageId } = req.body;
    if (!vercelProjectId || typeof vercelProjectId !== "string") {
      return res.status(400).json({ error: "vercelProjectId is required" });
    }
    if (!domain || typeof domain !== "string") {
      return res.status(400).json({ error: "domain is required" });
    }

    // Landing page ownership
    if (landingPageId && typeof landingPageId === "string") {
      const auth = await authorizeLandingPageAccess(landingPageId, userId, "edit");
      if (!auth.ok) {
        return res.status(auth.status).json({ error: auth.error });
      }
    }

    const result = await addCustomDomain(
      userId,
      vercelProjectId,
      domain,
      landingPageId && typeof landingPageId === "string" ? landingPageId : undefined
    );
    res.status(201).json(result);
  } catch (error: any) {
    console.error("[DOMAINS] Error adding custom domain:", error);
    const status = error.message?.includes("Invalid") ? 400 : 500;
    res.status(status).json({ error: error.message || "Failed to add custom domain" });
  }
});
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npm test -- routes.domains.test.ts`
Expected: all tests pass.

- [ ] **Step 5: TypeScript check**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/domains.ts backend/src/__tests__/routes.domains.test.ts
git commit -m "feat(domains): tier gate + landing-page ownership on POST /custom"
```

---

## Task 5: Persist `customDomainUrl` on `POST /api/domains/:id/verify` success

**Files:**
- Modify: `backend/src/routes/domains.ts`
- Modify: `backend/src/__tests__/routes.domains.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/__tests__/routes.domains.test.ts`:

```ts
describe("POST /api/domains/:id/verify — landing page persistence", () => {
  let landingPageUpdateSpy: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the dynamo mock's update method so we can spy on landing-page writes
    landingPageUpdateSpy = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
    mockDynamoInstance.update = landingPageUpdateSpy;
    mockDynamoInstance.get = jest.fn().mockReturnValue({
      promise: () => Promise.resolve({ Item: { id: "lp-42", slug: null, userId: "test-user-123" } }),
    });
  });

  it("updates customDomainUrl on landing page when verified + landingPageId present (root page)", async () => {
    mockVerifyDomain.mockResolvedValueOnce({
      verified: true,
      status: "active",
      record: {
        id: "dom-1",
        userId: "test-user-123",
        domain: "landing.example.com",
        type: "custom",
        status: "active",
        vercelProjectId: "prj_123",
        landingPageId: "lp-42",
        createdAt: "now",
        updatedAt: "now",
      },
    });

    const res = await request(app).post("/api/domains/dom-1/verify");

    expect(res.status).toBe(200);
    expect(landingPageUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { id: "lp-42" },
        ExpressionAttributeValues: expect.objectContaining({
          ":url": "https://landing.example.com",
        }),
      })
    );
  });

  it("appends slug to customDomainUrl for sub-pages", async () => {
    mockDynamoInstance.get = jest.fn().mockReturnValue({
      promise: () => Promise.resolve({ Item: { id: "lp-42", slug: "pricing", userId: "test-user-123" } }),
    });
    mockVerifyDomain.mockResolvedValueOnce({
      verified: true,
      status: "active",
      record: {
        id: "dom-1",
        userId: "test-user-123",
        domain: "landing.example.com",
        type: "custom",
        status: "active",
        vercelProjectId: "prj_123",
        landingPageId: "lp-42",
        createdAt: "now",
        updatedAt: "now",
      },
    });

    const res = await request(app).post("/api/domains/dom-1/verify");

    expect(res.status).toBe(200);
    expect(landingPageUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ExpressionAttributeValues: expect.objectContaining({
          ":url": "https://landing.example.com/pricing",
        }),
      })
    );
  });

  it("does not update landing page when record has no landingPageId", async () => {
    mockVerifyDomain.mockResolvedValueOnce({
      verified: true,
      status: "active",
      record: {
        id: "dom-1",
        userId: "test-user-123",
        domain: "landing.example.com",
        type: "custom",
        status: "active",
        vercelProjectId: "prj_123",
        createdAt: "now",
        updatedAt: "now",
      },
    });

    const res = await request(app).post("/api/domains/dom-1/verify");

    expect(res.status).toBe(200);
    expect(landingPageUpdateSpy).not.toHaveBeenCalled();
  });

  it("still returns 200 if landing page DB write fails (non-fatal)", async () => {
    landingPageUpdateSpy.mockReturnValueOnce({
      promise: () => Promise.reject(new Error("ConditionalCheckFailed")),
    });
    mockVerifyDomain.mockResolvedValueOnce({
      verified: true,
      status: "active",
      record: {
        id: "dom-1",
        userId: "test-user-123",
        domain: "landing.example.com",
        type: "custom",
        status: "active",
        vercelProjectId: "prj_123",
        landingPageId: "lp-42",
        createdAt: "now",
        updatedAt: "now",
      },
    });

    const res = await request(app).post("/api/domains/dom-1/verify");

    expect(res.status).toBe(200);
  });

  it("does not update landing page when verification is still pending", async () => {
    mockVerifyDomain.mockResolvedValueOnce({
      verified: false,
      status: "pending_verification",
      verificationRecords: [{ type: "TXT", domain: "_vercel.x", value: "abc" }],
      record: {
        id: "dom-1",
        userId: "test-user-123",
        domain: "landing.example.com",
        type: "custom",
        status: "pending_verification",
        vercelProjectId: "prj_123",
        landingPageId: "lp-42",
        createdAt: "now",
        updatedAt: "now",
      },
    });

    const res = await request(app).post("/api/domains/dom-1/verify");

    expect(res.status).toBe(200);
    expect(landingPageUpdateSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd backend && npm test -- routes.domains.test.ts`
Expected: 5 new tests fail.

- [ ] **Step 3: Implement**

In `backend/src/routes/domains.ts`, replace the `POST /:id/verify` handler (lines 168-180) with:

```ts
router.post("/:id/verify", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const result = await verifyDomain(req.params.id, userId);

    // If domain just transitioned to active and is linked to a landing page,
    // persist customDomainUrl on that page. Non-fatal on failure.
    if (result.verified && result.record.landingPageId) {
      try {
        const pageResult = await dynamodb.get({
          TableName: LANDING_PAGES_TABLE,
          Key: { id: result.record.landingPageId },
        }).promise();
        const slug = pageResult.Item?.slug;
        const customDomainUrl = slug
          ? `https://${result.record.domain}/${slug}`
          : `https://${result.record.domain}`;

        await dynamodb.update({
          TableName: LANDING_PAGES_TABLE,
          Key: { id: result.record.landingPageId },
          ConditionExpression: "userId = :uid",
          UpdateExpression: "SET customDomainUrl = :url, updatedAt = :now",
          ExpressionAttributeValues: {
            ":url": customDomainUrl,
            ":uid": userId,
            ":now": new Date().toISOString(),
          },
        }).promise();
      } catch (updateErr: any) {
        console.error("[DOMAINS] Failed to persist customDomainUrl on verify:", updateErr?.message);
      }
    }

    res.json(result);
  } catch (error: any) {
    console.error("[DOMAINS] Error verifying domain:", error);
    const status = error.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: error.message || "Failed to verify domain" });
  }
});
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npm test -- routes.domains.test.ts`
Expected: all tests pass.

- [ ] **Step 5: TypeScript check**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/domains.ts backend/src/__tests__/routes.domains.test.ts
git commit -m "feat(domains): persist customDomainUrl on landing page when verification succeeds"
```

---

## Task 6: Clear `customDomainUrl` on `DELETE /api/domains/:id`

**Files:**
- Modify: `backend/src/routes/domains.ts`
- Modify: `backend/src/__tests__/routes.domains.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `backend/src/__tests__/routes.domains.test.ts`:

```ts
describe("DELETE /api/domains/:id — landing page cleanup", () => {
  let landingPageUpdateSpy: jest.Mock;
  let landingPageGetSpy: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    landingPageUpdateSpy = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
    landingPageGetSpy = jest.fn().mockReturnValue({
      promise: () => Promise.resolve({
        Item: {
          id: "lp-42",
          userId: "test-user-123",
          customDomainUrl: "https://landing.example.com",
        },
      }),
    });
    mockDynamoInstance.update = landingPageUpdateSpy;
    mockDynamoInstance.get = landingPageGetSpy;
  });

  it("clears customDomainUrl when deleted domain matched and record has landingPageId", async () => {
    mockGetDomain.mockResolvedValueOnce({
      id: "dom-1",
      userId: "test-user-123",
      domain: "landing.example.com",
      landingPageId: "lp-42",
      type: "custom",
    });
    mockRemoveDomain.mockResolvedValueOnce(undefined);

    const res = await request(app).delete("/api/domains/dom-1");

    expect(res.status).toBe(200);
    expect(landingPageUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { id: "lp-42" },
        UpdateExpression: expect.stringContaining("REMOVE customDomainUrl"),
      })
    );
  });

  it("does not clear when the landing page customDomainUrl does not match the deleted domain", async () => {
    landingPageGetSpy.mockReturnValueOnce({
      promise: () => Promise.resolve({
        Item: {
          id: "lp-42",
          userId: "test-user-123",
          customDomainUrl: "https://other-site.agentwebforms.com",
        },
      }),
    });
    mockGetDomain.mockResolvedValueOnce({
      id: "dom-1",
      userId: "test-user-123",
      domain: "landing.example.com",
      landingPageId: "lp-42",
      type: "custom",
    });
    mockRemoveDomain.mockResolvedValueOnce(undefined);

    const res = await request(app).delete("/api/domains/dom-1");

    expect(res.status).toBe(200);
    expect(landingPageUpdateSpy).not.toHaveBeenCalled();
  });

  it("skips cleanup when domain record has no landingPageId", async () => {
    mockGetDomain.mockResolvedValueOnce({
      id: "dom-1",
      userId: "test-user-123",
      domain: "landing.example.com",
      type: "custom",
    });
    mockRemoveDomain.mockResolvedValueOnce(undefined);

    const res = await request(app).delete("/api/domains/dom-1");

    expect(res.status).toBe(200);
    expect(landingPageGetSpy).not.toHaveBeenCalled();
    expect(landingPageUpdateSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd backend && npm test -- routes.domains.test.ts`
Expected: 3 new tests fail.

- [ ] **Step 3: Implement**

In `backend/src/routes/domains.ts`, replace the `DELETE /:id` handler (lines 150-162) with:

```ts
router.delete("/:id", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Capture the domain record before removal so we can clean up the landing page link.
    const record = await getDomain(req.params.id, userId);

    await removeDomain(req.params.id, userId);

    // If the domain was linked to a landing page and that page's customDomainUrl
    // points at this domain, clear it. Non-fatal on failure.
    if (record?.landingPageId) {
      try {
        const pageResult = await dynamodb.get({
          TableName: LANDING_PAGES_TABLE,
          Key: { id: record.landingPageId },
        }).promise();
        const currentUrl = pageResult.Item?.customDomainUrl as string | undefined;
        if (currentUrl && currentUrl.startsWith(`https://${record.domain}`)) {
          await dynamodb.update({
            TableName: LANDING_PAGES_TABLE,
            Key: { id: record.landingPageId },
            ConditionExpression: "userId = :uid",
            UpdateExpression: "REMOVE customDomainUrl SET updatedAt = :now",
            ExpressionAttributeValues: {
              ":uid": userId,
              ":now": new Date().toISOString(),
            },
          }).promise();
        }
      } catch (cleanupErr: any) {
        console.error("[DOMAINS] Failed to clear customDomainUrl on delete:", cleanupErr?.message);
      }
    }

    res.json({ message: "Domain removed successfully" });
  } catch (error: any) {
    console.error("[DOMAINS] Error removing domain:", error);
    const status = error.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: error.message || "Failed to remove domain" });
  }
});
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npm test -- routes.domains.test.ts`
Expected: all tests pass.

- [ ] **Step 5: TypeScript check**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/domains.ts backend/src/__tests__/routes.domains.test.ts
git commit -m "feat(domains): clear customDomainUrl on delete when domains match"
```

---

## Task 7: Expose `allowedFeatures` in `/api/auth/me`

**Files:**
- Modify: `backend/src/routes/auth.ts`
- Modify: `backend/src/__tests__/auth.subscription.test.ts`

- [ ] **Step 1: Write failing test**

Open `backend/src/__tests__/auth.subscription.test.ts`. Add an import for `getAllowedFeatures` to the existing mock block, and add a test asserting the field is on the response. Locate the existing `jest.mock('../services/subscriptionService', ...)` block and extend it:

```ts
jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(async () => 'Pro'),
  getAllowedPages: jest.fn(async () => ['/tasks', '/seo']),
  getAllowedSkills: jest.fn(async () => [{ skillId: 'sk-1', name: 'Skill 1' }]),
  getHiddenPages: jest.fn(async () => []),
  getAllowedFeatures: jest.fn(async () => ['custom-domain']),
}));
```

Then add the import line and a new test (place it after an existing `/me` test):

```ts
import { getAllowedFeatures } from '../services/subscriptionService';

// ...inside the existing describe('GET /api/auth/me', ...) block:

it('returns allowedFeatures in the response', async () => {
  // Configure auth mock to return a valid user — follow the pattern used by neighboring tests
  const res = await request(app)
    .get('/api/auth/me')
    .set('Authorization', 'Bearer valid-token');

  expect(res.status).toBe(200);
  expect(res.body.allowedFeatures).toEqual(['custom-domain']);
  expect(getAllowedFeatures).toHaveBeenCalled();
});
```

If `auth.subscription.test.ts` mocks the auth middleware and module differently, follow the patterns already there — the goal is `expect(res.body.allowedFeatures).toEqual(['custom-domain'])`.

- [ ] **Step 2: Run failing test**

Run: `cd backend && npm test -- auth.subscription.test.ts`
Expected: test fails because `allowedFeatures` is undefined in the response.

- [ ] **Step 3: Implement**

In `backend/src/routes/auth.ts`, update the dynamic import (line 90) and response shape. Find the two places that set `response.allowedPages` (around lines 100 and 139):

At line 90, extend the import:

```ts
const { getUserSubscriptionType, getAllowedPages, getAllowedSkills, getHiddenPages, getAllowedFeatures } = await import('../services/subscriptionService');
```

After each `response.allowedPages = ...` line, add:

```ts
response.allowedFeatures = await getAllowedFeatures(subscriptionUserId); // or userId in the second branch
```

Also update the response type if there's an explicit `AuthMeResponse` interface in the same file — add `allowedFeatures?: string[]` to it. If the response is loosely typed, no type change is needed.

- [ ] **Step 4: Run test**

Run: `cd backend && npm test -- auth.subscription.test.ts`
Expected: passes.

- [ ] **Step 5: TypeScript check**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/auth.ts backend/src/__tests__/auth.subscription.test.ts
git commit -m "feat(auth): include allowedFeatures in /api/auth/me response"
```

---

## Task 8: Add `allowedFeatures` to frontend AuthContext User type

**Files:**
- Modify: `customer-portal/src/contexts/AuthContext.tsx`

This is a type-only change. Frontend tests will use the new field in subsequent tasks.

- [ ] **Step 1: Add field**

In `customer-portal/src/contexts/AuthContext.tsx`, around line 55 where `allowedPages` is declared, add the field below it:

```ts
allowedPages?: string[];
allowedSkills?: { skillId: string; name: string }[];
allowedFeatures?: string[]; // Feature flags granted by subscription tier
```

- [ ] **Step 2: TypeScript check**

Run: `cd customer-portal && npx tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add customer-portal/src/contexts/AuthContext.tsx
git commit -m "feat(auth-context): add allowedFeatures to user type"
```

---

## Task 9: `CustomDomainPanel` — skeleton, gate UX, rehydration on mount

**Files:**
- Create: `customer-portal/src/components/landing-pages/CustomDomainPanel.tsx`
- Create: `customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx`:

```tsx
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import CustomDomainPanel from '../CustomDomainPanel';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token', user: { userId: 'u1' } }),
}));

vi.mock('@/config', () => ({
  buildApiUrl: (path: string) => `http://localhost:3001${path}`,
}));

const mockToast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();
vi.mock('axios', () => ({
  default: {
    get: (...args: any[]) => mockGet(...args),
    post: (...args: any[]) => mockPost(...args),
    delete: (...args: any[]) => mockDelete(...args),
  },
}));

const defaultPage = {
  id: 'lp-42',
  vercelProjectId: 'prj_123',
  slug: null,
  name: 'My Page',
} as any;

describe('CustomDomainPanel — gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { domains: [] } });
  });

  it('renders upgrade card when isPaidForCustomDomain is false', async () => {
    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={false} onUpdate={vi.fn()} />
    );
    expect(await screen.findByText(/higher-tier/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upgrade/i })).toBeInTheDocument();
  });

  it('renders the input form when isPaidForCustomDomain is true', async () => {
    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={vi.fn()} />
    );
    expect(await screen.findByPlaceholderText(/landing\.mycompany\.com/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add domain/i })).toBeInTheDocument();
  });
});

describe('CustomDomainPanel — rehydration on mount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts in State 2 when a pending domain exists', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        domains: [
          {
            id: 'dom-1',
            type: 'custom',
            status: 'pending_verification',
            domain: 'landing.example.com',
            verificationRecords: [{ type: 'TXT', domain: '_vercel.landing.example.com', value: 'vc=abc' }],
          },
        ],
      },
    });

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={vi.fn()} />
    );

    expect(await screen.findByText(/pending dns/i)).toBeInTheDocument();
    expect(screen.getByText('vc=abc')).toBeInTheDocument();
  });

  it('starts in State 3 when an active domain exists', async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        domains: [
          { id: 'dom-1', type: 'custom', status: 'active', domain: 'landing.example.com' },
        ],
      },
    });

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={vi.fn()} />
    );

    expect(await screen.findByText(/your domain is live/i)).toBeInTheDocument();
    expect(screen.getByText('https://landing.example.com')).toBeInTheDocument();
  });

  it('starts in State 1 when no custom domain exists', async () => {
    mockGet.mockResolvedValueOnce({ data: { domains: [] } });

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={vi.fn()} />
    );

    expect(await screen.findByPlaceholderText(/landing\.mycompany\.com/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd customer-portal && npm test -- CustomDomainPanel`
Expected: all fail — module doesn't exist.

- [ ] **Step 3: Create the component**

Create `customer-portal/src/components/landing-pages/CustomDomainPanel.tsx`:

```tsx
import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import { useAuth } from "@/contexts/AuthContext";
import { buildApiUrl } from "@/config";
import { useToast } from "@/hooks/use-toast";
import { copyToClipboard } from "@/utils/clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckCircle, Copy, ExternalLink, Globe, Loader2 } from "lucide-react";

const STRIPE_SIGNUP_URL = "https://buy.stripe.com/8wM5o0aXC2vP58k3cc"; // mirrors handleUpgrade in LandingPages.tsx

interface DnsRecord {
  type: string;
  name: string;
  value: string;
}

interface CustomDomainRecord {
  id: string;
  domain: string;
  type: "subdomain" | "custom";
  status: "active" | "pending_verification" | "error";
  verificationRecords?: { type: string; domain: string; value: string }[];
}

interface CustomDomainPanelProps {
  page: { id: string; vercelProjectId: string; slug: string | null; name: string };
  isPaidForCustomDomain: boolean;
  onUpdate: () => void;
}

type PanelState =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "adding" }
  | { kind: "pending"; record: CustomDomainRecord }
  | { kind: "verified"; record: CustomDomainRecord }
  | { kind: "error"; message: string };

function isApex(domain: string): boolean {
  return domain.split(".").length === 2;
}

const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_CYCLES = 180; // 30 min @ 10s

const CustomDomainPanel: React.FC<CustomDomainPanelProps> = ({
  page,
  isPaidForCustomDomain,
  onUpdate,
}) => {
  const { token } = useAuth();
  const { toast } = useToast();
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [domainInput, setDomainInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const [pollCapped, setPollCapped] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const headers = { Authorization: `Bearer ${token}` };

  // ─── Rehydrate from server on mount ────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get(
          buildApiUrl(`/api/domains?projectId=${page.vercelProjectId}`),
          { headers }
        );
        if (cancelled) return;
        const existing = (res.data?.domains || []).find(
          (d: CustomDomainRecord) => d.type === "custom"
        );
        if (!existing) {
          setState({ kind: "idle" });
        } else if (existing.status === "active") {
          setState({ kind: "verified", record: existing });
        } else if (existing.status === "pending_verification") {
          setState({ kind: "pending", record: existing });
        } else {
          setState({ kind: "idle" });
        }
      } catch {
        if (!cancelled) setState({ kind: "idle" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page.vercelProjectId, token]);

  // (Subsequent tasks: add submit handler, polling, disconnect)

  // ─── Render ────────────────────────────────────────────────────────
  if (!isPaidForCustomDomain) {
    return (
      <div className="border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <Globe className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Custom Domains</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          Custom domains are available on higher-tier plans.
        </p>
        <Button
          onClick={() => window.open(STRIPE_SIGNUP_URL, "_blank")}
          className="bg-violet-600 hover:bg-violet-700 text-white"
        >
          Upgrade
        </Button>
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="border rounded-lg p-4 sm:p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading custom domain status…
      </div>
    );
  }

  if (state.kind === "idle" || state.kind === "adding" || state.kind === "error") {
    return (
      <div className="border rounded-lg p-4 sm:p-6 space-y-3">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Custom Domains</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Point your own domain at this landing page.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="landing.mycompany.com"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            disabled={submitting}
          />
          <Button
            onClick={() => { /* Task 10 implements */ }}
            disabled={submitting || !domainInput.trim()}
            className="bg-violet-600 hover:bg-violet-700 text-white"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Domain"}
          </Button>
        </div>
        {state.kind === "error" && (
          <p className="text-sm text-red-600">{state.message}</p>
        )}
      </div>
    );
  }

  // Task 10+ render pending and verified states
  return null;
};

export default CustomDomainPanel;
```

- [ ] **Step 4: Run tests**

Run: `cd customer-portal && npm test -- CustomDomainPanel`
Expected: the gate + rehydration tests pass. Pending/verified tests still fail (those will pass in Tasks 10–12).

Mark only the gate + rehydration tests as expected-pass for now. The pending/verified tests can be skipped in this task or left as known-failing until subsequent tasks (preferred: leave failing so the next task immediately picks them up). If skipping, wrap in `it.todo`.

For this task, the goal is: **gate tests pass**, **State 1 idle rehydration test passes**. Pending/verified-state tests will require subsequent tasks.

- [ ] **Step 5: TypeScript check**

Run: `cd customer-portal && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add customer-portal/src/components/landing-pages/CustomDomainPanel.tsx customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx
git commit -m "feat(landing-pages): CustomDomainPanel scaffold + gate + rehydration"
```

---

## Task 10: `CustomDomainPanel` — Submit + State 2 with apex/subdomain DNS

**Files:**
- Modify: `customer-portal/src/components/landing-pages/CustomDomainPanel.tsx`
- Modify: `customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx`

- [ ] **Step 1: Write failing tests**

Append to the test file:

```tsx
describe('CustomDomainPanel — submit and State 2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { domains: [] } });
  });

  it('submits a domain and transitions to pending state with TXT + CNAME for subdomain', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({
      data: {
        id: 'dom-1',
        domain: 'landing.example.com',
        type: 'custom',
        status: 'pending_verification',
        verificationRecords: [
          { type: 'TXT', domain: '_vercel.landing.example.com', value: 'vc-domain-verify=abc' },
        ],
      },
    });

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={vi.fn()} />
    );

    const input = await screen.findByPlaceholderText(/landing\.mycompany\.com/i);
    await user.type(input, 'landing.example.com');
    await user.click(screen.getByRole('button', { name: /add domain/i }));

    expect(await screen.findByText(/pending dns/i)).toBeInTheDocument();
    expect(screen.getByText('vc-domain-verify=abc')).toBeInTheDocument();
    expect(screen.getByText('cname.vercel-dns.com.')).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith(
      'http://localhost:3001/api/domains/custom',
      { vercelProjectId: 'prj_123', domain: 'landing.example.com', landingPageId: 'lp-42' },
      expect.any(Object)
    );
  });

  it('shows A record 76.76.21.21 instead of CNAME for apex domains', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({
      data: {
        id: 'dom-1',
        domain: 'example.com',
        type: 'custom',
        status: 'pending_verification',
        verificationRecords: [
          { type: 'TXT', domain: '_vercel.example.com', value: 'vc=abc' },
        ],
      },
    });

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={vi.fn()} />
    );

    const input = await screen.findByPlaceholderText(/landing\.mycompany\.com/i);
    await user.type(input, 'example.com');
    await user.click(screen.getByRole('button', { name: /add domain/i }));

    expect(await screen.findByText(/pending dns/i)).toBeInTheDocument();
    expect(screen.getByText('76.76.21.21')).toBeInTheDocument();
    expect(screen.queryByText('cname.vercel-dns.com.')).not.toBeInTheDocument();
  });

  it('shows error message on invalid domain (400 response)', async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValueOnce({
      response: { status: 400, data: { error: 'Invalid domain' } },
    });

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={vi.fn()} />
    );

    const input = await screen.findByPlaceholderText(/landing\.mycompany\.com/i);
    await user.type(input, 'not-a-domain');
    await user.click(screen.getByRole('button', { name: /add domain/i }));

    expect(await screen.findByText(/please enter a valid domain/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd customer-portal && npm test -- CustomDomainPanel`
Expected: 3 new tests fail.

- [ ] **Step 3: Implement submit + State 2 render**

In `CustomDomainPanel.tsx`, replace the "Task 10 implements" comment with a real handler, and add the pending-state render after the idle branch.

Inside the component body (above `return`), add:

```tsx
const handleAdd = async () => {
  if (!domainInput.trim()) return;
  const cleaned = domainInput.trim().toLowerCase();
  setSubmitting(true);
  try {
    const res = await axios.post(
      buildApiUrl("/api/domains/custom"),
      { vercelProjectId: page.vercelProjectId, domain: cleaned, landingPageId: page.id },
      { headers }
    );
    setState({ kind: "pending", record: res.data });
    setPollCount(0);
    setPollCapped(false);
  } catch (err: any) {
    const status = err.response?.status;
    const apiMessage = err.response?.data?.error || "Failed to add domain";
    let userMessage: string;
    if (status === 400) {
      userMessage = "Please enter a valid domain (e.g., landing.mycompany.com)";
    } else if (status === 403) {
      userMessage = apiMessage;
    } else if (status === 409) {
      userMessage = "This domain is already in use. Remove it from its current project first.";
    } else {
      userMessage = apiMessage;
    }
    setState({ kind: "error", message: userMessage });
  } finally {
    setSubmitting(false);
  }
};
```

Wire the button click to `handleAdd`:

```tsx
<Button onClick={handleAdd} disabled={submitting || !domainInput.trim()} ...>
```

Add a helper for the second DNS record:

```tsx
function buildSecondRecord(domain: string): DnsRecord {
  if (isApex(domain)) {
    return { type: "A", name: domain, value: "76.76.21.21" };
  }
  return { type: "CNAME", name: domain, value: "cname.vercel-dns.com." };
}
```

Append a pending-state render after the idle branch (before the final `return null`):

```tsx
if (state.kind === "pending") {
  const txtRecords: DnsRecord[] = (state.record.verificationRecords || []).map((r) => ({
    type: r.type,
    name: r.domain,
    value: r.value,
  }));
  const secondRecord = buildSecondRecord(state.record.domain);

  const renderRow = (r: DnsRecord) => (
    <div
      key={`${r.type}-${r.name}-${r.value}`}
      className="grid grid-cols-[80px,1fr,auto] sm:grid-cols-[80px,200px,1fr,auto] gap-2 items-center font-mono text-xs p-2 rounded border bg-muted/50"
    >
      <span className="font-semibold">{r.type}</span>
      <span className="truncate">{r.name}</span>
      <span className="truncate break-all sm:col-span-1">{r.value}</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={async () => {
          const ok = await copyToClipboard(r.value);
          if (ok) {
            setCopied(r.value);
            setTimeout(() => setCopied(null), 1500);
          }
        }}
        aria-label={`Copy ${r.type} value`}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  return (
    <div className="border rounded-lg p-4 sm:p-6 space-y-3">
      <div className="flex items-center gap-2">
        <Globe className="h-5 w-5 text-muted-foreground" />
        <h3 className="text-lg font-semibold">Custom Domains</h3>
        <span className="text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 px-2 py-0.5 rounded-full">
          Pending DNS
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Add these records at your DNS provider for <span className="font-mono">{state.record.domain}</span>:
      </p>
      <div className="space-y-2">
        {txtRecords.map(renderRow)}
        {renderRow(secondRecord)}
      </div>
      <p className="text-xs text-muted-foreground">
        DNS changes can take up to 48 hours to propagate. If verification doesn't complete in 30 minutes, close this panel and come back — click Check Again to retry.
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => { /* Task 11 wires manual verify */ }}
        >
          Check Again
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd customer-portal && npm test -- CustomDomainPanel`
Expected: 3 new tests pass.

- [ ] **Step 5: TypeScript check**

Run: `cd customer-portal && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add customer-portal/src/components/landing-pages/CustomDomainPanel.tsx customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx
git commit -m "feat(landing-pages): CustomDomainPanel submit + pending state with apex/subdomain DNS"
```

---

## Task 11: `CustomDomainPanel` — Auto-poll + manual verify + 30-min cap → State 3

**Files:**
- Modify: `customer-portal/src/components/landing-pages/CustomDomainPanel.tsx`
- Modify: `customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx`

- [ ] **Step 1: Write failing tests**

Append:

```tsx
describe('CustomDomainPanel — verify polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGet.mockResolvedValue({
      data: {
        domains: [
          {
            id: 'dom-1',
            type: 'custom',
            status: 'pending_verification',
            domain: 'landing.example.com',
            verificationRecords: [{ type: 'TXT', domain: '_vercel.landing.example.com', value: 'vc=abc' }],
          },
        ],
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-polls verify endpoint every 10s', async () => {
    mockPost.mockResolvedValue({ data: { verified: false, status: 'pending_verification' } });
    const onUpdate = vi.fn();

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={onUpdate} />
    );

    // Wait for rehydration → pending state
    await screen.findByText(/pending dns/i);

    // Advance 10s; assert verify called
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockPost).toHaveBeenCalledWith(
      'http://localhost:3001/api/domains/dom-1/verify',
      undefined,
      expect.any(Object)
    );
  });

  it('transitions to State 3 when poll returns verified=true', async () => {
    mockPost.mockResolvedValueOnce({
      data: { verified: true, status: 'active', record: { id: 'dom-1', domain: 'landing.example.com', status: 'active', type: 'custom' } },
    });
    const onUpdate = vi.fn();

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={onUpdate} />
    );
    await screen.findByText(/pending dns/i);

    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(screen.queryByText(/your domain is live/i)).toBeInTheDocument());
    expect(onUpdate).toHaveBeenCalled();
  });

  it('manual "Check Again" calls verify endpoint immediately', async () => {
    mockPost.mockResolvedValueOnce({ data: { verified: false, status: 'pending_verification' } });

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={vi.fn()} />
    );
    await screen.findByText(/pending dns/i);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: /check again/i }));

    expect(mockPost).toHaveBeenCalledWith(
      'http://localhost:3001/api/domains/dom-1/verify',
      undefined,
      expect.any(Object)
    );
  });

  it('stops polling after 30 minutes and shows banner', async () => {
    mockPost.mockResolvedValue({ data: { verified: false, status: 'pending_verification' } });

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={vi.fn()} />
    );
    await screen.findByText(/pending dns/i);

    // 180 cycles × 10s = 30 min
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(await screen.findByText(/taking longer than expected/i)).toBeInTheDocument();
    const callsAt30 = mockPost.mock.calls.length;

    // Advance another minute; should be no more verify calls
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockPost.mock.calls.length).toBe(callsAt30);
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `cd customer-portal && npm test -- CustomDomainPanel`
Expected: 4 new tests fail.

- [ ] **Step 3: Implement polling**

In `CustomDomainPanel.tsx`, add a verify handler and a polling effect. Inside the component body (after `handleAdd`):

```tsx
const verify = async (record: CustomDomainRecord): Promise<boolean> => {
  try {
    const res = await axios.post(
      buildApiUrl(`/api/domains/${record.id}/verify`),
      undefined,
      { headers }
    );
    if (res.data?.verified === true) {
      setState({ kind: "verified", record: { ...record, status: "active" } });
      onUpdate();
      return true;
    }
    if (res.data?.verificationRecords) {
      setState({
        kind: "pending",
        record: { ...record, verificationRecords: res.data.verificationRecords },
      });
    }
    return false;
  } catch {
    return false;
  }
};

useEffect(() => {
  if (state.kind !== "pending") return;
  if (pollCapped) return;

  const id = window.setInterval(() => {
    setPollCount((prev) => {
      const next = prev + 1;
      if (next > MAX_POLL_CYCLES) {
        setPollCapped(true);
        window.clearInterval(id);
        return prev;
      }
      // Fire-and-forget verify; failure is silent per spec
      void verify(state.record);
      return next;
    });
  }, POLL_INTERVAL_MS);

  return () => window.clearInterval(id);
  // verify uses state.record by value; including state.record in deps recreates the interval unnecessarily
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [state.kind, pollCapped]);
```

Wire the "Check Again" button:

```tsx
<Button
  variant="outline"
  onClick={async () => {
    if (state.kind === "pending") {
      const ok = await verify(state.record);
      if (!ok) toast({ description: "Still pending. Try again in a moment." });
    }
  }}
>
  Check Again
</Button>
```

Add the 30-minute-cap banner inside the pending state render (before the help text):

```tsx
{pollCapped && (
  <p className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded p-2">
    Verification is taking longer than expected. Close this panel and click Check Again later — DNS can take up to 48 hours.
  </p>
)}
```

Add the verified-state render below the pending block (still before `return null`):

```tsx
if (state.kind === "verified") {
  const url = `https://${state.record.domain}${page.slug ? `/${page.slug}` : ""}`;
  return (
    <div className="border rounded-lg p-4 sm:p-6 space-y-3">
      <div className="flex items-center gap-2">
        <CheckCircle className="h-5 w-5 text-green-500" />
        <h3 className="text-lg font-semibold">Custom Domains</h3>
      </div>
      <div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
        <p className="text-xs text-muted-foreground mb-1">Your domain is live at</p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-semibold text-green-700 dark:text-green-300 hover:underline break-all flex items-center gap-1.5"
        >
          {url}
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </a>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={async () => {
            const ok = await copyToClipboard(url);
            if (ok) {
              setCopied(url);
              setTimeout(() => setCopied(null), 1500);
            }
          }}
        >
          <Copy className="h-4 w-4 mr-1.5" />
          {copied === url ? "Copied!" : "Copy URL"}
        </Button>
        <Button
          variant="outline"
          onClick={() => setConfirmDisconnect(true)}
        >
          Disconnect
        </Button>
      </div>
      {/* AlertDialog wired in Task 12 */}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd customer-portal && npm test -- CustomDomainPanel`
Expected: 4 new tests pass.

- [ ] **Step 5: TypeScript check**

Run: `cd customer-portal && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add customer-portal/src/components/landing-pages/CustomDomainPanel.tsx customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx
git commit -m "feat(landing-pages): CustomDomainPanel auto-poll, manual verify, 30-min cap"
```

---

## Task 12: `CustomDomainPanel` — Disconnect with confirm dialog

**Files:**
- Modify: `customer-portal/src/components/landing-pages/CustomDomainPanel.tsx`
- Modify: `customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx`

- [ ] **Step 1: Write failing tests**

Append:

```tsx
describe('CustomDomainPanel — disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({
      data: {
        domains: [
          { id: 'dom-1', type: 'custom', status: 'active', domain: 'landing.example.com' },
        ],
      },
    });
  });

  it('shows confirm dialog when Disconnect is clicked', async () => {
    const user = userEvent.setup();
    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={vi.fn()} />
    );

    await screen.findByText(/your domain is live/i);
    await user.click(screen.getByRole('button', { name: /disconnect/i }));

    expect(await screen.findByText(/disconnect landing\.example\.com/i)).toBeInTheDocument();
  });

  it('calls DELETE and returns to State 1 when confirmed', async () => {
    const user = userEvent.setup();
    mockDelete.mockResolvedValueOnce({ data: { message: "ok" } });
    const onUpdate = vi.fn();

    render(
      <CustomDomainPanel page={defaultPage} isPaidForCustomDomain={true} onUpdate={onUpdate} />
    );

    await screen.findByText(/your domain is live/i);
    await user.click(screen.getByRole('button', { name: /disconnect/i }));
    await user.click(screen.getByRole('button', { name: /^disconnect$/i, hidden: false })); // confirm button in dialog

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(
      'http://localhost:3001/api/domains/dom-1',
      expect.any(Object)
    ));
    expect(onUpdate).toHaveBeenCalled();
    expect(await screen.findByPlaceholderText(/landing\.mycompany\.com/i)).toBeInTheDocument();
  });
});
```

Note: if both buttons match `/disconnect/i`, refine selectors using a `data-testid` (add `data-testid="btn-confirm-disconnect"` to the AlertDialogAction below).

- [ ] **Step 2: Run failing tests**

Expected: tests fail (dialog not implemented; DELETE not called).

- [ ] **Step 3: Implement**

In `CustomDomainPanel.tsx`, add a disconnect handler:

```tsx
const handleDisconnect = async () => {
  if (state.kind !== "verified") return;
  try {
    await axios.delete(buildApiUrl(`/api/domains/${state.record.id}`), { headers });
    onUpdate();
    setState({ kind: "idle" });
    setConfirmDisconnect(false);
    setDomainInput("");
  } catch (err: any) {
    toast({
      variant: "destructive",
      title: "Failed to disconnect",
      description: err.response?.data?.error || "Try again.",
    });
  }
};
```

Inside the verified-state render block, replace the `{/* AlertDialog wired in Task 12 */}` placeholder with:

```tsx
<AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Disconnect {state.record.domain}?</AlertDialogTitle>
      <AlertDialogDescription>
        This will remove the custom domain from this landing page. The page will revert to its subdomain (or default Vercel URL).
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction
        data-testid="btn-confirm-disconnect"
        onClick={handleDisconnect}
        className="bg-red-600 hover:bg-red-700 text-white"
      >
        Disconnect
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

Update the test in Step 1 to use `screen.getByTestId('btn-confirm-disconnect')` for the confirm click (replace the second `getByRole('button', { name: /^disconnect$/i, hidden: false })` line). This is more reliable than role matching when two buttons share the label.

- [ ] **Step 4: Run tests**

Run: `cd customer-portal && npm test -- CustomDomainPanel`
Expected: 2 new tests pass; existing tests still pass.

- [ ] **Step 5: TypeScript check**

Run: `cd customer-portal && npx tsc`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add customer-portal/src/components/landing-pages/CustomDomainPanel.tsx customer-portal/src/components/landing-pages/__tests__/CustomDomainPanel.test.tsx
git commit -m "feat(landing-pages): CustomDomainPanel disconnect flow with confirm"
```

---

## Task 13: Integrate `CustomDomainPanel` into `LandingPages.tsx`

**Files:**
- Modify: `customer-portal/src/pages/LandingPages.tsx`

- [ ] **Step 1: Add helper function**

In `customer-portal/src/pages/LandingPages.tsx`, below the existing `hasLandingPagesAccess` function (around line 113), add:

```tsx
function hasCustomDomainAccess(
  user: { isAdmin?: boolean; allowedFeatures?: string[] } | null
): boolean {
  if (!user) return false;
  if (user.isAdmin) return true;
  const f = user.allowedFeatures || [];
  return f.includes("*") || f.includes("custom-domain");
}
```

- [ ] **Step 2: Compute the gate value**

Just below `const isSuperPremium = user?.isAdmin || hasLandingPagesAccess(user);` (around line 176), add:

```tsx
const isPaidForCustomDomain = hasCustomDomainAccess(user);
```

- [ ] **Step 3: Import the new component**

Add to the imports at the top of the file (near `import SubdomainChooserModal from ...`):

```tsx
import CustomDomainPanel from "@/components/landing-pages/CustomDomainPanel";
```

- [ ] **Step 4: Replace the "Coming Soon" placeholder**

Locate the block in `LandingPages.tsx` at lines 939–949 (the "Custom Domains — Coming Soon" card) and replace it with:

```tsx
<CustomDomainPanel
  page={selectedPage as any}
  isPaidForCustomDomain={isPaidForCustomDomain}
  onUpdate={fetchGeneratedPages}
/>
```

(The `as any` is acceptable here only if `GeneratedPage` doesn't structurally satisfy the new prop type. If it does, drop the cast.)

- [ ] **Step 5: Verify existing tests pass and TypeScript clean**

Run: `cd customer-portal && npx tsc && npm test -- LandingPages`
Expected: no TypeScript errors; existing `LandingPages.tsx` tests still pass.

- [ ] **Step 6: Commit**

```bash
git add customer-portal/src/pages/LandingPages.tsx
git commit -m "feat(landing-pages): wire CustomDomainPanel into Domain Settings"
```

---

## Task 14: Release notes

**Files:**
- Modify: `backend/src/docs/user-release.ts`
- Modify: `customer-portal/src/docs/release.ts`

- [ ] **Step 1: Add entries**

Follow the existing format in each file. Add a single bullet to the most recent date entry (or create a new dated entry — use the merge date, not today's brainstorming date) along these lines:

Backend release entry:
```
Landing pages — paid users can now connect their own custom domains.
Verification status updates the live URL on the landing page card.
```

Frontend release entry (customer portal):
```
Landing Pages → Domain Settings: new Custom Domains panel with step-by-step
DNS setup. Paid users only.
```

(Tweak phrasing to match the file's voice.)

- [ ] **Step 2: TypeScript check**

Run: `cd backend && npx tsc && cd ../customer-portal && npx tsc`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/docs/user-release.ts customer-portal/src/docs/release.ts
git commit -m "docs: release notes for landing page custom domain UI"
```

---

## Task 15: Final verification

- [ ] **Step 1: Run backend coverage**

Run: `cd backend && npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary`
Expected: ≥ 95% on statements/branches/functions/lines for changed files.

If coverage is below 95% on any new code, identify uncovered branches and add tests.

- [ ] **Step 2: Run frontend tests**

Run: `cd customer-portal && npm test`
Expected: all pass.

- [ ] **Step 3: Run backend tsc**

Run: `cd backend && npx tsc`
Expected: no errors.

- [ ] **Step 4: Run frontend tsc**

Run: `cd customer-portal && npx tsc`
Expected: no errors.

- [ ] **Step 5: Manual verification on cloud test environment**

Use the cloud test environment (`./test-env/test-env.sh launch` + `sync`). Steps:
1. Log in as `test@example.com` / `Test123!` (admin — has `*` for allowedFeatures)
2. Navigate to a landing page → click "Domains"
3. Confirm Custom Domains panel renders (input form)
4. Submit a real domain you own; verify DNS records appear with the right type (CNAME for subdomain, A for apex)
5. Add the records at your registrar
6. Wait for verification (or use Check Again)
7. Confirm State 3 renders and the landing page card shows the new URL
8. Click Disconnect → confirm dialog → confirm → verify state returns to input form
9. Log in as `test1@example.com` (Basic) — confirm upgrade card appears instead of input

- [ ] **Step 6: Final commit (if any fixes from manual testing)**

```bash
git add -A
git commit -m "fix(landing-pages): <description of any fix found during manual test>"
```

- [ ] **Step 7: Push and open PR**

```bash
git push -u origin harshit/landing-page-custom-domain-ui
gh pr create --title "feat: custom domain UI for landing pages" --body "$(cat <<'EOF'
## Summary
- Replaces the "Custom Domains — Coming Soon" placeholder with a real panel: input → pending DNS → verified → disconnect
- Adds `allowedFeatures` to subscription tiers; gates the feature both server-side and client-side
- Persists `customDomainUrl` on the landing page on successful Vercel verification; clears it on disconnect

## Test plan
- [ ] Backend tests + coverage ≥ 95%
- [ ] Frontend tests
- [ ] tsc clean (backend + customer-portal)
- [ ] Manual test on cloud test env: paid user can add+verify+disconnect a real domain
- [ ] Manual test: Basic user sees upgrade card
EOF
)"
```

---

## Self-Review

After writing the plan, I checked:

**1. Spec coverage:**
- Spec §1 (Architecture, inline panel) → Tasks 9–13
- Spec §2 (States & UX) → Tasks 9 (gate + rehydration), 10 (State 1+2), 11 (polling + State 3), 12 (disconnect)
- Spec §3 (Subscription Gating) → Tasks 1 (helper), 7 (auth response), 8 (frontend type), 13 (frontend gate use)
- Spec §4 (Data Flow & API) → Tasks 3 (service schema), 4 (route gate + ownership), 5 (verify persistence)
- Spec §5 (Error Handling) → Task 10 covers add-domain errors; Task 11 covers verify errors + cap; Task 12 covers disconnect
- Spec §6 (Testing) → embedded in each task

**2. Placeholder scan:** no TBD / TODO / "add appropriate error handling" / "similar to Task N" without repeat. All code blocks are concrete.

**3. Type consistency:**
- `CustomDomainRecord.landingPageId` — same name backend (Task 3) and frontend (Tasks 9–12)
- `verifyDomain` return shape `{ verified, status, verificationRecords?, record }` — consistent between Task 3 (service) and Tasks 5, 11 (consumers)
- `userHasFeature(userId, feature)` — same signature in Task 1 (definition) and Task 4 (use)
- `hasCustomDomainAccess` (frontend) — used only in Task 13, references `user.allowedFeatures` added in Task 8

No drift found.
