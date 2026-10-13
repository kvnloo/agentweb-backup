/**
 * Tests for drip sequence routes and dripSequenceDb service.
 *
 * Covers: invalid inputs, boundary conditions, error paths, and the happy path.
 */

import request from 'supertest';
import express from 'express';
import sequenceRoutes from '../routes/sequences';
import { resendService } from '../services/resendService';
import { settingsService } from '../services/settingsService';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'test@acme.io' };
    next();
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn() },
}));

// ENG-2205: LinkedIn step account ids are checked against the caller's own/org-shared accounts.
const mockResolveLinkedInAccountForWrite = jest.fn();
jest.mock('../services/agentMode/linkedInDailyVolumeGate', () => ({
  resolveLinkedInAccountForWrite: (...args: any[]) => mockResolveLinkedInAccountForWrite(...args),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));

const mockGetEmailProvider = jest.fn();
jest.mock('../services/emailProviderService', () => ({
  getEmailProvider: (...args: any[]) => mockGetEmailProvider(...args),
  bootstrapEmailProviders: jest.fn().mockResolvedValue(undefined),
}));

// Mock the db service used in the by-list enrollment route
jest.mock('../services/db', () => ({
  crmDb: {
    getLeads: jest.fn().mockResolvedValue([
      { leadId: 'lead-1', email: 'a@acme.io' },
      { leadId: 'lead-2', email: 'b@acme.io' },
    ]),
    getLead: jest.fn().mockResolvedValue({ leadId: 'lead-1', email: 'a@acme.io', lifecycle: 'inbox' }),
    // The explicit enroll route decides reachability from the CRM ROW, not the request
    // body — its payload has no `linkedin` field, so reading the body made it enrol
    // nobody for a LinkedIn sequence. Resolve per leadId, because "this lead has no
    // address" is now a fact about the CRM, not about the payload.
    getLeadById: jest.fn().mockImplementation(async (_listId: string, leadId: string) => (
      leadId === 'lead-1'
        ? { leadId: 'lead-1', email: 'a@acme.io' }
        : { leadId, email: '' }
    )),
    getLeadsByListId: jest.fn().mockResolvedValue([
      { leadId: 'lead-1', email: 'a@acme.io' },
      { leadId: 'lead-2', email: 'b@acme.io' },
    ]),
    getAllLeadsByListId: jest.fn().mockResolvedValue([
      { leadId: 'lead-1', email: 'a@acme.io' },
      { leadId: 'lead-2', email: 'b@acme.io' },
    ]),
    getLeadsByStatus: jest.fn().mockResolvedValue([]),
    getLeadListById: jest.fn().mockResolvedValue({ listId: 'list-1', userId: 'user-123' }),
    canOrgMemberAccessList: jest.fn().mockResolvedValue(true),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'user-123', email: 'test@acme.io' }),
  },
}));

// Mock factory — cannot reference outer variables (Jest hoists jest.mock calls)
jest.mock('../services/dripSequenceDb', () => {
  const seq = {
    sequenceId: 'seq_1',
    userId: 'user-123',
    name: 'Free to Paid',
    campaignType: 'conversion',
    enrollmentTrigger: { type: 'manual' },
    exitConditions: { onUnsubscribe: true, onLifecycleChange: ['paying'] },
    steps: [
      { stepId: 's1', stepNumber: 1, name: 'Intro', delayDays: 0, subject: 'Hello', bodyHtml: '<p>Hi</p>' },
    ],
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  class SequenceNotFoundError extends Error {
    constructor(id: string) { super(`Sequence ${id} not found`); this.name = 'SequenceNotFoundError'; }
  }
  class SequenceAuthError extends Error {
    constructor() { super('Not authorized'); this.name = 'SequenceAuthError'; }
  }
  return {
    dripSequenceDb: {
      listSequences: jest.fn().mockResolvedValue([seq]),
      createSequence: jest.fn().mockResolvedValue(seq),
      getSequence: jest.fn().mockResolvedValue(seq),
      updateSequence: jest.fn().mockResolvedValue({ ...seq, name: 'Updated' }),
      deleteSequence: jest.fn().mockResolvedValue(undefined),
      listEnrollmentsForSequence: jest.fn().mockResolvedValue([]),
      getEnrollmentStats: jest.fn().mockResolvedValue({ active: 0, completed: 0, exited: 0, unsubscribed: 0, bounced: 0, total: 0 }),
      bulkEnroll: jest.fn().mockResolvedValue({ enrolled: 2, skipped: 0 }),
      exitEnrollment: jest.fn().mockResolvedValue(undefined),
    },
    SequenceNotFoundError,
    SequenceAuthError,
  };
});

const { dripSequenceDb, SequenceNotFoundError, SequenceAuthError } = require('../services/dripSequenceDb');

// Convenience alias for assertions
const mockSequence = {
  sequenceId: 'seq_1',
  userId: 'user-123',
  name: 'Free to Paid',
  campaignType: 'conversion',
  enrollmentTrigger: { type: 'manual' },
  exitConditions: { onUnsubscribe: true, onLifecycleChange: ['paying'] },
  steps: [
    { stepId: 's1', stepNumber: 1, name: 'Intro', delayDays: 0, subject: 'Hello', bodyHtml: '<p>Hi</p>' },
  ],
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('Opslane by-list filter regressions', () => {
  it.each(['', '   '])('uses lifecycle with blank status %p without enabling whole-list auto-enrollment', async (status) => {
    const { crmDb } = require('../services/db');
    crmDb.getAllLeadsByListId.mockResolvedValue([
      { leadId: 'inbox', email: 'a@acme.io' },
      { leadId: 'paying', email: 'b@acme.io', subscriptionState: 'active' },
    ]);
    const res = await request(app).post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'inbox', status });
    expect(res.status).toBe(200);
    expect(dripSequenceDb.bulkEnroll.mock.calls[0][0].map((lead: any) => lead.leadId)).toEqual(['inbox']);
    expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
  });

  it('rejects a present empty lifecycle', async () => {
    const res = await request(app).post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_lifecycle');
  });
  it('rejects explicit status outside a stored status vocabulary', async () => {
    const { crmDb } = require('../services/db');
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', statusConfig: [{ value: 'new' }, { value: 'won' }] });
    const res = await request(app).post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', status: 'nwe' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_status');
    expect(res.body.message).toContain('new');
    expect(res.body.message).toContain('won');
    expect(crmDb.getLeadsByStatus).not.toHaveBeenCalled();
    expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
  });

  it.each([undefined, []])('preserves custom statuses without a stored vocabulary %p', async (statusConfig) => {
    const { crmDb } = require('../services/db');
    crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', statusConfig });
    crmDb.getLeadsByStatus.mockResolvedValue([{ leadId: 'custom', email: 'a@acme.io' }]);
    const res = await request(app).post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', status: 'custom' });
    expect(res.status).toBe(200);
    expect(dripSequenceDb.bulkEnroll.mock.calls[0][0].map((lead: any) => lead.leadId)).toEqual(['custom']);
  });
  it('validates lifecycle even with explicit status', async () => {
    const res = await request(app).post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'inbxo', status: 'new' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_lifecycle');
    expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
  });

  it('intersects explicit status with derived lifecycle', async () => {
    const { crmDb } = require('../services/db');
    crmDb.getLeadsByStatus.mockResolvedValue([
      { leadId: 'inbox', email: 'a@acme.io', status: 'new' },
      { leadId: 'paying', email: 'b@acme.io', status: 'new', subscriptionState: 'active' },
    ]);
    const res = await request(app).post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'inbox', status: 'new' });
    expect(res.status).toBe(200);
    expect(dripSequenceDb.bulkEnroll.mock.calls[0][0].map((lead: any) => lead.leadId)).toEqual(['inbox']);
    expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
  });
  it.each(['', '   '])('rejects unknown lifecycle with blank status %p', async (status) => {
    const res = await request(app).post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'inbxo', status });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_lifecycle');
    expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
    expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
  });
});

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/', sequenceRoutes);

// Restore every crmDb/userDb fixture before each test.
//
// Tests here set fixtures by BARE REASSIGNMENT (`crmDbMock.getAllLeadsByListId =
// jest.fn()...`), which replaces the property outright — `clearAllMocks`/`resetAllMocks`
// cannot restore it, so whatever the previous test assigned leaks into the next one.
// That is not theoretical: one test mocked `getLeadsByListId` while the route calls
// `getAllLeadsByListId`, and it passed purely on the fixture left behind by its
// neighbour — a test asserting nothing about its own subject. Under `--randomize` this
// file failed 13-14 of 73. Re-seeding the defaults here makes each test independent of
// order, so a leak shows up as a failure in the test that actually has the bug.
beforeEach(() => {
  const { crmDb, userDb } = require('../services/db');
  crmDb.getLeads = jest.fn().mockResolvedValue([
    { leadId: 'lead-1', email: 'a@acme.io' },
    { leadId: 'lead-2', email: 'b@acme.io' },
  ]);
  crmDb.getLead = jest.fn().mockResolvedValue({ leadId: 'lead-1', email: 'a@acme.io', lifecycle: 'inbox' });
  crmDb.getLeadById = jest.fn().mockImplementation(async (_listId: string, leadId: string) => (
    leadId === 'lead-1'
      ? { leadId: 'lead-1', email: 'a@acme.io' }
      : { leadId, email: '' }
  ));
  crmDb.getLeadsByListId = jest.fn().mockResolvedValue([
    { leadId: 'lead-1', email: 'a@acme.io' },
    { leadId: 'lead-2', email: 'b@acme.io' },
  ]);
  crmDb.getAllLeadsByListId = jest.fn().mockResolvedValue([
    { leadId: 'lead-1', email: 'a@acme.io' },
    { leadId: 'lead-2', email: 'b@acme.io' },
  ]);
  crmDb.getLeadsByStatus = jest.fn().mockResolvedValue([]);
  crmDb.getLeadListById = jest.fn().mockResolvedValue({ listId: 'list-1', userId: 'user-123' });
  crmDb.canOrgMemberAccessList = jest.fn().mockResolvedValue(true);
  userDb.getUserById = jest.fn().mockResolvedValue({ userId: 'user-123', email: 'test@acme.io' });

  // dripSequenceDb too: `getSequence.mockResolvedValue(...)` (not ...Once) persists for
  // the rest of the file, so a test that swaps in a LinkedIn sequence silently changed
  // the channel every later test ran under.
  dripSequenceDb.listSequences.mockReset().mockResolvedValue([mockSequence]);
  dripSequenceDb.createSequence.mockReset().mockResolvedValue(mockSequence);
  dripSequenceDb.getSequence.mockReset().mockResolvedValue(mockSequence);
  dripSequenceDb.updateSequence.mockReset().mockResolvedValue({ ...mockSequence, name: 'Updated' });
  dripSequenceDb.deleteSequence.mockReset().mockResolvedValue(undefined);
  dripSequenceDb.listEnrollmentsForSequence.mockReset().mockResolvedValue([]);
  dripSequenceDb.getEnrollmentStats.mockReset().mockResolvedValue({ active: 0, completed: 0, exited: 0, unsubscribed: 0, bounced: 0, total: 0 });
  dripSequenceDb.bulkEnroll.mockReset().mockResolvedValue({ enrolled: 2, skipped: 0 });
  dripSequenceDb.exitEnrollment.mockReset().mockResolvedValue(undefined);
});

// ─── GET / — list sequences ───────────────────────────────────────────────────

describe('GET / - list sequences', () => {
  it('returns sequences for the authenticated user', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.sequences).toHaveLength(1);
    expect(res.body.sequences[0].sequenceId).toBe('seq_1');
  });

  it('returns empty array when user has no sequences', async () => {
    dripSequenceDb.listSequences.mockResolvedValueOnce([]);
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.sequences).toEqual([]);
  });

  it('returns 500 on db error', async () => {
    dripSequenceDb.listSequences.mockRejectedValueOnce(new Error('DB down'));
    const res = await request(app).get('/');
    expect(res.status).toBe(500);
  });
});

// ─── POST / — create sequence ─────────────────────────────────────────────────

describe('POST / - create sequence', () => {
  it('creates a sequence with valid name', async () => {
    const res = await request(app).post('/').send({ name: 'Free to Paid' });
    expect(res.status).toBe(201);
    expect(res.body.sequence.sequenceId).toBe('seq_1');
  });

  it('rejects missing name', async () => {
    const res = await request(app).post('/').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it('rejects empty string name', async () => {
    const res = await request(app).post('/').send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  describe('LinkedIn step account authorization (ENG-2205)', () => {
    const liStep = (linkedInAccountId?: unknown) => ({
      stepNumber: 1, name: 'DM', channel: 'linkedin', delayDays: 0, messageText: 'hi',
      ...(linkedInAccountId !== undefined ? { linkedInAccountId } : {}),
    });
    beforeEach(() => {
      mockResolveLinkedInAccountForWrite.mockReset();
      (dripSequenceDb.createSequence as jest.Mock).mockClear();
    });

    it('creates the sequence when the pinned account is the caller\'s own or org-shared', async () => {
      mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'user-123' });
      const res = await request(app).post('/').send({ name: 'Seq', steps: [liStep('my-acct')] });
      expect(res.status).toBe(201);
      expect(mockResolveLinkedInAccountForWrite).toHaveBeenCalledWith('user-123', 'my-acct');
    });

    it('refuses with 403 and stores nothing when a step names an account the caller does not own (e.g. the pool)', async () => {
      mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
      const res = await request(app).post('/').send({ name: 'Seq', steps: [liStep('pool-or-foreign-acct')] });
      expect(res.status).toBe(403);
      expect(dripSequenceDb.createSequence).not.toHaveBeenCalled();
    });

    it('refuses a non-string account id', async () => {
      const res = await request(app).post('/').send({ name: 'Seq', steps: [liStep({ $ne: null })] });
      expect(res.status).toBe(403);
      expect(dripSequenceDb.createSequence).not.toHaveBeenCalled();
    });

    it('does not run the check for auto-resolved steps (no pinned account), email steps, or no steps', async () => {
      for (const body of [
        { name: 'A', steps: [liStep()] },
        { name: 'B', steps: [liStep(''), { stepNumber: 2, name: 'Mail', delayDays: 1, subject: 's', bodyHtml: '<p>x</p>' }] },
        { name: 'C' },
      ]) {
        const res = await request(app).post('/').send(body);
        expect(res.status).toBe(201);
      }
      expect(mockResolveLinkedInAccountForWrite).not.toHaveBeenCalled();
    });

    it('PUT refuses with 403 and does not update when a step names a foreign account', async () => {
      mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
      (dripSequenceDb.updateSequence as jest.Mock).mockClear();
      const res = await request(app).put('/seq_1').send({ steps: [liStep('foreign-acct')] });
      expect(res.status).toBe(403);
      expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
    });

    it('PUT accepts an owned pinned account', async () => {
      mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'user-123' });
      const res = await request(app).put('/seq_1').send({ steps: [liStep('my-acct')] });
      expect(res.status).toBe(200);
    });

    // A pin already stored on the caller's own sequence must not block an unrelated edit just because the
    // account was disconnected since (it no longer resolves). Sending is still blocked: the drip worker
    // re-checks the pin at send time.
    describe('PUT with a pin already stored on the sequence', () => {
      const storedWith = (pin: string, userId = 'user-123') => ({
        ...mockSequence,
        userId,
        steps: [{ stepId: 's1', stepNumber: 1, name: 'DM', channel: 'linkedin', delayDays: 0, messageText: 'hi', linkedInAccountId: pin }],
      });

      it('saves an unrelated edit when the stored pin no longer resolves (account since disconnected)', async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
        dripSequenceDb.getSequence.mockResolvedValueOnce(storedWith('disconnected-acct'));
        (dripSequenceDb.updateSequence as jest.Mock).mockClear();
        const res = await request(app).put('/seq_1').send({ name: 'Renamed', steps: [liStep('disconnected-acct')] });
        expect(res.status).toBe(200);
        expect(dripSequenceDb.updateSequence).toHaveBeenCalled();
        expect(mockResolveLinkedInAccountForWrite).not.toHaveBeenCalled();
      });

      it('still refuses CHANGING a step to a different account the caller does not own', async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
        dripSequenceDb.getSequence.mockResolvedValueOnce(storedWith('disconnected-acct'));
        (dripSequenceDb.updateSequence as jest.Mock).mockClear();
        const res = await request(app).put('/seq_1').send({ steps: [liStep('pool-or-foreign-acct')] });
        expect(res.status).toBe(403);
        expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
      });

      it('does not trust pins stored on someone else\'s sequence', async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
        dripSequenceDb.getSequence.mockResolvedValueOnce(storedWith('pool-or-foreign-acct', 'other-user'));
        (dripSequenceDb.updateSequence as jest.Mock).mockClear();
        const res = await request(app).put('/seq_1').send({ steps: [liStep('pool-or-foreign-acct')] });
        expect(res.status).toBe(403);
        expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
      });

      it('PUT: a pin left on an EMAIL step (e.g. after switching a step to email) is inert - saving is not blocked', async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
        dripSequenceDb.getSequence.mockResolvedValueOnce({ ...mockSequence, userId: 'user-123', steps: [] });
        (dripSequenceDb.updateSequence as jest.Mock).mockClear();
        const emailStepWithStalePin = { stepNumber: 1, name: 'Mail', channel: 'email', delayDays: 0, subject: 's', bodyHtml: '<p>x</p>', linkedInAccountId: 'stale-disconnected-acct' };
        const res = await request(app).put('/seq_1').send({ steps: [emailStepWithStalePin] });
        expect(res.status).toBe(200);
        expect(mockResolveLinkedInAccountForWrite).not.toHaveBeenCalled();
        expect(dripSequenceDb.updateSequence).toHaveBeenCalled();
      });

      it('PUT: a pin stored on an EMAIL step is not trusted when that step is switched to LinkedIn', async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
        dripSequenceDb.getSequence.mockResolvedValueOnce({
          ...mockSequence, userId: 'user-123',
          steps: [{ stepId: 's1', stepNumber: 1, name: 'Mail', channel: 'email', delayDays: 0, subject: 's', bodyHtml: '<p>x</p>', linkedInAccountId: 'pool-or-foreign-acct' }],
        });
        (dripSequenceDb.updateSequence as jest.Mock).mockClear();
        const res = await request(app).put('/seq_1').send({ steps: [liStep('pool-or-foreign-acct')] });
        expect(res.status).toBe(403);
        expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
      });

      it('POST: a stale pin on an email step (e.g. a duplicated sequence) is accepted - the worker never uses it', async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
        (dripSequenceDb.createSequence as jest.Mock).mockClear();
        const res = await request(app).post('/').send({ name: 'Copy', steps: [{ stepNumber: 1, name: 'Mail', channel: 'email', delayDays: 0, subject: 's', bodyHtml: '<p>x</p>', linkedInAccountId: 'stale-disconnected-acct' }] });
        expect(res.status).toBe(201);
        expect(mockResolveLinkedInAccountForWrite).not.toHaveBeenCalled();
      });

      it('a channel written with odd casing/whitespace is still validated as LinkedIn (same normalisation as the worker)', async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
        (dripSequenceDb.createSequence as jest.Mock).mockClear();
        const res = await request(app).post('/').send({ name: 'Seq', steps: [{ stepNumber: 1, name: 'DM', channel: ' LinkedIn ', delayDays: 0, messageText: 'x', linkedInAccountId: 'pool-or-foreign-acct' }] });
        expect(res.status).toBe(403);
        expect(dripSequenceDb.createSequence).not.toHaveBeenCalled();
      });

      it('PUT: a transient read failure is a retryable 500, not a misleading 403 about the account', async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'user-123' });
        dripSequenceDb.getSequence.mockRejectedValueOnce(new Error('DynamoDB throttled'));
        (dripSequenceDb.updateSequence as jest.Mock).mockClear();
        const res = await request(app).put('/seq_1').send({ steps: [liStep('my-acct')] });
        expect(res.status).toBe(500);
        expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
      });

      it("with main's optimistic-concurrency guard: a foreign pin is refused (403) before any conflict check", async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
        (dripSequenceDb.updateSequence as jest.Mock).mockClear();
        const res = await request(app).put('/seq_1').send({ steps: [liStep('foreign-acct')], expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
        expect(res.status).toBe(403);
        expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
      });

      it("with main's optimistic-concurrency guard: an owned pin + stale expectedUpdatedAt still yields main's 409, and the guard is forwarded", async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue({ ownerUserId: 'user-123' });
        const conflict: any = new Error('Sequence seq_1 changed since it was read'); conflict.name = 'SequenceConflictError';
        (dripSequenceDb.updateSequence as jest.Mock).mockClear();
        (dripSequenceDb.updateSequence as jest.Mock).mockRejectedValueOnce(conflict);
        const res = await request(app).put('/seq_1').send({ steps: [liStep('my-acct')], expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('sequence_conflict');
        expect(dripSequenceDb.updateSequence).toHaveBeenCalledWith('seq_1', 'user-123', expect.anything(), { expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
      });

      it('POST stays strict: there is no stored pin to exempt', async () => {
        mockResolveLinkedInAccountForWrite.mockResolvedValue(null);
        (dripSequenceDb.createSequence as jest.Mock).mockClear();
        const res = await request(app).post('/').send({ name: 'Seq', steps: [liStep('disconnected-acct')] });
        expect(res.status).toBe(403);
        expect(dripSequenceDb.createSequence).not.toHaveBeenCalled();
      });
    });
  });

  it('passes through all optional fields', async () => {
    const res = await request(app).post('/').send({
      name: 'Onboarding',
      campaignType: 'onboarding',
      status: 'draft',
      steps: [{ stepNumber: 1, name: 'Welcome', delayDays: 0, subject: 'Hi', bodyHtml: '<p>Hi</p>' }],
    });
    expect(res.status).toBe(201);
    expect(dripSequenceDb.createSequence).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Onboarding', campaignType: 'onboarding' }),
    );
  });
});

// ─── GET /:sequenceId ─────────────────────────────────────────────────────────

describe('GET /:sequenceId - get sequence', () => {
  it('returns the sequence for its owner', async () => {
    const res = await request(app).get('/seq_1');
    expect(res.status).toBe(200);
    expect(res.body.sequence.sequenceId).toBe('seq_1');
  });

  it('returns 404 when sequence does not exist', async () => {
    dripSequenceDb.getSequence.mockResolvedValueOnce(null);
    const res = await request(app).get('/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns 403 when sequence belongs to another user', async () => {
    dripSequenceDb.getSequence.mockResolvedValueOnce({ ...mockSequence, userId: 'other-user' });
    const res = await request(app).get('/seq_1');
    expect(res.status).toBe(403);
  });
});

// ─── PUT /:sequenceId ─────────────────────────────────────────────────────────

describe('PUT /:sequenceId - update sequence', () => {
  it('updates sequence name', async () => {
    const res = await request(app).put('/seq_1').send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.sequence.name).toBe('Updated');
  });

  it('returns 404 when sequence not found', async () => {
    dripSequenceDb.updateSequence.mockRejectedValueOnce(new SequenceNotFoundError('seq_1'));
    const res = await request(app).put('/seq_1').send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('returns 403 on auth error', async () => {
    dripSequenceDb.updateSequence.mockRejectedValueOnce(new SequenceAuthError());
    const res = await request(app).put('/seq_1').send({ name: 'X' });
    expect(res.status).toBe(403);
  });
});

// ─── DELETE /:sequenceId ──────────────────────────────────────────────────────

describe('DELETE /:sequenceId - delete sequence', () => {
  it('deletes the sequence', async () => {
    const res = await request(app).delete('/seq_1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 404 when sequence not found', async () => {
    dripSequenceDb.deleteSequence.mockRejectedValueOnce(new SequenceNotFoundError('seq_1'));
    const res = await request(app).delete('/seq_1');
    expect(res.status).toBe(404);
  });
});

// ─── POST /:sequenceId/enrollments — bulk enroll ──────────────────────────────

describe('POST /:sequenceId/enrollments - bulk enroll', () => {
  it('enrolls provided leads', async () => {
    const res = await request(app)
      .post('/seq_1/enrollments')
      .send({
        leads: [
          { listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@acme.io' },
          { listId: 'list-1', leadId: 'lead-2', leadEmail: 'b@acme.io' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(2);
    expect(res.body.skipped).toBe(0);
  });

  // ENG-2083: leadEmail is the leadEmail-index partition key AND what the worker passes to
  // sendAsSender. An address-less enrollment therefore retries forever and stays invisible
  // to getActiveEnrollment. This route takes an explicit array, so the rows are dropped from
  // the enrol call and the count is REPORTED rather than silently swallowed.
  // The address-less rows are lead-2 and lead-3 in the CRM fixture above; the route reads
  // the row, not the payload, so that is where the fact now lives.
  it('drops address-less leads from the enrol call and reports the count', async () => {
    const res = await request(app)
      .post('/seq_1/enrollments')
      .send({
        leads: [
          { listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@acme.io' },
          { listId: 'list-1', leadId: 'lead-2' },
          { listId: 'list-1', leadId: 'lead-3', leadEmail: '' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.skippedNoEmail).toBe(2);
    const enrolled = dripSequenceDb.bulkEnroll.mock.calls.at(-1)![0];
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0].leadId).toBe('lead-1');
  });

  it('omits skippedNoEmail when every lead has an address', async () => {
    const res = await request(app)
      .post('/seq_1/enrollments')
      .send({ leads: [{ listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@acme.io' }] });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('skippedNoEmail');
  });

  it('rejects empty leads array', async () => {
    const res = await request(app).post('/seq_1/enrollments').send({ leads: [] });
    expect(res.status).toBe(400);
  });

  it('rejects missing leads field', async () => {
    const res = await request(app).post('/seq_1/enrollments').send({});
    expect(res.status).toBe(400);
  });

  it('rejects enrollment into sequence with no steps', async () => {
    dripSequenceDb.getSequence.mockResolvedValueOnce({ ...mockSequence, steps: [] });
    const res = await request(app)
      .post('/seq_1/enrollments')
      .send({ leads: [{ listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@acme.io' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no steps/i);
  });

  it('returns 403 when sequence belongs to another user', async () => {
    dripSequenceDb.getSequence.mockResolvedValueOnce({ ...mockSequence, userId: 'other-user' });
    const res = await request(app)
      .post('/seq_1/enrollments')
      .send({ leads: [{ listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@acme.io' }] });
    expect(res.status).toBe(403);
  });

  /*
   * Review round 3, finding 15. The candidate mechanism (bulkEnroll's lookup loop) was
   * mutation-tested; this call site's WIRING was not — deleting `identityCandidates:`
   * here left every test green. Assert the value reaching bulkEnroll directly.
   */
  it('passes identityCandidates through to bulkEnroll', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadById = jest.fn().mockResolvedValue({
      leadId: 'lead-1', email: 'a@acme.io', linkedin: 'https://linkedin.com/in/ada',
    });

    await request(app)
      .post('/seq_1/enrollments')
      .send({ leads: [{ listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@acme.io' }] });

    const input = dripSequenceDb.bulkEnroll.mock.calls.at(-1)![0][0];
    expect(input.identityCandidates).toEqual(
      expect.arrayContaining(['a@acme.io', 'https://www.linkedin.com/in/ada/']),
    );
  });
});

// ─── GET /:sequenceId/enrollments ─────────────────────────────────────────────

describe('GET /:sequenceId/enrollments - list enrollments', () => {
  it('returns enrollments and stats', async () => {
    const res = await request(app).get('/seq_1/enrollments');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.enrollments)).toBe(true);
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.total).toBe(0);
  });

  it('returns 404 for unknown sequence', async () => {
    dripSequenceDb.getSequence.mockResolvedValueOnce(null);
    const res = await request(app).get('/unknown/enrollments');
    expect(res.status).toBe(404);
  });
});

// ─── POST /:sequenceId/enrollments/by-list — auto-enroll list wiring ──────────

describe('POST /:sequenceId/enrollments/by-list - auto-enroll wiring', () => {
  beforeEach(() => {
    // Reset updateSequence mock to default (returns updated sequence)
    dripSequenceDb.updateSequence.mockResolvedValue({ ...mockSequence, autoEnrollListIds: ['list-1'] });
  });

  it('sets autoEnrollListIds on the sequence after by-list enrollment', async () => {
    // Simulate sequence without autoEnrollListIds yet
    dripSequenceDb.getSequence.mockResolvedValueOnce({ ...mockSequence, autoEnrollListIds: undefined });

    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'lead-1', email: 'a@acme.io' },
    ]);

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1' });

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(2); // bulkEnroll mock returns 2

    // updateSequence should have been called to add listId to autoEnrollListIds
    // (called fire-and-forget, so we wait a tick)
    await new Promise((r) => setTimeout(r, 10));
    expect(dripSequenceDb.updateSequence).toHaveBeenCalledWith(
      'seq_1',
      'user-123',
      expect.objectContaining({ autoEnrollListIds: ['list-1'] }),
    );
  });

  // ENG-2083: the filter that drops address-less leads used to live at the mapper, so
  // leadCount reported the whole list and then a smaller number was enrolled. Hoisting it
  // made leadCount truthful but silent — a 100-lead list would report 20 with nothing
  // saying where 80 went, which reads as leads having vanished. Report both.
  it('reports the full population AND the enrollable subset', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'lead-1', email: 'a@acme.io' },
      { leadId: 'lead-2' },
      { leadId: 'lead-3', email: '' },
      { leadId: 'lead-4', email: 'd@acme.io' },
    ]);

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1' });

    expect(res.status).toBe(200);
    expect(res.body.totalLeads).toBe(4);
    expect(res.body.enrollableLeads).toBe(2);
    expect(res.body.skippedNoEmail).toBe(2);
    // and only the addressable ones actually went to bulkEnroll
    const inputs = dripSequenceDb.bulkEnroll.mock.calls.at(-1)![0];
    expect(inputs.map((i: any) => i.leadId)).toEqual(['lead-1', 'lead-4']);
  });

  it('omits skippedNoEmail when every lead is addressable', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'lead-1', email: 'a@acme.io' },
    ]);

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1' });

    expect(res.body.totalLeads).toBe(1);
    expect(res.body.enrollableLeads).toBe(1);
    expect(res.body).not.toHaveProperty('skippedNoEmail');
  });

  // ENG-2083: verify-variables counted a different population than enroll-by-list, so the
  // same list produced contradictory numbers on two screens — and coverage warnings could
  // be raised over leads that were never enrolment candidates.
  it('verify-variables counts the same population enrol-by-list will actually enrol', async () => {
    const crmDbMock = require('../services/db').crmDb;
    // getAllLeadsByListId now, matching the route. The previous version mocked
    // getLeadsByListId — the single-~1MB-page loader — so the test's own title
    // ("same population enrol-by-list will actually enrol") was false for any list
    // over one page: the two screens read different loaders.
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'l1', email: 'a@acme.io', firstName: 'Ann' },
      { leadId: 'l2', firstName: 'Ben' },
      { leadId: 'l3', email: '', firstName: 'Cal' },
    ]);

    const res = await request(app)
      .post('/seq_1/steps/verify-variables')
      .send({ listId: 'list-1', subject: 'Hi {{firstName}}', htmlContent: '' });

    expect(res.status).toBe(200);
    expect(res.body.leadCount).toBe(1);
    expect(res.body.totalLeads).toBe(3);
    expect(res.body.skippedNoEmail).toBe(2);
    // and coverage describes only the enrollable lead
    expect(res.body.variableCoverage.firstName).toEqual({ present: 1, missing: 0 });
  });

  // ENG-2127: lifecycle is derived state. Lifecycle-only filters read complete lead
  // rows and compute the stage rather than querying the status index.
  it('derives lifecycle and does not enable unfiltered future auto-enroll', async () => {
    dripSequenceDb.getSequence.mockResolvedValueOnce({
      ...mockSequence,
      autoEnrollListIds: undefined,
    });
    dripSequenceDb.updateSequence.mockClear();
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'inbox-1', email: 'a@acme.io' },
      { leadId: 'unknown-1', company: 'No contact channel' },
    ]);

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'inbox' });

    expect(res.status).toBe(200);
    expect(crmDbMock.getLeadsByStatus).not.toHaveBeenCalled();
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalledWith([
      expect.objectContaining({ leadId: 'inbox-1', leadEmail: 'a@acme.io' }),
    ]);
    await new Promise((r) => setTimeout(r, 10));
    expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
  });

  it('preserves lifecycle-shaped values that are real list statuses', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadListById = jest.fn().mockResolvedValue({
      listId: 'list-1',
      userId: 'user-123',
      statusConfig: [
        { value: 'active', label: 'Active', color: 'green', type: 'active' },
        { value: 'churned', label: 'Churned', color: 'orange', type: 'churned' },
      ],
    });
    crmDbMock.canOrgMemberAccessList = jest.fn().mockResolvedValue(true);
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'churned' });

    expect(res.status).toBe(200);
    expect(crmDbMock.getLeadsByStatus).toHaveBeenCalledWith('list-1', 'churned', 200, undefined);
  });

  it('uses default status vocabulary when statusConfig is absent', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadListById = jest.fn().mockResolvedValue({
      listId: 'list-1',
      userId: 'user-123',
    });
    crmDbMock.canOrgMemberAccessList = jest.fn().mockResolvedValue(true);
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'churned' });

    expect(res.status).toBe(200);
    expect(crmDbMock.getLeadsByStatus).toHaveBeenCalledWith('list-1', 'churned', 200, undefined);
  });

  it('derives a lifecycle-only stage when it is not a status for this list type', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadListById = jest.fn().mockResolvedValue({
      listId: 'list-1',
      userId: 'user-123',
    });
    crmDbMock.canOrgMemberAccessList = jest.fn().mockResolvedValue(true);
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      {
        leadId: 'risk-1',
        email: 'risk@acme.io',
        lifecycle: 'paying',
        subscriptionState: 'past_due',
      },
    ]);

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'at_risk' });

    expect(res.status).toBe(200);
    expect(crmDbMock.getLeadsByStatus).not.toHaveBeenCalled();
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalledWith([
      expect.objectContaining({ leadId: 'risk-1' }),
    ]);

    crmDbMock.getLeadListById = jest.fn().mockResolvedValue({
      listId: 'list-1',
      userId: 'user-123',
      listType: 'customers',
    });
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });
    const customers = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'at_risk' });

    expect(customers.status).toBe(200);
    expect(crmDbMock.getLeadsByStatus).toHaveBeenCalledWith('list-1', 'at_risk', 200, undefined);
  });

  it('does not demote a stored paying customer to in_deal from an open deal alone', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      {
        leadId: 'paying-with-deal',
        email: 'paying@acme.io',
        lifecycle: 'paying',
        openDealStages: ['Negotiation'],
      },
      {
        leadId: 'inbox-with-deal',
        email: 'inbox@acme.io',
        lifecycle: 'inbox',
        openDealStages: ['Negotiation'],
      },
    ]);

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'in_deal' });

    expect(res.status).toBe(200);
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalledWith([
      expect.objectContaining({ leadId: 'inbox-with-deal' }),
    ]);
  });

  it('lets stale activity and usage advance stored customer lifecycle', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadListById = jest.fn().mockResolvedValue({
      listId: 'list-1',
      userId: 'user-123',
      statusConfig: [{ value: 'active', label: 'Active', color: 'green', type: 'active' }],
    });
    crmDbMock.canOrgMemberAccessList = jest.fn().mockResolvedValue(true);
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });
    crmDbMock.getAllLeadsByListId = jest.fn()
      .mockResolvedValueOnce([
        {
          leadId: 'stale-activity',
          email: 'churn@acme.io',
          lifecycle: 'paying',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          leadId: 'stale-usage',
          email: 'risk@acme.io',
          lifecycle: 'paying',
          lastUsageAt: '2026-01-01T00:00:00.000Z',
        },
      ]);

    const churned = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'churned' });
    expect(churned.status).toBe(200);
    expect(crmDbMock.getLeadsByStatus).not.toHaveBeenCalled();
    expect(dripSequenceDb.bulkEnroll).toHaveBeenLastCalledWith([
      expect.objectContaining({ leadId: 'stale-activity' }),
    ]);

    const atRisk = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'at_risk' });
    expect(atRisk.status).toBe(200);
    expect(dripSequenceDb.bulkEnroll).toHaveBeenLastCalledWith([
      expect.objectContaining({ leadId: 'stale-usage' }),
    ]);
  });

  it('rejects an unknown lifecycle typo when no legacy status rows match', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'inbxo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_lifecycle');
    expect(crmDbMock.getLeadsByStatus).toHaveBeenCalledWith('list-1', 'inbxo', 200, undefined);
  });

  it('preserves a removed legacy status when real lead rows still carry it', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadListById = jest.fn().mockResolvedValue({
      listId: 'list-1',
      userId: 'user-123',
      statusConfig: [
        { value: 'active', label: 'Active', color: 'green', type: 'active' },
      ],
    });
    crmDbMock.canOrgMemberAccessList = jest.fn().mockResolvedValue(true);
    const legacyLastKey = { listId: 'list-1', status: 'retired_stage', leadId: 'legacy-1' };
    crmDbMock.getLeadsByStatus = jest.fn()
      .mockResolvedValueOnce({
        items: [{ leadId: 'legacy-1', email: 'legacy@acme.io', status: 'retired_stage' }],
        lastEvaluatedKey: legacyLastKey,
      })
      .mockResolvedValueOnce({
        items: [{ leadId: 'legacy-2', email: 'legacy2@acme.io', status: 'retired_stage' }],
        lastEvaluatedKey: null,
      });

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'retired_stage' });

    expect(res.status).toBe(200);
    expect(crmDbMock.getLeadsByStatus).toHaveBeenCalledTimes(2);
    expect(crmDbMock.getLeadsByStatus).toHaveBeenNthCalledWith(
      1,
      'list-1',
      'retired_stage',
      200,
      undefined,
    );
    expect(crmDbMock.getLeadsByStatus).toHaveBeenNthCalledWith(
      2,
      'list-1',
      'retired_stage',
      200,
      legacyLastKey,
    );
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalledWith([
      expect.objectContaining({ leadId: 'legacy-1' }),
      expect.objectContaining({ leadId: 'legacy-2' }),
    ]);
  });

  it('accepts an explicit custom status without overloading lifecycle', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({
      items: [{ leadId: 'l1', email: 'a@example.com' }],
    });

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', status: 'custom_pipeline_stage' });

    expect(res.status).toBe(200);
    expect(crmDbMock.getLeadsByStatus).toHaveBeenCalledWith(
      'list-1',
      'custom_pipeline_stage',
      200,
      undefined,
    );
  });

  // My own regression, found by Manan questioning the "sequences are email-only" claim.
  // SequenceChannel is 'email' | 'linkedin', and dripSequenceWorker's sendLinkedInStep
  // loads the lead by leadId and reaches it through lead.linkedin — it never touches the
  // address. So a LinkedIn-only lead in a LinkedIn sequence WAS being messaged, and an
  // `l.email` enrollability test silently removed that capability.
  describe('channel-aware enrollability', () => {
    const linkedInSequence = {
      ...mockSequence,
      steps: [{ stepId: 's1', stepNumber: 1, name: 'invite', delayDays: 0,
                channel: 'linkedin', messageText: 'hi {{firstName}}' }],
    };

    it('enrols a LinkedIn-only lead into a LinkedIn sequence', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(linkedInSequence);
      const crmDbMock = require('../services/db').crmDb;
      crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
        { leadId: 'l1', listId: 'list-1', linkedin: 'https://linkedin.com/in/ada', firstName: 'Ada' },
      ]);

      const res = await request(app)
        .post('/seq_1/enrollments/by-list')
        .send({ listId: 'list-1' });

      expect(res.status).toBe(200);
      expect(res.body.enrollableLeads).toBe(1);
      expect(dripSequenceDb.bulkEnroll).toHaveBeenCalled();
      // The dedup key must be populated or getExistingEnrollment cannot see the row and
      // it is re-created — and the lead re-messaged — on every run.
      const input = dripSequenceDb.bulkEnroll.mock.calls[0][0][0];
      // Canonical, not raw: leadEmail is the partition key of leadEmail-index, so two
      // spellings of one profile would be two identities and the sequence would be
      // delivered twice.
      expect(input.leadEmail).toBe('https://www.linkedin.com/in/ada/');
    });

    // A live run reported `skippedNoEmail: 1` for a lead skipped because it had no
    // LinkedIn profile. The count was right and the word was a lie.
    it('names the skip reason after the channel that was actually missing', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(linkedInSequence);
      const crmDbMock = require('../services/db').crmDb;
      crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
        { leadId: 'l1', listId: 'list-1', email: 'a@x.com' },
        { leadId: 'l2', listId: 'list-1', linkedin: 'https://linkedin.com/in/b' },
      ]);

      const res = await request(app)
        .post('/seq_1/enrollments/by-list')
        .send({ listId: 'list-1' });

      expect(res.status).toBe(200);
      expect(res.body.enrollableLeads).toBe(1);
      expect(res.body.skippedUnreachable).toBe(1);
      expect(res.body.skippedNoEmail).toBeUndefined();
    });

    it('still refuses an address-less lead for an EMAIL sequence', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(mockSequence);
      const crmDbMock = require('../services/db').crmDb;
      crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
        { leadId: 'l1', listId: 'list-1', linkedin: 'https://linkedin.com/in/ada' },
      ]);

      const res = await request(app)
        .post('/seq_1/enrollments/by-list')
        .send({ listId: 'list-1' });

      expect(res.status).toBe(200);
      expect(res.body.enrollableLeads).toBe(0);
      expect(res.body.skippedNoEmail).toBe(1);
    });

    it('a MIXED sequence enrols anyone reachable on at least one of its channels', async () => {
      dripSequenceDb.getSequence.mockResolvedValue({
        ...mockSequence,
        steps: [
          { stepId: 's1', stepNumber: 1, name: 'mail', delayDays: 0, subject: 'x', bodyHtml: 'y' },
          { stepId: 's2', stepNumber: 2, name: 'invite', delayDays: 1, channel: 'linkedin', messageText: 'z' },
        ],
      });
      const crmDbMock = require('../services/db').crmDb;
      crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
        { leadId: 'both', listId: 'list-1', email: 'a@x.com', linkedin: 'https://linkedin.com/in/a' },
        { leadId: 'mail-only', listId: 'list-1', email: 'b@x.com' },
        { leadId: 'li-only', listId: 'list-1', linkedin: 'https://linkedin.com/in/c' },
      ]);

      const res = await request(app)
        .post('/seq_1/enrollments/by-list')
        .send({ listId: 'list-1' });

      expect(res.status).toBe(200);
      // All three. Requiring EVERY channel was the first answer and it cost a real send:
      // the email-only lead stopped being enrolled at all, where before it received the
      // email. The worker skips a step the lead cannot receive now, so each of these gets
      // the steps it can and completes.
      expect(res.body.enrollableLeads).toBe(3);
      const ids = dripSequenceDb.bulkEnroll.mock.calls[0][0].map((i: any) => i.leadId);
      expect(ids.sort()).toEqual(['both', 'li-only', 'mail-only']);
    });

    // B1: this route's payload is { listId, leadId, leadEmail } — `linkedin` was never
    // part of its contract. Reading it from the body made every lead look unreachable to
    // a LinkedIn sequence, so the route enrolled NOBODY: the same regression the
    // channel-aware guard was written to fix, on the sibling route.
    it('the EXPLICIT enroll route resolves the lead from the CRM, not the request body', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(linkedInSequence);
      const crmDbMock = require('../services/db').crmDb;
      // mockResolvedValueOnce on the SHARED mock rather than replacing it: a bare
      // reassignment persists for every later test in the file, because clearMocks does
      // not restore implementations.
      (crmDbMock.getLeadById as jest.Mock).mockResolvedValueOnce({
        leadId: 'lead-1', linkedin: 'https://linkedin.com/in/ada',
      });

      const res = await request(app)
        .post('/seq_1/enrollments')
        // exactly the payload the route's own contract defines — no `linkedin`
        .send({ leads: [{ listId: 'list-1', leadId: 'lead-1', leadEmail: '' }] });

      expect(res.status).toBe(200);
      expect(dripSequenceDb.bulkEnroll).toHaveBeenCalled();
      const input = dripSequenceDb.bulkEnroll.mock.calls[0][0][0];
      // Canonical, not raw: leadEmail is the partition key of leadEmail-index, so two
      // spellings of one profile would be two identities and the sequence would be
      // delivered twice.
      expect(input.leadEmail).toBe('https://www.linkedin.com/in/ada/');
      expect(res.body.skippedUnreachable).toBeUndefined();
    });

    it('the explicit route still enrols when the CRM lookup fails, using the payload', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(mockSequence);
      const crmDbMock = require('../services/db').crmDb;
      (crmDbMock.getLeadById as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB unavailable'));

      const res = await request(app)
        .post('/seq_1/enrollments')
        .send({ leads: [{ listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@acme.io' }] });

      expect(res.status).toBe(200);
      expect(dripSequenceDb.bulkEnroll).toHaveBeenCalled();
      expect(dripSequenceDb.bulkEnroll.mock.calls[0][0][0].leadEmail).toBe('a@acme.io');
    });

    // Review 5, finding 9. Nothing validates `step.channel` on create/update, so a
    // mis-cased value is storable. Under the old every-channel rule it failed OPEN
    // (matched no branch, everyone enrolled, the worker delivered them as email);
    // at-least-one inverted that to failing CLOSED — nobody enrolled, while the worker
    // would have sent fine.
    // Review 5, finding 6. f9ed770cc fixed three of FOUR emitting sites; verify-variables
    // still hardcoded the key, so it reported `skippedNoEmail` about a lead that HAS one.
    it('verify-variables names the skip reason after the channel too', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(linkedInSequence);
      const crmDbMock = require('../services/db').crmDb;
      // getAllLeadsByListId, NOT getLeadsByListId — the route paginates. Mocking the
      // single-page loader left this test reading whatever fixture the PREVIOUS test
      // had assigned, so it passed in file order and failed under -t and --randomize.
      // Same defect as two tests above; only that instance was repaired.
      crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
        { leadId: 'l1', listId: 'list-1', email: 'a@x.com' },
        { leadId: 'l2', listId: 'list-1', linkedin: 'https://linkedin.com/in/b' },
      ]);

      const res = await request(app)
        .post('/seq_1/steps/verify-variables')
        .send({ listId: 'list-1', subject: 'Hi {{firstName}}', htmlContent: '' });

      expect(res.status).toBe(200);
      expect(res.body.skippedUnreachable).toBe(1);
      expect(res.body.skippedNoEmail).toBeUndefined();
    });

    it('a mis-cased channel does not silently empty the enrolment', async () => {
      dripSequenceDb.getSequence.mockResolvedValue({
        ...mockSequence,
        steps: [{ stepId: 's1', stepNumber: 1, name: 'Mail', delayDays: 0,
                  channel: 'Email', subject: 'x', bodyHtml: 'y' }],
      });
      const crmDbMock = require('../services/db').crmDb;
      crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
        { leadId: 'l1', listId: 'list-1', email: 'a@x.com' },
        { leadId: 'l2', listId: 'list-1', email: 'b@x.com' },
      ]);

      const res = await request(app)
        .post('/seq_1/enrollments/by-list')
        .send({ listId: 'list-1' });

      expect(res.status).toBe(200);
      expect(res.body.enrollableLeads).toBe(2);
    });

    it('still refuses a lead reachable on NO channel of the sequence', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(linkedInSequence);
      const crmDbMock = require('../services/db').crmDb;
      crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
        { leadId: 'phone-only', listId: 'list-1', phone: '2125550000' },
      ]);

      const res = await request(app)
        .post('/seq_1/enrollments/by-list')
        .send({ listId: 'list-1' });

      expect(res.status).toBe(200);
      // Enrolling it would create a row that skips every step and completes having sent
      // nothing at all.
      expect(res.body.enrollableLeads).toBe(0);
      expect(res.body.skippedUnreachable).toBe(1);
    });
  });

  it('still enrols normally when a derived lifecycle filter returns leads', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'l1', email: 'a@acme.io' },
    ]);

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'inbox' });

    expect(res.status).toBe(200);
    expect(crmDbMock.getLeadsByStatus).not.toHaveBeenCalled();
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalled();
  });

  // A real lead STATUS is a legitimate filter and must keep working, including when the
  // list genuinely has none of them.
  it('leaves a real status filter alone, even when it matches nothing', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'qualified' });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });

  it('does not call updateSequence again if listId is already in autoEnrollListIds', async () => {
    dripSequenceDb.getSequence.mockResolvedValueOnce({
      ...mockSequence,
      autoEnrollListIds: ['list-1'],
    });
    dripSequenceDb.updateSequence.mockClear();

    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([]);

    await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });
    await new Promise((r) => setTimeout(r, 10));

    expect(dripSequenceDb.updateSequence).not.toHaveBeenCalled();
  });

  it('rejects missing listId', async () => {
    const res = await request(app).post('/seq_1/enrollments/by-list').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/listId/i);
  });
});

// ─── PUT /:sequenceId — autoEnrollListIds passthrough ─────────────────────────

describe('PUT /:sequenceId - autoEnrollListIds', () => {
  it('passes autoEnrollListIds to updateSequence', async () => {
    const res = await request(app)
      .put('/seq_1')
      .send({ autoEnrollListIds: ['list-1', 'list-2'] });
    expect(res.status).toBe(200);
    expect(dripSequenceDb.updateSequence).toHaveBeenCalledWith(
      'seq_1',
      'user-123',
      expect.objectContaining({ autoEnrollListIds: ['list-1', 'list-2'] }),
    );
  });

  it('passes null autoEnrollListIds to disable auto-enroll', async () => {
    const res = await request(app)
      .put('/seq_1')
      .send({ autoEnrollListIds: null });
    expect(res.status).toBe(200);
    expect(dripSequenceDb.updateSequence).toHaveBeenCalledWith(
      'seq_1',
      'user-123',
      expect.objectContaining({ autoEnrollListIds: null }),
    );
  });
});

// ─── POST /:sequenceId/steps/test-email — ENG-266 Part 3 sender routing ───────

describe('POST /:sequenceId/steps/test-email', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (settingsService.getSetting as jest.Mock).mockResolvedValue(undefined);
  });

  const validBody = {
    senderEmail: 'me@test.com',
    senderName: 'Me',
    subject: 'Hi',
    htmlContent: '<p>hi</p>',
    recipients: ['a@acme.io'],
  };

  describe('FAIL cases', () => {
    it('returns 400 if required fields are missing', async () => {
      const res = await request(app).post('/seq_1/steps/test-email').send({ subject: 'Hi' });
      expect(res.status).toBe(400);
    });

    it('returns 400 if no valid recipient emails are provided', async () => {
      const res = await request(app)
        .post('/seq_1/steps/test-email')
        .send({ ...validBody, recipients: ['not-an-email'] });
      expect(res.status).toBe(400);
    });

    it('counts a thrown send as failed instead of crashing the request', async () => {
      (resendService.sendEmail as jest.Mock).mockRejectedValue(new Error('resend down'));
      const res = await request(app).post('/seq_1/steps/test-email').send(validBody);
      expect(res.status).toBe(200);
      expect(res.body.failed).toBe(1);
      expect(res.body.sent).toBe(0);
    });
  });

  describe('SUCCESS cases', () => {
    it('sends via Resend for an unconfigured/ad-hoc sender, unchanged from before', async () => {
      (resendService.sendEmail as jest.Mock).mockResolvedValue({ id: 'msg-1' });
      const res = await request(app).post('/seq_1/steps/test-email').send(validBody);

      expect(resendService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'Me <me@test.com>',
          to: 'a@acme.io',
          subject: '[TEST] Hi',
        }),
      );
      expect(res.body.sent).toBe(1);
    });

    it('ENG-266 Part 3: routes a mailbox (outlook) sender through its real provider instead of refusing it', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify({
          senders: [{ id: 'ol-1', email: 'hunter@baldwin.com', fromName: 'Hunter', senderType: 'outlook', connectedAccountId: 'acct-1' }],
        }),
      });
      mockGetEmailProvider.mockReturnValue({
        sendEmail: jest.fn().mockResolvedValue({ messageId: 'ol-msg-1', threadId: '' }),
      });

      const res = await request(app).post('/seq_1/steps/test-email').send({
        senderId: 'ol-1',
        senderEmail: 'hunter@baldwin.com',
        senderName: 'Hunter',
        subject: 'Hi',
        htmlContent: '<p>hi</p>',
        recipients: ['a@acme.io'],
      });

      expect(resendService.sendEmail).not.toHaveBeenCalled();
      expect(mockGetEmailProvider).toHaveBeenCalledWith('outlook');
      expect(res.body.sent).toBe(1);
    });
  });
});

/*
 * Cross-tenant authorization.
 *
 * Two routes read CRM rows addressed entirely by ids from the request body/path. A
 * review found (a) the explicit-enroll fix had NO regression guard — deleting the whole
 * auth block left 71/71 green — and (b) verify-variables had no authorization at all,
 * returning another tenant's totalLeads, per-variable coverage, and a skip-reason key
 * whose name leaks whether their sequence has a LinkedIn step.
 *
 * The deny path was unexercised repo-wide because the harness mocks
 * canOrgMemberAccessList -> true unconditionally. These drive it false.
 */
describe('cross-tenant authorization', () => {
  const crmDbMock = require('../services/db').crmDb;
  const seqDbMock = require('../services/dripSequenceDb').dripSequenceDb ?? dripSequenceDb;

  afterEach(() => {
    crmDbMock.canOrgMemberAccessList.mockResolvedValue(true);
    crmDbMock.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-123' });
  });

  describe('POST /:sequenceId/enrollments (explicit)', () => {
    it('refuses the whole call when a listId is not accessible, and reads no lead', async () => {
      crmDbMock.canOrgMemberAccessList.mockResolvedValue(false);
      (crmDbMock.getLeadById as jest.Mock).mockClear();

      const res = await request(app)
        .post('/seq_1/enrollments')
        .send({ leads: [{ listId: 'other-tenant-list', leadId: 'victim-lead', leadEmail: '' }] });

      expect(res.status).toBe(403);
      // The oracle this closes: a skipped-count difference would reveal whether the
      // victim's lead exists or has an email. Nothing may be read at all.
      expect(crmDbMock.getLeadById).not.toHaveBeenCalled();
      expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
    });

    it('refuses the WHOLE call when only one of several lists is inaccessible', async () => {
      crmDbMock.canOrgMemberAccessList
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      (crmDbMock.getLeadById as jest.Mock).mockClear();

      const res = await request(app).post('/seq_1/enrollments').send({
        leads: [
          { listId: 'list-1', leadId: 'mine', leadEmail: 'a@x.com' },
          { listId: 'other-tenant-list', leadId: 'theirs', leadEmail: '' },
        ],
      });

      // Partial success is indistinguishable from "that lead was unreachable" — the
      // same oracle, wearing a 200.
      expect(res.status).toBe(403);
      expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
    });

    it('a missing list is refused, not treated as accessible', async () => {
      crmDbMock.getLeadListById.mockResolvedValue(null);
      const res = await request(app)
        .post('/seq_1/enrollments')
        .send({ leads: [{ listId: 'nope', leadId: 'l', leadEmail: 'a@x.com' }] });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /:sequenceId/steps/verify-variables', () => {
    it('refuses a sequence owned by another tenant, and reads no leads', async () => {
      dripSequenceDb.getSequence.mockResolvedValue({ ...mockSequence, userId: 'someone-else' });
      (crmDbMock.getLeadsByListId as jest.Mock).mockClear();

      const res = await request(app)
        .post('/seq_1/steps/verify-variables')
        .send({ listId: 'list-1', subject: 'Hi {{firstName}}', htmlContent: '' });

      expect(res.status).toBe(403);
      expect(crmDbMock.getLeadsByListId).not.toHaveBeenCalled();
    });

    it('refuses a list the caller cannot access, and reads no leads', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(mockSequence);
      crmDbMock.canOrgMemberAccessList.mockResolvedValue(false);
      (crmDbMock.getLeadsByListId as jest.Mock).mockClear();

      const res = await request(app)
        .post('/seq_1/steps/verify-variables')
        .send({ listId: 'other-tenant-list', subject: 'Hi {{firstName}}', htmlContent: '' });

      expect(res.status).toBe(403);
      expect(crmDbMock.getLeadsByListId).not.toHaveBeenCalled();
    });

    it('404s an unknown sequence rather than reading anything', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(null);
      (crmDbMock.getLeadsByListId as jest.Mock).mockClear();

      const res = await request(app)
        .post('/seq_1/steps/verify-variables')
        .send({ listId: 'list-1', subject: 'Hi', htmlContent: '' });

      expect(res.status).toBe(404);
      expect(crmDbMock.getLeadsByListId).not.toHaveBeenCalled();
    });

    /*
     * Review round 2, finding 7. Every cross-tenant test above passes a `listId`, so
     * only the LIST branch was exercised — scoping the sequence check to
     * `hasSequence && listId` left the ELSE branch (the sequence's own enrollments, and
     * a getLeadById per enrolled lead) completely unauthorised and 80/80 still passed.
     * That branch is the worst leak the route had: it returns another tenant's lead
     * rows, not just counts.
     */
    it('403s the enrollments branch (no listId) for someone else\'s sequence', async () => {
      dripSequenceDb.getSequence.mockResolvedValue({ ...mockSequence, userId: 'someone-else' });
      dripSequenceDb.listEnrollmentsForSequence.mockClear();
      (crmDbMock.getLeadById as jest.Mock).mockClear();

      const res = await request(app)
        .post('/seq_1/steps/verify-variables')
        .send({ subject: 'Hi {{firstName}}', htmlContent: '' });

      expect(res.status).toBe(403);
      expect(dripSequenceDb.listEnrollmentsForSequence).not.toHaveBeenCalled();
      expect(crmDbMock.getLeadById).not.toHaveBeenCalled();
    });

    it('404s the enrollments branch (no listId) for a sequence that does not exist', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(null);
      dripSequenceDb.listEnrollmentsForSequence.mockClear();

      const res = await request(app)
        .post('/seq_1/steps/verify-variables')
        .send({ subject: 'Hi', htmlContent: '' });

      expect(res.status).toBe(404);
      expect(dripSequenceDb.listEnrollmentsForSequence).not.toHaveBeenCalled();
    });

    it('reads the enrollments branch for the OWNER', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(mockSequence);
      dripSequenceDb.listEnrollmentsForSequence.mockResolvedValue([
        { listId: 'list-1', leadId: 'lead-1' },
      ]);

      const res = await request(app)
        .post('/seq_1/steps/verify-variables')
        .send({ subject: 'Hi {{firstName}}', htmlContent: '' });

      expect(res.status).toBe(200);
      expect(dripSequenceDb.listEnrollmentsForSequence).toHaveBeenCalledWith('seq_1');
    });

    it('still works for the owner', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(mockSequence);
      const res = await request(app)
        .post('/seq_1/steps/verify-variables')
        .send({ listId: 'list-1', subject: 'Hi {{firstName}}', htmlContent: '' });
      expect(res.status).toBe(200);
    });
  });
});

/*
 * The route's channel set must mirror the WORKER'S dispatch, not the stored value.
 *
 * dripSequenceWorker does `channel === 'linkedin' ? sendLinkedInStep : sendEmailStep`,
 * so anything that is not literally 'linkedin' is delivered as email. Mapping the raw
 * value here produced sets like {'sms'} or {''} that the reachability test can never
 * satisfy — so the route enrolled NOBODY while the worker would have emailed everyone.
 * `?? 'email'` does not catch '', so an unselected dropdown was enough to trigger it.
 */
describe('unknown channels fall back to email, matching the worker', () => {
  const crmDbMock = require('../services/db').crmDb;

  beforeEach(() => {
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'l1', listId: 'list-1', email: 'a@acme.io' },
      { leadId: 'l2', listId: 'list-1', email: 'b@acme.io' },
    ]);
  });

  it.each([
    ['an empty string (unselected dropdown)', ''],
    ['a typo', 'linkedln'],
    ['an unsupported channel', 'sms'],
    ['a non-string', 0 as any],
    ['null', null as any],
  ])('still enrols email-reachable leads when channel is %s', async (_label, channel) => {
    dripSequenceDb.getSequence.mockResolvedValue({
      ...mockSequence,
      steps: [{ stepId: 's1', stepNumber: 1, name: 'x', delayDays: 0, channel, subject: 'Hi', bodyHtml: 'y' }],
    });

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    expect(res.status).toBe(200);
    // Both leads have valid addresses and the worker would email them. Refusing here
    // is a silent lost send, reported as if it were clean data.
    expect(res.body.enrollableLeads).toBe(2);
  });

  it('still routes a genuine linkedin step to linkedin', async () => {
    dripSequenceDb.getSequence.mockResolvedValue({
      ...mockSequence,
      steps: [{ stepId: 's1', stepNumber: 1, name: 'x', delayDays: 0, channel: 'LinkedIn', messageText: 'hi' }],
    });
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'l1', listId: 'list-1', email: 'a@acme.io' },
    ]);

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    // Email-only lead, LinkedIn-only sequence -> genuinely unreachable.
    expect(res.body.enrollableLeads).toBe(0);
    expect(res.body.skippedUnreachable).toBe(1);
  });
});

/*
 * The ROUTE must use the shared predicates, not a truthiness check.
 *
 * Every existing route test uses leads whose fields are either valid or absent, so both
 * halves of leadIsReachable reverted to `!!String(x).trim()` with the suite fully green.
 * The case that matters is a field that is PRESENT but unreachable — `linkedin: 'Acme
 * Corp'` is exactly what db.ts stores verbatim for anything that is not a /in/ URL, and
 * enrolling it produces a row that skips every step and completes having sent nothing:
 * the precise outcome leadIsReachable is documented to prevent.
 */
describe('the route uses the shared predicates, not truthiness', () => {
  const crmDbMock = require('../services/db').crmDb;

  it('refuses a lead whose linkedin is free text, not a profile URL', async () => {
    dripSequenceDb.getSequence.mockResolvedValue({
      ...mockSequence,
      steps: [{ stepId: 's1', stepNumber: 1, name: 'invite', delayDays: 0, channel: 'linkedin', messageText: 'hi' }],
    });
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'junk', listId: 'list-1', linkedin: 'Acme Corp' },
      { leadId: 'company', listId: 'list-1', linkedin: 'https://www.linkedin.com/company/acme' },
      { leadId: 'real', listId: 'list-1', linkedin: 'https://www.linkedin.com/in/ada' },
    ]);

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    expect(res.status).toBe(200);
    expect(res.body.enrollableLeads).toBe(1);
    expect(res.body.skippedUnreachable).toBe(2);
    const ids = dripSequenceDb.bulkEnroll.mock.calls[0][0].map((i: any) => i.leadId);
    expect(ids).toEqual(['real']);
  });

  it('refuses a lead whose email is present but malformed', async () => {
    dripSequenceDb.getSequence.mockResolvedValue(mockSequence);   // email sequence
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'bad', listId: 'list-1', email: 'a@x..com' },
      { leadId: 'brackets', listId: 'list-1', email: '<a@x.com>' },
      { leadId: 'good', listId: 'list-1', email: 'ada@acme.io' },
    ]);

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    expect(res.body.enrollableLeads).toBe(1);
    const ids = dripSequenceDb.bulkEnroll.mock.calls[0][0].map((i: any) => i.leadId);
    expect(ids).toEqual(['good']);
  });

  it('accepts a LinkedIn URL carrying a query string, and keys it canonically', async () => {
    dripSequenceDb.getSequence.mockResolvedValue({
      ...mockSequence,
      steps: [{ stepId: 's1', stepNumber: 1, name: 'invite', delayDays: 0, channel: 'linkedin', messageText: 'hi' }],
    });
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'uk', listId: 'list-1', linkedin: 'https://linkedin.com/in/ada-lovelace?originalSubdomain=uk' },
    ]);

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    expect(res.body.enrollableLeads).toBe(1);
    // The dedup identity must be the CANONICAL url: leadEmail is the partition key of
    // leadEmail-index, so two spellings of one profile would enrol twice and deliver
    // the whole sequence twice.
    const input = dripSequenceDb.bulkEnroll.mock.calls[0][0][0];
    expect(input.leadEmail).toBe('https://www.linkedin.com/in/ada-lovelace/');
  });

  it('two spellings of the same profile produce ONE dedup identity', async () => {
    dripSequenceDb.getSequence.mockResolvedValue({
      ...mockSequence,
      steps: [{ stepId: 's1', stepNumber: 1, name: 'invite', delayDays: 0, channel: 'linkedin', messageText: 'hi' }],
    });
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'a', listId: 'list-1', linkedin: 'https://www.linkedin.com/in/ada/' },
      { leadId: 'b', listId: 'list-1', linkedin: 'https://linkedin.com/in/ada' },
    ]);

    await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    const identities = dripSequenceDb.bulkEnroll.mock.calls[0][0].map((i: any) => i.leadEmail);
    expect(new Set(identities).size).toBe(1);
  });

  /*
   * Review round 3, finding 15. Same gap as the explicit route: deleting
   * `identityCandidates:` at this call site left every test green.
   */
  it('by-list also passes identityCandidates through to bulkEnroll', async () => {
    dripSequenceDb.getSequence.mockResolvedValue({
      ...mockSequence,
      steps: [
        { stepId: 's1', stepNumber: 1, name: 'm', delayDays: 0, subject: 'Hi', bodyHtml: 'x' },
        { stepId: 's2', stepNumber: 2, name: 'dm', delayDays: 1, channel: 'linkedin', messageText: 'z' },
      ],
    });
    crmDbMock.getAllLeadsByListId = jest.fn().mockResolvedValue([
      { leadId: 'a', listId: 'list-1', email: 'ada@acme.io', linkedin: 'https://linkedin.com/in/ada' },
    ]);

    await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    const input = dripSequenceDb.bulkEnroll.mock.calls[0][0][0];
    expect(input.identityCandidates).toEqual(
      expect.arrayContaining(['ada@acme.io', 'https://www.linkedin.com/in/ada/']),
    );
  });
});

/*
 * Findings 7, 9 and 12 — each one a place where the route quietly disagreed with
 * itself about which leads exist.
 */
describe('the explicit route reports honestly about what it could not read', () => {
  const crmDbMock = require('../services/db').crmDb;

  it('distinguishes a FAILED READ from a genuine unreachability', async () => {
    dripSequenceDb.getSequence.mockResolvedValue({
      ...mockSequence,
      steps: [{ stepId: 's1', stepNumber: 1, name: 'invite', delayDays: 0, channel: 'linkedin', messageText: 'hi' }],
    });
    // One lead throttles, one genuinely has no profile.
    (crmDbMock.getLeadById as jest.Mock)
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'))
      .mockResolvedValueOnce({ leadId: 'nolinkedin', email: 'a@acme.io' });

    const res = await request(app).post('/seq_1/enrollments').send({
      leads: [
        { listId: 'list-1', leadId: 'throttled', leadEmail: '' },
        { listId: 'list-1', leadId: 'nolinkedin', leadEmail: 'a@acme.io' },
      ],
    });

    expect(res.status).toBe(200);
    // Reported in the same bucket, a throttle is indistinguishable from real data and
    // the lead is silently lost.
    expect(res.body.skippedReadFailed).toBe(1);
    expect(res.body.skippedUnreachable).toBe(1);
  });

  it('does NOT report skippedReadFailed when the payload rescues the lead', async () => {
    dripSequenceDb.getSequence.mockResolvedValue(mockSequence);   // email sequence
    (crmDbMock.getLeadById as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB unavailable'));

    const res = await request(app).post('/seq_1/enrollments')
      .send({ leads: [{ listId: 'list-1', leadId: 'l1', leadEmail: 'a@acme.io' }] });

    expect(res.body.skippedReadFailed).toBeUndefined();
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalled();
  });

  /*
   * `linkedin` is not in this route's payload contract ({listId, leadId, leadEmail}).
   * Honouring it let a caller enrol a lead that has no profile, under a dedup identity
   * of their choosing — producing exactly the row that skips every step and completes
   * having sent nothing.
   */
  it('ignores a payload-supplied linkedin when the CRM row has none', async () => {
    dripSequenceDb.getSequence.mockResolvedValue({
      ...mockSequence,
      steps: [{ stepId: 's1', stepNumber: 1, name: 'invite', delayDays: 0, channel: 'linkedin', messageText: 'hi' }],
    });
    (crmDbMock.getLeadById as jest.Mock).mockResolvedValueOnce({ leadId: 'l1', email: '', linkedin: '' });

    const res = await request(app).post('/seq_1/enrollments').send({
      leads: [{ listId: 'list-1', leadId: 'l1', leadEmail: '', linkedin: 'https://linkedin.com/in/not-theirs' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.skippedUnreachable).toBe(1);
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalledWith([]);
  });
});

describe('verify-variables counts the SAME population enrol does', () => {
  const crmDbMock = require('../services/db').crmDb;

  it('uses the paginated loader, not a single ~1MB page', async () => {
    dripSequenceDb.getSequence.mockResolvedValue(mockSequence);
    (crmDbMock.getAllLeadsByListId as jest.Mock).mockClear();
    (crmDbMock.getLeadsByListId as jest.Mock).mockClear();

    await request(app).post('/seq_1/steps/verify-variables')
      .send({ listId: 'list-1', subject: 'Hi {{firstName}}', htmlContent: '' });

    // db.ts: "Use this anywhere a complete list is required (enrollment, coverage
    // counts) — getLeadsByListId returns only a single ~1MB page."
    expect(crmDbMock.getAllLeadsByListId).toHaveBeenCalledWith('list-1');
    expect(crmDbMock.getLeadsByListId).not.toHaveBeenCalled();
  });
});

describe('POST /load-from-url SSRF guard (ENG-2425)', () => {
  it.each(['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8080/'])('rejects %s with 400', async (url) => {
    const res = await request(app).post('/load-from-url').send({ url });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/public internet address/);
  });
});
