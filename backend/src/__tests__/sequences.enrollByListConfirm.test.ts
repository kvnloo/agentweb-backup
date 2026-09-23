/**
 * Tests for the by-list enroll endpoint's missing-variable warning gating.
 *
 * The endpoint checks the sequence's template variables (email subject/body +
 * LinkedIn messageText) against the list's leads. If any supported variable is
 * missing for a lead, or any unsupported token is referenced, and `confirm` is
 * not set, it returns needsConfirmation WITHOUT enrolling.
 */

import request from 'supertest';
import express from 'express';
import sequenceRoutes from '../routes/sequences';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'test@example.com' };
    next();
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn().mockResolvedValue({ listId: 'list-1', userId: 'user-123' }),
    canOrgMemberAccessList: jest.fn().mockResolvedValue(true),
    getAllLeadsByListId: jest.fn().mockResolvedValue([]),
    getLeadsByStatus: jest.fn().mockResolvedValue([]),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'user-123', email: 'test@example.com' }),
  },
}));

jest.mock('../services/dripSequenceDb', () => {
  class SequenceNotFoundError extends Error {}
  class SequenceAuthError extends Error {}
  return {
    dripSequenceDb: {
      getSequence: jest.fn(),
      bulkEnroll: jest.fn().mockResolvedValue({ enrolled: 0, skipped: 0 }),
      updateSequence: jest.fn().mockResolvedValue({}),
    },
    SequenceNotFoundError,
    SequenceAuthError,
  };
});

const { dripSequenceDb } = require('../services/dripSequenceDb');
const { crmDb } = require('../services/db');

const app = express();
app.use(express.json());
app.use('/', sequenceRoutes);

function seqWith(steps: any[]) {
  return {
    sequenceId: 'seq_1',
    userId: 'user-123',
    name: 'Seq',
    campaignType: 'custom',
    enrollmentTrigger: { type: 'manual' },
    exitConditions: { onUnsubscribe: true },
    status: 'active',
    autoEnrollListIds: ['list-1'],
    steps,
  };
}

const emailStepWithGaps = {
  stepId: 's1', stepNumber: 1, name: 'Intro', delayDays: 0, channel: 'email',
  subject: 'Hi {{firstName}} {{customFields.region}}', bodyHtml: '<p>{{phone}}</p>',
};

const threeLeads = [
  { leadId: 'l1', email: 'a@example.com', firstName: 'A', customFields: { region: 'X' } },
  { leadId: 'l2', email: 'b@example.com', firstName: 'B', customFields: { region: 'Y' } },
  { leadId: 'l3', email: 'c@example.com', firstName: 'C' },
];

beforeEach(() => {
  jest.clearAllMocks();
  crmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', userId: 'user-123' });
  crmDb.canOrgMemberAccessList.mockResolvedValue(true);
  dripSequenceDb.bulkEnroll.mockResolvedValue({ enrolled: 3, skipped: 0 });
  dripSequenceDb.updateSequence.mockResolvedValue({});
});

describe('POST /:sequenceId/enrollments/by-list — variable-warning gating', () => {
  it('without confirm and with gaps: returns needsConfirmation and does NOT enroll', async () => {
    dripSequenceDb.getSequence.mockResolvedValue(seqWith([emailStepWithGaps]));
    crmDb.getAllLeadsByListId.mockResolvedValue(threeLeads);

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    expect(res.status).toBe(200);
    expect(res.body.needsConfirmation).toBe(true);
    expect(res.body.leadCount).toBe(3);
    expect(res.body.warnings.unsupported).toContain('phone');
    expect(res.body.warnings.missing).toEqual([
      { variable: 'customFields.region', missing: 1, present: 2 },
    ]);
    expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
  });

  it('includes variables that appear only in a LinkedIn messageText step', async () => {
    dripSequenceDb.getSequence.mockResolvedValue(seqWith([
      { stepId: 's1', stepNumber: 1, name: 'LI', delayDays: 0, channel: 'linkedin',
        messageText: 'Hey {{customFields.region}}' },
    ]));
    crmDb.getAllLeadsByListId.mockResolvedValue(threeLeads);

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    expect(res.body.needsConfirmation).toBe(true);
    expect(res.body.warnings.missing).toEqual([
      { variable: 'customFields.region', missing: 1, present: 2 },
    ]);
  });

  it('never flags senderName / senderEmail', async () => {
    dripSequenceDb.getSequence.mockResolvedValue(seqWith([
      { stepId: 's1', stepNumber: 1, name: 'Intro', delayDays: 0, channel: 'email',
        subject: 'Hi {{firstName}} from {{senderName}} {{senderEmail}}', bodyHtml: '<p>x</p>' },
    ]));
    crmDb.getAllLeadsByListId.mockResolvedValue([
      { leadId: 'l1', email: 'a@example.com', firstName: 'A' },
    ]);

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    // firstName present on all leads, sender vars excluded → clean → enrolls immediately
    expect(res.body.needsConfirmation).toBeFalsy();
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalled();
  });

  it('the confirm dialog counts only the leads that will actually be enrolled', async () => {
    // The filter has to run BEFORE the coverage loop. Applied at the mapper instead, the
    // response described one population and enrolled another: leadCount included leads that
    // were never candidates, and needsConfirmation could fire over a variable missing only
    // on those leads — asking the user to confirm a warning about rows nothing would send to.
    dripSequenceDb.getSequence.mockResolvedValue(seqWith([
      { stepId: 's1', stepNumber: 1, name: 'Intro', delayDays: 0, channel: 'email',
        subject: 'Hi {{firstName}}', bodyHtml: 'Hello' },
    ]));
    crmDb.getAllLeadsByListId.mockResolvedValue([
      { leadId: 'l1', email: 'a@example.com', firstName: 'A' },
      { leadId: 'l2', email: 'b@example.com', firstName: 'B' },
      // No email AND no firstName — it must not be counted, and must not be the reason
      // the confirmation gate fires.
      { leadId: 'l3', phone: '4155550142' },
    ]);

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1' });

    expect(res.status).toBe(200);
    // Both remaining leads have firstName, so there is nothing to warn about at all.
    expect(res.body.needsConfirmation).toBeFalsy();
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalledTimes(1);
    const [inputs] = dripSequenceDb.bulkEnroll.mock.calls[0];
    expect(inputs).toHaveLength(2);
  });

  it('never enrols a lead with no email address', async () => {
    // leadEmail feeds sendAsSender({ to }) in dripSequenceWorker, which RETHROWS on failure,
    // so an undefined address makes the enrollment retry forever. It is also the
    // leadEmail-index partition key, so the row is invisible to getActiveEnrollment and is
    // re-created on every run. Email-less leads were already reachable (LinkedIn imports,
    // the invite mirror); ENG-2082 made a whole list type produce them. crm.ts's identical
    // mapper has always filtered — this one did not.
    dripSequenceDb.getSequence.mockResolvedValue(seqWith([
      { stepId: 's1', stepNumber: 1, name: 'Intro', delayDays: 0, channel: 'email',
        subject: 'Hi', bodyHtml: 'Hello' },
    ]));
    crmDb.getAllLeadsByListId.mockResolvedValue([
      { leadId: 'l1', email: 'a@example.com', firstName: 'A' },
      { leadId: 'l2', phone: '4155550142', firstName: 'PhoneOnly' },
      { leadId: 'l3', email: '', firstName: 'Empty' },
    ]);

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', confirm: true });

    expect(res.status).toBe(200);
    const [inputs] = dripSequenceDb.bulkEnroll.mock.calls[0];
    expect(inputs).toHaveLength(1);
    expect(inputs[0].leadId).toBe('l1');
    expect(inputs.every((i: any) => !!i.leadEmail)).toBe(true);
  });

  it('with confirm:true and gaps: enrolls and returns the bulkEnroll result', async () => {
    dripSequenceDb.getSequence.mockResolvedValue(seqWith([emailStepWithGaps]));
    crmDb.getAllLeadsByListId.mockResolvedValue(threeLeads);

    const res = await request(app)
      .post('/seq_1/enrollments/by-list')
      .send({ listId: 'list-1', confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(3);
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalledTimes(1);
  });

  it('clean list (all supported vars populated): enrolls on first call', async () => {
    dripSequenceDb.getSequence.mockResolvedValue(seqWith([
      { stepId: 's1', stepNumber: 1, name: 'Intro', delayDays: 0, channel: 'email',
        subject: 'Hi {{firstName}}', bodyHtml: '<p>hi</p>' },
    ]));
    crmDb.getAllLeadsByListId.mockResolvedValue(threeLeads);

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    expect(res.body.needsConfirmation).toBeFalsy();
    expect(res.body.enrolled).toBe(3);
    expect(dripSequenceDb.bulkEnroll).toHaveBeenCalledTimes(1);
  });

  it('returns 403 when the caller cannot access the list', async () => {
    dripSequenceDb.getSequence.mockResolvedValue(seqWith([emailStepWithGaps]));
    crmDb.canOrgMemberAccessList.mockResolvedValue(false);

    const res = await request(app).post('/seq_1/enrollments/by-list').send({ listId: 'list-1' });

    expect(res.status).toBe(403);
    expect(dripSequenceDb.bulkEnroll).not.toHaveBeenCalled();
  });
});
