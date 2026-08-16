import AWS from "aws-sdk";

const mockDocClient = {
  query: jest.fn(),
  update: jest.fn(),
  transactWrite: jest.fn(),
};

jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocClient),
  },
  S3: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));

import { userDb } from "../services/db";

describe("userDb.incrementTokenUsageForMonth", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    DocumentClient();
    mockDocClient.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [{ userId: "u1", email: "u1@example.com" }],
      }),
    });
    mockDocClient.update.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Attributes: {
          userId: "u1",
          email: "u1@example.com",
          tokenUsage: {
            month: "2026-06",
            totalTokens: 7000,
            totalCost: 0.7,
          },
        },
      }),
    });
  });

  it("uses a conditional atomic arithmetic update for same-month usage", async () => {
    await userDb.incrementTokenUsageForMonth(
      "u1",
      "2026-06",
      2000,
      0.2,
      "2026-07-01T00:00:00.000Z"
    );

    expect(mockDocClient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { email: "u1@example.com" },
        UpdateExpression: expect.stringContaining(
          "#tokenUsage.#totalTokens = if_not_exists(#tokenUsage.#totalTokens, :zero) + :tokens"
        ),
        ConditionExpression: "#userId = :userId AND #tokenUsage.#month = :month",
        ExpressionAttributeValues: expect.objectContaining({
          ":userId": "u1",
          ":month": "2026-06",
          ":tokens": 2000,
          ":cost": 0.2,
          ":zero": 0,
        }),
        ReturnValues: "ALL_NEW",
      })
    );
  });

  it("returns null when the month condition fails", async () => {
    mockDocClient.update.mockReturnValue({
      promise: jest.fn().mockRejectedValue({
        code: "ConditionalCheckFailedException",
      }),
    });

    await expect(
      userDb.incrementTokenUsageForMonth(
        "u1",
        "2026-06",
        2000,
        0.2,
        "2026-07-01T00:00:00.000Z"
      )
    ).resolves.toBeNull();
  });
});

describe("userDb.resetTokenUsageForMonth (ENG-1134)", () => {
  const args = {
    userId: "u1",
    month: "2026-08",
    tokens: 500,
    cost: 5,
    resetDate: "2026-09-01T00:00:00.000Z",
    history: [{ month: "2026-07", totalTokens: 900, totalCost: 9 }],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    DocumentClient();
    mockDocClient.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [{ userId: "u1", email: "u1@example.com" }],
      }),
    });
  });

  it("guards the rollover so a concurrent writer cannot be clobbered", async () => {
    mockDocClient.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

    const ok = await userDb.resetTokenUsageForMonth(args);

    expect(ok).toBe(true);
    const params = mockDocClient.update.mock.calls[0][0];
    // Succeeds only while the stored month is still NOT the new one. Without this
    // condition two rollover writes both land and the second discards the first.
    expect(params.ConditionExpression).toContain("<>");
    expect(params.ExpressionAttributeValues[":month"]).toBe("2026-08");
    expect(params.ExpressionAttributeValues[":usage"]).toMatchObject({
      month: "2026-08",
      totalTokens: 500,
      totalCost: 5,
    });
    // Bonus is cleared as part of the same atomic write, not a second update.
    expect(params.ExpressionAttributeValues[":zero"]).toBe(0);
  });

  it("reports false when another writer already rolled the month", async () => {
    // The caller's cue to fall back to a plain increment rather than drop the charge.
    mockDocClient.update.mockReturnValue({
      promise: jest.fn().mockRejectedValue({ code: "ConditionalCheckFailedException" }),
    });

    await expect(userDb.resetTokenUsageForMonth(args)).resolves.toBe(false);
  });

  it("rethrows a genuine DynamoDB failure instead of reporting a lost race", async () => {
    // Swallowing this would silently drop the charge while looking like contention.
    mockDocClient.update.mockReturnValue({
      promise: jest.fn().mockRejectedValue({ code: "ProvisionedThroughputExceededException" }),
    });

    await expect(userDb.resetTokenUsageForMonth(args)).rejects.toBeDefined();
  });

  it("throws when the user cannot be resolved to an email key", async () => {
    mockDocClient.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    });

    await expect(userDb.resetTokenUsageForMonth(args)).rejects.toThrow(/not found/i);
  });
});

describe("userDb.applyMonthlyChargeAtomic (ENG-1251)", () => {
  const baseArgs = {
    userId: "u1",
    userEmail: "u1@example.com",
    month: "2026-08",
    tokens: 500,
    cost: 5,
    resetDate: "2026-09-01T00:00:00.000Z",
    auditTableName: "AW-LlmChargeEvents",
    billingUserId: "u1",
    eventId: "chatcmpl-abc123",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("increment path: combines the counter update and the audit marker in ONE transaction", async () => {
    mockDocClient.transactWrite.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

    const result = await userDb.applyMonthlyChargeAtomic({ ...baseArgs, isNewMonth: false });

    expect(result).toBe("applied");
    expect(mockDocClient.transactWrite).toHaveBeenCalledTimes(1);
    const { TransactItems } = mockDocClient.transactWrite.mock.calls[0][0];
    expect(TransactItems).toHaveLength(2);

    const [usersItem, auditItem] = TransactItems;
    expect(usersItem.Update).toMatchObject({
      Key: { email: "u1@example.com" },
      ConditionExpression: "#userId = :userId AND #tokenUsage.#month = :month",
    });
    expect(usersItem.Update.UpdateExpression).toContain(
      "#tokenUsage.#totalTokens = if_not_exists(#tokenUsage.#totalTokens, :zero) + :tokens"
    );
    expect(auditItem.Update).toMatchObject({
      TableName: "AW-LlmChargeEvents",
      Key: { billingUserId: "u1", eventId: "chatcmpl-abc123" },
      UpdateExpression: "SET counterAppliedAt = :now",
      // The idempotency guard: a retried transaction that already landed
      // must not re-apply the charge a second time.
      ConditionExpression: "attribute_not_exists(counterAppliedAt)",
    });
  });

  it("new-month path: combines the reset-shaped write and the audit marker in ONE transaction", async () => {
    mockDocClient.transactWrite.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
    const history = [{ month: "2026-07", totalTokens: 900, totalCost: 9 }];

    const result = await userDb.applyMonthlyChargeAtomic({
      ...baseArgs,
      isNewMonth: true,
      history,
    });

    expect(result).toBe("applied");
    const { TransactItems } = mockDocClient.transactWrite.mock.calls[0][0];
    const [usersItem] = TransactItems;
    expect(usersItem.Update.ConditionExpression).toContain("<>");
    expect(usersItem.Update.ExpressionAttributeValues[":usage"]).toMatchObject({
      month: "2026-08",
      totalTokens: 500,
      totalCost: 5,
    });
    expect(usersItem.Update.ExpressionAttributeValues[":history"]).toEqual(history);
  });

  it("reports lost_race when the users-table condition fails (a concurrent writer won)", async () => {
    mockDocClient.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue({
        code: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
      }),
    });

    const result = await userDb.applyMonthlyChargeAtomic({ ...baseArgs, isNewMonth: false });

    expect(result).toBe("lost_race");
  });

  it("reports already_applied when only the audit-table condition fails (idempotent retry)", async () => {
    mockDocClient.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue({
        code: "TransactionCanceledException",
        CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
      }),
    });

    const result = await userDb.applyMonthlyChargeAtomic({ ...baseArgs, isNewMonth: false });

    expect(result).toBe("already_applied");
  });

  it("rethrows a genuine DynamoDB failure instead of reporting a lost race", async () => {
    // Swallowing this would silently drop the charge while looking like contention.
    mockDocClient.transactWrite.mockReturnValue({
      promise: jest.fn().mockRejectedValue({ code: "ProvisionedThroughputExceededException" }),
    });

    await expect(
      userDb.applyMonthlyChargeAtomic({ ...baseArgs, isNewMonth: false })
    ).rejects.toBeDefined();
  });
});
