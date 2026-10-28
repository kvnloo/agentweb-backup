/**
 * ENG-266 Part 3 — the drip email step routes through sendAsSender (the
 * sender's real provider) instead of hardcoding Resend and refusing mailbox
 * senders outright.
 */

import { processDueEnrollments } from '../services/dripSequenceWorker';

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: {
    getAllDueEnrollments: jest.fn(),
    getSequence: jest.fn(),
    exitEnrollment: jest.fn(),
    completeEnrollment: jest.fn(),
    advanceEnrollment: jest.fn(),
    snoozeEnrollment: jest.fn(),
    setEnrollmentLinkedInProviderId: jest.fn(),
    claimEnrollment: jest.fn(),
    releaseEnrollmentClaim: jest.fn(),
  },
}));

const mockSendAsSender = jest.fn();
jest.mock('../services/sendAsSender', () => {
  const actual = jest.requireActual('../services/senderUsageTracker');
  return {
    sendAsSender: (...args: any[]) => mockSendAsSender(...args),
    SenderDailyLimitExceededError: actual.SenderDailyLimitExceededError,
  };
});

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountId: jest.fn(),
    resolveProviderId: jest.fn(),
    sendMessage: jest.fn(),
    getMessagesWithContact: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: { getLeadById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { getEventsByEmailDomainAndLeadEmail: jest.fn() },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));

import { dripSequenceDb } from '../services/dripSequenceDb';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';
import { settingsService } from '../services/settingsService';

const mockDripSequenceDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;
const mockGetSetting = settingsService.getSetting as jest.Mock;

const baseEnrollment = {
  enrollmentId: 'enroll-1',
  sequenceId: 'seq-1',
  leadId: 'lead-1',
  listId: 'list-1',
  leadEmail: 'lead@acme.io',
  userId: 'user-1',
  currentStep: 0,
  status: 'active',
  enrolledAt: '2026-01-01T00:00:00Z',
  nextSendAt: '2026-01-02T00:00:00Z',
};

const sequenceWithStep = {
  sequenceId: 'seq-1',
  userId: 'user-1',
  name: 'Test Sequence',
  status: 'active',
  campaignType: 'custom',
  enrollmentTrigger: { type: 'manual' },
  exitConditions: { onUnsubscribe: true },
  steps: [
    {
      stepId: 'step-1',
      stepNumber: 1,
      name: 'Step 1',
      delayDays: 0,
      channel: 'email',
      subject: 'Hi {{firstName}}',
      bodyHtml: '<p>hi</p>',
    },
  ],
};

const lead = { leadId: 'lead-1', email: 'lead@acme.io', firstName: 'Pat' };

const senderConfigWith = (senders: any[], defaultSenderId: string | null = null) =>
  mockGetSetting.mockResolvedValue({ settingValue: JSON.stringify({ senders, defaultSenderId }) });

beforeEach(() => {
  jest.clearAllMocks();
  mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);
  mockDripSequenceDb.claimEnrollment.mockResolvedValue(true);
  mockDripSequenceDb.releaseEnrollmentClaim.mockResolvedValue(undefined as any);
  mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
  mockDripSequenceDb.getSequence.mockResolvedValue(sequenceWithStep as any);
  mockCrmDb.getLeadById.mockResolvedValue(lead as any);
  mockDripSequenceDb.completeEnrollment.mockResolvedValue(undefined as any);
});

describe('dripSequenceWorker sender routing — FAIL cases', () => {
  it('throws (and does not advance) when sendAsSender rejects', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1' } as any);
    mockGetSetting.mockResolvedValue(null);
    mockSendAsSender.mockRejectedValue(new Error('mailbox token revoked'));

    const stats = await processDueEnrollments();

    expect(stats.errors).toBe(1);
    expect(stats.sent).toBe(0);
    expect(mockDripSequenceDb.completeEnrollment).not.toHaveBeenCalled();
    expect(mockDripSequenceDb.advanceEnrollment).not.toHaveBeenCalled();
  });

  it('skips the step (no sendAsSender call) when there is no configured sender and no legacy default', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1' } as any);
    mockGetSetting.mockResolvedValue(null);

    const stats = await processDueEnrollments();

    expect(mockSendAsSender).not.toHaveBeenCalled();
    expect(stats.errors).toBe(1);
  });

  it('does NOT refuse a mailbox-backed sender any more (the old guard is gone)', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1' } as any);
    senderConfigWith(
      [{ id: 's1', email: 'me@baldwin.com', fromName: 'Hunter', senderType: 'outlook', connectedAccountId: 'ol-1' }],
      's1',
    );
    mockSendAsSender.mockResolvedValue({ provider: 'outlook', messageId: 'ol-msg-1' });

    const stats = await processDueEnrollments();

    expect(stats.errors).toBe(0);
    expect(stats.sent).toBe(1);
    expect(mockSendAsSender).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ id: 's1', senderProvider: 'outlook' }),
      expect.objectContaining({ subject: 'Hi Pat', html: expect.stringContaining('<p>hi</p>') }),
    );
  });
});

describe('dripSequenceWorker sender routing — SUCCESS cases', () => {
  it('routes a resend-configured sender through sendAsSender identically to before', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1' } as any);
    senderConfigWith([{ id: 's1', email: 'hi@acme.com', fromName: 'Acme' }], 's1');
    mockSendAsSender.mockResolvedValue({ provider: 'resend', messageId: 'resend-1' });

    const stats = await processDueEnrollments();

    expect(stats.sent).toBe(1);
    expect(mockSendAsSender).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ id: 's1', senderProvider: 'resend', email: 'hi@acme.com' }),
      expect.objectContaining({ to: 'lead@acme.io', subject: 'Hi Pat', html: expect.stringContaining('<p>hi</p>') }),
    );
  });

  it('falls back to the legacy user-level default sender when no CRM senders are configured', async () => {
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'user-1',
      emailDomain: 'example.com',
      defaultSenderUsername: 'sender',
      displayName: 'Sender',
    } as any);
    mockGetSetting.mockResolvedValue(null);
    mockSendAsSender.mockResolvedValue({ provider: 'resend', messageId: 'resend-legacy-1' });

    const stats = await processDueEnrollments();

    expect(stats.sent).toBe(1);
    expect(mockSendAsSender).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ senderProvider: 'resend', email: 'sender@example.com' }),
      expect.anything(),
    );
  });
});

// ENG-673: a lead pushed to a customer's Smartlead campaign is emailed from there, so AgentWeb's own sequence must not also email it.
describe('dripSequenceWorker — leads pushed to Smartlead (ENG-673)', () => {
  const marker = (state: string) => ({ state, pushedAt: '2026-10-28T00:00:00Z', runId: 'r1', payloadHash: 'h' });
  const pushed = (state = 'pushed') => ({ ...lead, system: { smartlead_77: marker(state) } });

  beforeEach(() => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1' } as any);
    senderConfigWith([{ id: 's1', email: 'hi@acme.com', fromName: 'Acme' }], 's1');
    mockSendAsSender.mockResolvedValue({ provider: 'resend', messageId: 'resend-1' });
    mockDripSequenceDb.advanceEnrollment.mockResolvedValue(undefined as any);
  });

  it('control: the same lead WITHOUT a marker is emailed', async () => {
    const stats = await processDueEnrollments();
    expect(stats.sent).toBe(1);
    expect(mockSendAsSender).toHaveBeenCalledTimes(1);
  });

  it.each(['pushed', 'withdrawn'])('does not email a lead whose Smartlead marker is %s, and skips the step', async state => {
    mockCrmDb.getLeadById.mockResolvedValue(pushed(state) as any);
    const stats = await processDueEnrollments();
    expect(mockSendAsSender).not.toHaveBeenCalled();
    expect(stats.sent).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(mockDripSequenceDb.completeEnrollment).toHaveBeenCalledWith('enroll-1', 'completed_no_sends', 'completed', 'email', false); // the only step, skipped, delivered nothing
  });

  it('does NOT email, and does not advance, when the lead could not be read (failing open would skip every per-lead check)', async () => {
    mockCrmDb.getLeadById.mockRejectedValue(new Error('throttled'));
    const stats = await processDueEnrollments();
    expect(mockSendAsSender).not.toHaveBeenCalled();
    expect(stats.errors).toBe(1);
    expect(mockDripSequenceDb.advanceEnrollment).not.toHaveBeenCalled();
    expect(mockDripSequenceDb.completeEnrollment).not.toHaveBeenCalled();
  });

  it('emails the lead again once a list editor released the marker', async () => {
    mockCrmDb.getLeadById.mockResolvedValue(pushed('released') as any);
    const stats = await processDueEnrollments();
    expect(stats.sent).toBe(1);
  });

  it('also stops a pushed lead on a LATER email step of a longer sequence, but does not end the enrollment', async () => {
    mockDripSequenceDb.getSequence.mockResolvedValue({ ...sequenceWithStep, steps: [...sequenceWithStep.steps, { ...sequenceWithStep.steps[0], stepId: 'step-2', stepNumber: 2, delayDays: 3 }] } as any);
    mockCrmDb.getLeadById.mockResolvedValue(pushed() as any);
    await processDueEnrollments();
    expect(mockSendAsSender).not.toHaveBeenCalled();
    expect(mockDripSequenceDb.advanceEnrollment).toHaveBeenCalledWith('enroll-1', 1, expect.any(String), 'email', false);
  });
});
