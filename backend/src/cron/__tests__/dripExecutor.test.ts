/**
 * Unit tests for the drip executor (Phase A: multi-tenant, CRM-scoped).
 *
 * Phase A moves segmentation from AW-Users to AW-Leads. Campaigns target
 * each tenant's own CRM leads, not onboarding users. This test file pins
 * that new contract: `listLeadsForCampaign` DI instead of `listAllUsers`,
 * lead fields for merge rendering, lead `contactStatus` as unsubscribe
 * signal, and lead-keyed (listId:leadId) dripSends history.
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
  leadMatchesSegment,
  buildMergeFields,
  DEFAULT_MAX_PER_HOUR,
  ExecutorDeps,
  DripLead,
  _resetInFlightGuardForTests,
} from "../dripExecutor";
import { DripCampaign } from "../../services/dripCampaignDb";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeCampaign(overrides: Partial<DripCampaign> = {}): DripCampaign {
  return {
    campaignId: "camp-1",
    userId: "tenant-1",
    name: "Trialing nudge",
    segmentQuery: { lifecycle: "trialing" },
    templateHtml:
      "<p>Hey {{firstName}}, your trial at {{companyName}} is waiting.</p>",
    subjectLine: "Hi {{firstName}}",
    cadenceUnit: "days",
    cadenceValue: 7,
    maxSends: 3,
    isActive: true,
    killSwitch: false,
    createdBy: "tenant-1",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function makeLead(overrides: Partial<DripLead> = {}): DripLead {
  return {
    listId: "list-A",
    leadId: "lead-1",
    userId: "tenant-1",
    email: "bob@example.com",
    firstName: "Bob",
    lastName: "Smith",
    company: "Acme Co",
    lifecycle: "trialing",
    heatScore: 80,
    utmSource: "linkedin",
    contactStatus: "active",
    ...overrides,
  };
}

function makeDeps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    listActiveCampaigns: jest.fn(async () => []),
    listLeadsForCampaign: jest.fn(async () => []),
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

describe("leadMatchesSegment", () => {
  it("returns true when no segment criteria are set (empty segmentQuery matches everything)", () => {
    const lead = makeLead();
    const campaign = makeCampaign({ segmentQuery: {} });
    expect(leadMatchesSegment(lead, campaign)).toBe(true);
  });

  it("matches on lifecycle when equal", () => {
    const lead = makeLead({ lifecycle: "paying" });
    const campaign = makeCampaign({
      segmentQuery: { lifecycle: "paying" },
    });
    expect(leadMatchesSegment(lead, campaign)).toBe(true);
  });

  it("rejects when lifecycle differs", () => {
    const lead = makeLead({ lifecycle: "churned" });
    const campaign = makeCampaign({
      segmentQuery: { lifecycle: "paying" },
    });
    expect(leadMatchesSegment(lead, campaign)).toBe(false);
  });

  it("enforces minHeatScore floor", () => {
    const cold = makeLead({ heatScore: 20 });
    const hot = makeLead({ heatScore: 90 });
    const campaign = makeCampaign({
      segmentQuery: { minHeatScore: 50 },
    });
    expect(leadMatchesSegment(cold, campaign)).toBe(false);
    expect(leadMatchesSegment(hot, campaign)).toBe(true);
  });

  it("treats missing heatScore as zero for minHeatScore purposes", () => {
    const unscored = makeLead({ heatScore: undefined });
    const campaign = makeCampaign({
      segmentQuery: { minHeatScore: 1 },
    });
    expect(leadMatchesSegment(unscored, campaign)).toBe(false);
  });

  it("matches utmSource exactly", () => {
    const ok = makeLead({ utmSource: "linkedin" });
    const bad = makeLead({ utmSource: "google" });
    const campaign = makeCampaign({
      segmentQuery: { utmSource: "linkedin" },
    });
    expect(leadMatchesSegment(ok, campaign)).toBe(true);
    expect(leadMatchesSegment(bad, campaign)).toBe(false);
  });

  it("enforces leadListId as defense-in-depth", () => {
    const inList = makeLead({ listId: "list-A" });
    const outOfList = makeLead({ listId: "list-B" });
    const campaign = makeCampaign({
      segmentQuery: { leadListId: "list-A" },
    });
    expect(leadMatchesSegment(inList, campaign)).toBe(true);
    expect(leadMatchesSegment(outOfList, campaign)).toBe(false);
  });

  it("combines multiple criteria as AND", () => {
    const qualified = makeLead({
      lifecycle: "trialing",
      heatScore: 70,
      utmSource: "linkedin",
    });
    const missesUtm = makeLead({
      lifecycle: "trialing",
      heatScore: 70,
      utmSource: "organic",
    });
    const campaign = makeCampaign({
      segmentQuery: {
        lifecycle: "trialing",
        minHeatScore: 50,
        utmSource: "linkedin",
      },
    });
    expect(leadMatchesSegment(qualified, campaign)).toBe(true);
    expect(leadMatchesSegment(missesUtm, campaign)).toBe(false);
  });
});

describe("buildMergeFields", () => {
  it("pulls firstName + companyName from the lead", () => {
    const lead = makeLead({ firstName: "Jane", company: "WidgetCo" });
    const merge = buildMergeFields(lead);
    expect(merge.firstName).toBe("Jane");
    expect(merge.companyName).toBe("WidgetCo");
  });

  it("returns empty strings when firstName / company are missing", () => {
    const lead = makeLead({ firstName: undefined, company: undefined });
    const merge = buildMergeFields(lead);
    expect(merge.firstName).toBe("");
    expect(merge.companyName).toBe("");
  });

  it("lastStep and goal are always empty for leads (user-only concepts)", () => {
    const lead = makeLead();
    const merge = buildMergeFields(lead);
    expect(merge.lastStep).toBe("");
    expect(merge.goal).toBe("");
  });
});

// ─── End-to-end executor tick ──────────────────────────────────────────────

describe("runDripExecutor — global kill switch", () => {
  beforeEach(() => _resetInFlightGuardForTests());

  it("short-circuits when DRIP_CAMPAIGNS_ENABLED is unset", async () => {
    const deps = makeDeps({
      env: { DRIP_DRY_RUN: "false" }, // enabled flag missing
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
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
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
    });
    const result = await runDripExecutor(deps);
    expect(result.globalKillSwitch).toBe(true);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });
});

describe("runDripExecutor — dry-run default safety", () => {
  beforeEach(() => _resetInFlightGuardForTests());

  it("records dry_run status and does NOT call sendEmail when DRIP_DRY_RUN unset", async () => {
    const campaign = makeCampaign();
    const lead = makeLead();
    const deps = makeDeps({
      env: { DRIP_CAMPAIGNS_ENABLED: "true" }, // dry-run defaults to true
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listLeadsForCampaign: jest.fn(async () => [lead]),
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
  beforeEach(() => _resetInFlightGuardForTests());

  it("sends email to the LEAD, records sent, renders merge fields in subject + body", async () => {
    const lead = makeLead({
      firstName: "Alice",
      company: "Widget Co",
      email: "alice@widget.test",
    });
    const campaign = makeCampaign();
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listLeadsForCampaign: jest.fn(async () => [lead]),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
    expect(result.dryRuns).toBe(0);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    const sentArgs = (deps.sendEmail as jest.Mock).mock.calls[0][0];
    expect(sentArgs.to).toBe("alice@widget.test");
    expect(sentArgs.subject).toBe("Hi Alice");
    expect(sentArgs.html).toContain("Hey Alice");
    expect(sentArgs.html).toContain("Widget Co");

    const recorded = (deps.recordSend as jest.Mock).mock.calls[0][0];
    expect(recorded.status).toBe("sent");
    expect(recorded.dryRun).toBe(false);
    expect(recorded.messageId).toBe("msg-xyz");
  });
});

describe("runDripExecutor — safety gates", () => {
  beforeEach(() => _resetInFlightGuardForTests());

  it("skips paused campaigns", async () => {
    const paused = makeCampaign({ isActive: false });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [paused]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
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
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
    });
    const result = await runDripExecutor(deps);
    expect(result.campaignsSkipped).toBe(1);
    expect(result.skippedReasons.campaign_paused).toBe(1);
  });

  it("skips leads who already hit maxSends", async () => {
    const campaign = makeCampaign({ maxSends: 3 });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
      countSendsForUserCampaign: jest.fn(async () => 3),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.emailsSkipped).toBe(1);
    expect(result.skippedReasons.max_sends_reached).toBe(1);
  });

  it("skips leads inside the cadence window", async () => {
    const campaign = makeCampaign({ cadenceUnit: "days", cadenceValue: 7 });
    const twoDaysAgo = new Date("2026-04-16T06:00:00Z").toISOString();
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
      getMostRecentSendAt: jest.fn(async () => twoDaysAgo),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.skippedReasons.cadence_not_met).toBe(1);
  });

  it("allows send after cadence window elapses", async () => {
    const campaign = makeCampaign({ cadenceUnit: "days", cadenceValue: 7 });
    const tenDaysAgo = new Date("2026-04-08T06:00:00Z").toISOString();
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
      getMostRecentSendAt: jest.fn(async () => tenDaysAgo),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
  });

  it("skips leads with contactStatus='unsubscribed'", async () => {
    const lead = makeLead({ contactStatus: "unsubscribed" });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [lead]),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.skippedReasons.unsubscribed).toBe(1);
  });

  it("skips leads with contactStatus='do-not-contact'", async () => {
    const lead = makeLead({ contactStatus: "do-not-contact" });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [lead]),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.skippedReasons.unsubscribed).toBe(1);
  });

  it("skips leads without an email", async () => {
    const lead = makeLead({ email: "" });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [lead]),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.skippedReasons.no_email).toBe(1);
  });

  it("enforces per-campaign hourly rate limit", async () => {
    const campaign = makeCampaign();
    const leads = Array.from({ length: 5 }, (_, i) =>
      makeLead({ leadId: `l-${i}`, email: `u${i}@example.com` }),
    );
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listLeadsForCampaign: jest.fn(async () => leads),
      countSendsInWindow: jest.fn(async () => 49),
      env: {
        DRIP_CAMPAIGNS_ENABLED: "true",
        DRIP_DRY_RUN: "false",
      },
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
    expect(result.skippedReasons.rate_limit_exceeded).toBe(4);
  });

  it("skips entire campaign when rate limit is already exceeded for the hour", async () => {
    const campaign = makeCampaign();
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaign]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
      countSendsInWindow: jest.fn(async () => 100),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.campaignsSkipped).toBe(1);
    expect(result.skippedReasons.rate_limit_exceeded).toBe(1);
  });

  it("each campaign pulls its OWN tenant leads (cross-tenant isolation)", async () => {
    const campaignA = makeCampaign({
      campaignId: "camp-A",
      userId: "tenant-1",
    });
    const campaignB = makeCampaign({
      campaignId: "camp-B",
      userId: "tenant-2",
    });
    const leadForA = makeLead({
      leadId: "l-A",
      userId: "tenant-1",
      email: "a@a.test",
    });
    const leadForB = makeLead({
      leadId: "l-B",
      userId: "tenant-2",
      email: "b@b.test",
    });

    // The DI indirection lets us prove that each call gets a fresh
    // per-tenant lead set. If the executor ever accidentally shared a
    // single lead list across campaigns, tenant-2's leads would show up
    // under tenant-1 — this test would catch it.
    const leadFetcher = jest.fn(
      async (c: DripCampaign) =>
        c.userId === "tenant-1" ? [leadForA] : [leadForB],
    );

    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [campaignA, campaignB]),
      listLeadsForCampaign: leadFetcher,
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(2);
    // Order is campaign-order-preserving; proves listLeadsForCampaign was
    // called with each campaign separately.
    expect(leadFetcher).toHaveBeenNthCalledWith(1, campaignA);
    expect(leadFetcher).toHaveBeenNthCalledWith(2, campaignB);
    const recipients = (deps.sendEmail as jest.Mock).mock.calls.map(
      (c) => c[0].to,
    );
    expect(recipients.sort()).toEqual(["a@a.test", "b@b.test"].sort());
  });
});

describe("runDripExecutor — failure handling", () => {
  beforeEach(() => _resetInFlightGuardForTests());

  it("records a failed send when sendEmail throws", async () => {
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
      sendEmail: jest.fn(async () => {
        throw new Error("SMTP down");
      }),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsFailed).toBe(1);
    expect(result.emailsSent).toBe(0);
    const recorded = (deps.recordSend as jest.Mock).mock.calls[0][0];
    expect(recorded.status).toBe("failed");
    expect(recorded.error).toContain("SMTP down");
  });

  it("continues to the next lead when one send fails", async () => {
    const leads = [
      makeLead({ leadId: "l-1", email: "a@example.com" }),
      makeLead({ leadId: "l-2", email: "b@example.com" }),
    ];
    const sendMock = jest
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => ({ messageId: "msg-2" }));
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => leads),
      sendEmail: sendMock,
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
    expect(result.emailsFailed).toBe(1);
  });
});

describe("runDripExecutor — no-ops", () => {
  beforeEach(() => _resetInFlightGuardForTests());

  it("returns empty summary when no campaigns exist", async () => {
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => []),
    });
    const result = await runDripExecutor(deps);
    expect(result.campaignsConsidered).toBe(0);
    expect(result.emailsSent).toBe(0);
    expect(deps.listLeadsForCampaign).not.toHaveBeenCalled();
  });
});

// ─── Carry-over Senior Reviewer concerns (PR #1219) ───────────────────────

describe("runDripExecutor — in-flight guard (Concern A)", () => {
  beforeEach(() => {
    _resetInFlightGuardForTests();
  });

  it("skips re-entrant invocations while a previous tick is running", async () => {
    let release: () => void = () => {};
    const firstTickHangs = new Promise<DripCampaign[]>((resolve) => {
      release = () => resolve([]);
    });

    const depsA = makeDeps({
      listActiveCampaigns: jest.fn(() => firstTickHangs),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
    });
    const depsB = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
    });

    const firstPromise = runDripExecutor(depsA);
    const secondResult = await runDripExecutor(depsB);

    expect(depsB.listActiveCampaigns).not.toHaveBeenCalled();
    expect(secondResult.skippedReasons.tick_in_flight).toBe(1);
    expect(secondResult.emailsSent).toBe(0);
    expect(secondResult.dryRuns).toBe(0);

    release();
    await firstPromise;
  });

  it("releases the guard after the tick completes, allowing a subsequent run", async () => {
    const depsFirst = makeDeps({
      listActiveCampaigns: jest.fn(async () => []),
    });
    await runDripExecutor(depsFirst);

    const depsSecond = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
    });
    const result = await runDripExecutor(depsSecond);
    expect(depsSecond.listActiveCampaigns).toHaveBeenCalled();
    expect(result.emailsSent).toBe(1);
    expect(result.skippedReasons.tick_in_flight).toBeUndefined();
  });

  it("releases the guard even when the tick throws unexpectedly", async () => {
    const depsBroken = makeDeps({
      listActiveCampaigns: jest.fn(async () => {
        throw new Error("DynamoDB outage");
      }),
    });
    await expect(runDripExecutor(depsBroken)).rejects.toThrow(
      "DynamoDB outage",
    );

    const depsRecovered = makeDeps({
      listActiveCampaigns: jest.fn(async () => []),
    });
    const result = await runDripExecutor(depsRecovered);
    expect(result.skippedReasons.tick_in_flight).toBeUndefined();
    expect(depsRecovered.listActiveCampaigns).toHaveBeenCalled();
  });
});

describe("runDripExecutor — real-send audit fidelity (Concern B)", () => {
  beforeEach(() => {
    _resetInFlightGuardForTests();
  });

  it("records status='sent' with the REAL messageId, not a synthesized one", async () => {
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
      sendEmail: jest.fn(async () => ({ messageId: "real-provider-id-42" })),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(1);
    const recorded = (deps.recordSend as jest.Mock).mock.calls[0][0];
    expect(recorded.status).toBe("sent");
    expect(recorded.messageId).toBe("real-provider-id-42");
    expect(recorded.messageId).not.toMatch(/^drip-\d+-[a-z0-9]+$/);
  });

  it("records status='failed' (not 'sent') when the underlying sender throws", async () => {
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [makeLead()]),
      sendEmail: jest.fn(async () => {
        throw new Error("SMTP: connection refused");
      }),
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(0);
    expect(result.emailsFailed).toBe(1);
    const recorded = (deps.recordSend as jest.Mock).mock.calls[0][0];
    expect(recorded.status).toBe("failed");
    expect(recorded.messageId).toBeNull();
    expect(recorded.error).toContain("SMTP: connection refused");
  });
});

describe("runDripExecutor — cheap-first gate ordering", () => {
  beforeEach(() => {
    _resetInFlightGuardForTests();
  });

  it("skips unsubscribed leads WITHOUT calling scan-based checks", async () => {
    const lead = makeLead({ contactStatus: "unsubscribed" });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [lead]),
    });
    await runDripExecutor(deps);
    expect(deps.countSendsForUserCampaign).not.toHaveBeenCalled();
    expect(deps.getMostRecentSendAt).not.toHaveBeenCalled();
  });

  it("skips no-email leads WITHOUT calling scan-based checks", async () => {
    const lead = makeLead({ email: "" });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [lead]),
    });
    await runDripExecutor(deps);
    expect(deps.countSendsForUserCampaign).not.toHaveBeenCalled();
    expect(deps.getMostRecentSendAt).not.toHaveBeenCalled();
  });

  it("stops calling scan-based checks once in-loop rate-cap is exhausted", async () => {
    const leads = Array.from({ length: 10 }, (_, i) =>
      makeLead({ leadId: `l-${i}`, email: `u${i}@example.com` }),
    );
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => leads),
      countSendsInWindow: jest.fn(async () => 48),
      env: { DRIP_CAMPAIGNS_ENABLED: "true", DRIP_DRY_RUN: "false" },
    });
    const result = await runDripExecutor(deps);
    expect(result.emailsSent).toBe(2);
    expect(
      (deps.countSendsForUserCampaign as jest.Mock).mock.calls.length,
    ).toBeLessThanOrEqual(2);
    expect(
      (deps.getMostRecentSendAt as jest.Mock).mock.calls.length,
    ).toBeLessThanOrEqual(2);
  });
});

describe("dripSends are keyed by (listId:leadId)", () => {
  beforeEach(() => _resetInFlightGuardForTests());

  it("passes listId:leadId as the dripSends userId field so cadence + cap queries are per-lead, not per-tenant", async () => {
    const lead = makeLead({ listId: "L1", leadId: "LD1" });
    const deps = makeDeps({
      listActiveCampaigns: jest.fn(async () => [makeCampaign()]),
      listLeadsForCampaign: jest.fn(async () => [lead]),
    });
    await runDripExecutor(deps);
    expect(deps.countSendsForUserCampaign).toHaveBeenCalledWith(
      "L1:LD1",
      "camp-1",
    );
    expect(deps.getMostRecentSendAt).toHaveBeenCalledWith(
      "L1:LD1",
      "camp-1",
    );
    const recorded = (deps.recordSend as jest.Mock).mock.calls[0][0];
    expect(recorded.userId).toBe("L1:LD1");
  });
});
