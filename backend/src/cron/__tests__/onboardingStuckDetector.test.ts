/**
 * Tests for onboardingStuckDetector.
 *
 * Mocks userDb.getAllUsers + reportUIError so the test asserts purely on
 * classification + dispatch logic without touching DDB or Notion.
 */
jest.mock('../../services/db', () => ({
  userDb: {
    getAllUsers: jest.fn(),
  },
}));

jest.mock('../../utils/errorReporter', () => ({
  reportUIError: jest.fn().mockResolvedValue(undefined),
}));

import { runOnboardingStuckDetector } from '../onboardingStuckDetector';
const { userDb } = require('../../services/db');
const { reportUIError } = require('../../utils/errorReporter');

const HOUR_MS = 60 * 60 * 1000;

function tsHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runOnboardingStuckDetector', () => {
  it('skips users in terminal stages (onboarding_completed / active)', async () => {
    userDb.getAllUsers.mockResolvedValue([
      {
        userId: 'u1',
        email: 'u1@example.com',
        onboardingStage: 'onboarding_completed',
        onboardingEvents: [{ event: 'onboarding_completed', ts: tsHoursAgo(48) }],
      },
      {
        userId: 'u2',
        email: 'u2@example.com',
        onboardingStage: 'active',
        onboardingEvents: [{ event: 'channel_connected', ts: tsHoursAgo(48) }],
      },
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.scanned).toBe(2);
    expect(r.fired).toBe(0);
    expect(reportUIError).not.toHaveBeenCalled();
  });

  it('skips users without an onboardingStage (haven\'t started yet)', async () => {
    userDb.getAllUsers.mockResolvedValue([
      { userId: 'u1', email: 'u1@example.com', createdAt: tsHoursAgo(48) },
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.fired).toBe(0);
    expect(reportUIError).not.toHaveBeenCalled();
  });

  it('skips users whose last event is recent (< STUCK_HOURS)', async () => {
    userDb.getAllUsers.mockResolvedValue([
      {
        userId: 'u1',
        email: 'u1@example.com',
        onboardingStage: 'goal_selected',
        onboardingEvents: [{ event: 'goal_selected', ts: tsHoursAgo(0.1) }],
      },
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.fired).toBe(0);
  });

  it('fires "stuck" for an idle non-engaged user (signed_up_no_start past 1h)', async () => {
    userDb.getAllUsers.mockResolvedValue([
      {
        userId: 'u1',
        email: 'u1@realuser.com',
        onboardingStage: 'signed_up_no_start',
        onboardingEvents: [{ event: 'goal_selected', ts: tsHoursAgo(2) }],
      },
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.fired).toBe(1);
    expect(r.byClassification.stuck).toBe(1);
    expect(reportUIError).toHaveBeenCalledTimes(1);
    expect(reportUIError).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'onboarding:stuck',
        userId: 'u1',
        context: expect.objectContaining({
          Stage: 'signed_up_no_start',
        }),
      }),
    );
  });

  it('fires "abandoned" (not "stuck") for an engaged user idle > 24h', async () => {
    userDb.getAllUsers.mockResolvedValue([
      {
        userId: 'u1',
        email: 'u1@realuser.com',
        onboardingStage: 'brand_submitted',
        onboardingEvents: [{ event: 'brand_submitted', ts: tsHoursAgo(48) }],
      },
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.fired).toBe(1);
    expect(r.byClassification.abandoned).toBe(1);
    expect(r.byClassification.stuck).toBe(0);
    expect(reportUIError).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'onboarding:abandoned' }),
    );
  });

  it('fires both stuck and abandoned in a mixed batch', async () => {
    userDb.getAllUsers.mockResolvedValue([
      {
        userId: 'a',
        email: 'a@realuser.com',
        onboardingStage: 'goal_selected',
        onboardingEvents: [{ event: 'goal_selected', ts: tsHoursAgo(50) }],
      },
      {
        userId: 'b',
        email: 'b@realuser.com',
        onboardingStage: 'signed_up_no_start',
        onboardingEvents: [{ event: 'goal_selected', ts: tsHoursAgo(2) }],
      },
      {
        userId: 'c',
        email: 'c@realuser.com',
        onboardingStage: 'onboarding_completed',
        onboardingEvents: [{ event: 'onboarding_completed', ts: tsHoursAgo(50) }],
      },
    ]);
    const r = await runOnboardingStuckDetector();
    expect(r.scanned).toBe(3);
    expect(r.fired).toBe(2);
    expect(r.byClassification.stuck).toBe(1);
    expect(r.byClassification.abandoned).toBe(1);
  });

  // Bug 2: all-steps-ready short-circuit + test-domain filter.
  describe('Bug 2 — all-steps-ready short-circuit', () => {
    const ALL_READY = {
      brandBuildStatus: 'ready',
      icpStatus: 'ready',
      competitorStatus: 'ready',
      creativeDirStatus: 'ready',
      adImageStatus: 'ready',
      adCopyStatus: 'ready',
    };

    it('skips users whose 6 step statuses are all ready, even if stage is stale', async () => {
      userDb.getAllUsers.mockResolvedValue([
        {
          userId: 'u1',
          email: 'u1@realuser.com',
          onboardingStage: 'brand_submitted', // stale stage
          onboardingEvents: [{ event: 'brand_submitted', ts: tsHoursAgo(48) }],
          ...ALL_READY,
        },
      ]);
      const r = await runOnboardingStuckDetector();
      expect(r.fired).toBe(0);
      expect(reportUIError).not.toHaveBeenCalled();
    });

    it('still fires for a real user with mid-flow stale stage and not all steps ready', async () => {
      userDb.getAllUsers.mockResolvedValue([
        {
          userId: 'u1',
          email: 'u1@realuser.com',
          onboardingStage: 'brand_submitted',
          onboardingEvents: [{ event: 'brand_submitted', ts: tsHoursAgo(48) }],
          ...ALL_READY,
          adCopyStatus: 'running', // one step not ready → still fires
        },
      ]);
      const r = await runOnboardingStuckDetector();
      expect(r.fired).toBe(1);
      expect(r.byClassification.abandoned).toBe(1);
    });

    it('fires when no step statuses are present at all (legacy users)', async () => {
      userDb.getAllUsers.mockResolvedValue([
        {
          userId: 'u1',
          email: 'u1@realuser.com',
          onboardingStage: 'brand_submitted',
          onboardingEvents: [{ event: 'brand_submitted', ts: tsHoursAgo(48) }],
          // No *Status fields at all.
        },
      ]);
      const r = await runOnboardingStuckDetector();
      expect(r.fired).toBe(1);
    });
  });

  describe('Bug 2 — test-domain filter', () => {
    const ENGAGED_STALE = {
      onboardingStage: 'brand_submitted',
      onboardingEvents: [{ event: 'brand_submitted', ts: tsHoursAgo(48) }],
    };

    it.each([
      ['u@agenttest.com'],
      ['rui@example.com'],
      ['Harsha@AgentTest.com'], // case-insensitive
      ['test+qa@gmail.com'],
      ['someone+qa-batch3@workdomain.io'],
    ])('skips test-domain email: %s', async (email) => {
      userDb.getAllUsers.mockResolvedValue([
        { userId: 'u1', email, ...ENGAGED_STALE },
      ]);
      const r = await runOnboardingStuckDetector();
      expect(r.fired).toBe(0);
      expect(reportUIError).not.toHaveBeenCalled();
    });

    it.each([
      ['real@gmail.com'],
      ['founder@startup.io'],
      ['plus.dot+marketing@company.com'], // `+marketing`, not `+qa`
    ])('still fires for non-test email: %s', async (email) => {
      userDb.getAllUsers.mockResolvedValue([
        { userId: 'u1', email, ...ENGAGED_STALE },
      ]);
      const r = await runOnboardingStuckDetector();
      expect(r.fired).toBe(1);
    });

    it('treats missing/undefined email as non-test (still fires)', async () => {
      userDb.getAllUsers.mockResolvedValue([
        { userId: 'u1', ...ENGAGED_STALE }, // no email field
      ]);
      const r = await runOnboardingStuckDetector();
      expect(r.fired).toBe(1);
    });
  });
});
