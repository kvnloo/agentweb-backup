/**
 * Tests for getChatSessionCount in UserDB.
 *
 * Verifies that getChatSessionCount only counts sessions with portalType='agent',
 * aligning the admin Users tab count with what users see in the customer portal.
 */

const mockQuery = jest.fn();
const mockScan = jest.fn();

const mockDocClient = {
  query: jest.fn(() => ({ promise: mockQuery })),
  scan: jest.fn(() => ({ promise: mockScan })),
  get: jest.fn(() => ({ promise: jest.fn() })),
  put: jest.fn(() => ({ promise: jest.fn() })),
  update: jest.fn(() => ({ promise: jest.fn() })),
  delete: jest.fn(() => ({ promise: jest.fn() })),
};

jest.mock("aws-sdk", () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocClient),
  },
  S3: jest.fn(() => ({})),
}));

import { userDb } from "../services/db";

describe("getChatSessionCount — agent portal type filter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ Count: 0, Items: [] });
    mockScan.mockResolvedValue({ Items: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // FAIL test 1: filter expression must include portalType = :agentType
  it("should include portalType='agent' in DynamoDB FilterExpression", async () => {
    mockQuery.mockResolvedValueOnce({ Count: 2 });

    await (userDb as any).getChatSessionCount("user-abc");

    const queryCallArgs = (mockDocClient.query.mock.calls as any[][])[0][0];
    expect(queryCallArgs.FilterExpression).toContain(":agentType");
    expect(queryCallArgs.ExpressionAttributeValues[":agentType"]).toBe("agent");
  });

  // FAIL test 2: boundary — non-agent sessions must NOT be counted
  it("should return 0 when only non-agent sessions exist (emma-sidebar)", async () => {
    // The query should filter by portalType='agent' so non-agent sessions return 0
    mockQuery.mockResolvedValueOnce({ Count: 0 });

    const count = await (userDb as any).getChatSessionCount("user-abc");

    expect(count).toBe(0);
    // Verify the filter was applied
    const queryCallArgs = (mockDocClient.query.mock.calls as any[][])[0][0];
    expect(queryCallArgs.FilterExpression).toContain(":agentType");
  });

  // FAIL test 3: boundary — archived agent sessions must not be counted
  it("should filter out archived sessions from the count", async () => {
    mockQuery.mockResolvedValueOnce({ Count: 3 });

    await (userDb as any).getChatSessionCount("user-xyz");

    const queryCallArgs = (mockDocClient.query.mock.calls as any[][])[0][0];
    // Both archived filter and portalType filter must be present
    expect(queryCallArgs.FilterExpression).toContain(":archivedFalse");
    expect(queryCallArgs.FilterExpression).toContain(":agentType");
  });

  // SUCCESS test 4: happy path — counts agent sessions correctly
  it("should return correct count for agent sessions", async () => {
    mockQuery.mockResolvedValueOnce({ Count: 5 });

    const count = await (userDb as any).getChatSessionCount("user-123");

    expect(count).toBe(5);
  });

  // FAIL test 5: paginated results — must sum counts across pages
  it("should sum counts across paginated DynamoDB results", async () => {
    mockQuery
      .mockResolvedValueOnce({ Count: 4, LastEvaluatedKey: { sessionId: "last-key" } })
      .mockResolvedValueOnce({ Count: 3 });

    const count = await (userDb as any).getChatSessionCount("user-paged");

    expect(count).toBe(7);
    expect(mockDocClient.query).toHaveBeenCalledTimes(2);
  });
});
