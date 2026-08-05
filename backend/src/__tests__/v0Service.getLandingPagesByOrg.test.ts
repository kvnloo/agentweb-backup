/**
 * ENG-900 — `getLandingPagesByOrg` must never reach outside the caller's org.
 *
 * This function is the org fan-out behind two separate surfaces:
 *   - `GET /api/landing-pages/v0/generated` (org-shared page list)
 *   - `assessClientHealth` / `list_all_clients` (ENG-717 org lander detection)
 *
 * Both of those have tests that *look* like they cover cross-org isolation, and
 * neither does. `orgSharedLandingPages.test.ts` has "does NOT include pages from
 * a different org", but it MOCKS this function and has the mock return only
 * member pages — its own comment reads "fanout only returns pages of org members
 * — pages of other orgs won't appear". `clientHealth.test.ts` mocks it too, and
 * every fixture there shares one orgId.
 *
 * So the property was assumed by both callers' mocks and verified by nobody. If
 * this fan-out were later "optimized" into a single unscoped scan plus a filter,
 * every one of those tests would stay green while another organization's landing
 * pages appeared in an admin-facing client-health assessment.
 *
 * These tests are deliberately about WHO IS ASKED, not about filtering the
 * result. A non-member's pages must never be fetched in the first place — there
 * is then nothing to leak, and no filter to get wrong.
 *
 * They assert on the DynamoDB queries the fan-out actually issues. Spying on the
 * exported `getLandingPagesByOwner` does NOT work here: `getLandingPagesByOrg`
 * calls it through an internal module reference, so the spy never fires and
 * every assertion passes vacuously against an empty result. Reading the query
 * layer is the only place the owner ids are observable.
 */

const mockQuery = jest.fn();
jest.mock("aws-sdk", () => {
  const mockFn = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
  const DocumentClient = jest.fn().mockImplementation(() => ({
    put: mockFn, update: mockFn, get: mockFn, delete: mockFn, scan: mockFn,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    query: (...a: unknown[]) => (global as any).__mockQuery(...a),
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

const mockGetOrgMembers = jest.fn();
jest.mock("../services/db", () => ({
  orgDb: { getOrgMembers: (...a: unknown[]) => mockGetOrgMembers(...a) },
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
}));

import * as v0Service from "../services/v0Service";

const ORG = "org-abc";
const CALLER = "user-caller";
const TEAMMATE = "user-teammate";
const OUTSIDER = "user-outsider";

const page = (id: string, userId: string) => ({
  id,
  userId,
  status: "deployed",
  customDomainUrl: `https://${id}.example.com`,
});

/** The userIds the fan-out actually queried for, in call order. */
const queriedOwners = (): string[] =>
  mockQuery.mock.calls
    .map(([params]) => params?.ExpressionAttributeValues?.[":u"])
    .filter((u): u is string => typeof u === "string");

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).__mockQuery = mockQuery;
  mockQuery.mockImplementation((params: any) => ({
    promise: async () => {
      const uid = params?.ExpressionAttributeValues?.[":u"];
      return { Items: uid === TEAMMATE ? [page("teammate-lander", TEAMMATE)] : [] };
    },
  }));
});

describe("ENG-900 — getLandingPagesByOrg is scoped to org members", () => {
  it("only fetches pages for members returned by the org roster", async () => {
    mockGetOrgMembers.mockResolvedValue([
      { userId: CALLER },
      { userId: TEAMMATE },
    ]);

    await v0Service.getLandingPagesByOrg(ORG, CALLER);

    const asked = queriedOwners();
    // Proves the fan-out really ran: without this the "not contains" below
    // would hold on an empty array and guard nothing.
    expect(asked).toContain(TEAMMATE);
    expect(asked).not.toContain(OUTSIDER);
  });

  it("never asks for a non-member's pages even when one exists in the system", async () => {
    // The outsider owns a deployed page. The roster does not list them, so the
    // fan-out must never reach for it. This is the actual leak scenario.
    mockGetOrgMembers.mockResolvedValue([{ userId: CALLER }, { userId: TEAMMATE }]);

    const pages = await v0Service.getLandingPagesByOrg(ORG, CALLER);

    expect(queriedOwners()).not.toContain(OUTSIDER);
    expect(queriedOwners().length).toBeGreaterThan(0);
    expect(pages.map((p) => p.userId)).not.toContain(OUTSIDER);
  });

  it("queries the roster for the requested org, not a wider set", async () => {
    mockGetOrgMembers.mockResolvedValue([{ userId: CALLER }, { userId: TEAMMATE }]);

    await v0Service.getLandingPagesByOrg(ORG, CALLER);

    expect(mockGetOrgMembers).toHaveBeenCalledTimes(1);
    expect(mockGetOrgMembers).toHaveBeenCalledWith(ORG);
  });

  it("excludes the caller's own pages — those come from the owner query", async () => {
    // Not cosmetic: including them here is how the route ended up needing a
    // dedupe pass, and a dedupe that mis-keys is another way to surface a page
    // that should not be there.
    mockGetOrgMembers.mockResolvedValue([{ userId: CALLER }, { userId: TEAMMATE }]);

    await v0Service.getLandingPagesByOrg(ORG, CALLER);

    expect(queriedOwners()).not.toContain(CALLER);
    expect(queriedOwners()).toContain(TEAMMATE);
  });

  it("returns nothing, and asks nobody, when the caller is the only member", async () => {
    mockGetOrgMembers.mockResolvedValue([{ userId: CALLER }]);

    const pages = await v0Service.getLandingPagesByOrg(ORG, CALLER);

    expect(pages).toEqual([]);
    expect(queriedOwners()).toEqual([]);
  });

  it("returns an empty list for an org with no roster rather than falling back to a wider query", async () => {
    // An empty roster must mean "no org pages", never "fetch everything".
    mockGetOrgMembers.mockResolvedValue([]);

    const pages = await v0Service.getLandingPagesByOrg(ORG, CALLER);

    expect(pages).toEqual([]);
    expect(queriedOwners()).toEqual([]);
  });
});
