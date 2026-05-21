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

describe("pruneEditorListsForUser — funnels", () => {
  beforeEach(() => { mockUpdate.mockReset(); mockGet.mockReset(); });

  test("pruneEditorListsForUser strips the removed user from funnels.editors", async () => {
    // Arrange: org with shareSettings.funnels.editors = ["keep-me", "remove-me"]
    mockGet.mockResolvedValueOnce({ Item: {
      orgId: "org-1", ownerUserId: "u-owner", name: "n",
      shareSettings: {
        knowledgeBase:     { enabled: false, editors: [] },
        htmlTemplates:     { enabled: false, editors: [] },
        landingPages:      { enabled: false, editors: [] },
        workPlans:         { enabled: true,  editors: [] },
        skills:            { enabled: true,  editors: [] },
        funnels:           { enabled: false, editors: ["keep-me", "remove-me"] },
        brandGuidelines:   { editors: [] },
        marketingStrategy: { editors: [] },
      },
    }});
    mockUpdate.mockResolvedValueOnce({});

    // Act
    await orgDb.pruneEditorListsForUser("org-1", "remove-me");

    // Assert: the persisted shareSettings.funnels.editors === ["keep-me"]
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const persistedSettings = mockUpdate.mock.calls[0][0].ExpressionAttributeValues[":s"];
    expect(persistedSettings.funnels.editors).toEqual(["keep-me"]);
  });
});
