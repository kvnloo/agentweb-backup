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

// Mock the dynamic imports deliverCompletion uses for post-back delivery.
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
jest.mock("../server", () => ({ io: { to: mockTo } }));

const mockGetChatSession = jest.fn();
const mockAddMessageToSession = jest.fn();
jest.mock("../services/chatbotService", () => ({
  chatbotDb: {
    getChatSession: (...a: any[]) => mockGetChatSession(...a),
    addMessageToSession: (...a: any[]) => mockAddMessageToSession(...a),
  },
}));

import {
  claimCompletion,
  findInFlightJobForSession,
  deliverCompletion,
  buildCompletionMessage,
} from "../services/durableLandingService";

const ok = (value: any) => ({ promise: () => Promise.resolve(value) });
const fail = (err: any) => ({ promise: () => Promise.reject(err) });

beforeEach(() => {
  mockUpdate.mockReset();
  mockQuery.mockReset();
  mockEmit.mockReset();
  mockTo.mockClear();
  mockGetChatSession.mockReset();
  mockAddMessageToSession.mockReset();
  mockGetChatSession.mockResolvedValue({ sessionId: "s1" });
  mockAddMessageToSession.mockResolvedValue(undefined);
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

describe("buildCompletionMessage", () => {
  it("includes the live URL when deployed", () => {
    const msg = buildCompletionMessage({
      name: "Front Desk EMMA",
      deployedUrl: "https://x.agentwebforms.com/front-desk-emma",
    } as any);
    expect(msg).toContain("Front Desk EMMA");
    expect(msg).toContain("https://x.agentwebforms.com/front-desk-emma");
  });

  it("prefers the custom domain over the vercel URL", () => {
    const msg = buildCompletionMessage({
      name: "P",
      deployedUrl: "https://p.vercel.app",
      customDomainUrl: "https://p.agentwebforms.com",
    } as any);
    expect(msg).toContain("https://p.agentwebforms.com");
    expect(msg).not.toContain("vercel.app");
  });

  it("falls back to a generic line when there is no URL", () => {
    const msg = buildCompletionMessage({ name: "P" } as any);
    expect(msg).toContain("finished building");
  });
});

describe("deliverCompletion — exactly-once post-back", () => {
  const page = {
    id: "p1",
    userId: "u1",
    name: "Front Desk EMMA",
    originatingSessionId: "s1",
    deployedUrl: "https://x.agentwebforms.com/fde",
  } as any;

  it("appends to the session and emits live when it wins the claim", async () => {
    mockUpdate.mockReturnValue(ok({})); // claim succeeds
    const delivered = await deliverCompletion(page);
    expect(delivered).toBe(true);
    expect(mockAddMessageToSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("https://x.agentwebforms.com/fde") })
    );
    expect(mockTo).toHaveBeenCalledWith("user:u1");
    expect(mockEmit).toHaveBeenCalledWith(
      "session-message-appended",
      expect.objectContaining({ sessionId: "s1" })
    );
  });

  it("no-ops (no append, no emit) when another deliverer already claimed", async () => {
    mockUpdate.mockReturnValue(
      fail(Object.assign(new Error("c"), { code: "ConditionalCheckFailedException" }))
    );
    const delivered = await deliverCompletion(page);
    expect(delivered).toBe(false);
    expect(mockAddMessageToSession).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it("returns false without claiming when the page has no originating session", async () => {
    const delivered = await deliverCompletion({ ...page, originatingSessionId: undefined });
    expect(delivered).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("still emits (and returns true) when the session was deleted before completion", async () => {
    mockUpdate.mockReturnValue(ok({})); // claim succeeds
    mockGetChatSession.mockResolvedValue(null); // session gone
    const delivered = await deliverCompletion(page);
    expect(delivered).toBe(true);
    expect(mockAddMessageToSession).not.toHaveBeenCalled(); // nothing to append to
    expect(mockEmit).toHaveBeenCalled();
  });
});
