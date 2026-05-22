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
  beforeEach(() => { mockUpdate.mockReset(); mockGet.mockReset(); });

  it("writes the shareSettings field as a single UpdateItem", async () => {
    mockUpdate.mockResolvedValueOnce({});
    const settings = {
      knowledgeBase:     { enabled: false, editors: [] },
      htmlTemplates:     { enabled: true,  editors: ["u-1"] },
      landingPages:      { enabled: false, editors: [] },
      workPlans:         { enabled: true,  editors: [] },
      skills:            { enabled: false, editors: [] },
      funnels:           { enabled: false, editors: [] },
      analytics:         { enabled: false, editors: [] },
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
        funnels:           { enabled: false, editors: [] },
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
  });
});
