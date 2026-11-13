/**
 * ENG-2783: forward-lead records the visitor's call consent on the lead (system.callConsent) BEFORE the call gates can run,
 * ignores a malformed one (never a 400, one warning of the reason code only), never stores it as a custom field and never
 * echoes it. A repeat submission by an existing lead records it once (first record wins); an idempotent replay writes nothing.
 */
import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { PUBLIC_LEAD_ALIAS_PATH, publicLeadAlias } from '../routes/publicLeadAlias';
import { crmDb, userDb } from '../services/db';
import { dispatchLeadCreated } from '../services/orgLeadNotificationService';
import { __configureLeadSubmissionIdempotencyForTests } from '../services/leadSubmissionIdempotency';
import { buildCallConsentNotice } from '../services/voice/callConsent';
import { InMemoryDynamo } from './helpers/inMemoryDynamo';

jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(), getLeadByEmail: jest.fn(), createLead: jest.fn(), updateLead: jest.fn(), getLeadById: jest.fn(),
    createLeadSystemRecordOnce: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/metaAccountCredentials', () => ({ getMetaAccountCredentials: jest.fn() }));
jest.mock('../services/dripSequenceDb', () => ({ dripSequenceDb: { getSequencesByAutoEnrollList: jest.fn().mockResolvedValue([]), bulkEnroll: jest.fn() } }));
jest.mock('../services/externalCrmSyncService', () => ({ externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: { notifyLeadListOwnerIfConfigured: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/leadCaptureFailureService', () => ({ recordLeadCaptureFailure: jest.fn() }));
jest.mock('../services/roadmapDelivery', () => ({ sendRoadmapDeliveryEmail: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { updateEmailDraftForLead: jest.fn(), getCrmSenders: jest.fn() } }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn(), sendSystemEmail: jest.fn().mockResolvedValue({ id: 'e' }) } }));
jest.mock('../services/webhookService', () => ({ webhookService: { initialize: jest.fn(), verifyWebhook: jest.fn(), extractEmailDomain: jest.fn(), generateEventId: jest.fn() } }));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: { eventExists: jest.fn(), addEmailEvent: jest.fn() } }));

const app = express();
app.use(express.json());
app.post(PUBLIC_LEAD_ALIAS_PATH, publicLeadAlias);
app.use('/api/webhooks', webhookRouter);

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const createdLead = () => (crmDb.createLead as jest.Mock).mock.calls[0][1];
const TEXT = buildCallConsentNotice('Acme Plumbing LLC');
const consent = (over: Record<string, unknown> = {}) => ({ granted: true, text: TEXT, version: 'v1', ...over });
const post = (body: Record<string, unknown>) => request(app).post('/api/webhooks/forward-lead')
  .set('X-Forwarded-For', '203.0.113.7').set('User-Agent', 'Mozilla/5.0 test')
  .set('Referer', 'https://acme.example/quote?email=a%40b.com&utm_source=x')
  .send({ listId: 'list_1', email: 'a@b.com', phone: '+12125550142', ...body });
const warnLines = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('call consent'));

let warn: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list_1', userId: 'u1', name: 'L', publicAccessEnabled: true, autoDraftEnabled: false });
  (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
  (crmDb.createLead as jest.Mock).mockImplementation(async (listId: string, d: Record<string, unknown>) => ({ ...d, listId, leadId: 'lead_1' }));
  (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
  (crmDb.createLeadSystemRecordOnce as jest.Mock).mockResolvedValue(true);
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1', connected_accounts: [] });
});
afterEach(() => warn.mockRestore());

describe('forward-lead call consent: a new lead', () => {
  it('records every field in the CREATE input, with the server time, before dispatch', async () => {
    const before = Date.now();
    const res = await post({ callConsent: consent(), visitorIp: undefined });
    await flush();
    expect(res.status).toBe(201);
    const rec = createdLead().system.callConsent;
    expect(rec).toEqual({
      granted: true, text: TEXT, version: 'v1', phoneDigits: '12125550142', capturedAt: expect.any(String), pageUrl: 'https://acme.example/quote',
      ip: createdLead().clientIp, userAgent: 'Mozilla/5.0 test', source: 'form',
    });
    expect(Date.parse(rec.capturedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(rec.capturedAt)).toBeLessThanOrEqual(Date.now());
    expect(rec.pageUrl).not.toContain('?');
    expect(crmDb.createLeadSystemRecordOnce).not.toHaveBeenCalled(); // no second write
    expect((crmDb.createLead as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((dispatchLeadCreated as jest.Mock).mock.invocationCallOrder[0] ?? Infinity);
  });

  it('uses the capture route\'s declared visitor ip and page when the Referer header is absent', async () => {
    const res = await request(app).post('/api/webhooks/forward-lead').set('User-Agent', 'node')
      .send({ listId: 'list_1', email: 'a@b.com', phone: '+12125550142', visitorIp: '93.184.216.34', visitorUserAgent: 'Mozilla/5.0 (iPhone)', visitorPageUrl: 'https://acme.example/lp?x=1', callConsent: consent() });
    await flush();
    expect(res.status).toBe(201);
    expect(createdLead().system.callConsent).toMatchObject({ ip: '93.184.216.34', userAgent: 'Mozilla/5.0 (iPhone)', pageUrl: 'https://acme.example/lp' });
  });

  it('a client-supplied capturedAt / source inside callConsent is never used', async () => {
    await post({ callConsent: consent({ capturedAt: '1999-01-01T00:00:00.000Z', source: 'operator', note: 'x', ip: '1.1.1.1' }) });
    await flush();
    const rec = createdLead().system.callConsent;
    expect(rec.capturedAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(rec.source).toBe('form');
    expect(rec).not.toHaveProperty('note');
    expect(rec.ip).not.toBe('1.1.1.1');
  });

  it('is not a custom field, not a note, and not echoed in the response', async () => {
    const res = await post({ callConsent: consent() });
    await flush();
    expect(JSON.stringify(createdLead().customFields)).not.toContain('callConsent');
    expect(JSON.stringify(createdLead().customFields)).not.toContain('By checking this box');
    expect(createdLead().notes).toBe('');
    expect(JSON.stringify(res.body)).not.toContain('By checking');
    expect(res.body).toEqual({ success: true, message: 'Lead forwarded successfully', event: 'lead.created', leadId: 'lead_1', listId: 'list_1' });
  });

  it('works for a phone-only lead too', async () => {
    const res = await request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_1', phone: '+12125550143', callConsent: consent() });
    await flush();
    expect(res.status).toBe(201);
    expect(createdLead().system.callConsent.granted).toBe(true);
  });

  it('no consent field: the lead is created without system.callConsent and nothing warns', async () => {
    const res = await post({});
    await flush();
    expect(res.status).toBe(201);
    expect(createdLead().system).toBeUndefined();
    expect(warnLines(warn)).toEqual([]);
  });

  it.each([
    ['the string "true"', consent({ granted: 'true' }), 'not_granted'],
    ['text too short', consent({ text: 'I agree to automated calls' }), 'text_too_short'],
    ['text too long', consent({ text: `call automated ${'a'.repeat(1000)}` }), 'text_too_long'],
    ['no call word', consent({ text: 'I agree to be contacted by automated systems about my enquiry.' }), 'text_no_call_word'],
    ['no automated word', consent({ text: 'I agree that Acme Plumbing LLC may call me at the number above about my enquiry.' }), 'text_no_automated_word'],
    ['the literal placeholder', consent({ text: buildCallConsentNotice('[REGISTERED BUSINESS NAME]') }), 'placeholder_name'],
    ['a lower-case spaced placeholder', consent({ text: buildCallConsentNotice('registered   business name') }), 'placeholder_name'],
    ['a bracketed name placeholder', consent({ text: buildCallConsentNotice('[Your Company Name]') }), 'placeholder_name'],
    ['bad version', consent({ version: 'v 1!' }), 'bad_version'],
    ['not an object', 'yes', 'not_object'],
    ['text not a string', consent({ text: { a: 1 } }), 'bad_text'],
  ])('ignores %s: still 201, no consent stored, exactly one warning with only the reason code', async (_n, raw, reason) => {
    const res = await post({ callConsent: raw });
    await flush();
    expect(res.status).toBe(201);
    expect(createdLead().system).toBeUndefined();
    expect(JSON.stringify(createdLead().customFields)).not.toContain('callConsent');
    expect(warnLines(warn)).toEqual([`[forward-lead] call consent ignored: ${reason}`]);
    const all = JSON.stringify(warn.mock.calls);
    expect(all).not.toContain('a@b.com');
    expect(all).not.toContain('2125550142');
  });
});

describe('the public alias /api/leads/public/:listId is the same handler', () => {
  it('records consent through the alias exactly as forward-lead does', async () => {
    const res = await request(app).post('/api/leads/public/list_1').send({ email: 'a@b.com', phone: '+12125550142', callConsent: consent() });
    await flush();
    expect(res.status).toBe(201);
    expect(createdLead().system.callConsent).toMatchObject({ granted: true, phoneDigits: '12125550142' });
  });
});

describe('forward-lead call consent: unticked box and no phone', () => {
  it('granted: false (an unticked box) is the normal case: created without consent and NO warning', async () => {
    const res = await post({ callConsent: consent({ granted: false }) });
    await flush();
    expect(res.status).toBe(201);
    expect(createdLead().system).toBeUndefined();
    expect(warnLines(warn)).toEqual([]);
  });
  it('a valid callConsent with no phone in the submission is ignored (no number to bind it to): one warning no_phone', async () => {
    const res = await request(app).post('/api/webhooks/forward-lead').send({ listId: 'list_1', email: 'a@b.com', callConsent: consent() });
    await flush();
    expect(res.status).toBe(201);
    expect(createdLead().system).toBeUndefined();
    expect(warnLines(warn)).toEqual(['[forward-lead] call consent ignored: no_phone']);
  });
});

describe('forward-lead call consent: an existing lead submitting again', () => {
  const existing = (over: Record<string, unknown> = {}) => ({ leadId: 'lead_old', listId: 'list_1', email: 'a@b.com', firstName: 'Old', phone: '(212) 555-0142', customFields: { source: 'landing-page' }, ...over });

  it('records consent once when the lead has none, and dispatches the call gates AFTER the record is written', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existing());
    const res = await post({ callConsent: consent() });
    await flush();
    expect(res.status).toBe(200);
    expect(crmDb.createLead).not.toHaveBeenCalled();
    expect(crmDb.createLeadSystemRecordOnce).toHaveBeenCalledTimes(1);
    const [listId, leadId, key, rec] = (crmDb.createLeadSystemRecordOnce as jest.Mock).mock.calls[0];
    expect([listId, leadId, key]).toEqual(['list_1', 'lead_old', 'callConsent']);
    expect(rec).toMatchObject({ granted: true, text: TEXT, source: 'form' });
    expect((crmDb.updateLead as jest.Mock).mock.calls.every((c) => !('system' in c[2]))).toBe(true); // never a full-map system overwrite
    expect(dispatchLeadCreated).toHaveBeenCalledWith('list_1', 'lead_old', 'form_fill', expect.objectContaining({ submissionId: expect.any(String) }));
    expect((crmDb.createLeadSystemRecordOnce as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((dispatchLeadCreated as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('records when the submitted phone is the lead\'s own number written another way (same E.164)', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existing({ phone: '2125550142' }));
    await post({ phone: '+1 (212) 555-0142', callConsent: consent() });
    await flush();
    expect(crmDb.createLeadSystemRecordOnce).toHaveBeenCalledTimes(1);
    expect((crmDb.createLeadSystemRecordOnce as jest.Mock).mock.calls[0][3]).toMatchObject({ phoneDigits: '12125550142' });
  });

  it('FORGERY: V\'s email + a DIFFERENT phone + a ticked box records NOTHING on V (one warning phone_mismatch, lead still processed)', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existing());
    const res = await post({ phone: '(646) 555-0188', callConsent: consent() });
    await flush();
    expect(res.status).toBe(200);
    expect(crmDb.createLeadSystemRecordOnce).not.toHaveBeenCalled();
    expect(warnLines(warn)).toEqual(['[forward-lead] call consent ignored: phone_mismatch']);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('6465550188');
  });

  it('a lead that consented with phone A and resubmits with phone B: the merge may change the stored phone, and the gate then refuses', async () => {
    const { hasCallConsent } = jest.requireActual('../services/voice/callConsent');
    const consented = existing({ system: { callConsent: { granted: true, text: TEXT, phoneDigits: '12125550142', capturedAt: '2026-01-01T00:00:00.000Z', source: 'form' } } });
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(consented);
    await post({ phone: '(646) 555-0188', callConsent: consent() });
    await flush();
    const update = (crmDb.updateLead as jest.Mock).mock.calls[0][2];
    expect(update.phone).toBe('(646) 555-0188'); // an email-matched merge DOES overwrite the stored phone
    expect(crmDb.createLeadSystemRecordOnce).not.toHaveBeenCalled(); // first record kept, nothing new written
    expect(hasCallConsent({ ...consented, ...update })).toBe(false); // the old record cannot cover the new number
    expect(hasCallConsent(consented)).toBe(true);
  });

  it('keeps the FIRST record: a lead that already has consent is not written again, even with a different text', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existing({ system: { callConsent: { granted: true, text: 'first text that mentions a call, long enough', capturedAt: '2026-01-01T00:00:00.000Z', source: 'form' } } }));
    await post({ callConsent: consent({ text: `${TEXT} (changed)` }) });
    await flush();
    expect(crmDb.createLeadSystemRecordOnce).not.toHaveBeenCalled();
  });

  it('a repeat submission without consent writes nothing about consent', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existing());
    await post({});
    await flush();
    expect(crmDb.createLeadSystemRecordOnce).not.toHaveBeenCalled();
  });

  it('a failed consent write does not fail the submission (the lead is then skipped by the gate, never called)', async () => {
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(existing());
    (crmDb.createLeadSystemRecordOnce as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await post({ callConsent: consent() });
    await flush();
    expect(res.status).toBe(200);
  });
});

describe('forward-lead call consent: idempotent replay', () => {
  let dynamo: InMemoryDynamo;
  beforeEach(() => {
    dynamo = new InMemoryDynamo({ 'AW-Configs': { hash: 'userId', range: 'configId' }, 'Dev-AW-Configs': { hash: 'userId', range: 'configId' } });
    __configureLeadSubmissionIdempotencyForTests({ client: new (dynamo.documentClient as unknown as new () => never)(), waitAttempts: 3, waitDelayMs: 5 });
  });
  afterAll(() => __configureLeadSubmissionIdempotencyForTests({ client: null }));

  it('the replayed request writes no lead and no consent, and the original lead kept its consent', async () => {
    const body = { callConsent: consent(), submissionId: '6f1c2b1e-1111-4a6b-9c8d-0000000000c1' };
    const first = await post(body);
    await flush();
    const second = await post(body);
    await flush();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(crmDb.createLead).toHaveBeenCalledTimes(1);
    expect(createdLead().system.callConsent.granted).toBe(true);
    expect(crmDb.createLeadSystemRecordOnce).not.toHaveBeenCalled();
    expect(JSON.stringify(createdLead().customFields)).not.toContain('callConsent');
  });
});
