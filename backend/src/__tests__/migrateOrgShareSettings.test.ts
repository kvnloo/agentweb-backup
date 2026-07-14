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

  it("backfills settings-less orgs from defaultShareSettings()", async () => {
    // The migration writes whatever defaultShareSettings() returns (its single
    // source of truth), and only to orgs that have NO shareSettings yet — orgs
    // that already have a stored config are skipped (see idempotency test below)
    // and keep it. Since the default is now shared-by-default, a settings-less
    // org gets the same shared config a newly-created org would.
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
      expect(settings.knowledgeBase.enabled).toBe(true);
      expect(settings.htmlTemplates.enabled).toBe(true);
      expect(settings.landingPages.enabled).toBe(true);
      expect(settings.analytics.enabled).toBe(true);
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
