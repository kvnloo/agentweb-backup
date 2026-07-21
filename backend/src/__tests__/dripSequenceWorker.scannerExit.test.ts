/**
 * Integration tests for ENG-325 wiring: the drip worker's "exit on open/click"
 * must ignore automated MACHINE engagement (link scanners / prefetch) while still
 * exiting on real human opens/clicks and always exiting on a reply.
 */

import { processDueEnrollments } from '../services/dripSequenceWorker';

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: {
    getAllDueEnrollments: jest.fn(),
    claimEnrollment: jest.fn(),
    getSequence: jest.fn(),
    exitEnrollment: jest.fn(),
    completeEnrollment: jest.fn(),
    advanceEnrollment: jest.fn(),
    snoozeEnrollment: jest.fn(),
    releaseEnrollmentClaim: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));

jest.mock('../services/db', () => ({
  crmDb: { getLeadById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { getEventsByEmailDomainAndLeadEmail: jest.fn() },
}));

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));

jest.mock('../services/crmSenderService', () => ({ loadSenderConfig: jest.fn() }));

jest.mock('../services/sendAsSender', () => ({ sendAsSender: jest.fn() }));

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
import { loadSenderConfig } from '../services/crmSenderService';
import { sendAsSender } from '../services/sendAsSender';

const mockDb = dripSequenceDb as jest.Mocked<typeof dripSequenceDb>;
const mockResend = resendService as jest.Mocked<typeof resendService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockEmailEventsDb = emailEventsDb as jest.Mocked<typeof emailEventsDb>;
const mockLoadSenderConfig = loadSenderConfig as jest.Mock;
const mockSendAsSender = sendAsSender as jest.Mock;

const enrollment = {
  enrollmentId: 'enroll-1',
  sequenceId: 'seq-1',
  leadId: 'lead-1',
  listId: 'list-1',
  leadEmail: 'lead@corp.com',
  userId: 'user-1',
  currentStep: 0,
  status: 'active',
  enrolledAt: '2026-07-14T14:00:00Z',
  nextSendAt: '2026-07-14T14:30:00Z',
};

// Sequence exits on open OR click OR reply.
const sequence = {
  sequenceId: 'seq-1',
  userId: 'user-1',
  name: 'Cold outreach',
  status: 'active',
  campaignType: 'outbound',
  enrollmentTrigger: { type: 'manual' },
  exitConditions: { onEmailEngagement: ['opened', 'clicked', 'replied'] },
  steps: [{ stepId: 'step-1', stepNumber: 1, name: 'Step 1', delayDays: 0, subject: 'Hi', bodyHtml: '<p>Hi</p>' }],
};

const user = { userId: 'user-1', email: 'sender@corp.com', displayName: 'Sender', emailDomain: 'corp.com' };

const SEND = '2026-07-14 14:30:05.123456+00'; // send time (Resend format)

function scannerClickEvent() {
  return {
    eventType: 'email.clicked',
    createdAt: '2026-07-14T14:30:06.000Z', // ~0.9s after send
    data: { created_at: SEND, click: { userAgent: 'Mimecast Link Protect', timestamp: '2026-07-14T14:30:06.000Z' } },
  };
}

function humanClickEvent() {
  return {
    eventType: 'email.clicked',
    createdAt: '2026-07-14T14:30:30.000Z', // ~25s after send
    data: { created_at: SEND, click: { userAgent: 'Mozilla/5.0 Chrome/126 Safari/537.36', timestamp: '2026-07-14T14:30:30.000Z' } },
  };
}

function replyEvent() {
  return { eventType: 'email.received', createdAt: '2026-07-14T15:00:00.000Z', data: { created_at: SEND } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.getAllDueEnrollments.mockResolvedValue([enrollment as any]);
  mockDb.claimEnrollment.mockResolvedValue(true as any);
  mockDb.getSequence.mockResolvedValue(sequence as any);
  mockDb.exitEnrollment.mockResolvedValue(undefined as any);
  mockDb.completeEnrollment.mockResolvedValue(undefined as any);
  mockDb.advanceEnrollment.mockResolvedValue(undefined as any);
  mockDb.releaseEnrollmentClaim.mockResolvedValue(undefined as any);
  mockDb.snoozeEnrollment.mockResolvedValue(undefined as any);
  mockUserDb.getUserById.mockResolvedValue(user as any);
  mockCrmDb.getLeadById.mockResolvedValue({ leadId: 'lead-1', email: 'lead@corp.com' } as any);
  mockResend.sendEmail.mockResolvedValue({ id: 'sent-1' } as any);
  mockLoadSenderConfig.mockResolvedValue({
    senders: [{ id: 'default', fromEmail: 'sender@corp.com', fromName: 'Sender' }],
    defaultSenderId: 'default',
  });
  mockSendAsSender.mockResolvedValue({ provider: 'resend', messageId: 'sent-1' });
});

describe('dripSequenceWorker — scanner-aware engagement exit (ENG-325)', () => {
  it('does NOT exit on a scanner click (named scanner UA); keeps sending', async () => {
    mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([scannerClickEvent()] as any);

    const stats = await processDueEnrollments();

    expect(mockDb.exitEnrollment).not.toHaveBeenCalledWith('enroll-1', 'engagement');
    expect(mockSendAsSender).toHaveBeenCalledTimes(1); // kept sending
    expect(stats.exited).toBe(0);
    expect(stats.sent).toBe(1);
  });

  it('DOES exit on a real human click (browser UA, 25s gap)', async () => {
    mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([humanClickEvent()] as any);

    const stats = await processDueEnrollments();

    expect(mockDb.exitEnrollment).toHaveBeenCalledWith('enroll-1', 'engagement');
    expect(mockResend.sendEmail).not.toHaveBeenCalled();
    expect(stats.exited).toBe(1);
  });

  it('DOES exit on a reply (email.received) — no false-positive mode', async () => {
    mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([replyEvent()] as any);

    const stats = await processDueEnrollments();

    expect(mockDb.exitEnrollment).toHaveBeenCalledWith('enroll-1', 'engagement');
    expect(stats.exited).toBe(1);
  });

  it('does NOT exit when only a scanner click exists alongside a pre-send open', async () => {
    const preSendOpen = {
      eventType: 'email.opened',
      createdAt: '2026-07-14T14:30:04.000Z', // BEFORE send (14:30:05)
      data: { created_at: SEND, open: { userAgent: 'AnyProxy/1.0', timestamp: '2026-07-14T14:30:04.000Z' } },
    };
    mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([preSendOpen, scannerClickEvent()] as any);

    const stats = await processDueEnrollments();

    expect(mockDb.exitEnrollment).not.toHaveBeenCalledWith('enroll-1', 'engagement');
    expect(stats.exited).toBe(0);
  });

  it('exits on a real human open even when a scanner click is also present', async () => {
    const humanOpen = {
      eventType: 'email.opened',
      createdAt: '2026-07-14T14:31:00.000Z', // ~55s after send
      data: {
        created_at: SEND,
        open: { userAgent: 'Mozilla/5.0 (Windows NT 5.0 (via ggpht.com GoogleImageProxy)', timestamp: '2026-07-14T14:31:00.000Z' },
      },
    };
    mockEmailEventsDb.getEventsByEmailDomainAndLeadEmail.mockResolvedValue([scannerClickEvent(), humanOpen] as any);

    const stats = await processDueEnrollments();

    expect(mockDb.exitEnrollment).toHaveBeenCalledWith('enroll-1', 'engagement');
    expect(stats.exited).toBe(1);
  });
});
