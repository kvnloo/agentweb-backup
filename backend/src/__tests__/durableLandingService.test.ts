// Mock aws-sdk before importing the service (same convention as services.v0Service.test.ts).
const mockUpdate = jest.fn();
const mockQuery = jest.fn();

jest.mock("aws-sdk", () => {
  const client = () => ({ update: mockUpdate, query: mockQuery });
  return {
    __esModule: true,
    default: {
      DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
      config: { update: jest.fn() },
    },
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
    config: { update: jest.fn() },
  };
});

import {
  claimCompletion,
  findInFlightJobForSession,
} from "../services/durableLandingService";

const ok = (value: any) => ({ promise: () => Promise.resolve(value) });
const fail = (err: any) => ({ promise: () => Promise.reject(err) });

beforeEach(() => {
  mockUpdate.mockReset();
  mockQuery.mockReset();
});

describe("claimCompletion — exactly-once idempotency guard", () => {
  it("returns true when it wins the conditional claim (attribute_not_exists)", async () => {
    mockUpdate.mockReturnValue(ok({}));
    const claimed = await claimCompletion("page-1");
    expect(claimed).toBe(true);
    const arg = mockUpdate.mock.calls[0][0];
    expect(arg.ConditionExpression).toMatch(/attribute_not_exists\(claimedCompletionAt\)/);
    expect(arg.Key).toEqual({ id: "page-1" });
  });

  it("returns false when another deliverer already claimed (ConditionalCheckFailedException)", async () => {
    mockUpdate.mockReturnValue(
      fail(Object.assign(new Error("conditional"), { code: "ConditionalCheckFailedException" }))
    );
    const claimed = await claimCompletion("page-1");
    expect(claimed).toBe(false);
  });

  it("propagates unexpected errors (not a silent false) so real failures surface", async () => {
    mockUpdate.mockReturnValue(
      fail(Object.assign(new Error("throttled"), { code: "ProvisionedThroughputExceededException" }))
    );
    await expect(claimCompletion("page-1")).rejects.toThrow(/throttled/);
  });
});

describe("findInFlightJobForSession — reconnect lookup", () => {
  const pages = [
    { id: "a", userId: "u1", status: "deployed", originatingSessionId: "s1" },
    { id: "b", userId: "u1", status: "generating", originatingSessionId: "s1" },
    { id: "c", userId: "u1", status: "deploying", originatingSessionId: "s2" },
    { id: "d", userId: "u1", status: "failed", originatingSessionId: "s1" },
  ];

  it("returns the in-flight (generating/deploying) page for the session", async () => {
    mockQuery.mockReturnValue(ok({ Items: pages }));
    const job = await findInFlightJobForSession("u1", "s1");
    expect(job?.id).toBe("b"); // generating + this session; not the deployed/failed ones
  });

  it("returns null when the session has no in-flight build (only terminal states)", async () => {
    mockQuery.mockReturnValue(ok({ Items: [pages[0], pages[3]] }));
    const job = await findInFlightJobForSession("u1", "s1");
    expect(job).toBeNull();
  });

  it("does not match another session's in-flight build", async () => {
    mockQuery.mockReturnValue(ok({ Items: [pages[2]] })); // deploying but session s2
    const job = await findInFlightJobForSession("u1", "s1");
    expect(job).toBeNull();
  });

  it("returns null (never throws) when the query fails — reconnect is best-effort", async () => {
    mockQuery.mockReturnValue(fail(new Error("ddb down")));
    const job = await findInFlightJobForSession("u1", "s1");
    expect(job).toBeNull();
  });
});
