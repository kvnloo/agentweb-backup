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
