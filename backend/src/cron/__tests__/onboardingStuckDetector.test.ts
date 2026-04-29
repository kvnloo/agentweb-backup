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
        email: 'u1@example.com',
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
        email: 'u1@example.com',
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
        email: 'a@example.com',
        onboardingStage: 'goal_selected',
        onboardingEvents: [{ event: 'goal_selected', ts: tsHoursAgo(50) }],
      },
      {
        userId: 'b',
        email: 'b@example.com',
        onboardingStage: 'signed_up_no_start',
        onboardingEvents: [{ event: 'goal_selected', ts: tsHoursAgo(2) }],
      },
      {
        userId: 'c',
        email: 'c@example.com',
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
});
