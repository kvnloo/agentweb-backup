/**
 * Unit tests for DripSendsDb (Lifecycle Drip Phase 4).
 * Follows the DripCampaignDb mock pattern — stub `aws-sdk` at the module level.
 */
import { DripSendsDb, DripSend } from "../services/dripSendsDb";

const mockPut = jest
  .fn()
  .mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
const mockScan = jest.fn();

jest.mock("aws-sdk", () => {
  return {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: mockPut,
        scan: mockScan,
      })),
    },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPut.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  mockScan.mockReset();
});

const validInput = {
  campaignId: "camp-1",
  userId: "user-1",
  email: "user@example.com",
  templateSnapshot: "<p>hi</p>",
  subjectSnapshot: "hello",
  messageId: "msg-1",
  status: "sent" as const,
  dryRun: false,
};

describe("DripSendsDb.record", () => {
  it("writes a DripSend record with a generated sendId", async () => {
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    const record = await db.record(validInput);

    expect(record.sendId).toBeDefined();
    expect(record.sendId).toHaveLength(36); // uuid v4
    expect(record.campaignId).toBe("camp-1");
    expect(record.userId).toBe("user-1");
    expect(record.status).toBe("sent");
    expect(record.dryRun).toBe(false);
    expect(record.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mockPut).toHaveBeenCalledTimes(1);
    const call = mockPut.mock.calls[0][0];
    expect(call.TableName).toBe("Dev-AW-DripSends-test");
    expect(call.Item.campaignId).toBe("camp-1");
  });

  it("persists dryRun=true and stores status='dry_run' verbatim", async () => {
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    const record = await db.record({
      ...validInput,
      status: "dry_run",
      dryRun: true,
      messageId: null,
    });
    expect(record.status).toBe("dry_run");
    expect(record.dryRun).toBe(true);
    expect(record.messageId).toBeNull();
  });

  it("persists failure records with error string", async () => {
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    const record = await db.record({
      ...validInput,
      status: "failed",
      messageId: null,
      error: "SMTP connection refused",
    });
    expect(record.status).toBe("failed");
    expect(record.error).toBe("SMTP connection refused");
  });

  it("throws when campaignId is missing", async () => {
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    await expect(
      db.record({ ...validInput, campaignId: "" }),
    ).rejects.toThrow(/campaignId is required/);
  });

  it("throws when userId is missing", async () => {
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    await expect(
      db.record({ ...validInput, userId: "" }),
    ).rejects.toThrow(/userId is required/);
  });

  it("throws when email is missing", async () => {
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    await expect(
      db.record({ ...validInput, email: "" }),
    ).rejects.toThrow(/email is required/);
  });

  it("throws on invalid status", async () => {
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    await expect(
      db.record({ ...validInput, status: "weird" as any }),
    ).rejects.toThrow(/status must be one of/);
  });
});

describe("DripSendsDb.countSendsForUserCampaign", () => {
  it("counts only status='sent' records for a specific user+campaign", async () => {
    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [
          { sendId: "a", status: "sent" },
          { sendId: "b", status: "sent" },
        ],
      }),
    });
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    const count = await db.countSendsForUserCampaign("user-1", "camp-1");
    expect(count).toBe(2);
    const call = mockScan.mock.calls[0][0];
    expect(call.FilterExpression).toContain("userId = :uid");
    expect(call.FilterExpression).toContain("campaignId = :cid");
    expect(call.FilterExpression).toContain("#status = :sent");
    expect(call.ExpressionAttributeValues[":uid"]).toBe("user-1");
    expect(call.ExpressionAttributeValues[":cid"]).toBe("camp-1");
    expect(call.ExpressionAttributeValues[":sent"]).toBe("sent");
  });

  it("returns 0 when no items match", async () => {
    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    });
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    const count = await db.countSendsForUserCampaign("ghost", "camp-1");
    expect(count).toBe(0);
  });
});

describe("DripSendsDb.getMostRecentSendAt", () => {
  it("returns the newest sentAt when multiple sends exist", async () => {
    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [
          { sentAt: "2026-04-10T00:00:00Z", status: "sent" },
          { sentAt: "2026-04-17T00:00:00Z", status: "sent" },
          { sentAt: "2026-04-05T00:00:00Z", status: "sent" },
        ],
      }),
    });
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    const latest = await db.getMostRecentSendAt("user-1", "camp-1");
    expect(latest).toBe("2026-04-17T00:00:00Z");
  });

  it("returns null when user has no sends", async () => {
    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    });
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    const latest = await db.getMostRecentSendAt("user-1", "camp-1");
    expect(latest).toBeNull();
  });
});

describe("DripSendsDb.countSendsInWindow", () => {
  it("counts campaign sends since the window start", async () => {
    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [{ sendId: "a" }, { sendId: "b" }, { sendId: "c" }],
      }),
    });
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    const count = await db.countSendsInWindow(
      "camp-1",
      "2026-04-17T00:00:00Z",
    );
    expect(count).toBe(3);
    const call = mockScan.mock.calls[0][0];
    expect(call.FilterExpression).toContain("sentAt >= :since");
  });
});

describe("DripSendsDb.listForCampaign", () => {
  it("returns all sends for a campaign", async () => {
    const records: Partial<DripSend>[] = [
      { sendId: "a", campaignId: "camp-1" },
      { sendId: "b", campaignId: "camp-1" },
    ];
    mockScan.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: records }),
    });
    const db = new DripSendsDb("Dev-AW-DripSends-test");
    const results = await db.listForCampaign("camp-1");
    expect(results).toHaveLength(2);
  });
});
