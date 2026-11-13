/**
 * ENG-2936 — same-email re-submits keep both submissions (notes append, overwritten values
 * and one form.submitted history entry per distinct submission).
 *
 * The merge used to send the whole merged customFields map, which updateLead wrote as one
 * overwrite and which therefore erased every key a concurrent repeat submission had just stored.
 * It now sends ONLY the keys this submission adds or changes, flagged `customFieldsKeyMerge`.
 * Everything that decides `changed` / `isUpdated` / `matchQualityBackfilled` is untouched and is
 * pinned byte-for-byte by webhooks.forwardLead.mergeEquivalence.test.ts; this file pins the call.
 */

import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';
import { onPublicFormSubmitted } from '../services/contactCaptureHooks';
import { appendNotes, collectOverwrittenValues, MAX_NOTES_CHARS } from '../utils/leadSubmissionHistory';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    getLeadById: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/metaAccountCredentials', () => ({ getMetaAccountCredentials: jest.fn() }));
jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getSequencesByAutoEnrollList: jest.fn().mockResolvedValue([]), bulkEnroll: jest.fn() },
}));
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn() },
}));
jest.mock('../services/leadCaptureFailureService', () => ({ recordLeadCaptureFailure: jest.fn() }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { updateEmailDraftForLead: jest.fn(), getCrmSenders: jest.fn() },
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn(), sendSystemEmail: jest.fn().mockResolvedValue({ id: 'email_1' }) },
}));
jest.mock('../services/webhookService', () => ({
  webhookService: { initialize: jest.fn(), verifyWebhook: jest.fn(), extractEmailDomain: jest.fn(), generateEventId: jest.fn() },
}));
jest.mock('../services/contactCaptureHooks', () => ({ onPublicFormSubmitted: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: { eventExists: jest.fn(), addEmailEvent: jest.fn() } }));

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);
const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

const demo = {
  leadId: 'lead_1', listId: 'list_123', email: 'a@b.com', phone: '555',
  notes: 'Requested Book a Demo \u00b7 Position: CTO',
  customFields: { source: 'get-started', team_size: 'Up to 50', hiring_timeline: 'Q1' },
};
const post = (body: any) => request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_123', email: 'a@b.com', ...body });
const hook = onPublicFormSubmitted as jest.Mock;

describe('ENG-2936 forward-lead submission history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_123', userId: 'user_123', name: 'L', publicAccessEnabled: true });
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(demo);
    (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user_123', connected_accounts: [] });
  });

  it('second form, same email: one lead, notes appended, prior team_size kept in the history entry', async () => {
    const res = await post({ source: 'bad-hire-calculator', notes: 'Completed Bad Hire Calculator: $575,000', customFields: { team_size: '10' } });
    await flush();
    expect(res.body.event).toBe('lead.updated');
    expect(crmDb.createLead).not.toHaveBeenCalled();
    const updates = (crmDb.updateLead as jest.Mock).mock.calls[0][2];
    expect(updates.notes).toBe('Requested Book a Demo \u00b7 Position: CTO\n\nCompleted Bad Hire Calculator: $575,000');
    expect(hook).toHaveBeenCalledTimes(1);
    const entry = hook.mock.calls[0][0];
    expect(entry.email).toBe('a@b.com');
    expect(entry.payload.notes).toBe('Completed Bad Hire Calculator: $575,000');
    expect(entry.payload.overwrittenValues).toMatchObject({ 'customFields.team_size': 'Up to 50', 'customFields.source': 'get-started' });
    expect(entry.payload.fields.customFields.team_size).toBe('10');
  });

  it('re-reads and re-merges when another submission wins the notes write', async () => {
    const concurrent = { ...demo, notes: `${demo.notes}\n\nother visitor` };
    (crmDb.updateLead as jest.Mock).mockRejectedValueOnce({ code: 'ConditionalCheckFailedException' });
    (crmDb.getLeadById as jest.Mock).mockResolvedValueOnce(concurrent);
    const res = await post({ notes: 'this visitor' });
    expect(res.status).toBe(200);
    expect(crmDb.getLeadById).toHaveBeenCalledWith('list_123', 'lead_1', { consistentRead: true });
    expect((crmDb.updateLead as jest.Mock).mock.calls[1][2]).toMatchObject({
      expectedNotes: concurrent.notes, notes: `${concurrent.notes}\n\nthis visitor`,
    });
  });

  it('caller submissionId gives a deterministic history key, so logEvent dedupes a retry', async () => {
    await post({ submissionId: 'sub-1', notes: 'x' });
    await flush();
    expect(hook.mock.calls[0][0].sourceRecordId).toBe('forward-lead:list_123:client:sub-1');
  });

  it('distinct submissions without a key get distinct history entries', async () => {
    await post({ notes: 'one' });
    await post({ notes: 'two' });
    await flush();
    const ids = hook.mock.calls.map((c) => c[0].sourceRecordId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('leadSubmissionHistory helpers', () => {
  it('appendNotes appends, skips empties and duplicates', () => {
    expect(appendNotes('', 'a')).toBe('a');
    expect(appendNotes('a', '')).toBe('a');
    expect(appendNotes('a', 'a')).toBe('a');
    expect(appendNotes('a\n\nb', 'b')).toBe('a\n\nb');
    expect(appendNotes('a', 'b')).toBe('a\n\nb');
  });

  it('appendNotes dedupes a multi-paragraph note already present as a whole block', () => {
    const once = appendNotes('First note A', 'P1\n\nP2');
    expect(once).toBe('First note A\n\nP1\n\nP2');
    expect(appendNotes(once, 'P1\n\nP2')).toBe(once);
    // a substring that is not block-bounded is still new text
    expect(appendNotes('P1X\n\nP2', 'P1')).toBe('P1X\n\nP2\n\nP1');
  });

  it('appendNotes stays under the item-size cap, dropping the oldest blocks first', () => {
    let notes = '';
    for (let i = 0; i < 40; i += 1) notes = appendNotes(notes, `${i}-${'x'.repeat(14_000)}`);
    expect(notes.length).toBeLessThanOrEqual(MAX_NOTES_CHARS);
    expect(notes.endsWith(`39-${'x'.repeat(14_000)}`)).toBe(true);
    expect(notes.includes('0-x')).toBe(false);
    expect(appendNotes('', 'y'.repeat(MAX_NOTES_CHARS + 10)).length).toBe(MAX_NOTES_CHARS);
  });
  it('collectOverwrittenValues reports only non-empty conflicting priors', () => {
    expect(collectOverwrittenValues(
      { phone: '1', company: '', notes: 'n', customFields: { a: 1, b: '', c: 3 } },
      { phone: '2', company: 'X', notes: 'm', customFields: { a: 2, b: 'z', c: 3, d: 4 } },
    )).toEqual({ phone: '1', 'customFields.a': 1 });
  });
});
