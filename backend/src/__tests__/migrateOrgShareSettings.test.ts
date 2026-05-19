const mockScan = jest.fn();
const mockUpdate = jest.fn();
jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      scan:   (...a: any[]) => ({ promise: () => mockScan(...a) }),
      update: (...a: any[]) => ({ promise: () => mockUpdate(...a) }),
    })),
  },
}));

import { runMigration } from "../scripts/migrate-org-share-settings";

describe("migrate-org-share-settings", () => {
  beforeEach(() => { mockScan.mockReset(); mockUpdate.mockReset(); });

  it("writes preserve-current-behavior defaults for existing orgs", async () => {
    mockScan.mockResolvedValueOnce({
      Items: [
        { orgId: "org-1", ownerUserId: "u" },
        { orgId: "org-2", ownerUserId: "u" },
      ],
    });
    mockUpdate.mockResolvedValue({});

    await runMigration();

    expect(mockUpdate).toHaveBeenCalledTimes(2);
    for (const call of mockUpdate.mock.calls) {
      const settings = call[0].ExpressionAttributeValues[":s"];
      expect(settings.workPlans.enabled).toBe(true);
      expect(settings.skills.enabled).toBe(true);
      expect(settings.knowledgeBase.enabled).toBe(false);
      expect(settings.htmlTemplates.enabled).toBe(false);
      expect(settings.landingPages.enabled).toBe(false);
      expect(settings.brandGuidelines.editors).toEqual([]);
      expect(settings.marketingStrategy.editors).toEqual([]);
    }
  });

  it("is idempotent: skips orgs that already have shareSettings", async () => {
    mockScan.mockResolvedValueOnce({
      Items: [{ orgId: "org-1", shareSettings: { workPlans: { enabled: true, editors: [] } } }],
    });
    await runMigration();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
