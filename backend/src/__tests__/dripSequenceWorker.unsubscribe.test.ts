/**
 * Tests that unsubscribed leads are not sent sequence emails.
 */

import { processDueEnrollments } from '../services/dripSequenceWorker';

// Mock all external dependencies
jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: {
    getAllDueEnrollments: jest.fn(),
    getSequence: jest.fn(),
    exitEnrollment: jest.fn(),
    completeEnrollment: jest.fn(),
    advanceEnrollment: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
  },
}));

jest.mock('../utils/emailVariables', () => ({
  substituteVariables: jest.fn((s: string) => s),
  injectUnsubscribeUrl: jest.fn((s: string) => s),
  rewriteS3ImageUrls: jest.fn((s: string) => s),
  normalizeYoutubeUrls: jest.fn((s: string) => s),
}));

import { dripSequenceDb } from '../services/dripSequenceDb';
import { resendService } from '../services/resendService';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';

const mockDripSequenceDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockResendService = resendService as jest.Mocked<typeof resendService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;

const baseEnrollment = {
  enrollmentId: 'enroll-1',
  sequenceId: 'seq-1',
  leadId: 'lead-1',
  listId: 'list-1',
  leadEmail: 'test@example.com',
  userId: 'user-1',
  currentStep: 0,
  status: 'active',
  enrolledAt: '2026-01-01T00:00:00Z',
  nextSendAt: '2026-01-02T00:00:00Z',
};

const baseSequence = {
  sequenceId: 'seq-1',
  userId: 'user-1',
  name: 'Test Sequence',
  status: 'active',
  campaignType: 'outbound',
  enrollmentTrigger: { type: 'manual' },
  exitConditions: {
    onUnsubscribe: true,
  },
  steps: [
    {
      stepId: 'step-1',
      stepNumber: 1,
      name: 'Step 1',
      delayDays: 0,
      subject: 'Hello',
      bodyHtml: '<p>Hi</p>',
    },
  ],
};

const baseUser = {
  userId: 'user-1',
  email: 'sender@example.com',
  displayName: 'Sender',
  emailDomain: 'example.com',
  defaultSenderUsername: 'sender',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserDb.getUserById.mockResolvedValue(baseUser as any);
  mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);
  (require('../services/settingsService').settingsService.getSetting as jest.Mock).mockResolvedValue(null);
});

describe('dripSequenceWorker - unsubscribe handling', () => {
  it('exits enrollment and does not send email when lead has contactStatus=unsubscribed', async () => {
    mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
    mockDripSequenceDb.getSequence.mockResolvedValue(baseSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1',
      email: 'test@example.com',
      contactStatus: 'unsubscribed',
    } as any);
    mockDripSequenceDb.exitEnrollment.mockResolvedValue(undefined as any);

    const stats = await processDueEnrollments();

    expect(mockDripSequenceDb.exitEnrollment).toHaveBeenCalledWith('enroll-1', 'unsubscribed');
    expect(mockResendService.sendEmail).not.toHaveBeenCalled();
    expect(stats.exited).toBe(1);
    expect(stats.sent).toBe(0);
  });

  it('exits enrollment and does not send email when lead has contactStatus=do-not-contact', async () => {
    mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
    mockDripSequenceDb.getSequence.mockResolvedValue(baseSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1',
      email: 'test@example.com',
      contactStatus: 'do-not-contact',
    } as any);
    mockDripSequenceDb.exitEnrollment.mockResolvedValue(undefined as any);

    const stats = await processDueEnrollments();

    expect(mockDripSequenceDb.exitEnrollment).toHaveBeenCalledWith('enroll-1', 'unsubscribed');
    expect(mockResendService.sendEmail).not.toHaveBeenCalled();
    expect(stats.exited).toBe(1);
  });

  it('exits enrollment and does not send email when lead has legacy unsubscribedFromGroupEmail=true', async () => {
    mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
    mockDripSequenceDb.getSequence.mockResolvedValue(baseSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1',
      email: 'test@example.com',
      unsubscribedFromGroupEmail: true,
    } as any);
    mockDripSequenceDb.exitEnrollment.mockResolvedValue(undefined as any);

    const stats = await processDueEnrollments();

    expect(mockDripSequenceDb.exitEnrollment).toHaveBeenCalledWith('enroll-1', 'unsubscribed');
    expect(mockResendService.sendEmail).not.toHaveBeenCalled();
    expect(stats.exited).toBe(1);
  });

  it('sends email normally when lead is active (not unsubscribed)', async () => {
    mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
    mockDripSequenceDb.getSequence.mockResolvedValue(baseSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1',
      email: 'test@example.com',
      contactStatus: 'active',
    } as any);
    mockResendService.sendEmail.mockResolvedValue({ id: 'email-id-1' } as any);
    mockDripSequenceDb.completeEnrollment.mockResolvedValue(undefined as any);

    const stats = await processDueEnrollments();

    expect(mockResendService.sendEmail).toHaveBeenCalledTimes(1);
    expect(mockDripSequenceDb.exitEnrollment).not.toHaveBeenCalled();
    expect(stats.sent).toBe(1);
    expect(stats.exited).toBe(0);
  });

  it('sends email normally when lead has no contactStatus (active by default)', async () => {
    mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
    mockDripSequenceDb.getSequence.mockResolvedValue(baseSequence as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1',
      email: 'test@example.com',
    } as any);
    mockResendService.sendEmail.mockResolvedValue({ id: 'email-id-2' } as any);
    mockDripSequenceDb.completeEnrollment.mockResolvedValue(undefined as any);

    const stats = await processDueEnrollments();

    expect(mockResendService.sendEmail).toHaveBeenCalledTimes(1);
    expect(stats.sent).toBe(1);
  });
});
