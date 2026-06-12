/**
 * Unit tests for v0Service.canUserEditLandingPage — the single source of truth
 * for the landing-page EDIT decision, shared by the route layer, the list/get
 * endpoints (editable flag), and the coding agent preflight.
 *
 * Regression coverage for the systemic bug where a plain org member could VIEW a
 * shared landing page (and the agent would therefore select it) but was blocked
 * from editing it — surfacing as a confusing "platform permission bug".
 */

// aws-sdk is pulled in transitively by v0Service; provide a no-op mock.
jest.mock("aws-sdk", () => {
  const mockFn = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
  const DocumentClient = jest.fn().mockImplementation(() => ({
    put: mockFn, update: mockFn, get: mockFn, query: mockFn, delete: mockFn,
  }));
  const SecretsManager = jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
    }),
  }));
  return {
    __esModule: true,
    default: { DynamoDB: { DocumentClient }, SecretsManager, S3: jest.fn(), config: { update: jest.fn() } },
    DynamoDB: { DocumentClient },
    SecretsManager,
    S3: jest.fn(),
    config: { update: jest.fn() },
  };
});

jest.mock("../utils/secretsManager", () => ({
  getV0ApiKey: jest.fn().mockResolvedValue("test-key"),
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: "t", org: "o" }),
  getVercelToken: jest.fn().mockResolvedValue("v"),
  getLandingPagesConfig: jest.fn().mockResolvedValue({}),
  getSecret: jest.fn().mockResolvedValue("{}"),
}));

jest.mock("../services/settingsService", () => ({
  settingsService: { getSetting: jest.fn(), updateSetting: jest.fn() },
}));

jest.mock("../services/customDomainService", () => ({
  addSubdomain: jest.fn(),
  generateSubdomain: jest.fn(),
}));

const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
jest.mock("../services/db", () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrgById(...a) },
}));

import { canUserEditLandingPage } from "../services/v0Service";

const ORG = "org-1";
const OWNER_USER = "owner-page";
const CALLER = "caller-1";

function org(enabled: boolean, editors: string[] = []) {
  return { orgId: ORG, ownerUserId: "org-owner", shareSettings: { landingPages: { enabled, editors } } };
}

describe("canUserEditLandingPage", () => {
  beforeEach(() => jest.clearAllMocks());

  // --- SUCCESS / true ---

  it("returns true for the page owner (no DB lookups needed)", async () => {
    const result = await canUserEditLandingPage({ userId: CALLER }, CALLER);
    expect(result).toBe(true);
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it("returns true for a listed landingPages editor in the same org", async () => {
    mockGetUserById.mockImplementation(async (id: string) =>
      id === CALLER
        ? { userId: CALLER, orgId: ORG, orgRole: "member" }
        : { userId: OWNER_USER, orgId: ORG, orgRole: "member" },
    );
    mockGetOrgById.mockResolvedValue(org(true, [CALLER]));

    expect(await canUserEditLandingPage({ userId: OWNER_USER }, CALLER)).toBe(true);
  });

  it("returns true for the org owner editing a member's page", async () => {
    mockGetUserById.mockImplementation(async (id: string) =>
      id === CALLER
        ? { userId: CALLER, orgId: ORG, orgRole: "owner" }
        : { userId: OWNER_USER, orgId: ORG, orgRole: "member" },
    );
    mockGetOrgById.mockResolvedValue(org(true, []));

    expect(await canUserEditLandingPage({ userId: OWNER_USER }, CALLER)).toBe(true);
  });

  // --- FAIL / false ---

  it("returns false for a plain member (sharing on, not an editor) — the reported bug", async () => {
    mockGetUserById.mockImplementation(async (id: string) =>
      id === CALLER
        ? { userId: CALLER, orgId: ORG, orgRole: "member" }
        : { userId: OWNER_USER, orgId: ORG, orgRole: "member" },
    );
    mockGetOrgById.mockResolvedValue(org(true, [])); // enabled (visible) but no editors

    expect(await canUserEditLandingPage({ userId: OWNER_USER }, CALLER)).toBe(false);
  });

  it("returns false when caller is in a different org", async () => {
    mockGetUserById.mockImplementation(async (id: string) =>
      id === CALLER
        ? { userId: CALLER, orgId: "other-org", orgRole: "owner" }
        : { userId: OWNER_USER, orgId: ORG, orgRole: "member" },
    );
    // orgs differ → org context resolves to null
    mockGetOrgById.mockResolvedValue(null);

    expect(await canUserEditLandingPage({ userId: OWNER_USER }, CALLER)).toBe(false);
    // No point fetching the org when orgIds don't match.
    expect(mockGetOrgById).not.toHaveBeenCalled();
  });

  it("returns false (deny) when a DB lookup throws — fail closed", async () => {
    mockGetUserById.mockRejectedValue(new Error("DynamoDB down"));
    expect(await canUserEditLandingPage({ userId: OWNER_USER }, CALLER)).toBe(false);
  });
});
