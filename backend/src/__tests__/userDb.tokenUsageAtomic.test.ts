import AWS from "aws-sdk";

const mockDocClient = {
  query: jest.fn(),
  update: jest.fn(),
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
