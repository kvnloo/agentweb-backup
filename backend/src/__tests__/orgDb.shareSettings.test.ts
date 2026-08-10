const mockUpdate = jest.fn();
const mockGet = jest.fn();

jest.mock("aws-sdk", () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get:    (...a: any[]) => ({ promise: () => mockGet(...a) }),
      update: (...a: any[]) => ({ promise: () => mockUpdate(...a) }),
      query:  () => ({ promise: () => Promise.resolve({ Items: [] }) }),
      scan:   () => ({ promise: () => Promise.resolve({ Items: [] }) }),
      put:    () => ({ promise: () => Promise.resolve({}) }),
      delete: () => ({ promise: () => Promise.resolve({}) }),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn(() => ({ promise: jest.fn() })),
    getObject: jest.fn(() => ({ promise: jest.fn() })),
    deleteObject: jest.fn(() => ({ promise: jest.fn() })),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn(() => ({
      promise: jest.fn().mockResolvedValue({ SecretString: "{}" }),
    })),
  })),
}));

import { orgDb } from "../services/db";

describe("updateShareSettings", () => {
  beforeEach(() => {
    mockUpdate.mockReset();
    mockGet.mockReset();
    jest.useRealTimers();
  });

  afterEach(() => { jest.useRealTimers(); });

  it("writes the shareSettings field as a single UpdateItem", async () => {
    mockUpdate.mockResolvedValueOnce({});
    const settings = {
      knowledgeBase:     { enabled: false, editors: [] },
      htmlTemplates:     { enabled: true,  editors: ["u-1"] },
      landingPages:      { enabled: false, editors: [] },
      workPlans:         { enabled: true,  editors: [] },
      skills:            { enabled: false, editors: [] },
      analytics:         { enabled: false, editors: [] },
      brandGuidelines:   { editors: [] },
      marketingStrategy: { editors: [] },
    };
    await orgDb.updateShareSettings("org-1", settings, "2026-01-01T00:00:00.000Z");
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const args = mockUpdate.mock.calls[0][0];
    expect(args.Key.orgId).toBe("org-1");
    expect(args.UpdateExpression).toContain("shareSettings");
    expect(args.ConditionExpression).toBe("updatedAt = :expected");
    expect(args.ExpressionAttributeValues[":expected"]).toBe("2026-01-01T00:00:00.000Z");
  });

  it("guards a legacy org with no updatedAt via attribute_not_exists", async () => {
    mockUpdate.mockResolvedValueOnce({});
    const settings = { brandGuidelines: { editors: [] } } as any;
    await orgDb.updateShareSettings("org-1", settings, undefined);
    const args = mockUpdate.mock.calls[0][0];
    expect(args.ConditionExpression).toBe("attribute_not_exists(updatedAt)");
  });

  it.each([
    ["the clock equals the prior revision", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.001Z"],
    ["the clock is one millisecond behind", "2026-01-01T00:00:00.001Z", "2026-01-01T00:00:00.002Z"],
    ["the clock is well behind", "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:01.001Z"],
  ])("advances the revision when %s", async (_case, expectedUpdatedAt, nextUpdatedAt) => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockUpdate.mockResolvedValueOnce({});

    await orgDb.updateShareSettings(
      "org-1",
      { brandGuidelines: { editors: [] } } as any,
      expectedUpdatedAt,
    );

    const args = mockUpdate.mock.calls[0][0];
    expect(args.ExpressionAttributeValues[":u"]).toBe(nextUpdatedAt);
  });
});

describe("pruneEditorListsForUser", () => {
  beforeEach(() => { mockUpdate.mockReset(); mockGet.mockReset(); });

  it("removes the userId from each editors array and writes once", async () => {
    mockGet.mockResolvedValueOnce({ Item: {
      orgId: "org-1", ownerUserId: "u-owner", name: "n",
      shareSettings: {
        knowledgeBase:     { enabled: false, editors: ["u-x", "u-1"] },
        htmlTemplates:     { enabled: true,  editors: ["u-1"] },
        landingPages:      { enabled: false, editors: [] },
        workPlans:         { enabled: true,  editors: [] },
        skills:            { enabled: false, editors: [] },
        analytics:         { enabled: false, editors: [] },
        brandGuidelines:   { editors: ["u-1", "u-2"] },
        marketingStrategy: { editors: [] },
      },
    }});
    mockUpdate.mockResolvedValueOnce({});
    await orgDb.pruneEditorListsForUser("org-1", "u-1");
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const args = mockUpdate.mock.calls[0][0];
    const written = JSON.stringify(args.ExpressionAttributeValues);
    expect(written).not.toContain("u-1");
    expect(written).toContain("u-x");
    expect(written).toContain("u-2");
    expect(args.ConditionExpression).toBeDefined();
  });

  it("re-reads and retries when a concurrent writer bumps updatedAt", async () => {
    const orgAt = (updatedAt: string, editors: string[]) => ({ Item: {
      orgId: "org-1", ownerUserId: "u-owner", name: "n", updatedAt,
      shareSettings: {
        knowledgeBase:     { enabled: false, editors },
        htmlTemplates:     { enabled: false, editors: [] },
        landingPages:      { enabled: false, editors: [] },
        workPlans:         { enabled: false, editors: [] },
        skills:            { enabled: false, editors: [] },
        analytics:         { enabled: false, editors: [] },
        brandGuidelines:   { editors: [] },
        marketingStrategy: { editors: [] },
      },
    }});
    mockGet.mockResolvedValueOnce(orgAt("t1", ["u-1", "u-a"]));
    const conflict: any = new Error("conflict");
    conflict.code = "ConditionalCheckFailedException";
    mockUpdate.mockRejectedValueOnce(conflict);
    // Fresh state written by the overlapping writer includes a new grant u-b.
    mockGet.mockResolvedValueOnce(orgAt("t2", ["u-1", "u-a", "u-b"]));
    mockUpdate.mockResolvedValueOnce({});

    await orgDb.pruneEditorListsForUser("org-1", "u-1");

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    const second = mockUpdate.mock.calls[1][0];
    expect(second.ExpressionAttributeValues[":expected"]).toBe("t2");
    const written = JSON.stringify(second.ExpressionAttributeValues[":s"]);
    expect(written).not.toContain("u-1");
    expect(written).toContain("u-b"); // concurrent grant preserved
  });
});
