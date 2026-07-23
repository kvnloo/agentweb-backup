// findUserSiteRecord must not resurrect an archived (soft-deleted) root page.
//
// The mock simulates DynamoDB's server-side FilterExpression evaluation for the one
// filter this function uses (archived), since paginatedQuery/DocumentClient.query()
// does no client-side filtering itself — a bare jest.fn() returning canned Items would
// pass regardless of what FilterExpression the code sends, silently defeating the test.
let allItems: any[] = [];
const mockQuery = jest.fn((params: any) => ({
  promise: () => {
    const passesFilter =
      params.FilterExpression === "attribute_not_exists(archived) OR archived = :archivedFalse";
    const items = passesFilter ? allItems.filter((i) => !i.archived) : allItems;
    return Promise.resolve({ Items: items });
  },
}));
const mockS3 = { putObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }) };

jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        query: mockQuery,
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

    const result = await findUserSiteRecord("user-1");

    expect(result).toEqual(
      expect.objectContaining({ id: "live-root", githubRepoUrl: "https://github.com/org/live-repo" })
    );
  });
});
