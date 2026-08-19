/**
 * ENG-932 AC5: a skill sitting in pending_review past the stale window
 * appears in a digest a human receives; submitting a single skill (i.e. a
 * queue with nothing stale yet) pages nobody.
 */
jest.mock("../../services/skillService", () => ({
  skillService: {
    getSkillsByVisibility: jest.fn(),
  },
}));

jest.mock("../../utils/agentModeAlerts", () => ({
  sendAgentModeOncallAlert: jest.fn(async () => undefined),
}));

const { skillService } = require("../../services/skillService");
const { sendAgentModeOncallAlert } = require("../../utils/agentModeAlerts");
import { runSkillReviewQueueDigest, PENDING_REVIEW_STALE_HOURS } from "../skillReviewQueueDigestCron";

const NOW = new Date("2026-08-19T21:00:00.000Z").getTime();
const HOUR_MS = 60 * 60 * 1000;

function skillAt(hoursAgo: number, overrides: Partial<Record<string, any>> = {}) {
  return {
    skillId: `skill-${hoursAgo}h`,
    name: `Skill submitted ${hoursAgo}h ago`,
    ownerId: "owner-1",
    ownerEmail: "owner@example.com",
    visibility: "pending_review",
    updatedAt: new Date(NOW - hoursAgo * HOUR_MS).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runSkillReviewQueueDigest", () => {
  it("sends no alert when the queue is empty", async () => {
    skillService.getSkillsByVisibility.mockResolvedValue([]);

    const summary = await runSkillReviewQueueDigest(NOW);

    expect(summary).toEqual({ queueSize: 0, stale: 0, alertSent: false });
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it("sends no alert when a skill was just submitted (under the stale window)", async () => {
    skillService.getSkillsByVisibility.mockResolvedValue([skillAt(1)]);

    const summary = await runSkillReviewQueueDigest(NOW);

    expect(summary).toEqual({ queueSize: 1, stale: 0, alertSent: false });
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it("sends exactly one alert once a skill crosses the stale window, even with multiple stale skills", async () => {
    skillService.getSkillsByVisibility.mockResolvedValue([
      skillAt(PENDING_REVIEW_STALE_HOURS + 1),
      skillAt(PENDING_REVIEW_STALE_HOURS + 5),
      skillAt(1), // fresh — should not count as stale
    ]);

    const summary = await runSkillReviewQueueDigest(NOW);

    expect(summary).toEqual({ queueSize: 3, stale: 2, alertSent: true });
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
    const call = sendAgentModeOncallAlert.mock.calls[0][0];
    expect(call.dedupeKey).toBe("skill-review-queue-digest");
    expect(call.message).toContain("owner@example.com");
  });

  it("treats the exact stale-hour boundary as stale (>=)", async () => {
    skillService.getSkillsByVisibility.mockResolvedValue([skillAt(PENDING_REVIEW_STALE_HOURS)]);

    const summary = await runSkillReviewQueueDigest(NOW);

    expect(summary.stale).toBe(1);
    expect(sendAgentModeOncallAlert).toHaveBeenCalledTimes(1);
  });

  it("does not throw and returns an empty summary if the scan fails", async () => {
    skillService.getSkillsByVisibility.mockRejectedValue(new Error("DynamoDB down"));

    const summary = await runSkillReviewQueueDigest(NOW);

    expect(summary).toEqual({ queueSize: 0, stale: 0, alertSent: false });
    expect(sendAgentModeOncallAlert).not.toHaveBeenCalled();
  });

  it("ignores a skill with a missing/unparseable updatedAt rather than crashing", async () => {
    skillService.getSkillsByVisibility.mockResolvedValue([skillAt(100, { updatedAt: undefined })]);

    const summary = await runSkillReviewQueueDigest(NOW);

    expect(summary).toEqual({ queueSize: 1, stale: 0, alertSent: false });
  });
});
