/**
 * Tests that LinkedIn "not a 1st-degree connection" errors trigger a 6-hour snooze
 * instead of retrying every 5 minutes (retry storm prevention).
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
    claimEnrollment: jest.fn(),
    releaseEnrollmentClaim: jest.fn(),
  },
}));

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    sendMessage: jest.fn(),
    resolveAccountId: jest.fn(),
    resolveProviderId: jest.fn(),
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

jest.mock('../utils/emailVariables', () => ({
  substituteVariables: jest.fn((s: string) => s),
  injectUnsubscribeUrl: jest.fn((s: string) => s),
  rewriteS3ImageUrls: jest.fn((s: string) => s),
  normalizeYoutubeUrls: jest.fn((s: string) => s),
}));

import { dripSequenceDb } from '../services/dripSequenceDb';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';

const mockDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockLinkedIn = linkedInOutreachService as jest.Mocked<typeof linkedInOutreachService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;

const linkedInEnrollment = {
  enrollmentId: 'enroll-li-1',
  sequenceId: 'seq-1',
  leadId: 'lead-1',
  listId: 'list-1',
  leadEmail: 'prospect@example.com',
  userId: 'user-1',
  currentStep: 0,
  status: 'active',
  enrolledAt: '2026-01-01T00:00:00Z',
  nextSendAt: '2026-01-02T00:00:00Z',
};

const linkedInSequence = {
  sequenceId: 'seq-1',
  userId: 'user-1',
  name: 'LinkedIn Drip',
  status: 'active',
  campaignType: 'custom',
  enrollmentTrigger: { type: 'linkedin_connection_accepted' },
  exitConditions: { onUnsubscribe: true, onLinkedInReply: true },
  steps: [
    {
      stepId: 'step-1',
      stepNumber: 1,
      name: 'Opening message',
      channel: 'linkedin',
      delayDays: 0,
      messageText: 'Hi {{firstName}} — thanks for connecting!',
    },
  ],
};

const activeLead = {
  leadId: 'lead-1',
  email: 'prospect@example.com',
  firstName: 'John',
  linkedin: 'https://www.linkedin.com/in/john-prospect/',
  contactStatus: 'active',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'sender@example.com' } as any);
  mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);
  (require('../services/settingsService').settingsService.getSetting as jest.Mock).mockResolvedValue(null);
  mockLinkedIn.resolveAccountId.mockResolvedValue('account-123');
  mockDb.snoozeEnrollment.mockResolvedValue(undefined as any);
  mockDb.claimEnrollment.mockResolvedValue(true);
  mockDb.releaseEnrollmentClaim.mockResolvedValue(undefined as any);
});

describe('dripSequenceWorker - LinkedIn not-connected handling', () => {
  it('snoozes enrollment for ~6h when target is not a 1st-degree connection', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([linkedInEnrollment as any]);
    mockDb.getSequence.mockResolvedValue(linkedInSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue(activeLead as any);
    mockLinkedIn.sendMessage.mockRejectedValue(
      new Error('Cannot send message: target is not a 1st-degree connection (status: SECOND_DEGREE). Use the send-invite action first to connect.'),
    );

    const before = Date.now();
    const stats = await processDueEnrollments();
    const after = Date.now();

    expect(stats.errors).toBe(1);
    expect(stats.sent).toBe(0);

    expect(mockDb.snoozeEnrollment).toHaveBeenCalledTimes(1);
    const [enrollmentId, retryAt] = mockDb.snoozeEnrollment.mock.calls[0];
    expect(enrollmentId).toBe('enroll-li-1');

    const retryMs = new Date(retryAt).getTime();
    const expectedMin = before + 5 * 60 * 60 * 1000;
    const expectedMax = after + 7 * 60 * 60 * 1000;
    expect(retryMs).toBeGreaterThanOrEqual(expectedMin);
    expect(retryMs).toBeLessThanOrEqual(expectedMax);
  });

  it('does NOT snooze when LinkedIn send fails for an unrelated reason', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([linkedInEnrollment as any]);
    mockDb.getSequence.mockResolvedValue(linkedInSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue(activeLead as any);
    mockLinkedIn.sendMessage.mockRejectedValue(new Error('Unipile API timeout'));

    const stats = await processDueEnrollments();

    expect(stats.errors).toBe(1);
    expect(mockDb.snoozeEnrollment).not.toHaveBeenCalled();
  });

  it('does NOT snooze on success — advances to next step normally', async () => {
    mockDb.getAllDueEnrollments.mockResolvedValue([linkedInEnrollment as any]);
    mockDb.getSequence.mockResolvedValue(linkedInSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue(activeLead as any);
    mockLinkedIn.sendMessage.mockResolvedValue({ id: 'msg-1' });
    mockDb.completeEnrollment.mockResolvedValue(undefined as any);

    const stats = await processDueEnrollments();

    expect(stats.sent).toBe(1);
    expect(stats.errors).toBe(0);
    expect(mockDb.snoozeEnrollment).not.toHaveBeenCalled();
  });
});
