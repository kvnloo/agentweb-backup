/**
 * ENG-2529: every drip LinkedIn send goes through the shared write gate (daily cap +
 * hourly pacer), and a refusal DEFERS the enrollment instead of sending, failing, or
 * advancing it. Also enumerates the LinkedIn write surfaces and asserts each one calls
 * the shared gate, so a new surface cannot silently bypass it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { processDueEnrollments, linkedInDeferRetryAt, LINKEDIN_PACER_DEFER_MS } from '../services/dripSequenceWorker';

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
    setEnrollmentLinkedInProviderId: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
const mockResolveLinkedInAccountForWrite = jest.fn();
const mockPace = jest.fn();
const mockRelease = jest.fn();
const mockReserveWriteSlot = jest.fn();
jest.mock('../services/linkedInWritePacer', () => ({
  reserveWriteSlot: (...args: any[]) => mockReserveWriteSlot(...args),
}));
jest.mock('../services/agentMode/linkedInDailyVolumeGate', () => ({
  resolveLinkedInAccountForWrite: (...args: any[]) => mockResolveLinkedInAccountForWrite(...args),
  // ENG-2529: the send path is paced; this suite is about URLs, so the gate always allows.
  paceLinkedInWrite: (...args: any[]) => mockPace(...args),
  releaseLinkedInDailySlot: (...args: any[]) => mockRelease(...args),
}));

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

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));

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
const mockLi = linkedInOutreachService as jest.Mocked<typeof linkedInOutreachService>;

const enrollment = {
  enrollmentId: 'enroll-1', sequenceId: 'seq-1', leadId: 'lead-1', listId: 'list-1',
  leadEmail: 'https://www.linkedin.com/in/ada/', userId: 'user-1', currentStep: 0,
  status: 'active', enrolledAt: '2026-01-01T00:00:00Z', nextSendAt: '2026-01-02T00:00:00Z',
};
const sequence = {
  sequenceId: 'seq-1', userId: 'user-1', name: 'LI', status: 'active', campaignType: 'custom',
  enrollmentTrigger: { type: 'manual' }, exitConditions: { onUnsubscribe: true },
  steps: [{ stepId: 's1', stepNumber: 1, name: 'DM', channel: 'linkedin', delayDays: 0, messageText: 'hi' }],
};
const resolved = { ownerUserId: 'user-1', configuredDailyInviteCap: 20, dailyVolumeState: null, connectedAt: null };

beforeEach(() => {
  jest.clearAllMocks();
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', email: 's@acme.io' });
  (crmDb.getLeadById as jest.Mock).mockResolvedValue({ leadId: 'lead-1', linkedin: 'https://www.linkedin.com/in/ada' });
  (emailEventsDb.getEventsByEmailDomainAndLeadEmail as jest.Mock).mockResolvedValue([]);
  (require('../services/settingsService').settingsService.getSetting as jest.Mock).mockResolvedValue(null);
  mockDb.getAllDueEnrollments.mockResolvedValue([enrollment as any]);
  mockDb.getSequence.mockResolvedValue(sequence as any);
  mockDb.claimEnrollment.mockResolvedValue(true);
  mockLi.resolveAccountId.mockResolvedValue('acct-1' as any);
  mockLi.resolveProviderId.mockResolvedValue('prov-1' as any);
  mockLi.sendMessage.mockResolvedValue(undefined as any);
  mockResolveLinkedInAccountForWrite.mockResolvedValue(resolved);
  mockPace.mockResolvedValue({ refusal: null });
  mockDb.snoozeEnrollment.mockResolvedValue(undefined as any);
  mockReserveWriteSlot.mockResolvedValue({ allowed: true });
});

describe('ENG-2529 AC1: drip LinkedIn sends call the shared gate before sending', () => {
  it('paces send-message with the resolved account before sendMessage', async () => {
    const order: string[] = [];
    mockPace.mockImplementation(async () => { order.push('pace'); return { refusal: null }; });
    mockLi.sendMessage.mockImplementation(async () => { order.push('send'); return undefined as any; });

    const stats = await processDueEnrollments();

    expect(stats.errors).toBe(0);
    expect(mockPace).toHaveBeenCalledWith('send-message', resolved, 'acct-1');
    expect(order).toEqual(['pace', 'send']);
    expect(mockDb.advanceEnrollment.mock.calls.length + mockDb.completeEnrollment.mock.calls.length).toBe(1);
  });

  it('a shared-pool account the owner does not hold is still held to the hourly pacer', async () => {
    mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
    mockReserveWriteSlot.mockResolvedValue({ allowed: false, reason: 'hourly ceiling' });

    await processDueEnrollments();

    expect(mockReserveWriteSlot).toHaveBeenCalledWith('acct-1');
    expect(mockLi.sendMessage).not.toHaveBeenCalled();
    expect(mockDb.snoozeEnrollment).toHaveBeenCalledTimes(1);
  });
});

describe('ENG-2529: a failed send gives its daily slot back (Opslane run 725 P1)', () => {
  it('releases the reserved slot when sendMessage throws, and not on success', async () => {
    mockLi.sendMessage.mockRejectedValueOnce(new Error('unipile down'));
    mockDb.releaseEnrollmentClaim.mockResolvedValue(undefined as any);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await processDueEnrollments();
    expect(mockRelease).toHaveBeenCalledWith('send-message', resolved, 'acct-1', undefined);

    mockRelease.mockClear();
    mockLi.sendMessage.mockResolvedValue(undefined as any);
    await processDueEnrollments();
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe('ENG-2529 AC2: a refusal defers the enrollment, never sends/fails/advances', () => {
  it.each(['daily_volume', 'write_pacer', 'reservation_persistence'])('gate %s refuses -> deferred', async (gate) => {
    mockPace.mockResolvedValue({ refusal: { success: false, message: 'm', error: `limit hit (${gate})\nmore`, gate } });
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });

    await processDueEnrollments();
    spy.mockRestore();

    expect(mockLi.sendMessage).not.toHaveBeenCalled();
    expect(mockDb.advanceEnrollment).not.toHaveBeenCalled();
    expect(mockDb.completeEnrollment).not.toHaveBeenCalled();
    expect(mockDb.exitEnrollment).not.toHaveBeenCalled();
    expect(mockDb.releaseEnrollmentClaim).not.toHaveBeenCalled();
    expect(mockDb.snoozeEnrollment).toHaveBeenCalledWith('enroll-1', expect.any(String));
    // the reason is recorded
    expect(logs.some((l) => l.includes('Deferred enrollment enroll-1') && l.includes(gate) && l.includes('limit hit'))).toBe(true);
  });

  it('daily cap defers to next UTC midnight; pacer defers briefly', () => {
    const now = new Date('2026-10-17T15:00:00Z');
    expect(linkedInDeferRetryAt('daily_volume', now)).toBe('2026-10-18T00:00:00.000Z');
    expect(linkedInDeferRetryAt('write_pacer', now)).toBe(new Date(now.getTime() + LINKEDIN_PACER_DEFER_MS).toISOString());
  });
});

describe('ENG-2529 AC3: every LinkedIn write surface calls the shared gate', () => {
  const src = path.join(__dirname, '..');
  const surfaces: Array<[string, string]> = [
    ['agent tool', 'emma/impl/linkedin.ts'],
    ['CRM routes', 'routes/crm.ts'],
    ['drip worker', 'services/dripSequenceWorker.ts'],
  ];
  it.each(surfaces)('%s (%s) calls paceLinkedInWrite', (_label, rel) => {
    const code = fs.readFileSync(path.join(src, rel), 'utf8');
    expect(code).toMatch(/paceLinkedInWrite\(/);
  });
});

describe('ENG-2529 AC3: each CRM LinkedIn send route paces before sending', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'routes/crm.ts'), 'utf8');
  const routeBody = (route: string): string => {
    const start = code.indexOf(`router.post('${route}'`);
    expect(start).toBeGreaterThan(-1);
    const next = code.indexOf('\nrouter.', start + 1);
    return code.slice(start, next === -1 ? undefined : next);
  };
  it.each([
    ['/lists/:listId/leads/:leadId/send-linkedin-message', 'send-message', 'sendMessage('],
    ['/lists/:listId/leads/:leadId/send-linkedin-invite', 'send-invite', 'sendInvitation('],
  ])('%s calls paceLinkedInWrite(%s) before the Unipile call', (route, action, sendCall) => {
    const body = routeBody(route);
    const paceIdx = body.indexOf(`paceLinkedInWrite('${action}'`);
    const sendIdx = body.indexOf(sendCall);
    expect(paceIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(paceIdx);
    expect(body.slice(paceIdx, sendIdx)).toMatch(/status\(429\)/);
  });
});
