// findUserSiteRecord must not resurrect an archived (soft-deleted) root page.
//
// The mock simulates DynamoDB's server-side FilterExpression evaluation for the one
// filter this function uses (archived), since paginatedQuery/DocumentClient.query()
// does no client-side filtering itself — a bare jest.fn() returning canned Items would
// pass regardless of what FilterExpression the code sends, silently defeating the test.
//
// ENG-478: the GSI query (`query`, below) is unavoidably eventually consistent, so
// findUserSiteRecord also does a strongly-consistent `get` by primary key on whatever
// candidate the GSI query selects, to catch a delete that lands between the two reads.
// `getById` is a SEPARATE snapshot from `allItems` (not just a re-filter of it) so a
// test can simulate the GSI read and the primary-key verify disagreeing — the actual
// race this fix exists to catch.
let allItems: any[] = [];
let getById: Record<string, any> = {};
const mockQuery = jest.fn((params: any) => ({
  promise: () => {
    const passesFilter =
      params.FilterExpression === "attribute_not_exists(archived) OR archived = :archivedFalse";
    const items = passesFilter ? allItems.filter((i) => !i.archived) : allItems;
    return Promise.resolve({ Items: items });
  },
}));
const mockGet = jest.fn((params: any) => ({
  promise: () => Promise.resolve({ Item: getById[params.Key.id] }),
}));
const mockUpdate = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
const mockS3 = { putObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }) };

jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        query: mockQuery,
        get: mockGet,
        update: mockUpdate,
      })),
    },
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: () => Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
      }),
    })),
    S3: jest.fn().mockImplementation(() => mockS3),
    config: { update: jest.fn() },
  },
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      query: mockQuery,
      get: mockGet,
      update: mockUpdate,
    })),
  },
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
    }),
  })),
  S3: jest.fn().mockImplementation(() => mockS3),
  config: { update: jest.fn() },
}));

import { findUserSiteRecord } from "../services/v0Service";

describe("findUserSiteRecord archived filter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    allItems = [];
    getById = {};
  });

  it("does not return an archived root page even when it is the only isRootPage match", async () => {
    allItems = [
      {
        id: "archived-root",
        userId: "user-1",
        isRootPage: true,
        githubRepoUrl: "https://github.com/org/stale-repo",
        archived: true,
      },
    ];

    const result = await findUserSiteRecord("user-1");

    expect(result).toBeNull();
  });

  it("passes an archived-exclusion FilterExpression to the query, like getLandingPagesByOwner does", async () => {
    await findUserSiteRecord("user-1");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        FilterExpression: "attribute_not_exists(archived) OR archived = :archivedFalse",
        ExpressionAttributeValues: expect.objectContaining({ ":archivedFalse": false }),
      })
    );
  });

  it("still returns a non-archived root page when one exists alongside an archived one", async () => {
    allItems = [
      {
        id: "archived-root",
        userId: "user-1",
        isRootPage: true,
        githubRepoUrl: "https://github.com/org/stale-repo",
        archived: true,
      },
      {
        id: "live-root",
        userId: "user-1",
        isRootPage: true,
        githubRepoUrl: "https://github.com/org/live-repo",
      },
    ];
    getById = {
      "live-root": {
        id: "live-root",
        userId: "user-1",
        isRootPage: true,
        githubRepoUrl: "https://github.com/org/live-repo",
      },
    };

    const result = await findUserSiteRecord("user-1");

    expect(result).toEqual(
      expect.objectContaining({ id: "live-root", githubRepoUrl: "https://github.com/org/live-repo" })
    );
  });

  // ENG-478: the GSI query is unavoidably eventually consistent — these cover the
  // strongly-consistent primary-key verify added on top of it.
  describe("ENG-478: strongly-consistent verify against the GSI race", () => {
    it("FAIL: GSI read shows the candidate live, but a concurrent delete already archived it — returns null, not the stale record", async () => {
      allItems = [
        {
          id: "root-1",
          userId: "user-1",
          isRootPage: true,
          githubRepoUrl: "https://github.com/org/mid-delete-repo",
        },
      ];
      // The strongly-consistent read reflects a delete that landed AFTER the GSI
      // read but BEFORE this verify — the actual race this fix exists to catch.
      getById = {
        "root-1": {
          id: "root-1",
          userId: "user-1",
          isRootPage: true,
          githubRepoUrl: "https://github.com/org/mid-delete-repo",
          archived: true,
        },
      };

      const result = await findUserSiteRecord("user-1");

      expect(result).toBeNull();
    });

    it("FAIL: strongly-consistent read finds no Item at all (hard-deleted between reads) — returns null", async () => {
      allItems = [
        {
          id: "root-1",
          userId: "user-1",
          isRootPage: true,
          githubRepoUrl: "https://github.com/org/gone-repo",
        },
      ];
      getById = {}; // no entry for "root-1" — Item comes back undefined

      const result = await findUserSiteRecord("user-1");

      expect(result).toBeNull();
    });

    it("SUCCESS: verify confirms the candidate is still live — returns it, and the isRootPage backfill still runs", async () => {
      allItems = [
        {
          id: "root-1",
          userId: "user-1",
          githubRepoUrl: "https://github.com/org/live-repo",
          // isRootPage NOT set yet — exercises the backfill write on top of a
          // verified-live record.
        },
      ];
      getById = {
        "root-1": {
          id: "root-1",
          userId: "user-1",
          githubRepoUrl: "https://github.com/org/live-repo",
        },
      };

      const result = await findUserSiteRecord("user-1");

      expect(result).toEqual(
        expect.objectContaining({ id: "root-1", isRootPage: true })
      );
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { id: "root-1" },
          UpdateExpression: "SET isRootPage = :val",
        })
      );
    });

    it("passes ConsistentRead:true and the candidate's id as the primary key to the verify read", async () => {
      allItems = [
        {
          id: "root-1",
          userId: "user-1",
          isRootPage: true,
          githubRepoUrl: "https://github.com/org/live-repo",
        },
      ];
      getById = { "root-1": allItems[0] };

      await findUserSiteRecord("user-1");

      expect(mockGet).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { id: "root-1" },
          ConsistentRead: true,
        })
      );
    });
  });
});
