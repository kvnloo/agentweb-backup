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
    req.user = { userId: 'user-123', email: 'test@example.com' };
    next();
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn() },
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
      { leadId: 'lead-1', email: 'a@example.com' },
      { leadId: 'lead-2', email: 'b@example.com' },
    ]),
    getLead: jest.fn().mockResolvedValue({ leadId: 'lead-1', email: 'a@example.com', lifecycle: 'inbox' }),
    // The explicit enroll route decides reachability from the CRM ROW, not the request
    // body — its payload has no `linkedin` field, so reading the body made it enrol
    // nobody for a LinkedIn sequence. Resolve per leadId, because "this lead has no
    // address" is now a fact about the CRM, not about the payload.
    getLeadById: jest.fn().mockImplementation(async (_listId: string, leadId: string) => (
      leadId === 'lead-1'
        ? { leadId: 'lead-1', email: 'a@example.com' }
        : { leadId, email: '' }
    )),
    getLeadsByListId: jest.fn().mockResolvedValue([
      { leadId: 'lead-1', email: 'a@example.com' },
      { leadId: 'lead-2', email: 'b@example.com' },
    ]),
    getAllLeadsByListId: jest.fn().mockResolvedValue([
      { leadId: 'lead-1', email: 'a@example.com' },
      { leadId: 'lead-2', email: 'b@example.com' },
    ]),
    getLeadsByStatus: jest.fn().mockResolvedValue([]),
    getLeadListById: jest.fn().mockResolvedValue({ listId: 'list-1', userId: 'user-123' }),
    canOrgMemberAccessList: jest.fn().mockResolvedValue(true),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'user-123', email: 'test@example.com' }),
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

// ─── App setup ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use('/', sequenceRoutes);

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
          { listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@example.com' },
          { listId: 'list-1', leadId: 'lead-2', leadEmail: 'b@example.com' },
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
          { listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@example.com' },
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
      .send({ leads: [{ listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@example.com' }] });
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
      .send({ leads: [{ listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@example.com' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no steps/i);
  });

  it('returns 403 when sequence belongs to another user', async () => {
    dripSequenceDb.getSequence.mockResolvedValueOnce({ ...mockSequence, userId: 'other-user' });
    const res = await request(app)
      .post('/seq_1/enrollments')
      .send({ leads: [{ listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@example.com' }] });
    expect(res.status).toBe(403);
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
      { leadId: 'lead-1', email: 'a@example.com' },
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
      { leadId: 'lead-1', email: 'a@example.com' },
      { leadId: 'lead-2' },
      { leadId: 'lead-3', email: '' },
      { leadId: 'lead-4', email: 'd@example.com' },
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
      { leadId: 'lead-1', email: 'a@example.com' },
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
    crmDbMock.getLeadsByListId = jest.fn().mockResolvedValue({
      items: [
        { leadId: 'l1', email: 'a@example.com', firstName: 'Ann' },
        { leadId: 'l2', firstName: 'Ben' },
        { leadId: 'l3', email: '', firstName: 'Cal' },
      ],
    });

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

  // ENG-2127: the lifecycle filter is handed to getLeadsByStatus, which queries the
  // `status` attribute and never reads `lifecycle`. The vocabularies are disjoint, so it
  // matches nothing — and an empty array is a legitimate result, so the caller used to
  // report "0 enrolled" with no indication that the filter itself is broken.
  it('refuses a lifecycle filter instead of silently enrolling nobody', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'inbox' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('lifecycle_filter_unsupported');
    expect(res.body.message).toMatch(/matches nothing/);
    expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
  });

  // at_risk and churned are BOTH lifecycle stages AND default lead statuses (db.ts:5364),
  // and a list may define any statusConfig it likes. The first version of this guard
  // answered a perfectly valid `status: churned` filter that matched nothing with a 400
  // telling the caller to filter by a status instead — which is what they had done.
  it('does NOT reject a value the list defines as a real status', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadListById = jest.fn().mockResolvedValue({
      listId: 'list-1', userId: 'user-123',
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
    expect(res.body.error).toBeUndefined();
  });

  // Same defect, one step further out: a list with NO stored statusConfig does not have
  // no statuses — it falls back to the default set, which contains `churned`. Reading
  // absent as empty reinstated the bogus 400 for every list created before
  // createLeadList began persisting a default.
  it('does NOT reject a default status on a list with no stored statusConfig', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadListById = jest.fn().mockResolvedValue({
      listId: 'list-1', userId: 'user-123',
      // no statusConfig key at all — the pre-default row shape
    });
    crmDbMock.canOrgMemberAccessList = jest.fn().mockResolvedValue(true);
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'churned' });

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });

  // ...and the fallback is listType-aware: `at_risk` is a default status only for a
  // customers list. On a prospect list it is a lifecycle stage and nothing else, so the
  // guard must still fire — otherwise the widening has simply disabled it.
  it('still rejects a lifecycle-only value on a list with no stored statusConfig', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadListById = jest.fn().mockResolvedValue({
      listId: 'list-1', userId: 'user-123',
    });
    crmDbMock.canOrgMemberAccessList = jest.fn().mockResolvedValue(true);
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({ items: [] });

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'at_risk' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('lifecycle_filter_unsupported');

    // but on a customers list the same value IS a default status
    crmDbMock.getLeadListById = jest.fn().mockResolvedValue({
      listId: 'list-1', userId: 'user-123', listType: 'customers',
    });
    const customers = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'at_risk' });

    expect(customers.status).toBe(200);
    expect(customers.body.error).toBeUndefined();
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
      expect(input.leadEmail).toBe('https://linkedin.com/in/ada');
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
      expect(input.leadEmail).toBe('https://linkedin.com/in/ada');
      expect(res.body.skippedUnreachable).toBeUndefined();
    });

    it('the explicit route still enrols when the CRM lookup fails, using the payload', async () => {
      dripSequenceDb.getSequence.mockResolvedValue(mockSequence);
      const crmDbMock = require('../services/db').crmDb;
      (crmDbMock.getLeadById as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB unavailable'));

      const res = await request(app)
        .post('/seq_1/enrollments')
        .send({ leads: [{ listId: 'list-1', leadId: 'lead-1', leadEmail: 'a@example.com' }] });

      expect(res.status).toBe(200);
      expect(dripSequenceDb.bulkEnroll).toHaveBeenCalled();
      expect(dripSequenceDb.bulkEnroll.mock.calls[0][0][0].leadEmail).toBe('a@example.com');
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
      crmDbMock.getLeadsByListId = jest.fn().mockResolvedValue([
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

  it('still enrols normally when a lifecycle filter does return leads', async () => {
    const crmDbMock = require('../services/db').crmDb;
    crmDbMock.getLeadsByStatus = jest.fn().mockResolvedValue({
      items: [{ leadId: 'l1', email: 'a@example.com' }],
    });

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', lifecycle: 'inbox' });

    expect(res.status).toBe(200);
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
    recipients: ['a@example.com'],
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
          to: 'a@example.com',
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
        recipients: ['a@example.com'],
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
      { leadId: 'l1', listId: 'list-1', email: 'a@example.com' },
      { leadId: 'l2', listId: 'list-1', email: 'b@example.com' },
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
      { leadId: 'l1', listId: 'list-1', email: 'a@example.com' },
    ]);

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    // Email-only lead, LinkedIn-only sequence -> genuinely unreachable.
    expect(res.body.enrollableLeads).toBe(0);
    expect(res.body.skippedUnreachable).toBe(1);
  });
});
