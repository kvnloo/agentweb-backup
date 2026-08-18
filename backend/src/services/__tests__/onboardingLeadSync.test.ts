/**
 * Onboarding v2 analytics — Lead dual-write tests.
 *
 * Every onboarding event written to a User record also mirrors to the matching
 * Lead row in the founders@ "AgentWeb Signups" list so Fangfang can review
 * qualitative behavior and Emma can reason programmatically.
 *
 * Task: https://www.notion.so/34c09247c951812cbc90f09aa68fc5d3
 */

import {
  mirrorOnboardingEventToLead,
  ONBOARDING_LEAD_FIELD,
  ONBOARDING_DEVIATION_COUNT_FIELD,
  ONBOARDING_STAGE_FIELD,
} from '../onboardingLeadSync';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockGetLeadListsByUserId = jest.fn();
const mockGetLeadByEmail = jest.fn();
const mockCreateLead = jest.fn();
const mockUpdateLeadOnboarding = jest.fn();

const mockCrmDb = {
  getLeadListsByUserId: mockGetLeadListsByUserId,
  getLeadByEmail: mockGetLeadByEmail,
  createLead: mockCreateLead,
  updateLeadOnboardingAnalytics: mockUpdateLeadOnboarding,
};

const FOUNDERS_LIST = {
  listId: 'list-founders-signups',
  name: 'AgentWeb Signups',
};

const silentLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  log: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLeadListsByUserId.mockResolvedValue([FOUNDERS_LIST]);
  mockGetLeadByEmail.mockResolvedValue({
    leadId: 'lead-abc',
    listId: FOUNDERS_LIST.listId,
    email: 'user@example.com',
  });
  mockUpdateLeadOnboarding.mockResolvedValue(undefined);
  mockCreateLead.mockResolvedValue({ leadId: 'lead-new', listId: FOUNDERS_LIST.listId });
});

describe('mirrorOnboardingEventToLead', () => {
  // ─── FAIL cases ───────────────────────────────────────────────────────────

  it('no-ops and returns { mirrored: false } when email is missing', async () => {
    const result = await mirrorOnboardingEventToLead(
      {
        userId: 'u-1',
        email: '',
        event: { event: 'goal_selected', ts: '2026-04-23T00:00:00Z' },
        allEvents: [],
        onboardingStage: 'goal_selected',
      },
      { crmDb: mockCrmDb as any, logger: silentLogger },
    );
    expect(result.mirrored).toBe(false);
    expect(result.reason).toBe('no_email');
    expect(mockUpdateLeadOnboarding).not.toHaveBeenCalled();
    expect(mockCreateLead).not.toHaveBeenCalled();
  });

  it('swallows crmDb errors — never throws, returns { reason: "error" }', async () => {
    mockGetLeadByEmail.mockRejectedValueOnce(new Error('boom'));
    const result = await mirrorOnboardingEventToLead(
      {
        userId: 'u-1',
        email: 'user@example.com',
        event: { event: 'goal_selected', ts: '2026-04-23T00:00:00Z' },
        allEvents: [{ event: 'goal_selected', ts: '2026-04-23T00:00:00Z' }],
        onboardingStage: 'goal_selected',
      },
      { crmDb: mockCrmDb as any, logger: silentLogger },
    );
    expect(result.mirrored).toBe(false);
    expect(result.reason).toBe('error');
  });

  it('does not create a Lead when the founders list is missing (treated as not yet provisioned)', async () => {
    mockGetLeadListsByUserId.mockResolvedValueOnce([]);
    const result = await mirrorOnboardingEventToLead(
      {
        userId: 'u-1',
        email: 'user@example.com',
        event: { event: 'goal_selected', ts: '2026-04-23T00:00:00Z' },
        allEvents: [],
        onboardingStage: 'goal_selected',
      },
      { crmDb: mockCrmDb as any, logger: silentLogger },
    );
    expect(result.mirrored).toBe(false);
    expect(result.reason).toBe('no_list');
    expect(mockCreateLead).not.toHaveBeenCalled();
  });

  // ─── SUCCESS cases ────────────────────────────────────────────────────────

  it('mirrors an event to the matched Lead — writes full event log + stage', async () => {
    const allEvents = [
      { event: 'goal_selected', ts: '2026-04-23T00:00:00Z', data: { goal: 'paid_ads' } },
      { event: 'brand_submitted', ts: '2026-04-23T00:01:00Z' },
    ];
    const result = await mirrorOnboardingEventToLead(
      {
        userId: 'u-1',
        email: 'user@example.com',
        event: allEvents[1],
        allEvents,
        onboardingStage: 'brand_submitted',
      },
      { crmDb: mockCrmDb as any, logger: silentLogger },
    );
    expect(result.mirrored).toBe(true);
    expect(result.reason).toBe('updated');
    expect(result.leadId).toBe('lead-abc');
    expect(mockUpdateLeadOnboarding).toHaveBeenCalledWith(
      FOUNDERS_LIST.listId,
      'lead-abc',
      expect.objectContaining({
        [ONBOARDING_LEAD_FIELD]: allEvents,
        [ONBOARDING_STAGE_FIELD]: 'brand_submitted',
      }),
    );
  });

  it('mirrors a lateral voice event without changing Lead lifecycle stage', async () => {
    const voiceEvent = { event: 'voice_onboarding_presented', ts: '2026-04-23T00:00:00Z' };
    await mirrorOnboardingEventToLead(
      {
        userId: 'u-1',
        email: 'user@example.com',
        event: voiceEvent,
        allEvents: [voiceEvent],
        onboardingStage: null,
      },
      { crmDb: mockCrmDb as any, logger: silentLogger },
    );

    expect(mockUpdateLeadOnboarding).toHaveBeenCalledWith(
      FOUNDERS_LIST.listId,
      'lead-abc',
      expect.not.objectContaining({ [ONBOARDING_STAGE_FIELD]: expect.anything() }),
    );
  });

  it('creates the Lead when no match exists, then mirrors the event to it', async () => {
    mockGetLeadByEmail.mockResolvedValueOnce(null);
    const allEvents = [{ event: 'goal_selected', ts: '2026-04-23T00:00:00Z' }];
    const result = await mirrorOnboardingEventToLead(
      {
        userId: 'u-1',
        email: 'newuser@example.com',
        event: allEvents[0],
        allEvents,
        onboardingStage: 'goal_selected',
      },
      { crmDb: mockCrmDb as any, logger: silentLogger },
    );
    expect(result.mirrored).toBe(true);
    expect(result.reason).toBe('created_and_updated');
    expect(mockCreateLead).toHaveBeenCalledWith(
      FOUNDERS_LIST.listId,
      expect.objectContaining({ email: 'newuser@example.com' }),
    );
    expect(mockUpdateLeadOnboarding).toHaveBeenCalled();
  });

  it('increments deviation count when the event is "deviation"', async () => {
    const allEvents = [
      { event: 'goal_selected', ts: '2026-04-23T00:00:00Z' },
      {
        event: 'deviation',
        ts: '2026-04-23T00:00:30Z',
        data: { message: 'what about e-commerce?', step: 'goal' },
      },
    ];
    const result = await mirrorOnboardingEventToLead(
      {
        userId: 'u-1',
        email: 'user@example.com',
        event: allEvents[1],
        allEvents,
        onboardingStage: 'goal_selected',
      },
      { crmDb: mockCrmDb as any, logger: silentLogger },
    );
    expect(result.mirrored).toBe(true);
    const args = mockUpdateLeadOnboarding.mock.calls[0][2];
    expect(args[ONBOARDING_DEVIATION_COUNT_FIELD]).toBe(1);
  });

  it('deviation count reflects the total in allEvents (idempotent on re-run)', async () => {
    const allEvents = [
      { event: 'goal_selected', ts: '2026-04-23T00:00:00Z' },
      { event: 'deviation', ts: '2026-04-23T00:00:10Z', data: { message: 'q1' } },
      { event: 'deviation', ts: '2026-04-23T00:00:20Z', data: { message: 'q2' } },
      { event: 'deviation', ts: '2026-04-23T00:00:30Z', data: { message: 'q3' } },
    ];
    await mirrorOnboardingEventToLead(
      {
        userId: 'u-1',
        email: 'user@example.com',
        event: allEvents[3],
        allEvents,
        onboardingStage: 'goal_selected',
      },
      { crmDb: mockCrmDb as any, logger: silentLogger },
    );
    const args = mockUpdateLeadOnboarding.mock.calls[0][2];
    expect(args[ONBOARDING_DEVIATION_COUNT_FIELD]).toBe(3);
  });

  it('normalises email casing when looking up the Lead', async () => {
    await mirrorOnboardingEventToLead(
      {
        userId: 'u-1',
        email: 'User@Example.COM',
        event: { event: 'goal_selected', ts: '2026-04-23T00:00:00Z' },
        allEvents: [{ event: 'goal_selected', ts: '2026-04-23T00:00:00Z' }],
        onboardingStage: 'goal_selected',
      },
      { crmDb: mockCrmDb as any, logger: silentLogger },
    );
    expect(mockGetLeadByEmail).toHaveBeenCalledWith(
      FOUNDERS_LIST.listId,
      'user@example.com',
    );
  });
});
