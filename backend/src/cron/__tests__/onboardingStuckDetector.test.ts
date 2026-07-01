/**
 * Tests for onboardingStuckDetector — daily aggregated report.
 *
 * The detector no longer fires per-user reportUIError calls. It scans all
 * users once per day, groups non-terminal users by their onboardingStage,
 * and files ONE aggregated oncall item summarizing the counts. These tests mock
 * userDb.getAllUsers + intakeService.fileAutoIssue and assert on the
 * aggregated shape + the single-task post.
 */
jest.mock('../../services/db', () => ({
  userDb: {
    getAllUsers: jest.fn(),
  },
}));

// ENG-6: the daily report files via the shared intake service (fileAutoIssue) -> a private Linear
// issue (Auto label, Triage). Assert on the intake payload it builds.
jest.mock('../../services/intakeService', () => ({
  fileAutoIssue: jest.fn().mockResolvedValue({
    pageId: 'ENG-1',
    url: 'https://linear.app/emmabyaw/issue/ENG-1',
    deduped: false,
    tracker: 'Linear',
  }),
}));

import { runOnboardingStuckDetector } from '../onboardingStuckDetector';
const { userDb } = require('../../services/db');
const { fileAutoIssue } = require('../../services/intakeService');

const HOUR_MS = 60 * 60 * 1000;

function tsHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

function makeUser(opts: {
  userId: string;
  email?: string;
  stage?: string;
  hoursIdle?: number;
  allStepsReady?: boolean;
  oneStepRunning?: boolean;
}): any {
  const u: any = {
    userId: opts.userId,
    email: opts.email,
    onboardingStage: opts.stage,
  };
  if (opts.hoursIdle != null && opts.stage) {
    u.onboardingEvents = [{ event: opts.stage, ts: tsHoursAgo(opts.hoursIdle) }];
  }
  if (opts.allStepsReady) {
    u.brandBuildStatus = 'ready';
    u.icpStatus = 'ready';
    u.competitorStatus = 'ready';
    u.creativeDirStatus = 'ready';
    u.adImageStatus = 'ready';
    u.adCopyStatus = opts.oneStepRunning ? 'running' : 'ready';
  }
  return u;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runOnboardingStuckDetector — daily aggregated report', () => {
  it('returns zero counts and does NOT create a Notion task when no users are stuck', async () => {
    userDb.getAllUsers.mockResolvedValue([
      // recent activity — not stuck
      makeUser({ userId: 'u1', email: 'u1@real.com', stage: 'goal_selected', hoursIdle: 0.1 }),
      // terminal — skipped
      makeUser({ userId: 'u2', email: 'u2@real.com', stage: 'onboarding_completed', hoursIdle: 48 }),
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.scanned).toBe(2);
    expect(r.totalStuck).toBe(0);
    expect(r.byStage).toEqual({});
    expect(r.notionUrl).toBeNull();
    expect(fileAutoIssue).not.toHaveBeenCalled();
  });

  it('groups stuck users by stage and posts ONE Notion task with per-stage counts', async () => {
    userDb.getAllUsers.mockResolvedValue([
      makeUser({ userId: 'a', email: 'a@real.com', stage: 'brand_submitted', hoursIdle: 8 }),
      makeUser({ userId: 'b', email: 'b@real.com', stage: 'brand_submitted', hoursIdle: 30 }),
      makeUser({ userId: 'c', email: 'c@real.com', stage: 'brand_submitted', hoursIdle: 4 }),
      makeUser({ userId: 'd', email: 'd@real.com', stage: 'icp_selected', hoursIdle: 12 }),
      makeUser({ userId: 'e', email: 'e@real.com', stage: 'welcome_offer_shown', hoursIdle: 50 }),
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.scanned).toBe(5);
    expect(r.totalStuck).toBe(5);
    expect(r.byStage.brand_submitted.count).toBe(3);
    expect(r.byStage.icp_selected.count).toBe(1);
    expect(r.byStage.welcome_offer_shown.count).toBe(1);
    // oldestHours reflects the most-idle user in that stage (b @ 30h)
    expect(r.byStage.brand_submitted.oldestHours).toBeGreaterThanOrEqual(29);
    expect(r.byStage.brand_submitted.oldestHours).toBeLessThan(31);
    // Exactly one Notion task posted, regardless of N stuck users
    expect(fileAutoIssue).toHaveBeenCalledTimes(1);
    expect(fileAutoIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringMatching(/^Onboarding stuck users — daily report /),
        notionTags: expect.arrayContaining(['Onboarding']),
      }),
    );
    // Title carries today's date (YYYY-MM-DD)
    const callArg = fileAutoIssue.mock.calls[0][0];
    expect(callArg.title).toMatch(/\d{4}-\d{2}-\d{2}$/);
    // Context surfaces totalStuck + per-stage rows
    expect(callArg.notionContext).toEqual(
      expect.objectContaining({
        'Total Stuck Users': '5',
        'Stage: brand_submitted': expect.stringContaining('3 users'),
        'Stage: icp_selected': expect.stringContaining('1 user'),
        'Stage: welcome_offer_shown': expect.stringContaining('1 user'),
      }),
    );
  });

  it('caps sample emails per stage at 5 and lists them in the context row', async () => {
    const users = Array.from({ length: 8 }, (_, i) =>
      makeUser({ userId: `u${i}`, email: `u${i}@real.com`, stage: 'brand_submitted', hoursIdle: 6 + i }),
    );
    userDb.getAllUsers.mockResolvedValue(users);
    const r = await runOnboardingStuckDetector();
    expect(r.byStage.brand_submitted.count).toBe(8);
    expect(r.byStage.brand_submitted.sampleEmails.length).toBe(5);
    const stageRow = fileAutoIssue.mock.calls[0][0].notionContext['Stage: brand_submitted'];
    // The row should mention "+3 more" since we capped at 5 of 8
    expect(stageRow).toMatch(/\+3 more/);
  });

  it('still applies the all-steps-ready short-circuit (legacy stale-stage users excluded)', async () => {
    userDb.getAllUsers.mockResolvedValue([
      makeUser({
        userId: 'u1',
        email: 'u1@real.com',
        stage: 'brand_submitted',
        hoursIdle: 48,
        allStepsReady: true,
      }),
      makeUser({
        userId: 'u2',
        email: 'u2@real.com',
        stage: 'brand_submitted',
        hoursIdle: 48,
        allStepsReady: true,
        oneStepRunning: true, // one step not ready → still counts
      }),
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.totalStuck).toBe(1);
    expect(r.byStage.brand_submitted.count).toBe(1);
    expect(r.byStage.brand_submitted.sampleEmails).toEqual(['u2@real.com']);
  });

  it('still applies the test-domain filter (agenttest, example, +qa)', async () => {
    userDb.getAllUsers.mockResolvedValue([
      makeUser({ userId: 't1', email: 'rui@example.com', stage: 'brand_submitted', hoursIdle: 48 }),
      makeUser({ userId: 't2', email: 'someone@agenttest.com', stage: 'brand_submitted', hoursIdle: 48 }),
      makeUser({ userId: 't3', email: 'real+qa@gmail.com', stage: 'brand_submitted', hoursIdle: 48 }),
      makeUser({ userId: 'r1', email: 'real@startup.io', stage: 'brand_submitted', hoursIdle: 48 }),
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.totalStuck).toBe(1);
    expect(r.byStage.brand_submitted.sampleEmails).toEqual(['real@startup.io']);
  });

  it('skips users in terminal stages and users without an onboardingStage', async () => {
    userDb.getAllUsers.mockResolvedValue([
      makeUser({ userId: 'u1', email: 'u1@real.com', stage: 'onboarding_completed', hoursIdle: 48 }),
      makeUser({ userId: 'u2', email: 'u2@real.com', stage: 'active', hoursIdle: 48 }),
      makeUser({ userId: 'u3', email: 'u3@real.com' /* no stage */ }),
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.totalStuck).toBe(0);
    expect(fileAutoIssue).not.toHaveBeenCalled();
  });

  it('skips users whose last event is more recent than STUCK_HOURS', async () => {
    userDb.getAllUsers.mockResolvedValue([
      makeUser({ userId: 'u1', email: 'u1@real.com', stage: 'brand_submitted', hoursIdle: 0.2 }),
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.totalStuck).toBe(0);
    expect(fileAutoIssue).not.toHaveBeenCalled();
  });

  it('survives a Notion API failure — returns the report with notionUrl=null', async () => {
    fileAutoIssue.mockRejectedValueOnce(new Error('Notion API down'));
    userDb.getAllUsers.mockResolvedValue([
      makeUser({ userId: 'u1', email: 'u1@real.com', stage: 'brand_submitted', hoursIdle: 8 }),
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.totalStuck).toBe(1);
    expect(r.notionUrl).toBeNull();
  });
});
