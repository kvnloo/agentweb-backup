/**
 * ENG-2123 — phone-only capture dedupe in POST /api/webhooks/forward-lead, by rollout mode.
 *
 *   off     today's behaviour, byte for byte (the default; also what a failed settings read yields)
 *   create  concurrent same-phone captures collapse (phoneUniqueCreate), no lookup
 *   shadow  create + lookup + LOG, never merge
 *   on      create + lookup + merge a repeat visitor into the oldest compatible row
 *
 * Merging two different people is the irreversible failure, so most cases here are the ones that must
 * NOT merge.
 */
import request from 'supertest';
import express from 'express';
import webhookRouter from '../routes/webhooks';
import { crmDb, userDb } from '../services/db';
import { setPhoneDedupeModeOverride } from '../utils/phoneLeadDedupeMode';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    getLeadById: jest.fn(),
    getLeadIdsByPhoneKey: jest.fn(),
    mergeSessionLeadEvent: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));
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
jest.mock('../services/roadmapDelivery', () => ({ sendRoadmapDeliveryEmail: jest.fn().mockResolvedValue(false) }));
jest.mock('../services/webhookService', () => ({
  webhookService: { initialize: jest.fn(), verifyWebhook: jest.fn(), extractEmailDomain: jest.fn(), generateEventId: jest.fn() },
}));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: { eventExists: jest.fn(), addEventEmail: jest.fn(), addEmailEvent: jest.fn() } }));
jest.mock('../services/orgLeadNotificationService', () => ({ dispatchLeadCreated: jest.fn().mockResolvedValue(undefined) }));

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhookRouter);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

const PHONE = '(212) 456-7890';
const KEY = '2124567890';
const list = (listType?: string) => ({ listId: 'L1', userId: 'u1', name: 'Phone list', publicAccessEnabled: true, ...(listType ? { listType } : {}) });
const existing = (over: any = {}) => ({
  leadId: 'lead_1700000000000_aaaaaaaaa', listId: 'L1', firstName: 'Ana', lastName: '', phone: '+1 212 456 7890',
  createdAt: '2026-10-01T00:00:00.000Z', customFields: {}, ...over,
});
const post = async (extra: Record<string, any> = {}) => {
  const r = await request(app).post('/api/webhooks/forward-lead').send({ listId: 'L1', phone: PHONE, firstName: 'Ana', source: 'lp', customFields: {}, ...extra });
  await flush();
  return r;
};
const createCalls = () => (crmDb.createLead as jest.Mock).mock.calls;
const logged = () => (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[phone-dedupe]'));

beforeEach(() => {
  jest.clearAllMocks();
  setPhoneDedupeModeOverride('off');
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  (crmDb.getLeadListById as jest.Mock).mockResolvedValue(list());
  (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(null);
  (crmDb.createLead as jest.Mock).mockImplementation(async (_l: string, d: any) => ({ ...d, listId: 'L1', leadId: d.leadId || 'lead_new' }));
  (crmDb.updateLead as jest.Mock).mockResolvedValue(undefined);
  (crmDb.getLeadIdsByPhoneKey as jest.Mock).mockResolvedValue({ available: true, leadIds: [], capped: false });
  (crmDb.getLeadById as jest.Mock).mockResolvedValue(null);
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'u1', connected_accounts: [] });
});
afterEach(() => { setPhoneDedupeModeOverride(null); jest.restoreAllMocks(); });

const withCandidates = (rows: any[]) => {
  (crmDb.getLeadIdsByPhoneKey as jest.Mock).mockResolvedValue({ available: true, leadIds: rows.map((r) => r.leadId), capped: false });
  (crmDb.getLeadById as jest.Mock).mockImplementation(async (_l: string, id: string) => rows.find((r) => r.leadId === id) ?? null);
};

describe('mode off (default)', () => {
  it('creates exactly as before: no phoneUniqueCreate, no lookup, 201', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(createCalls()).toHaveLength(1);
    expect(createCalls()[0][1]).not.toHaveProperty('phoneUniqueCreate');
    expect(crmDb.getLeadIdsByPhoneKey).not.toHaveBeenCalled();
  });
});

describe('mode create', () => {
  it('asks for the exactly-once create and does not look anything up', async () => {
    setPhoneDedupeModeOverride('create');
    await post();
    expect(createCalls()[0][1]).toMatchObject({ phoneUniqueCreate: true });
    expect(crmDb.getLeadIdsByPhoneKey).not.toHaveBeenCalled();
  });

  it('a concurrent loser naming the SAME person adopts the winner (merge, never a second row)', async () => {
    setPhoneDedupeModeOverride('create');
    const winner = existing();
    (crmDb.createLead as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('dup'), { duplicatePhone: true, existingLead: winner }));
    (crmDb.getLeadById as jest.Mock).mockResolvedValue(winner);
    const res = await post({ company: 'Acme' });
    expect(createCalls()).toHaveLength(1);
    expect(crmDb.updateLead).toHaveBeenCalledWith('L1', winner.leadId, expect.objectContaining({ company: 'Acme' }));
    expect(res.status).toBe(200);
    expect(res.body.leadId).toBe(winner.leadId);
  });

  it('a loser whose winner has since been given a corrected phone is NOT merged (the carried row is stale)', async () => {
    setPhoneDedupeModeOverride('create');
    const carried = existing();
    (crmDb.createLead as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('dup'), { duplicatePhone: true, existingLead: carried }));
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({ ...carried, phone: '+1 646 555 0188' });
    const res = await post();
    expect(res.status).toBe(201);
    expect(createCalls()).toHaveLength(2);
    expect(createCalls()[1][1]).not.toHaveProperty('phoneUniqueCreate');
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('a loser whose winner has since gained an email is NOT merged', async () => {
    setPhoneDedupeModeOverride('create');
    const carried = existing();
    (crmDb.createLead as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('dup'), { duplicatePhone: true, existingLead: carried }));
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({ ...carried, email: 'ana@example.com' });
    const res = await post();
    expect(res.status).toBe(201);
    expect(createCalls()).toHaveLength(2);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('a concurrent loser naming a DIFFERENT person becomes its own row on an ordinary id (no overwrite)', async () => {
    setPhoneDedupeModeOverride('create');
    const winner = existing({ firstName: 'Bob' });
    (crmDb.createLead as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('dup'), { duplicatePhone: true, existingLead: winner }));
    const res = await post({ firstName: 'Ana' });
    expect(res.status).toBe(201);
    expect(createCalls()).toHaveLength(2);
    expect(createCalls()[1][1]).not.toHaveProperty('phoneUniqueCreate');
    expect(createCalls()[1][1]).toMatchObject({ firstName: 'Ana' });
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });
});

describe('mode shadow', () => {
  it('looks up and logs the decision but NEVER merges, even when a match exists', async () => {
    setPhoneDedupeModeOverride('shadow');
    withCandidates([existing()]);
    const res = await post();
    expect(res.status).toBe(201);
    expect(crmDb.getLeadIdsByPhoneKey).toHaveBeenCalledWith('L1', KEY);
    expect(createCalls()).toHaveLength(1);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
    expect(logged()).toEqual(['[phone-dedupe] mode=shadow list=L1 decision=match candidates=1 valid=1']);
  });

  it('the log carries no phone number, name or lead id', async () => {
    setPhoneDedupeModeOverride('shadow');
    withCandidates([existing()]);
    await post();
    const line = logged().join('\n');
    expect(line).not.toContain(KEY);
    expect(line).not.toContain('456');
    expect(line).not.toContain('Ana');
    expect(line).not.toContain('lead_');
  });
});

describe('mode on', () => {
  beforeEach(() => setPhoneDedupeModeOverride('on'));

  it('merges a repeat visitor into the existing row: no new row', async () => {
    const row = existing();
    withCandidates([row]);
    const res = await post({ company: 'Acme' });
    expect(createCalls()).toHaveLength(0);
    expect(crmDb.updateLead).toHaveBeenCalledWith('L1', row.leadId, expect.objectContaining({ company: 'Acme' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ event: 'lead.updated', leadId: row.leadId });
  });

  it('merges into the OLDEST compatible row, by createdAt not by id', async () => {
    const newer = existing({ leadId: 'lead_a_newer', createdAt: '2026-10-10T00:00:00.000Z' });
    const older = existing({ leadId: 'lead_z_older', createdAt: '2026-09-01T00:00:00.000Z' });
    withCandidates([newer, older]);
    await post({ company: 'Acme' });
    expect(crmDb.updateLead).toHaveBeenCalledWith('L1', 'lead_z_older', expect.anything());
  });

  it('re-reads every index candidate CONSISTENTLY (the index is eventually consistent and KEYS_ONLY)', async () => {
    withCandidates([existing()]);
    await post();
    expect(crmDb.getLeadById).toHaveBeenCalledWith('L1', existing().leadId, { consistentRead: true });
  });

  it('a row naming a different person is NOT merged into: a new row is created', async () => {
    withCandidates([existing({ firstName: 'Bob' })]);
    const res = await post({ firstName: 'Ana' });
    expect(res.status).toBe(201);
    expect(createCalls()).toHaveLength(1);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
    expect(logged()[0]).toContain('decision=name-conflict');
  });

  it('skips the conflicting row and merges into a compatible one', async () => {
    withCandidates([existing({ leadId: 'lead_bob', firstName: 'Bob', createdAt: '2026-08-01T00:00:00.000Z' }), existing({ leadId: 'lead_ana', createdAt: '2026-09-01T00:00:00.000Z' })]);
    await post({ company: 'Acme' });
    expect(crmDb.updateLead).toHaveBeenCalledWith('L1', 'lead_ana', expect.anything());
  });

  it('a blank name on one side is not a conflict (a later step of a multi-step lander)', async () => {
    withCandidates([existing({ firstName: 'Ana' })]);
    await post({ firstName: '', company: 'Acme' });
    expect(createCalls()).toHaveLength(0);
    expect(crmDb.updateLead).toHaveBeenCalled();
  });

  it('a shared line (more rows than the fan-out cap) is never merged', async () => {
    (crmDb.getLeadIdsByPhoneKey as jest.Mock).mockResolvedValue({ available: true, leadIds: ['a', 'b', 'c', 'd', 'e', 'f'], capped: true });
    const res = await post();
    expect(res.status).toBe(201);
    expect(createCalls()).toHaveLength(1);
    expect(crmDb.getLeadById).not.toHaveBeenCalled();
    expect(logged()[0]).toContain('decision=shared-line');
  });

  it.each(['shadow', 'on'] as const)('a known shared line (%s) also opts out of the same-bucket exactly-once create', async (mode) => {
    setPhoneDedupeModeOverride(mode);
    (crmDb.getLeadIdsByPhoneKey as jest.Mock).mockResolvedValue({ available: true, leadIds: ['a', 'b', 'c', 'd', 'e', 'f'], capped: true });
    await post();
    expect(createCalls()[0][1]).not.toHaveProperty('phoneUniqueCreate');
  });

  it('a STALE index entry (the row has since gained an email) is ignored', async () => {
    withCandidates([existing({ email: 'ana@example.com' })]);
    await post();
    expect(createCalls()).toHaveLength(1);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('a STALE index entry (the phone was edited to another number) is ignored', async () => {
    withCandidates([existing({ phone: '+1 303 456 7890' })]);
    await post();
    expect(createCalls()).toHaveLength(1);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('a row that vanished between the index read and the re-read is ignored', async () => {
    (crmDb.getLeadIdsByPhoneKey as jest.Mock).mockResolvedValue({ available: true, leadIds: ['gone'], capped: false });
    await post();
    expect(createCalls()).toHaveLength(1);
  });

  it('the index missing or not permitted is reported as UNAVAILABLE in the log (not a plain miss), so shadow data shows it', async () => {
    (crmDb.getLeadIdsByPhoneKey as jest.Mock).mockResolvedValue({ available: false, leadIds: [], capped: false });
    await post();
    expect(logged()[0]).toContain('decision=unavailable');
  });

  it('the index missing or not permitted is a miss: the capture still creates', async () => {
    (crmDb.getLeadIdsByPhoneKey as jest.Mock).mockResolvedValue({ available: false, leadIds: [], capped: false });
    const res = await post();
    expect(res.status).toBe(201);
    expect(createCalls()).toHaveLength(1);
  });

  it('a lookup that THROWS never fails the capture', async () => {
    (crmDb.getLeadIdsByPhoneKey as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await post();
    expect(res.status).toBe(201);
    expect(createCalls()).toHaveLength(1);
  });
});

describe('where no phone dedupe applies, in ANY mode', () => {
  beforeEach(() => setPhoneDedupeModeOverride('on'));
  const untouched = () => {
    expect(crmDb.getLeadIdsByPhoneKey).not.toHaveBeenCalled();
    for (const c of createCalls()) expect(c[1]).not.toHaveProperty('phoneUniqueCreate');
  };

  it.each([['sequential', '1234567890'], ['one repeated digit', '555-555-5555'], ['too short', '415-0142'], ['NANP exchange starting with 1', '212 156 7890']])(
    'a junk or non-specific number (%s)', async (_n, phone) => {
      withCandidates([existing({ phone })]);
      const res = await post({ phone });
      expect(res.status).toBe(201);
      untouched();
    });

  it('the synthetic smoke-test number keeps its own deterministic-id path', async () => {
    await post({ phone: '(415) 555-0142' });
    expect(createCalls()[0][1]).toMatchObject({ failIfExists: true });
    expect(createCalls()[0][1].leadId).toMatch(/^lead_ph_/);
    untouched();
  });

  it('a session list', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(list('session'));
    await post();
    untouched();
  });

  it('a capture that carries a linkedin URL (createLead never gives it a phoneKey)', async () => {
    withCandidates([existing()]);
    const res = await post({ linkedin: 'https://www.linkedin.com/in/ana' });
    expect(res.status).toBe(201);
    untouched();
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });

  it('a capture that carries an email follows the email path only', async () => {
    await post({ email: 'ana@example.com' });
    expect(createCalls()[0][1]).toMatchObject({ emailUniqueCreate: true });
    untouched();
  });
});
