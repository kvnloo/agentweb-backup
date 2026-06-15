// Mock aws-sdk (scan) + the delivery functions the poller routes to.
const mockScan = jest.fn();
jest.mock("aws-sdk", () => {
  const client = () => ({ scan: mockScan });
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

const mockDeliverCompletion = jest.fn();
const mockDeliverStuckFailure = jest.fn();
jest.mock("../services/durableLandingService", () => ({
  deliverCompletion: (...a: any[]) => mockDeliverCompletion(...a),
  deliverStuckFailure: (...a: any[]) => mockDeliverStuckFailure(...a),
}));

import { runDurableLandingPollerOnce } from "../services/durableLandingPoller";

const ok = (v: any) => ({ promise: () => Promise.resolve(v) });

const NOW = new Date("2026-06-13T12:00:00Z").getTime();
const FORTY_MIN_AGO = new Date(NOW - 40 * 60 * 1000).toISOString();
const FIVE_MIN_AGO = new Date(NOW - 5 * 60 * 1000).toISOString();

beforeEach(() => {
  mockScan.mockReset();
  mockDeliverCompletion.mockReset().mockResolvedValue(true);
  mockDeliverStuckFailure.mockReset().mockResolvedValue(true);
});

describe("runDurableLandingPollerOnce", () => {
  it("delivers the completion for a deployed awaiting-reconnect build (redeploy recovery)", async () => {
    mockScan.mockReturnValue(
      ok({ Items: [{ id: "p1", status: "deployed", originatingSessionId: "s1", createdAt: FIVE_MIN_AGO }] })
    );
    const r = await runDurableLandingPollerOnce(NOW);
    expect(mockDeliverCompletion).toHaveBeenCalledTimes(1);
    expect(mockDeliverStuckFailure).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, delivered: 1, failed: 0 });
  });

  it("fails a build stuck generating past the 30-min ceiling", async () => {
    mockScan.mockReturnValue(
      ok({ Items: [{ id: "p2", status: "generating", originatingSessionId: "s2", createdAt: FORTY_MIN_AGO }] })
    );
    const r = await runDurableLandingPollerOnce(NOW);
    expect(mockDeliverStuckFailure).toHaveBeenCalledTimes(1);
    expect(mockDeliverCompletion).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
  });

  it("leaves a still-building build that has not yet hit the ceiling (in-process hook owns it)", async () => {
    mockScan.mockReturnValue(
      ok({ Items: [{ id: "p3", status: "generating", originatingSessionId: "s3", createdAt: FIVE_MIN_AGO }] })
    );
    const r = await runDurableLandingPollerOnce(NOW);
    expect(mockDeliverCompletion).not.toHaveBeenCalled();
    expect(mockDeliverStuckFailure).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, delivered: 0, failed: 0 });
  });

  it("scans only awaiting-reconnect, unclaimed, session-tagged builds (filter expression)", async () => {
    mockScan.mockReturnValue(ok({ Items: [] }));
    await runDurableLandingPollerOnce(NOW);
    const filter = mockScan.mock.calls[0][0].FilterExpression;
    expect(filter).toMatch(/awaitingReconnect = :true/);
    expect(filter).toMatch(/attribute_not_exists\(claimedCompletionAt\)/);
    expect(filter).toMatch(/attribute_exists\(originatingSessionId\)/);
  });

  it("continues the sweep when one record's delivery throws", async () => {
    mockDeliverCompletion.mockRejectedValueOnce(new Error("boom"));
    mockScan.mockReturnValue(
      ok({
        Items: [
          { id: "p4", status: "deployed", originatingSessionId: "s4", createdAt: FIVE_MIN_AGO },
          { id: "p5", status: "generating", originatingSessionId: "s5", createdAt: FORTY_MIN_AGO },
        ],
      })
    );
    const r = await runDurableLandingPollerOnce(NOW);
    expect(mockDeliverStuckFailure).toHaveBeenCalledTimes(1); // p5 still processed after p4 threw
    expect(r.scanned).toBe(2);
  });
});
