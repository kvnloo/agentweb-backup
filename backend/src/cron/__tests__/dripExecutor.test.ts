/**
 * Unit tests for the Lifecycle Drip Phase 4 executor.
 *
 * Uses full dependency injection (see `ExecutorDeps`) so no real DynamoDB,
 * no real email provider, and no real time are involved. All safety gates
 * are exercised explicitly.
 */

import {
  runDripExecutor,
  isGloballyEnabled,
  isDryRun,
  getMaxPerHour,
  userMatchesSegment,
  buildMergeFields,
  DEFAULT_MAX_PER_HOUR,
  ExecutorDeps,
} from "../dripExecutor";
import { DripCampaign } from "../../services/dripCampaignDb";
import { User } from "../../services/db";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeCampaign(overrides: Partial<DripCampaign> = {}): DripCampaign {
  return {
    campaignId: "camp-1",
    name: "Brand skip drip",
    segmentQuery: { stage: "brand_skipped" },
    templateHtml: "<p>Hey {{firstName}}, Emma awaits at {{companyName}}.</p>",
    subjectLine: "Hi {{firstName}}",
    cadenceUnit: "days",
    cadenceValue: 7,
    maxSends: 3,
    isActive: true,
    killSwitch: false,
    createdBy: "admin-1",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    userId: "u-1",
    email: "bob@example.com",
    password: "x",
    isOAuthUser: false,
    isAdmin: false,
    isActive: true,
    createdAt: "2026-04-01T00:00:00Z",
    displayName: "Bob Smith",
    lastActiveAt: "2026-04-02T00:00:00Z",
    onboardingStage: "brand_skipped",
    ...overrides,
  };
}

function makeDeps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    listActiveCampaigns: jest.fn(async () => []),
    listAllUsers: jest.fn(async () => []),
    countSendsForUserCampaign: jest.fn(async () => 0),
    getMostRecentSendAt: jest.fn(async () => null),
    countSendsInWindow: jest.fn(async () => 0),
    recordSend: jest.fn(async () => {}),
    sendEmail: jest.fn(async () => ({ messageId: "msg-xyz" })),
    now: () => new Date("2026-04-18T06:00:00Z"),
    env: { DRIP_CAMPAIGNS_ENABLED: "true", DRIP_DRY_RUN: "false" },
    ...over,
  };
}

// ─── Pure helpers ──────────────────────────────────────────────────────────

describe("isGloballyEnabled", () => {
  it("defaults to false (safe) when env var is unset", () => {
    expect(isGloballyEnabled({})).toBe(false);
  });
  it("returns true for 'true'", () => {
    expect(isGloballyEnabled({ DRIP_CAMPAIGNS_ENABLED: "true" })).toBe(true);
  });
  it("returns true for '1'", () => {
    expect(isGloballyEnabled({ DRIP_CAMPAIGNS_ENABLED: "1" })).toBe(true);
  });
  it("returns false for 'false' / 'no' / random strings", () => {
    expect(isGloballyEnabled({ DRIP_CAMPAIGNS_ENABLED: "false" })).toBe(false);
    expect(isGloballyEnabled({ DRIP_CAMPAIGNS_ENABLED: "no" })).toBe(false);
    expect(isGloballyEnabled({ DRIP_CAMPAIGNS_ENABLED: "maybe" })).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(isGloballyEnabled({ DRIP_CAMPAIGNS_ENABLED: "TRUE" })).toBe(true);
  });
});

describe("isDryRun", () => {
  it("defaults to true (safe) when env var is unset", () => {
    expect(isDryRun({})).toBe(true);
  });
  it("returns false only when env var is exactly 'false' or '0'", () => {
    expect(isDryRun({ DRIP_DRY_RUN: "false" })).toBe(false);
    expect(isDryRun({ DRIP_DRY_RUN: "0" })).toBe(false);
    expect(isDryRun({ DRIP_DRY_RUN: "true" })).toBe(true);
    expect(isDryRun({ DRIP_DRY_RUN: "no" })).toBe(true);
  });
});

describe("getMaxPerHour", () => {
  it("falls back to DEFAULT_MAX_PER_HOUR when unset", () => {
    expect(getMaxPerHour({})).toBe(DEFAULT_MAX_PER_HOUR);
  });
  it("parses a positive integer env value", () => {
    expect(getMaxPerHour({ DRIP_MAX_PER_HOUR: "200" })).toBe(200);
  });
  it("falls back on non-numeric values", () => {
    expect(getMaxPerHour({ DRIP_MAX_PER_HOUR: "abc" })).toBe(
      DEFAULT_MAX_PER_HOUR,
    );
  });
  it("falls back on zero / negative", () => {
    expect(getMaxPerHour({ DRIP_MAX_PER_HOUR: "0" })).toBe(
      DEFAULT_MAX_PER_HOUR,
    );
    expect(getMaxPerHour({ DRIP_MAX_PER_HOUR: "-5" })).toBe(
      DEFAULT_MAX_PER_HOUR,
    );
  });
});

describe("userMatchesSegment", () => {
  it("returns true when stage + goal match", () => {
    const user = makeUser({
      onboardingStage: "brand_skipped",
      onboardingEvents: [
        { event: "goal_selected", ts: "2026-04-01", data: { goal: "paid_ads" } },
      ] as any,
    });
    const campaign = makeCampaign({
      segmentQuery: { stage: "brand_skipped", goal: "paid_ads" },
    });
    expect(userMatchesSegment(user, campaign)).toBe(true);
  });

  it("returns false when stage differs", () => {
    const user = makeUser({ onboardingStage: "active" });
    const campaign = makeCampaign({ segmentQuery: { stage: "brand_skipped" } });
    expect(userMatchesSegment(user, campaign)).toBe(false);
  });

  it("excludes users with no lastActiveAt when lastActivityBefore is set", () => {
    const user = makeUser({ lastActiveAt: undefined });
    const campaign = makeCampaign({
      segmentQuery: {
        stage: "brand_skipped",
        lastActivityBefore: "2026-04-10T00:00:00Z",
      },
    });
    expect(userMatchesSegment(user, campaign)).toBe(false);
  });

  it("includes users with lastActiveAt strictly before cutoff", () => {
    const user = makeUser({ lastActiveAt: "2026-04-01T00:00:00Z" });
    const campaign = makeCampaign({
      segmentQuery: {
        stage: "brand_skipped",
        lastActivityBefore: "2026-04-10T00:00:00Z",
      },
    });
    expect(userMatchesSegment(user, campaign)).toBe(true);
  });

  it("excludes users whose lastActiveAt equals or exceeds cutoff", () => {
    const user = makeUser({ lastActiveAt: "2026-04-10T00:00:00Z" });
    const campaign = makeCampaign({
      segmentQuery: {
        stage: "brand_skipped",
        lastActivityBefore: "2026-04-10T00:00:00Z",
      },
    });
    expect(userMatchesSegment(user, campaign)).toBe(false);
  });

  it("derives stage from events when onboardingStage is missing", () => {
    // a user with only `goal_selected` event → derived stage is 'goal_selected'
    const user = makeUser({
      onboardingStage: undefined,
      onboardingEvents: [
        { event: "goal_selected", ts: "2026-04-01", data: { goal: "seo" } },
      ] as any,
    });
    const campaign = makeCampaign({ segmentQuery: { stage: "goal_selected" } });
    expect(userMatchesSegment(user, campaign)).toBe(true);
  });
});

describe("buildMergeFields", () => {
  it("pulls firstName from displayName", () => {
    const user = makeUser({ displayName: "Jane Doe" });
    expect(buildMergeFields(user).firstName).toBe("Jane");
  });

  it("falls back to empty string when displayName is missing", () => {
    const user = makeUser({ displayName: undefined });
    expect(buildMergeFields(user).firstName).toBe("");
  });

  it("uses latest goal_selected event's data.goal", () => {
    const user = makeUser({
      onboardingEvents: [
        { event: "goal_selected", ts: "2026-04-01", data: { goal: "old" } },
        { event: "goal_selected", ts: "2026-04-05", data: { goal: "new" } },
      ] as any,
    });
    expect(buildMergeFields(user).goal).toBe("new");
  });

  it("lastStep is the newest event by ts", () => {
    const user = makeUser({
      onboardingEvents: [
        { event: "goal_selected", ts: "2026-04-01" },
        { event: "brand_skipped", ts: "2026-04-05" },
      ] as any,
    });
    expect(buildMergeFields(user).lastStep).toBe("brand_skipped");
  });
});

// ─── End-to-end executor tick ──────────────────────────────────────────────

describe("runDripExecutor — global kill switch", () => {
  it("short-circuits when DRIP_CAMPAIGNS_ENABLED is unset", async () => {
    const deps = makeDeps({
      env: { DRIP_DRY_RUN: "false" }, // enabled flag missing
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listAllUsers: jest.fn(async () => [makeUser()]),
    });
    const result = await runDripExecutor(deps);
    expect(result.globalKillSwitch).toBe(true);
    expect(result.emailsSent).toBe(0);
    expect(result.dryRuns).toBe(0);
    expect(deps.listActiveCampaigns).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("short-circuits when DRIP_CAMPAIGNS_ENABLED=false", async () => {
    const deps = makeDeps({
      env: { DRIP_CAMPAIGNS_ENABLED: "false", DRIP_DRY_RUN: "false" },
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listAllUsers: jest.fn(async () => [makeUser()]),
    });
    const result = await runDripExecutor(deps);
    expect(result.globalKillSwitch).toBe(true);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });
});

describe("runDripExecutor — dry-run default safety", () => {
  it("records dry_run status and does NOT call sendEmail when DRIP_DRY_RUN unset", async () => {
    const user = makeUser();
    const campaign = makeCampaign();
    const deps = makeDeps({
      env: { DRIP_CAMPAIGNS_ENABLED: "true" }, // dry-run defaults to true
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listAllUsers: jest.fn(async () => [user]),
    });
    const result = await runDripExecutor(deps);
    expect(result.dryRun).toBe(true);
    expect(result.dryRuns).toBe(1);
    expect(result.emailsSent).toBe(0);
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.recordSend).toHaveBeenCalledTimes(1);
    const recorded = (deps.recordSend as jest.Mock).mock.calls[0][0];
    expect(recorded.status).toBe("dry_run");
    expect(recorded.dryRun).toBe(true);
    expect(recorded.messageId).toBeNull();
  });
});

describe("runDripExecutor — real send path", () => {
  it("sends email, records sent, renders merge fields in subject + body", async () => {
    const user = makeUser({
      displayName: "Alice Jones",
      companyName: "Acme Co" as any,
      email: "alice@acme.test",
    });
    const campaign = makeCampaign();
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listAllUsers: jest.fn(async () => [user]),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
    expect(result.dryRuns).toBe(0);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const sentArgs = (deps.sendEmail as jest.Mock).mock.calls[0][0];
    expect(sentArgs.to).toBe("alice@acme.test");
    expect(sentArgs.subject).toBe("Hi Alice");
    expect(sentArgs.html).toContain("Hey Alice");
    expect(sentArgs.html).toContain("Acme Co");

    const recorded = (deps.recordSend as jest.Mock).mock.calls[0][0];
    expect(recorded.status).toBe("sent");
    expect(recorded.dryRun).toBe(false);
    expect(recorded.messageId).toBe("msg-xyz");
  });
});

describe("runDripExecutor — safety gates", () => {
  it("skips paused campaigns", async () => {
    const paused = makeCampaign({ isActive: false });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [paused]),
      listAllUsers: jest.fn(async () => [makeUser()]),
    });
    const result = await runDripExecutor(deps);
    expect(result.campaignsSkipped).toBe(1);
    expect(result.emailsSent).toBe(0);
    expect(result.skippedReasons.campaign_paused).toBe(1);
  });

  it("skips when campaign killSwitch=true", async () => {
    const killed = makeCampaign({ killSwitch: true });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [killed]),
      listAllUsers: jest.fn(async () => [makeUser()]),
    });
    const result = await runDripExecutor(deps);
    expect(result.campaignsSkipped).toBe(1);
    expect(result.skippedReasons.campaign_paused).toBe(1);
  });

  it("skips users who already hit maxSends", async () => {
    const campaign = makeCampaign({ maxSends: 3 });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listAllUsers: jest.fn(async () => [makeUser()]),
      countSendsForUserCampaign: jest.fn(async () => 3),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.emailsSkipped).toBe(1);
    expect(result.skippedReasons.max_sends_reached).toBe(1);
  });

  it("skips users inside the cadence window", async () => {
    const campaign = makeCampaign({ cadenceUnit: "days", cadenceValue: 7 });
    // most recent send was 2 days ago → still inside the 7-day window
    const twoDaysAgo = new Date("2026-04-16T06:00:00Z").toISOString();
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listAllUsers: jest.fn(async () => [makeUser()]),
      getMostRecentSendAt: jest.fn(async () => twoDaysAgo),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.skippedReasons.cadence_not_met).toBe(1);
  });

  it("allows send after cadence window elapses", async () => {
    const campaign = makeCampaign({ cadenceUnit: "days", cadenceValue: 7 });
    // last send was 10 days ago
    const tenDaysAgo = new Date("2026-04-08T06:00:00Z").toISOString();
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listAllUsers: jest.fn(async () => [makeUser()]),
      getMostRecentSendAt: jest.fn(async () => tenDaysAgo),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
  });

  it("skips unsubscribed users", async () => {
    const user = makeUser({ dripUnsubscribed: true } as any);
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listAllUsers: jest.fn(async () => [user]),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.skippedReasons.unsubscribed).toBe(1);
  });

  it("skips users without an email", async () => {
    const user = makeUser({ email: "" });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listAllUsers: jest.fn(async () => [user]),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.skippedReasons.no_email).toBe(1);
  });

  it("enforces per-campaign hourly rate limit", async () => {
    const campaign = makeCampaign();
    const users = Array.from({ length: 5 }, (_, i) =>
      makeUser({ userId: `u-${i}`, email: `u${i}@example.com` }),
    );
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listAllUsers: jest.fn(async () => users),
      // already sent 49 in last hour; only 1 slot left out of default 50
      countSendsInWindow: jest.fn(async () => 49),
      env: {
        DRIP_CAMPAIGNS_ENABLED: "true",
        DRIP_DRY_RUN: "false",
      },
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
    // 4 more users filtered by rate cap
    expect(result.skippedReasons.rate_limit_exceeded).toBe(4);
  });

  it("skips entire campaign when rate limit is already exceeded for the hour", async () => {
    const campaign = makeCampaign();
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listAllUsers: jest.fn(async () => [makeUser()]),
      countSendsInWindow: jest.fn(async () => 100),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.campaignsSkipped).toBe(1);
    expect(result.skippedReasons.rate_limit_exceeded).toBe(1);
  });

  it("filters non-matching segments (doesn't send to active users for a brand_skipped campaign)", async () => {
    const campaign = makeCampaign({ segmentQuery: { stage: "brand_skipped" } });
    const users = [
      makeUser({ userId: "u-match", onboardingStage: "brand_skipped" }),
      makeUser({ userId: "u-no-match", onboardingStage: "active" }),
    ];
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listAllUsers: jest.fn(async () => users),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
    const sentTo = (deps.sendEmail as jest.Mock).mock.calls[0][0].to;
    expect(sentTo).toBe("bob@example.com"); // u-match has default email
  });

  it("excludes deleted users (userId starts with 'deleted_')", async () => {
    const users = [
      makeUser({ userId: "deleted_u-1" }),
      makeUser({ userId: "u-2" }),
    ];
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listAllUsers: jest.fn(async () => users),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
  });
});

describe("runDripExecutor — failure handling", () => {
  it("records a failed send when sendEmail throws", async () => {
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listAllUsers: jest.fn(async () => [makeUser()]),
      sendEmail: jest.fn(async () => {
        throw new Error("SMTP down");
      }),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsFailed).toBe(1);
    expect(result.emailsSent).toBe(0);
    // recordSend should have been called once with status='failed'
    const recorded = (deps.recordSend as jest.Mock).mock.calls[0][0];
    expect(recorded.status).toBe("failed");
    expect(recorded.error).toContain("SMTP down");
  });

  it("continues to the next user when one send fails", async () => {
    const users = [
      makeUser({ userId: "u-1", email: "a@example.com" }),
      makeUser({ userId: "u-2", email: "b@example.com" }),
    ];
    const sendMock = jest
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => ({ messageId: "msg-2" }));
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listAllUsers: jest.fn(async () => users),
      sendEmail: sendMock,
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
    expect(result.emailsFailed).toBe(1);
  });
});

describe("runDripExecutor — no-ops", () => {
  it("returns empty summary when no campaigns exist", async () => {
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => []),
    });
    const result = await runDripExecutor(deps);
    expect(result.campaignsConsidered).toBe(0);
    expect(result.emailsSent).toBe(0);
    expect(deps.listAllUsers).not.toHaveBeenCalled();
  });
});
