/**
 * Twilio voice webhooks (ENG-2271): signature guard, per-endpoint state machine, metering.
 * The store is FakeLeadCallStore, an in-memory fake with the same conditional semantics as LeadCallStore.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { getExpectedTwilioSignature } from 'twilio';

const mockGetCreds = jest.fn();
jest.mock('../utils/secretsManager', () => ({ getTwilioCredentials: (...a: unknown[]) => mockGetCreds(...a) }));
jest.mock('../services/db', () => ({
  crmDb: { getLeadListById: jest.fn(), getLeadById: jest.fn(), updateLead: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/voice/voiceUsage', () => ({ recordCallUsage: jest.fn() }));
jest.mock('../services/hotLeadCallAttempts', () => ({ requestNextHotLeadCallAttempt: jest.fn() }));
// The lead-local window depends on the wall clock; held open by default, closed per test (the window itself is
// covered by leadLocalHours.test.ts).
jest.mock('../services/voice/leadLocalHours', () => ({ isInsideLeadCallWindow: jest.fn() }));

import { crmDb, orgDb, userDb } from '../services/db';
import { isInsideLeadCallWindow } from '../services/voice/leadLocalHours';
import { recordCallUsage } from '../services/voice/voiceUsage';
import { requestNextHotLeadCallAttempt } from '../services/hotLeadCallAttempts';
import { nextAttemptOrFinish } from '../services/voice/callFinalisation';
import { leadPhoneMacOf } from '../services/voice/leadPhoneMac';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { setLeadCallStoreForTests } from '../services/voice/leadCallStore';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { FakeVoiceProvider } from './helpers/fakeVoiceProvider';
import { FakeLeadCallStore } from './helpers/fakeLeadCallStore';
import { FakeLimitStore } from './helpers/fakeLimitStore';
import { setLimitStoreForTests } from '../services/voice/limitStore';
import { dncKey, setDncRetryDelayForTests } from '../services/voice/hotLeadCallDnc';
import type { HotLeadCallRecord, HotLeadCallState } from '../services/voice/leadCallStore.types';
import * as twiml from '../services/voice/twiml';
import { buildVoiceWebhookUrl } from '../services/voice/voiceUrls';
import twilioVoiceWebhookRoutes, { twilioVoiceBodyParser } from '../routes/twilioVoiceWebhook';
import { teamMember, MEMBER_ID } from './helpers/hotLeadCallFixtures';

const mock = (fn: unknown) => fn as jest.Mock;
const BASE = 'https://api.example.test';
const MOUNT = '/api/webhooks/twilio-voice';
const LIST = 'list-a';
const LEAD = 'lead-a';
const JOB = 'job-1';
const MEMBER_SID = 'CA00000001';
const LEAD_SID = 'CA00000002';
const MEMBER_PHONE = '+14155550100';
const TWILIO_NUMBER = '+14155550111';
const LEAD_PHONE = '+14155550123';
const QUERY = `listId=${LIST}&leadId=${LEAD}&jobKey=${JOB}`;
const NEXT_MEMBER_SID = 'CA00000003';

const orgConfig = {
  enabled: true,
  team: [teamMember(MEMBER_PHONE)],
  twilioNumber: TWILIO_NUMBER,
  announcedName: 'Smith & Sons',
  callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
};

let store: FakeLeadCallStore;
let fake: FakeVoiceProvider;
let limits: FakeLimitStore;
let logSpy: jest.SpyInstance[];

function seed(state: HotLeadCallState, extra: Partial<HotLeadCallRecord> = {}) {
  store.record = {
    state, jobKey: JOB, startedAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
    memberCallSid: MEMBER_SID, attemptNo: 1, memberId: MEMBER_ID, triedMemberIds: [MEMBER_ID], meteredLegs: [], lastSequence: {},
    leadPhoneMac: leadPhoneMacOf('org-a', LEAD_PHONE), ...extra,
  };
}

/** `errorHandler` stands in for app.ts's global handler, which logs and reports whatever reaches it. */
const app = (opts: { errorHandler?: (err: unknown) => void } = {}) => {
  const a = express();
  // Same order as app.ts: the route's narrow parser first, then the global wide ones.
  a.use(MOUNT, twilioVoiceBodyParser);
  a.use(express.json({ limit: '50mb' }));
  a.use(express.urlencoded({ limit: '50mb', extended: true }));
  a.use(MOUNT, twilioVoiceWebhookRoutes);
  // Express only treats a 4-argument function as an error handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the 4-argument signature is what makes it an error handler
  a.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    opts.errorHandler?.(err);
    res.status(500).end();
  });
  return a;
};

interface PostOpts { query?: string; signature?: string | null; host?: string }
function post(endpoint: string, params: Record<string, string>, opts: PostOpts = {}) {
  const req = request(app()).post(`${MOUNT}/${endpoint}?${opts.query ?? QUERY}`).type('form');
  if (opts.signature !== null) req.set('X-Twilio-Signature', opts.signature ?? 'sig');
  if (opts.host) req.set('Host', opts.host);
  return req.send(params);
}
const memberPrompt = (extra: Record<string, string> = {}) => post('owner', { CallSid: MEMBER_SID, CallStatus: 'in-progress', ...extra });
const gather = (digits?: string, extra: Record<string, string> = {}) =>
  post('gather', { CallSid: MEMBER_SID, ...(digits === undefined ? {} : { Digits: digits }), ...extra });
const dial = (status: string, extra: Record<string, string> = {}) =>
  post('dial', { CallSid: MEMBER_SID, DialCallStatus: status, ...extra });
const memberStatus = (callStatus: string, extra: Record<string, string> = {}) =>
  post('status', { CallSid: MEMBER_SID, CallStatus: callStatus, ...extra });
const screen = (extra: Record<string, string> = {}, sid = LEAD_SID) => post('screen', { CallSid: sid, CallStatus: 'in-progress', ...extra });
const screenResult = (digits?: string, extra: Record<string, string> = {}, sid = LEAD_SID) =>
  post('screen-result', { CallSid: sid, ...(digits === undefined ? {} : { Digits: digits }), ...extra });
const leadStatus = (callStatus: string, extra: Record<string, string> = {}) =>
  post('status', { CallSid: LEAD_SID, ParentCallSid: MEMBER_SID, CallStatus: callStatus, ...extra }, { query: `${QUERY}&leg=lead` });

/** The console.warn spy (logSpy is log, warn, error, info in that order). */
const warnSpy = (): jest.SpyInstance => logSpy[1];

const usage = () => mock(recordCallUsage).mock.calls.map((c) => c[0]);

beforeEach(() => {
  jest.resetAllMocks();
  mock(isInsideLeadCallWindow).mockReturnValue(true);
  process.env.BACKEND_URL = `${BASE}/`;
  process.env.JWT_SECRET = 'test-secret';
  mock(requestNextHotLeadCallAttempt).mockResolvedValue({ enqueued: false, reason: 'no_candidates' });
  store = new FakeLeadCallStore();
  setLeadCallStoreForTests(store);
  limits = new FakeLimitStore();
  setLimitStoreForTests(limits);
  fake = new FakeVoiceProvider();
  setVoiceProviderForTests(fake);
  setHotLeadCallEnabledOverride(true);
  mock(crmDb.getLeadListById).mockResolvedValue({ listId: LIST, userId: 'owner-a' });
  mock(userDb.getUserById).mockResolvedValue({ userId: 'owner-a', orgId: 'org-a' });
  mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: orgConfig });
  mock(crmDb.getLeadById).mockResolvedValue({ listId: LIST, leadId: LEAD, phone: LEAD_PHONE });
  mock(recordCallUsage).mockResolvedValue(undefined);
  logSpy = (['log', 'warn', 'error', 'info'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
});

afterEach(() => {
  setVoiceProviderForTests(null);
  setLeadCallStoreForTests(null);
  setLimitStoreForTests(null);
  setHotLeadCallEnabledOverride(null);
  logSpy.forEach((s) => s.mockRestore());
  delete process.env.BACKEND_URL;
  delete process.env.JWT_SECRET;
});

const digitsOf = (s: string) => s.replace(/\D/g, '');
const noPhoneIn = (text: string) => {
  for (const p of [MEMBER_PHONE, LEAD_PHONE, TWILIO_NUMBER]) expect(digitsOf(text)).not.toContain(digitsOf(p));
};

// ── guard ────────────────────────────────────────────────────────────────────

// The state each endpoint's guard tests start from: the screening endpoints only act on a record that is already bridging.
const ENDPOINTS: Array<[string, () => request.Test, HotLeadCallState, Partial<HotLeadCallRecord>]> = [
  ['owner', () => memberPrompt(), 'member_answered', {}],
  ['gather', () => gather('1'), 'member_answered', {}],
  ['dial', () => dial('no-answer'), 'member_answered', {}],
  ['status', () => memberStatus('completed', { CallDuration: '30' }), 'member_answered', {}],
  ['screen', () => screen(), 'bridging', { leadCallSid: LEAD_SID }],
  ['screen-result', () => screenResult('1'), 'bridging', { leadCallSid: LEAD_SID }],
];

// Each guard test starts a fresh log window (the "cannot verify" line is logged once per window).
let guardClock = 1_800_000_000_000;
describe.each(ENDPOINTS)('%s guard', (name, call, startState, startExtra) => {
  let nowSpy: jest.SpyInstance;
  beforeEach(() => {
    seed(startState, { meteredLegs: [], ...startExtra });
    guardClock += 60_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => guardClock);
  });
  afterEach(() => nowSpy.mockRestore());

  it('answers 503 and processes nothing when credentials cannot be loaded', async () => {
    fake.ensureCredentials = async () => { throw new Error('secrets down'); };
    const res = await call();
    expect(res.status).toBe(503);
    expect(fake.signatureChecks).toHaveLength(0);
    expect(store.transitions).toBe(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('logs a credentials outage once per window, not once per unauthenticated request', async () => {
    fake.ensureCredentials = async () => { throw new Error('secrets down'); };
    for (let i = 0; i < 20; i++) expect((await call()).status).toBe(503);
    const outageLines = () => logSpy.flatMap((s) => s.mock.calls).filter((c) => String(c[0]).includes('cannot verify callback'));
    expect(outageLines()).toHaveLength(1);
    guardClock += 5_001;
    await call();
    expect(outageLines()).toHaveLength(2);
  });

  it('logs only the error name when it cannot verify (no message, no params)', async () => {
    fake.ensureCredentials = async () => { throw new Error(`secret ${LEAD_PHONE}`); };
    await call();
    const logs = JSON.stringify(logSpy.flatMap((s) => s.mock.calls));
    expect(logs).toContain('cannot verify callback');
    expect(logs).not.toContain('secret');
  });

  it('answers 401 when the signature header is missing', async () => {
    const res = await post(name, { CallSid: MEMBER_SID }, { signature: null });
    expect(res.status).toBe(401);
    expect(store.transitions).toBe(0);
  });

  it('answers 401 for a signature the provider rejects, and writes nothing', async () => {
    fake.signatureValid = false;
    const res = await call();
    expect(res.status).toBe(401);
    expect(store.transitions).toBe(0);
    expect(store.events).toHaveLength(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('verifies against BACKEND_URL + the request path and query, never the Host header', async () => {
    await post(name, { CallSid: MEMBER_SID }, { host: 'evil.example' });
    expect(fake.signatureChecks).toHaveLength(1);
    expect(fake.signatureChecks[0].url).toBe(`${BASE}${MOUNT}/${name}?${QUERY}`);
    expect(fake.signatureChecks[0].params).toEqual({ CallSid: MEMBER_SID });
  });

  it('awaits credentials before verifying (the strict fake rejects otherwise)', async () => {
    await call();
    expect(fake.ensureCredentialsCalls).toBe(1);
    expect(fake.signatureChecks).toHaveLength(1);
  });

  it.each([
    ['an unexpected query key', `${QUERY}&extra=1`],
    ['a repeated query key', `${QUERY}&listId=other`],
    ['a malformed id', `listId=${LIST}&leadId=a%20b&jobKey=${JOB}`],
    ['a missing jobKey', `listId=${LIST}&leadId=${LEAD}`],
    ['an unknown leg', `${QUERY}&leg=both`],
  ])('ignores %s without writing (safe answer, HTTP 200)', async (_label, query) => {
    const res = await post(name, { CallSid: MEMBER_SID, Digits: '1', DialCallStatus: 'no-answer', CallStatus: 'completed' }, { query });
    expect(res.status).toBe(200);
    if (name === 'status') expect(res.text).toBe('');
    else expect(res.text).toContain('<Hangup/>');
    expect(store.transitions).toBe(0);
    expect(store.events).toHaveLength(0);
  });

  it('ignores a callback whose jobKey is not the record\'s', async () => {
    const res = await post(name, { CallSid: MEMBER_SID, Digits: '1', DialCallStatus: 'no-answer', CallStatus: 'completed' }, { query: `listId=${LIST}&leadId=${LEAD}&jobKey=old-job` });
    expect(res.status).toBe(200);
    expect(store.transitions).toBe(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('ignores a callback when no record exists', async () => {
    store.record = null;
    const res = await call();
    expect(res.status).toBe(200);
    expect(store.events).toHaveLength(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('ignores a callback for a different CallSid', async () => {
    const res = await post(name, { CallSid: 'CA09999999', Digits: '1', DialCallStatus: 'no-answer', CallStatus: 'completed', CallDuration: '9' });
    expect(res.status).toBe(200);
    expect(store.transitions).toBe(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });
});

describe('signature with the real provider', () => {
  const TOKEN = 'unit-test-token';
  beforeEach(() => {
    setVoiceProviderForTests(null);
    mockGetCreds.mockResolvedValue({ accountSid: 'ACfake0123456789abcdef0123456789ab', authToken: TOKEN });
    seed('member_ringing');
  });
  const signed = (query: string, params: Record<string, string>, token = TOKEN) =>
    getExpectedTwilioSignature(token, `${BASE}${MOUNT}/owner?${query}`, params);

  it('loads credentials, then accepts a genuine Twilio signature', async () => {
    const params = { CallSid: MEMBER_SID, CallStatus: 'in-progress' };
    const res = await post('owner', params, { signature: signed(QUERY, params) });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather');
    expect(mockGetCreds).toHaveBeenCalled();
    expect(store.record?.state).toBe('member_answered');
  });

  it.each([
    ['a tampered query', (p: Record<string, string>) => ({ query: `listId=${LIST}&leadId=other&jobKey=${JOB}`, sig: signed(QUERY, p), params: p })],
    ['a tampered body', (p: Record<string, string>) => ({ query: QUERY, sig: signed(QUERY, p), params: { ...p, CallStatus: 'completed' } })],
    ['the wrong auth token', (p: Record<string, string>) => ({ query: QUERY, sig: signed(QUERY, p, 'other-token'), params: p })],
  ])('rejects %s with 401 and writes nothing', async (_label, build) => {
    const { query, sig, params } = build({ CallSid: MEMBER_SID, CallStatus: 'in-progress' });
    const res = await post('owner', params, { query, signature: sig });
    expect(res.status).toBe(401);
    expect(store.record?.state).toBe('member_ringing');
    expect(store.events).toHaveLength(0);
  });

  it('answers 503 when credentials are unavailable, even with a valid-looking signature', async () => {
    mockGetCreds.mockRejectedValue(new Error('no secret'));
    const params = { CallSid: MEMBER_SID };
    const res = await post('owner', params, { signature: signed(QUERY, params) });
    expect(res.status).toBe(503);
    expect(store.record?.state).toBe('member_ringing');
  });
});

// ── /owner ───────────────────────────────────────────────────────────────────

describe('POST /owner', () => {
  it('moves member_ringing to member_answered once and answers the escaped prompt as text/xml', async () => {
    seed('member_ringing');
    const res = await memberPrompt();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('New lead from Smith &amp; Sons. Are you available to take the call now? Press 1.');
    expect(res.text).toContain(`action="${BASE}${MOUNT}/gather?${QUERY}"`.replace(/&/g, '&amp;'));
    expect(store.record?.state).toBe('member_answered');
    expect(store.eventTypes()).toEqual(['call.member_answered']);
    noPhoneIn(res.text);
  });

  it('serves the same prompt again on a Twilio retry without a second event', async () => {
    seed('member_ringing');
    await memberPrompt();
    const res = await memberPrompt();
    expect(res.text).toContain('<Gather');
    expect(store.eventTypes()).toEqual(['call.member_answered']);
  });

  it.each(['bridging', 'connected', 'finished'] as const)('hangs up when the record is already %s', async (state) => {
    seed(state);
    const res = await memberPrompt();
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(store.record?.state).toBe(state);
    expect(store.events).toHaveLength(0);
  });

  it.each([
    ['disabled', { ...orgConfig, enabled: false }],
    ['invalid', { ...orgConfig, maxCallsPerDay: 9999 }],
  ])('hangs up without a prompt when the org config is now %s, recording only the aborted outcome', async (_label, cfg) => {
    seed('member_ringing');
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: cfg });
    const res = await memberPrompt();
    expect(res.text).not.toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'member_answered', outcome: 'aborted' });
    expect(store.eventTypes()).toEqual(['call.failed']);
  });
});

describe('records still in dialing (orchestrator has not stored the member CallSid yet)', () => {
  beforeEach(() => seed('dialing', { memberCallSid: undefined }));

  it('/owner adopts the CallSid of the signed callback and answers the prompt', async () => {
    const res = await memberPrompt();
    expect(res.text).toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'member_answered', memberCallSid: MEMBER_SID });
    expect(store.eventTypes()).toEqual(['call.initiated', 'call.member_answered']);
  });

  it('writes call.initiated once, by the winning adoption only, even when callbacks race', async () => {
    await Promise.all([memberPrompt(), memberPrompt(), memberStatus('in-progress')]);
    expect(store.eventTypes().filter((t) => t === 'call.initiated')).toHaveLength(1);
    expect(store.record?.memberCallSid).toBe(MEMBER_SID);
  });

  it('with both callbacks holding the same stale snapshot, only one adoption writes call.initiated', async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realGet = store.get.bind(store);
    jest.spyOn(store, 'get').mockImplementation(async () => {
      const snapshot = await realGet();
      if (++reads <= 2) {
        if (reads === 2) release();
        await gate; // both requests read 'dialing' before either writes
      }
      return snapshot;
    });
    await Promise.all([memberPrompt(), post('owner', { CallSid: 'CA00000077' })]);
    expect(store.eventTypes().filter((t) => t === 'call.initiated')).toHaveLength(1);
  });

  it('adoption moves the record to member_ringing, so the orchestrator\'s late settle loses and call.initiated is written once', async () => {
    await memberStatus('in-progress');
    expect(store.record).toMatchObject({ state: 'member_ringing', memberCallSid: MEMBER_SID });
    // The orchestrator's settle (dialing -> member_ringing, then call.initiated).
    const settled = await store.transition(LIST, LEAD, ['dialing'], { state: 'member_ringing', memberCallSid: MEMBER_SID });
    if (settled) await store.addEvent(LIST, LEAD, 'call.initiated');
    expect(settled).toBe(false);
    expect(store.eventTypes()).toEqual(['call.initiated']);
  });

  it('keeps the orchestrator\'s placement_unknown outcome untouched when adopting', async () => {
    seed('dialing', { outcome: 'placement_unknown', memberCallSid: undefined });
    await memberStatus('in-progress');
    expect(store.record).toMatchObject({ state: 'member_ringing', outcome: 'placement_unknown' });
  });

  it('the first adopted sid wins: a racing callback with another sid cannot replace it', async () => {
    await Promise.all([memberPrompt(), post('owner', { CallSid: 'CA00000077' })]);
    expect(['CA00000077', MEMBER_SID]).toContain(store.record?.memberCallSid);
    const first = store.record?.memberCallSid;
    await post('owner', { CallSid: first === MEMBER_SID ? 'CA00000077' : MEMBER_SID });
    expect(store.record?.memberCallSid).toBe(first);
  });

  it('does not adopt for a callback whose jobKey is not the record\'s', async () => {
    const res = await post('owner', { CallSid: MEMBER_SID }, { query: `listId=${LIST}&leadId=${LEAD}&jobKey=other-job` });
    expect(res.text).not.toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'dialing' });
    expect(store.record?.memberCallSid).toBeUndefined();
  });

  it('does not adopt a malformed CallSid', async () => {
    const res = await post('owner', { CallSid: 'not-a-sid' });
    expect(res.text).not.toContain('<Gather');
    expect(store.record?.memberCallSid).toBeUndefined();
  });

  it('keeps the adopted sid: a later callback with another sid is ignored', async () => {
    await memberPrompt();
    const res = await post('owner', { CallSid: 'CA09999999' });
    expect(res.text).not.toContain('<Gather');
    expect(store.record?.memberCallSid).toBe(MEMBER_SID);
  });

  it('/gather and /dial never adopt a sid or act on a record that has not been answered', async () => {
    await gather('1');
    await dial('no-answer');
    expect(store.record?.memberCallSid).toBeUndefined();
    expect(store.events).toHaveLength(0);
  });

  it('a lead-leg callback does not adopt anything', async () => {
    await leadStatus('completed', { CallDuration: '5' });
    expect(store.record?.memberCallSid).toBeUndefined();
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('the member final status adopts the sid, meters under it and finishes an unanswered call', async () => {
    await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'member_no_answer', memberCallSid: MEMBER_SID });
    expect(usage()).toEqual([{ userId: 'owner-a', callSid: MEMBER_SID, leg: 'member', durationSeconds: 0 }]);
  });
});

// ── /gather ──────────────────────────────────────────────────────────────────

describe('POST /gather', () => {
  beforeEach(() => seed('member_answered'));

  it('does not dial and tells the member when the lead window closed while the member was answering (lead_outside_hours)', async () => {
    mock(isInsideLeadCallWindow).mockReturnValue(false);
    const res = await gather('1');
    expect(res.text).toContain('could not reach them');
    expect(res.text).not.toContain('<Dial');
    expect(res.text).not.toContain(LEAD_PHONE);
    expect(isInsideLeadCallWindow).toHaveBeenCalledWith(LEAD_PHONE, expect.any(Date));
    expect(store.record).toMatchObject({ state: 'member_answered', outcome: 'lead_outside_hours' });
    expect(store.events).toEqual([{ type: 'call.failed', detail: { reason: 'lead_outside_hours' } }]);
  });

  it('bridges on Digits=1: state bridging, Dial with the lead number from the lead row, status callback with leg=lead', async () => {
    const res = await gather('1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(store.record?.state).toBe('bridging');
    expect(res.text).toContain('Calling the lead now, please hold.');
    expect(res.text).toContain('<Dial answerOnBridge="true"');
    expect(res.text).toContain(`<Number url="${BASE}${MOUNT}/screen?${QUERY.replace(/&/g, '&amp;')}" method="POST"`);
    expect(res.text).toContain(`callerId="${TWILIO_NUMBER}"`);
    expect(res.text).toContain(`>${LEAD_PHONE}</Number>`);
    expect(res.text).toContain(`${MOUNT}/status?${QUERY.replace(/&/g, '&amp;')}&amp;leg=lead#rc=3&amp;rp=5xx,ct"`);
    expect(res.text).toContain(`${MOUNT}/dial?${QUERY.replace(/&/g, '&amp;')}`);
    // The lead number appears in the <Number> element and nowhere else.
    expect(res.text.split(LEAD_PHONE)).toHaveLength(2);
    expect(res.text).not.toContain(MEMBER_PHONE);
  });

  it('never takes the lead number from the request: a Digits/To/Phone in the body is ignored', async () => {
    const res = await gather('1', { To: '+14155559999', Phone: '+14155558888' });
    expect(res.text).toContain(`>${LEAD_PHONE}</Number>`);
    expect(res.text).not.toContain('9999');
    expect(res.text).not.toContain('8888');
  });

  it('normalises a national-format lead number to E.164 before dialing', async () => {
    mock(crmDb.getLeadById).mockResolvedValue({ phone: '(415) 555-0123' });
    const res = await gather('1');
    expect(res.text).toContain(`>${LEAD_PHONE}</Number>`);
  });

  it('does not bridge twice when Digits=1 is replayed', async () => {
    await gather('1');
    const res = await gather('1');
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(store.transitions).toBe(1);
  });

  it.each([['2'], ['11'], [' 1'], ['#'], ['']])('declines on Digits=%j: outcome member_declined, one event, hangup', async (digits) => {
    const res = await gather(digits);
    expect(res.text).toContain('<Hangup/>');
    expect(res.text).not.toContain('<Dial');
    expect(store.record).toMatchObject({ state: 'member_answered', outcome: 'member_declined' });
    expect(store.eventTypes()).toEqual(['call.member_declined']);
  });

  it('treats a missing Digits field as a decline', async () => {
    const res = await gather(undefined);
    expect(res.text).not.toContain('<Dial');
    expect(store.eventTypes()).toEqual(['call.member_declined']);
  });

  it('does not repeat the decline event on replay, and a later "1" cannot reverse it', async () => {
    await gather('2');
    await gather('2');
    const late = await gather('1');
    expect(late.text).not.toContain('<Dial');
    expect(store.record?.state).toBe('member_answered');
    expect(store.eventTypes()).toEqual(['call.member_declined']);
  });

  it.each(['member_ringing', 'bridging', 'connected', 'finished'] as const)('hangs up when the record is %s', async (state) => {
    seed(state);
    const res = await gather('1');
    expect(res.text).not.toContain('<Dial');
    expect(store.record?.state).toBe(state);
    expect(store.events).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['garbage', 'not a number'],
    ['non-US/CA', '+442071838750'],
    ['toll free', '+18005550123'],
    ['no phone field', null],
  ])('answers the apology and records call.failed when the lead phone is %s', async (_label, phone) => {
    mock(crmDb.getLeadById).mockResolvedValue(phone === null ? { leadId: LEAD } : { phone });
    const res = await gather('1');
    expect(res.text).toContain('could not reach them');
    expect(res.text).not.toContain('<Dial');
    expect(store.record).toMatchObject({ state: 'member_answered', outcome: 'lead_phone_invalid' });
    expect(store.events).toEqual([{ type: 'call.failed', detail: { reason: 'lead_phone_invalid' } }]);
  });

  it('answers the apology when the lead row is gone', async () => {
    mock(crmDb.getLeadById).mockResolvedValue(null);
    const res = await gather('1');
    expect(res.text).toContain('could not reach them');
  });

  it('rejects a lead number outside the org allowedCountries even if the global allowlist accepts it', async () => {
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, allowedCountries: ['CA'] } });
    const res = await gather('1');
    expect(res.text).not.toContain('<Dial');
  });

  it('hangs up without dialing when the kill switch is off or the config is disabled', async () => {
    setHotLeadCallEnabledOverride(false);
    expect((await gather('1')).text).not.toContain('<Dial');
    setHotLeadCallEnabledOverride(true);
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, enabled: false } });
    expect((await gather('1')).text).not.toContain('<Dial');
    expect(store.record?.state).toBe('member_answered');
    expect(store.record?.outcome).toBe('aborted');
    expect(store.eventTypes()).toEqual(['call.failed']); // once, the second press is a replay of the decision
  });
});

describe('POST /gather: the lead phone must still be the one that passed the gates', () => {
  beforeEach(() => seed('member_answered'));
  const NEW_PHONE = '+14155550177';

  it('refuses to dial when the live lead phone differs from the one stored at dispatch: lead_phone_changed, call.failed, polite hangup', async () => {
    mock(crmDb.getLeadById).mockResolvedValue({ phone: NEW_PHONE });
    const res = await gather('1');
    expect(res.text).not.toContain('<Dial');
    expect(res.text).toContain('We could not reach the lead. Their details are in your lead alert.');
    expect(res.text).toContain('<Hangup/>');
    expect(store.record).toMatchObject({ state: 'member_answered', outcome: 'lead_phone_changed' });
    expect(store.events).toEqual([{ type: 'call.failed', detail: { reason: 'lead_phone_changed' } }]);
    noPhoneIn(res.text);
    noPhoneIn(JSON.stringify(logSpy.flatMap((s) => s.mock.calls)));
  });

  it('is decided once: a replayed press repeats the message without a second event, and cannot dial', async () => {
    mock(crmDb.getLeadById).mockResolvedValue({ phone: NEW_PHONE });
    await gather('1');
    const again = await gather('1');
    expect(again.text).not.toContain('<Dial');
    expect(store.eventTypes()).toEqual(['call.failed']);
  });

  it('meters the member leg first, then finishes the record with the lead_phone_changed outcome and does not try another member', async () => {
    mock(crmDb.getLeadById).mockResolvedValue({ phone: NEW_PHONE });
    await gather('1');
    expect(store.record?.state).toBe('member_answered');
    await memberStatus('completed', { CallDuration: '15' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'lead_phone_changed', meteredLegs: ['member:1'] });
    expect(store.eventTypes()).toEqual(['call.failed', 'call.completed']);
    expect(usage()).toHaveLength(1);
    expect(requestNextHotLeadCallAttempt).not.toHaveBeenCalled();
  });

  it('dials when the same person typed the number differently (the comparison is on the normalised E.164)', async () => {
    mock(crmDb.getLeadById).mockResolvedValue({ phone: '(415) 555-0123' });
    expect((await gather('1')).text).toContain(`>${LEAD_PHONE}</Number>`);
    expect(store.record?.state).toBe('bridging');
  });

  it('keys the stored value by org: a record minted for another org does not match', async () => {
    seed('member_answered', { leadPhoneMac: leadPhoneMacOf('org-other', LEAD_PHONE) });
    expect((await gather('1')).text).not.toContain('<Dial');
    expect(store.record?.outcome).toBe('lead_phone_changed');
  });

  it('refuses a record that has no stored value: a phone it cannot compare is treated as changed', async () => {
    seed('member_answered', { leadPhoneMac: undefined as unknown as string });
    const res = await gather('1');
    expect(res.text).not.toContain('<Dial');
    expect(store.record?.outcome).toBe('lead_phone_changed');
    expect(store.eventTypes()).toEqual(['call.failed']);
  });

  it('keeps reporting lead_phone_invalid (not changed) when the live number is no longer callable at all', async () => {
    mock(crmDb.getLeadById).mockResolvedValue({ phone: 'garbage' });
    await gather('1');
    expect(store.record?.outcome).toBe('lead_phone_invalid');
  });
});

// ── /screen: the lead answered ───────────────────────────────────────────────

describe('POST /screen', () => {
  beforeEach(() => seed('bridging'));

  it('adopts the body CallSid as the lead leg and asks the lead to press 1, 2 or 3, with the announced name escaped and the org number spoken', async () => {
    const res = await screen();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('Hi, this is an automated call from Smith &amp; Sons. To stop these calls at any time, press 3. We&apos;re calling about the enquiry you sent us. Press 1 and we&apos;ll connect you to a person now, or press 2 and we&apos;ll call you again later. You can also call us on 4 1 5, 5 5 5, 0 1 1 1.');
    expect(res.text).toContain('<Gather input="dtmf" numDigits="1" timeout="8"');
    expect(res.text).toContain(`action="${BASE}${MOUNT}/screen-result?${QUERY.replace(/&/g, '&amp;')}"`);
    expect(res.text).toContain('We did not get your answer. Goodbye.');
    expect(store.record).toMatchObject({ state: 'bridging', leadCallSid: LEAD_SID });
    expect(store.events).toHaveLength(0);
    // The org's own number is spoken on purpose (spaced digits, never as +1...); the member's and the lead's are not.
    expect(res.text).not.toContain(TWILIO_NUMBER);
    for (const p of [MEMBER_PHONE, LEAD_PHONE]) expect(digitsOf(res.text)).not.toContain(digitsOf(p));
  });

  it('serves the same prompt on a Twilio retry without writing again', async () => {
    await screen();
    const writes = store.transitions;
    const res = await screen();
    expect(res.text).toContain('<Gather');
    expect(store.transitions).toBe(writes);
  });

  it('first writer wins: a different sid afterwards is ignored and gets a hangup', async () => {
    await screen();
    const res = await screen({}, 'CA00000099');
    expect(res.text).not.toContain('<Gather');
    expect(res.text).toContain('<Hangup/>');
    expect(store.record?.leadCallSid).toBe(LEAD_SID);
  });

  it('with two different sids racing, exactly one is adopted and only that one is served the prompt', async () => {
    const results = await Promise.all([screen({}, 'CA00000098'), screen({}, 'CA00000099')]);
    expect(results.filter((r) => r.text.includes('<Gather'))).toHaveLength(1);
    expect(['CA00000098', 'CA00000099']).toContain(store.record?.leadCallSid);
  });

  it('keeps a lead sid already learned from the lead status callback', async () => {
    seed('bridging', { leadCallSid: LEAD_SID });
    expect((await screen()).text).toContain('<Gather');
    expect((await screen({}, 'CA00000099')).text).not.toContain('<Gather');
    expect(store.record?.leadCallSid).toBe(LEAD_SID);
  });

  it('never adopts the member sid as the lead leg (the request would not be on the lead\'s leg)', async () => {
    const res = await screen({}, MEMBER_SID);
    expect(res.text).not.toContain('<Gather');
    expect(store.record?.leadCallSid).toBeUndefined();
    expect(store.transitions).toBe(0);
  });

  it('does not adopt a malformed or missing CallSid', async () => {
    expect((await screen({}, 'not-a-sid')).text).not.toContain('<Gather');
    expect((await post('screen', {})).text).not.toContain('<Gather');
    expect(store.record?.leadCallSid).toBeUndefined();
  });

  it.each(['dialing', 'member_ringing', 'member_answered', 'between_attempts', 'connected', 'finished', 'failed'] as const)('hangs up and writes nothing when the record is %s', async (state) => {
    seed(state);
    const res = await screen();
    expect(res.text).not.toContain('<Gather');
    expect(store.transitions).toBe(0);
    expect(store.record?.leadCallSid).toBeUndefined();
  });

  it('ignores a record that does not exist or belongs to another job', async () => {
    expect((await post('screen', { CallSid: LEAD_SID }, { query: `listId=${LIST}&leadId=${LEAD}&jobKey=old` })).text).not.toContain('<Gather');
    store.record = null;
    expect((await screen()).text).not.toContain('<Gather');
  });

  it.each([['missing', undefined], ['not E.164', '4155550111']])('aborts, never as a decline, when the org number is %s (it cannot be read out)', async (_name, number) => {
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, twilioNumber: number } });
    const res = await screen();
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<Gather');
    await screen();
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'aborted' });
    expect(store.eventTypes()).toEqual(['call.failed']);
  });

  it('aborts when the kill switch is off or the config is disabled: no prompt, outcome aborted once, never relabelled as a decline', async () => {
    setHotLeadCallEnabledOverride(false);
    const res = await screen();
    expect(res.text).not.toContain('<Gather');
    await screen();
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'aborted' });
    expect(store.eventTypes()).toEqual(['call.failed']);
    const dialed = await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' });
    expect(dialed.text).toContain('did not confirm');
    expect(store.record?.outcome).toBe('aborted');
    expect(store.eventTypes()).toEqual(['call.failed']);
  });
});

describe('POST /screen-result', () => {
  beforeEach(() => seed('bridging', { leadCallSid: LEAD_SID }));

  it('Digits=1: answers an empty response (the bridge proceeds), records the decision and the connection once', async () => {
    const res = await screenResult('1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(store.record).toMatchObject({ state: 'connected', lastSequence: { [`${LEAD_SID}#screen`]: 1 } });
    expect(store.eventTypes()).toEqual(['call.connected']);
  });

  it.each([['4'], ['11'], ['#'], [''], [undefined]])('Digits=%j: hangs the lead up, outcome lead_declined, call.lead_declined once', async (digits) => {
    const res = await screenResult(digits);
    // A key (even an empty one) is answered with the callback number; a request with no Digits at all is a bare hangup.
    expect(res.text).toBe(digits === undefined ? '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>' : '<?xml version="1.0" encoding="UTF-8"?><Response><Say>You can reach us on 4 1 5, 5 5 5, 0 1 1 1. Goodbye.</Say><Hangup/></Response>');
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_declined' });
    expect(store.eventTypes()).toEqual(['call.lead_declined']);
  });

  it('is one decision per screening: a replay repeats it, and a later different digit cannot reverse it', async () => {
    await screenResult('1');
    expect((await screenResult('1')).text).toContain('<Response/>');
    expect((await screenResult('2')).text).toContain('<Response/>');
    expect(store.eventTypes()).toEqual(['call.connected']);
    expect(store.record?.outcome).toBeUndefined();

    seed('bridging', { leadCallSid: LEAD_SID });
    store.events = [];
    await screenResult('4');
    expect((await screenResult('1')).text).toContain('<Hangup/>');
    expect((await screenResult('1')).text).not.toContain('<Response/>');
    expect(store.eventTypes()).toEqual(['call.lead_declined']);
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_declined' });
  });

  it('two simultaneous answers produce one decision and one event', async () => {
    const results = await Promise.all([screenResult('1'), screenResult('2'), screenResult('1')]);
    expect(new Set(results.map((r) => r.text.includes('<Response/>'))).size).toBe(1);
    expect(store.events).toHaveLength(1);
  });

  it('a decline also uses the dial marker, so /dial\'s DialBridged=false result adds nothing', async () => {
    await screenResult('2');
    expect(store.record?.lastSequence).toMatchObject({ [`${LEAD_SID}#screen`]: 1, [`${MEMBER_SID}#dial`]: 1 });
  });

  it('ignores a CallSid that is not the adopted lead leg (the member\'s, another, none)', async () => {
    for (const sid of [MEMBER_SID, 'CA00000099']) expect((await screenResult('1', {}, sid)).text).toContain('<Hangup/>');
    expect((await post('screen-result', { Digits: '1' })).text).toContain('<Hangup/>');
    expect(store.transitions).toBe(0);
    expect(store.events).toHaveLength(0);
  });

  it('does nothing when no lead leg was adopted by /screen', async () => {
    seed('bridging');
    expect((await screenResult('1')).text).toContain('<Hangup/>');
    expect(store.transitions).toBe(0);
  });

  it.each(['dialing', 'member_ringing', 'member_answered', 'between_attempts', 'finished', 'failed'] as const)('writes nothing and hangs up when the record is %s', async (state) => {
    seed(state, { leadCallSid: LEAD_SID });
    expect((await screenResult('1')).text).toContain('<Hangup/>');
    expect(store.transitions).toBe(0);
    expect(store.events).toHaveLength(0);
  });

  it('a decline after the abort marker keeps the abort and still hangs the lead up', async () => {
    seed('bridging', { leadCallSid: LEAD_SID, outcome: 'aborted', lastSequence: { [`${MEMBER_SID}#dial`]: 1 } });
    const res = await screenResult('2');
    expect(res.text).toContain('<Hangup/>');
    expect(store.record?.outcome).toBe('aborted');
    expect(store.events).toHaveLength(0);
  });

  it('a lead who declined still gets both legs metered and the record finishes lead_declined, without trying another member', async () => {
    await screenResult('4');
    await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' });
    await leadStatus('completed', { CallDuration: '9', SequenceNumber: '3' });
    expect(store.record?.state).toBe('bridging');
    await memberStatus('completed', { CallDuration: '30' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'lead_declined', meteredLegs: ['lead', 'member:1'] });
    expect(store.eventTypes()).toEqual(['call.lead_declined', 'call.completed']);
    expect(requestNextHotLeadCallAttempt).not.toHaveBeenCalled();
  });

  it('a conversation finishes as completed even when both leg callbacks beat /dial', async () => {
    await screenResult('1');
    await leadStatus('completed', { CallDuration: '125', SequenceNumber: '3' });
    await memberStatus('completed', { CallDuration: '140' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(store.eventTypes()).toEqual(['call.connected', 'call.completed']);
  });
});

// ── member attempts: a member leg that ends without a bridge ─────────────────

describe('member attempt finalisation', () => {
  const nextAttempt = () => mock(requestNextHotLeadCallAttempt);

  it.each([
    ['member_ringing', 'no-answer'], ['member_ringing', 'busy'], ['member_ringing', 'failed'], ['member_ringing', 'canceled'],
    ['dialing', 'no-answer'], ['member_answered', 'completed'],
  ] as const)('%s + %s: meters member:1, moves to between_attempts and asks the seam once, with the record as it now is', async (state, callStatus) => {
    seed(state, state === 'dialing' ? { memberCallSid: undefined } : {});
    nextAttempt().mockResolvedValue({ enqueued: true });
    const res = await memberStatus(callStatus, { CallDuration: '7', SequenceNumber: '1' });
    expect(res.status).toBe(200);
    expect(store.record).toMatchObject({ state: 'between_attempts', meteredLegs: ['member:1'] });
    expect(usage()).toEqual([{ userId: 'owner-a', callSid: MEMBER_SID, leg: 'member', durationSeconds: 7 }]);
    expect(nextAttempt()).toHaveBeenCalledTimes(1);
    expect(nextAttempt().mock.calls[0][0]).toMatchObject({ listId: LIST, leadId: LEAD, record: { state: 'between_attempts', attemptNo: 1, meteredLegs: ['member:1'] } });
  });

  it('writes the matching outcome and event for a no-answer and for a hang-up on the prompt, never both', async () => {
    seed('member_ringing');
    nextAttempt().mockResolvedValue({ enqueued: true });
    await memberStatus('no-answer', { CallDuration: '0' });
    expect(store.record?.outcome).toBe('member_no_answer');
    expect(store.eventTypes()).toEqual(['call.member_no_answer']);

    seed('member_answered');
    store.events = [];
    await memberStatus('completed', { CallDuration: '3' });
    expect(store.record?.outcome).toBe('member_declined');
    expect(store.eventTypes()).toEqual(['call.member_declined']);
  });

  it('a member who pressed 2 keeps the single call.member_declined written at /gather', async () => {
    seed('member_answered');
    nextAttempt().mockResolvedValue({ enqueued: true });
    await gather('2');
    await memberStatus('completed', { CallDuration: '3' });
    expect(store.record).toMatchObject({ state: 'between_attempts', outcome: 'member_declined' });
    expect(store.eventTypes()).toEqual(['call.member_declined']);
  });

  it('seam enqueued: the record waits in between_attempts for the next attempt and is not finished', async () => {
    seed('member_ringing');
    nextAttempt().mockResolvedValue({ enqueued: true });
    await memberStatus('no-answer', { CallDuration: '0' });
    expect(store.record?.state).toBe('between_attempts');
    expect(store.eventTypes()).not.toContain('call.completed');
  });

  it.each(['max_attempts', 'no_candidates', 'too_old', 'disabled'] as const)('first attempt, seam refuses (%s): finishes with the member\'s own outcome and call.completed', async (reason) => {
    seed('member_ringing');
    nextAttempt().mockResolvedValue({ enqueued: false, reason });
    await memberStatus('no-answer', { CallDuration: '0' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'member_no_answer' });
    expect(store.eventTypes()).toEqual(['call.member_no_answer', 'call.completed']);
    expect(store.events[1].detail).toEqual({ outcome: 'member_no_answer' });
  });

  it('a later attempt, seam refuses: finishes with no_member_available', async () => {
    seed('member_answered', { attemptNo: 2, memberId: 'mother00', triedMemberIds: [MEMBER_ID, 'mother00'], meteredLegs: ['member:1'], outcome: 'member_declined' });
    nextAttempt().mockResolvedValue({ enqueued: false, reason: 'no_candidates' });
    await memberStatus('completed', { CallDuration: '3' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'no_member_available', meteredLegs: ['member:1', 'member:2'] });
    expect(store.eventTypes()).toEqual(['call.member_declined', 'call.completed']);
    expect(store.events[1].detail).toEqual({ outcome: 'no_member_available' });
  });

  it('a stale outcome left by an earlier attempt does not hide this attempt\'s own result', async () => {
    seed('member_ringing', { attemptNo: 2, memberCallSid: NEXT_MEMBER_SID, meteredLegs: ['member:1'], outcome: 'member_declined' });
    nextAttempt().mockResolvedValue({ enqueued: true });
    await post('status', { CallSid: NEXT_MEMBER_SID, CallStatus: 'no-answer', CallDuration: '0' });
    expect(store.record).toMatchObject({ state: 'between_attempts', outcome: 'member_no_answer', meteredLegs: ['member:1', 'member:2'] });
    expect(store.eventTypes()).toEqual(['call.member_no_answer']);
  });

  it('a stale member outcome never becomes the outcome of a call a later member took', async () => {
    seed('connected', { attemptNo: 2, memberCallSid: NEXT_MEMBER_SID, leadCallSid: LEAD_SID, meteredLegs: ['member:1'], outcome: 'member_declined' });
    await leadStatus('completed', { CallDuration: '60', SequenceNumber: '3', ParentCallSid: NEXT_MEMBER_SID });
    await post('status', { CallSid: NEXT_MEMBER_SID, CallStatus: 'completed', CallDuration: '70' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'completed' });
  });

  it('a seam that throws finishes the record (nothing is known to be queued) and logs only the error name', async () => {
    seed('member_ringing');
    nextAttempt().mockRejectedValue(new Error(`queue down for ${LEAD_PHONE}`));
    const res = await memberStatus('no-answer', { CallDuration: '0' });
    expect(res.status).toBe(200);
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'member_no_answer' });
    const logs = JSON.stringify(logSpy.flatMap((s) => s.mock.calls));
    expect(logs).toContain('next attempt request failed');
    noPhoneIn(logs);
  });

  it('finishing a waiting record applies only to the attempt that was read: a record that moved on is not finished', async () => {
    seed('between_attempts', { outcome: 'member_no_answer', meteredLegs: ['member:1'] });
    const realGet = store.get.bind(store);
    store.get = async () => {
      const record = await realGet();
      store.record!.attemptNo = 2; // another worker took the next attempt and it ended again, after this read
      return record;
    };
    await nextAttemptOrFinish({ listId: LIST, leadId: LEAD, jobKey: JOB, leg: 'member' }, 'member_no_answer');
    expect(store.record).toMatchObject({ state: 'between_attempts', attemptNo: 2 });
  });

  it('bills and writes once for a replayed or concurrent final callback; the hand-over request is repeated (the queue key dedupes it)', async () => {
    seed('member_ringing');
    nextAttempt().mockResolvedValue({ enqueued: true });
    await Promise.all([1, 2, 3].map(() => memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' })));
    await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    expect(nextAttempt().mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const [args] of nextAttempt().mock.calls) expect(args).toMatchObject({ listId: LIST, leadId: LEAD, record: { attemptNo: 1, jobKey: JOB } });
    expect(usage()).toHaveLength(1);
    expect(store.eventTypes()).toEqual(['call.member_no_answer']);
    expect(store.record).toMatchObject({ state: 'between_attempts', meteredLegs: ['member:1'] });
  });

  describe('a hand-over that did not happen after the leg was metered', () => {
    // The leg is metered and the record is between_attempts, then the store fails before the next attempt is requested.
    const failHandOverOnce = () => {
      const realGet = store.get.bind(store);
      let failing = true;
      jest.spyOn(store, 'get').mockImplementation(async (...args) => {
        if (failing && store.record?.state === 'between_attempts') {
          failing = false;
          throw new Error('ddb down');
        }
        return realGet(...args);
      });
    };

    it('is requested again by the Twilio retry, which finds the leg already metered, without billing twice', async () => {
      seed('member_ringing');
      nextAttempt().mockResolvedValue({ enqueued: true });
      failHandOverOnce();
      expect((await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' })).status).toBe(500);
      expect(store.record).toMatchObject({ state: 'between_attempts', meteredLegs: ['member:1'], outcome: 'member_no_answer' });
      expect(nextAttempt()).not.toHaveBeenCalled();

      expect((await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' })).status).toBe(200);
      expect(nextAttempt()).toHaveBeenCalledTimes(1);
      expect(usage()).toHaveLength(1);
      expect(store.eventTypes()).toEqual(['call.member_no_answer']);
    });

    it('finishes the record on the retry when no further attempt can be queued', async () => {
      seed('member_ringing');
      failHandOverOnce();
      await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
      await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
      expect(store.record).toMatchObject({ state: 'finished', outcome: 'member_no_answer' });
      expect(store.eventTypes()).toEqual(['call.member_no_answer', 'call.completed']);
      expect(usage()).toHaveLength(1);
    });

    it('is not requested again once the next attempt has taken the record', async () => {
      seed('member_ringing');
      nextAttempt().mockResolvedValue({ enqueued: true });
      await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
      await store.transition(LIST, LEAD, ['between_attempts'], { state: 'dialing', attemptNo: 2, memberId: 'mother00', triedMemberIds: ['mother00'], clear: ['memberCallSid', 'outcome'] });
      await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
      expect(nextAttempt()).toHaveBeenCalledTimes(1);
      expect(store.record?.state).toBe('dialing');
    });
  });

  it('a replay after the record finished writes and requests nothing', async () => {
    seed('member_ringing');
    await memberStatus('no-answer', { CallDuration: '0' });
    store.events = [];
    const writes = store.transitions;
    await memberStatus('no-answer', { CallDuration: '0' });
    expect(store.transitions).toBe(writes);
    expect(store.events).toHaveLength(0);
    expect(nextAttempt()).toHaveBeenCalledTimes(1);
  });

  it('a callback for an earlier attempt\'s sid is acknowledged with an empty 200 and writes nothing', async () => {
    seed('member_ringing', { attemptNo: 2, memberCallSid: NEXT_MEMBER_SID, meteredLegs: ['member:1'] });
    const res = await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '2' }); // MEMBER_SID: attempt 1's call
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    expect(store.transitions).toBe(0);
    expect(store.events).toHaveLength(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
    expect(nextAttempt()).not.toHaveBeenCalled();
  });

  it('a callback for the previous sid between attempts (before the next one is stored) writes and bills nothing', async () => {
    seed('member_ringing');
    nextAttempt().mockResolvedValue({ enqueued: true });
    await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    store.events = [];
    const writes = store.transitions;
    await memberStatus('completed', { CallDuration: '0', SequenceNumber: '2' });
    expect(store.transitions).toBe(writes);
    expect(usage()).toHaveLength(1);
  });

  describe('while the next attempt is being placed (dialing, call sid and outcome cleared)', () => {
    const startNextAttempt = async () => {
      seed('member_ringing');
      nextAttempt().mockResolvedValue({ enqueued: true });
      await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
      expect(await store.transition(LIST, LEAD, ['between_attempts'], {
        state: 'dialing', attemptNo: 2, memberId: MEMBER_ID, clear: ['memberCallSid', 'outcome'],
      })).toBe(true);
      store.events = [];
    };

    it('a late callback of the earlier attempt\'s call is not adopted as the next attempt\'s call', async () => {
      await startNextAttempt();
      const writes = store.transitions;
      expect((await memberStatus('completed', { CallDuration: '3', SequenceNumber: '2' })).status).toBe(200);
      expect((await memberPrompt()).text).toContain('<Hangup/>');
      expect((await gather('1')).text).toContain('<Hangup/>');
      expect(store.transitions).toBe(writes);
      expect(store.record).toMatchObject({ state: 'dialing', attemptNo: 2 });
      expect(store.record).not.toHaveProperty('memberCallSid');
      expect(store.events).toHaveLength(0);
    });

    it('the first callback of the next attempt\'s own call is adopted, and the attempt runs to its end', async () => {
      await startNextAttempt();
      const prompt = await post('owner', { CallSid: NEXT_MEMBER_SID, CallStatus: 'in-progress' });
      expect(prompt.text).toContain('<Gather');
      expect(store.record).toMatchObject({ state: 'member_answered', memberCallSid: NEXT_MEMBER_SID, attemptNo: 2 });
      expect(store.eventTypes()).toEqual(['call.initiated', 'call.member_answered']);
    });

    it('the next attempt\'s call, adopted from a status callback while the orchestrator is still placing it, is metered as attempt 2', async () => {
      await startNextAttempt();
      await post('status', { CallSid: NEXT_MEMBER_SID, CallStatus: 'no-answer', CallDuration: '0', SequenceNumber: '1' });
      expect(store.record).toMatchObject({ state: 'between_attempts', memberCallSid: NEXT_MEMBER_SID, meteredLegs: ['member:1', 'member:2'], outcome: 'member_no_answer' });
    });

    it('an attempt that connects finishes as completed when the reset left no outcome', async () => {
      seed('connected', { attemptNo: 2, memberCallSid: NEXT_MEMBER_SID, leadCallSid: LEAD_SID, outcome: undefined, meteredLegs: ['member:1', 'lead'] });
      await post('status', { CallSid: NEXT_MEMBER_SID, CallStatus: 'completed', CallDuration: '60', SequenceNumber: '1' });
      expect(store.record).toMatchObject({ state: 'finished', outcome: 'completed' });
      expect(store.events.at(-1)).toMatchObject({ type: 'call.completed', detail: { outcome: 'completed' } });
    });
  });

  it('each attempt is metered under its own leg key and call sid, once per attempt even when replayed', async () => {
    seed('member_ringing');
    nextAttempt().mockResolvedValue({ enqueued: true });
    await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    // The orchestrator starts the next attempt.
    await store.transition(LIST, LEAD, ['between_attempts'], { state: 'member_ringing', attemptNo: 2, memberId: 'mother00', memberCallSid: NEXT_MEMBER_SID, triedMemberIds: ['mother00'] });
    const second = { CallSid: NEXT_MEMBER_SID, CallStatus: 'completed', CallDuration: '40', SequenceNumber: '1' };
    await post('status', second);
    await post('status', second);
    expect(store.record?.meteredLegs).toEqual(['member:1', 'member:2']);
    expect(usage()).toEqual([
      { userId: 'owner-a', callSid: MEMBER_SID, leg: 'member', durationSeconds: 0 },
      { userId: 'owner-a', callSid: NEXT_MEMBER_SID, leg: 'member', durationSeconds: 40 },
    ]);
  });

  it.each([
    ['aborted', 'member_answered'], ['lead_phone_invalid', 'member_answered'], ['lead_phone_changed', 'member_answered'],
  ] as const)('does not ask for another member when the call ended as %s', async (outcome, state) => {
    seed(state, { outcome });
    await memberStatus('completed', { CallDuration: '9' });
    expect(nextAttempt()).not.toHaveBeenCalled();
    expect(store.record).toMatchObject({ state: 'finished', outcome });
  });

  it.each(['bridging', 'connected'] as const)('does not ask for another member when the member took the lead (%s)', async (state) => {
    seed(state, { leadCallSid: LEAD_SID, meteredLegs: ['lead'] });
    await memberStatus('completed', { CallDuration: '9' });
    expect(nextAttempt()).not.toHaveBeenCalled();
    expect(store.record?.state).toBe('finished');
  });

  it('a member who answers, presses 1 and then drops while the lead is still ringing is not a declined attempt', async () => {
    seed('member_answered');
    await gather('1');
    await memberStatus('completed', { CallDuration: '9' });
    expect(nextAttempt()).not.toHaveBeenCalled();
    expect(store.record).toMatchObject({ state: 'bridging', meteredLegs: ['member:1'] });
  });

  it('a final callback racing the press of 1 never both bridges and moves on to another member', async () => {
    for (let i = 0; i < 5; i++) {
      seed('member_answered');
      nextAttempt().mockReset().mockResolvedValue({ enqueued: true });
      const [pressed] = await Promise.all([gather('1'), memberStatus('completed', { CallDuration: '9' })]);
      const bridged = pressed.text.includes('<Dial');
      expect(bridged ? store.record?.state : 'between_attempts').toBe(bridged ? 'bridging' : 'between_attempts');
      expect(nextAttempt()).toHaveBeenCalledTimes(bridged ? 0 : 1);
    }
  });

  it('answers 500 and requests nothing when no member can be found to bill', async () => {
    seed('member_ringing');
    mock(crmDb.getLeadListById).mockResolvedValue(null);
    expect((await memberStatus('no-answer', { CallDuration: '0' })).status).toBe(500);
    expect(nextAttempt()).not.toHaveBeenCalled();
    expect(store.record?.state).toBe('member_ringing');
  });
});

describe('terminal rule across several attempts', () => {
  const secondAttempt = (state: HotLeadCallState, extra: Partial<HotLeadCallRecord> = {}) =>
    seed(state, { attemptNo: 2, memberId: 'mother00', memberCallSid: NEXT_MEMBER_SID, triedMemberIds: [MEMBER_ID, 'mother00'], meteredLegs: ['member:1'], ...extra });
  const secondLeadEnds = () => leadStatus('completed', { CallDuration: '40', SequenceNumber: '3', ParentCallSid: NEXT_MEMBER_SID });
  const secondMemberEnds = (extra: Record<string, string> = {}) =>
    post('status', { CallSid: NEXT_MEMBER_SID, CallStatus: 'completed', CallDuration: '50', ...extra });

  it('finishes only when attempt 2\'s member leg and the lead leg are metered; attempt 1\'s key does not stand in for either', async () => {
    secondAttempt('connected', { leadCallSid: LEAD_SID });
    await secondLeadEnds();
    expect(store.record?.state).toBe('connected');
    await secondMemberEnds();
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'completed', meteredLegs: ['member:1', 'lead', 'member:2'] });
    expect(usage().map((u) => [u.callSid, u.leg])).toEqual([[LEAD_SID, 'lead'], [NEXT_MEMBER_SID, 'member']]);
  });

  it('member:1 and the lead metered but member:2 not: the record stays live', async () => {
    secondAttempt('connected', { leadCallSid: LEAD_SID, meteredLegs: ['member:1', 'lead'] });
    await secondLeadEnds();
    expect(store.record?.state).toBe('connected');
  });

  it('does not wait for the lead leg of an earlier attempt that never dialed one', async () => {
    secondAttempt('member_answered', { outcome: 'lead_phone_invalid' });
    await secondMemberEnds();
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'lead_phone_invalid', meteredLegs: ['member:1', 'member:2'] });
  });

  it('the lead leg of the bridged attempt is metered once, even replayed', async () => {
    secondAttempt('connected', { leadCallSid: LEAD_SID });
    for (let i = 0; i < 3; i++) await secondLeadEnds();
    expect(usage()).toHaveLength(1);
  });
});

// ── /dial ────────────────────────────────────────────────────────────────────

describe('POST /dial', () => {
  beforeEach(() => seed('bridging'));

  it.each(['no-answer', 'busy', 'failed'])('records lead_no_answer once for DialCallStatus=%s and apologises', async (status) => {
    const res = await dial(status, { DialCallSid: LEAD_SID });
    expect(res.text).toContain('could not reach them');
    expect(res.text).toContain('<Hangup/>');
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_no_answer', leadCallSid: LEAD_SID });
    await dial(status, { DialCallSid: LEAD_SID });
    expect(store.eventTypes()).toEqual(['call.lead_no_answer']);
  });

  it('treats canceled (the member hung up while the lead was ringing) as bridge_unconfirmed: no lead_no_answer, no apology', async () => {
    const res = await dial('canceled', { DialCallSid: LEAD_SID });
    expect(res.text).not.toContain('could not reach them');
    expect(res.text).toContain('<Hangup/>');
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'bridge_unconfirmed', leadCallSid: LEAD_SID });
    await dial('canceled', { DialCallSid: LEAD_SID });
    expect(store.events).toEqual([]);

    // Both legs end: the record finishes with that outcome and a single call.completed.
    await memberStatus('completed', { CallDuration: '30' });
    await leadStatus('completed', { CallDuration: '5' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'bridge_unconfirmed' });
    expect(store.eventTypes()).toEqual(['call.completed']);
  });

  it('records a lead that never started (no DialCallSid) without a lead sid', async () => {
    await dial('failed');
    expect(store.record?.leadCallSid).toBeUndefined();
    expect(store.eventTypes()).toEqual(['call.lead_no_answer']);
  });

  it('moves bridging to connected once on completed with DialBridged=true, with one call.connected', async () => {
    const res = await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'true' });
    expect(res.text).toContain('<Hangup/>');
    expect(res.text).not.toContain('did not confirm');
    await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'true' });
    expect(store.record).toMatchObject({ state: 'connected', leadCallSid: LEAD_SID });
    expect(store.eventTypes()).toEqual(['call.connected']);
  });

  it('records lead_declined once for completed with DialBridged=false (the lead screened themselves out) and tells the member', async () => {
    const res = await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' });
    expect(res.text).toContain('The lead did not confirm. Their details are in your lead alert.');
    expect(res.text).toContain('<Hangup/>');
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_declined', leadCallSid: LEAD_SID });
    const replay = await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' });
    expect(replay.text).toContain('did not confirm');
    expect(store.eventTypes()).toEqual(['call.lead_declined']);
  });

  it('another key declines and the lead hears the callback number, then goodbye (Say + Hangup, no Gather)', async () => {
    seed('bridging', { leadCallSid: LEAD_SID });
    const res = await screenResult('4');
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say>You can reach us on 4 1 5, 5 5 5, 0 1 1 1. Goodbye.</Say><Hangup/></Response>');
  });

  it('press 1 is unchanged: an empty response, so Twilio bridges the calls', async () => {
    seed('bridging', { leadCallSid: LEAD_SID });
    expect((await screenResult('1')).text).toContain('<Response/>');
  });

  it('does not repeat call.lead_declined when /screen-result already recorded the decline', async () => {
    seed('bridging', { leadCallSid: LEAD_SID });
    await screenResult('4');
    const res = await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' });
    expect(res.text).toContain('did not confirm');
    expect(store.eventTypes()).toEqual(['call.lead_declined']);
    expect(store.record?.outcome).toBe('lead_declined');
  });

  it('writes nothing for completed without a DialBridged field: it cannot tell a conversation from a decline', async () => {
    const res = await dial('completed', { DialCallSid: LEAD_SID });
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(store.transitions).toBe(0);
  });

  it('never tries another member after the lead declined: no next-attempt request from /dial', async () => {
    await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' });
    await dial('no-answer', { DialCallSid: LEAD_SID });
    expect(requestNextHotLeadCallAttempt).not.toHaveBeenCalled();
  });

  it('does not downgrade a connected call or repeat the connected event when the answered callback came first', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await dial('completed', { DialCallSid: LEAD_SID });
    await dial('no-answer', { DialCallSid: LEAD_SID });
    expect(store.record).toMatchObject({ state: 'connected' });
    expect(store.record?.outcome).toBeUndefined();
    expect(store.events).toHaveLength(0);
  });

  it('ignores an unknown DialCallStatus and a DialCallSid equal to the member sid', async () => {
    await dial('weird', { DialCallSid: MEMBER_SID });
    await dial('failed', { DialCallSid: MEMBER_SID });
    expect(store.record?.leadCallSid).toBeUndefined();
    expect(store.eventTypes()).toEqual(['call.lead_no_answer']);
  });

  it.each(['member_answered', 'member_ringing'] as const)('writes nothing when the record is %s', async (state) => {
    seed(state);
    await dial('completed');
    await dial('no-answer');
    expect(store.events).toHaveLength(0);
    expect(store.record?.state).toBe(state);
  });
});

// ── /status ──────────────────────────────────────────────────────────────────

describe('POST /status', () => {
  it.each(['no-answer', 'busy', 'failed', 'canceled'])('member never answered (%s): meters the member leg once, records member_no_answer and finishes', async (status) => {
    seed('member_ringing');
    const res = await memberStatus(status, { CallDuration: '0', SequenceNumber: '1' });
    expect(res.status).toBe(200);
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'member_no_answer', meteredLegs: ['member:1'] });
    expect(usage()).toEqual([{ userId: 'owner-a', callSid: MEMBER_SID, leg: 'member', durationSeconds: 0 }]);
  });

  it('records the timeline events for an unanswered member exactly once, even when replayed', async () => {
    seed('member_ringing');
    await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    expect(store.eventTypes()).toEqual(['call.member_no_answer', 'call.completed']);
    expect(recordCallUsage).toHaveBeenCalledTimes(1);
  });

  it('full call: lead answered, lead ends first, member ends last. Meters each leg once; the last callback finishes', async () => {
    seed('member_answered');
    await gather('1');
    await leadStatus('initiated', { SequenceNumber: '0' });
    await leadStatus('ringing', { SequenceNumber: '1' });
    await leadStatus('in-progress', { SequenceNumber: '2' });
    expect(store.record).toMatchObject({ state: 'bridging', leadCallSid: LEAD_SID }); // answered, not yet confirmed
    await screen();
    await screenResult('1');
    expect(store.record).toMatchObject({ state: 'connected', leadCallSid: LEAD_SID });
    await leadStatus('completed', { SequenceNumber: '3', CallDuration: '125' });
    expect(store.record?.state).toBe('connected'); // member leg not metered yet
    expect(usage()).toEqual([{ userId: 'owner-a', callSid: LEAD_SID, leg: 'lead', durationSeconds: 125 }]);
    await memberStatus('completed', { CallDuration: '140', SequenceNumber: '1' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'completed', meteredLegs: ['lead', 'member:1'] });
    expect(usage()).toHaveLength(2);
    expect(usage()[1]).toEqual({ userId: 'owner-a', callSid: MEMBER_SID, leg: 'member', durationSeconds: 140 });
    expect(store.eventTypes()).toEqual(['call.connected', 'call.completed']);
  });

  it('full call with the member leg ending first: the lead callback is the one that finishes', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await memberStatus('completed', { CallDuration: '90' });
    expect(store.record?.state).toBe('connected');
    expect(store.events).toHaveLength(0);
    await leadStatus('completed', { CallDuration: '85', SequenceNumber: '3' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(usage().map((u) => u.leg).sort()).toEqual(['lead', 'member']);
  });

  it('terminal rule: a leg-terminal callback never finishes the record while the other dialed leg is unmetered', async () => {
    seed('bridging');
    await memberStatus('completed', { CallDuration: '20' });
    expect(store.record?.state).toBe('bridging');
    expect(store.record?.meteredLegs).toEqual(['member:1']);
    // The late lead callback can still be metered because the record never went terminal.
    await leadStatus('no-answer', { CallDuration: '0', SequenceNumber: '2' });
    // No /dial result was ever seen, so the lead outcome is not claimed.
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'bridge_unconfirmed', meteredLegs: ['member:1', 'lead'] });
    expect(store.eventTypes()).toEqual(['call.completed']);
    expect(usage()).toHaveLength(2);
  });

  it('does not wait for a lead leg that was never created (dial failed without a sid)', async () => {
    seed('bridging');
    await dial('failed');
    await memberStatus('completed', { CallDuration: '30' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'lead_no_answer', meteredLegs: ['member:1'] });
    expect(usage()).toHaveLength(1);
  });

  it('waits for the lead leg when /dial reported a lead sid', async () => {
    seed('bridging');
    await dial('no-answer', { DialCallSid: LEAD_SID });
    await memberStatus('completed', { CallDuration: '30' });
    expect(store.record?.state).toBe('bridging');
    await leadStatus('no-answer', { CallDuration: '0', SequenceNumber: '2' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'lead_no_answer' });
  });

  it('member declined: the member leg final callback meters and finishes with member_declined', async () => {
    seed('member_answered');
    await gather('2');
    expect(store.record?.state).toBe('member_answered');
    await memberStatus('completed', { CallDuration: '12' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'member_declined' });
    expect(store.eventTypes()).toEqual(['call.member_declined', 'call.completed']);
    expect(usage()).toHaveLength(1);
  });

  it('member hung up on the prompt without pressing anything: member_declined, once', async () => {
    seed('member_answered');
    await memberStatus('completed', { CallDuration: '4' });
    await memberStatus('completed', { CallDuration: '4' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'member_declined' });
    expect(store.eventTypes()).toEqual(['call.member_declined', 'call.completed']);
  });

  it('never meters a leg twice: replays of the same terminal callback bill once', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    for (let i = 0; i < 3; i++) await leadStatus('completed', { CallDuration: '60', SequenceNumber: '3' });
    expect(usage()).toHaveLength(1);
    // Same callback without a SequenceNumber (guarded by meteredLegs alone).
    for (let i = 0; i < 3; i++) await memberStatus('completed', { CallDuration: '70' });
    expect(usage().map((u) => u.leg)).toEqual(['lead', 'member']);
    expect(store.eventTypes()).toEqual(['call.completed']);
  });

  it('meters exactly once when the same terminal callback arrives concurrently', async () => {
    seed('connected', { leadCallSid: LEAD_SID, meteredLegs: ['lead'] });
    await Promise.all([1, 2, 3].map(() => memberStatus('completed', { CallDuration: '70', SequenceNumber: '1' })));
    expect(usage()).toHaveLength(1);
    expect(store.eventTypes()).toEqual(['call.completed']);
  });

  it('ignores an out-of-order progress callback that arrives after a higher sequence number', async () => {
    seed('bridging');
    await leadStatus('ringing', { SequenceNumber: '4' });
    await leadStatus('in-progress', { SequenceNumber: '2' });
    expect(store.record?.state).toBe('bridging');
    expect(store.events).toHaveLength(0);
  });

  it('ignores a progress callback after the leg was metered (no meter, no event)', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await leadStatus('completed', { SequenceNumber: '3', CallDuration: '10' });
    await leadStatus('in-progress', { SequenceNumber: '2' });
    expect(usage()).toHaveLength(1);
    expect(store.events).toHaveLength(0);
  });

  it('a lead "answered" callback only remembers the lead sid: the lead may still decline at the screening prompt', async () => {
    seed('bridging');
    await leadStatus('in-progress', { SequenceNumber: '2' });
    await leadStatus('in-progress', { SequenceNumber: '2' });
    expect(store.events).toHaveLength(0);
    expect(store.record).toMatchObject({ state: 'bridging', leadCallSid: LEAD_SID });
  });

  it('does not default a missing CallDuration to 0: the duration reaches the meter as NaN', async () => {
    seed('member_answered');
    await memberStatus('completed');
    expect(usage()).toHaveLength(1);
    expect(Number.isNaN(usage()[0].durationSeconds)).toBe(true);
  });

  it('passes through a garbled CallDuration as NaN too', async () => {
    seed('member_answered');
    await memberStatus('completed', { CallDuration: 'abc' });
    expect(Number.isNaN(usage()[0].durationSeconds)).toBe(true);
  });

  it.each(['', '   '])('treats an empty or blank CallDuration (%j) as missing, not as 0 seconds', async (blank) => {
    seed('member_answered');
    await memberStatus('completed', { CallDuration: blank });
    expect(usage()).toHaveLength(1);
    expect(Number.isNaN(usage()[0].durationSeconds)).toBe(true);
  });

  it('names the member leg after the attempt it belongs to', async () => {
    seed('member_ringing', { attemptNo: 2, memberId: MEMBER_ID, triedMemberIds: ['mother00', MEMBER_ID] });
    await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    expect(store.record).toMatchObject({ state: 'finished', meteredLegs: ['member:2'] });
  });

  it('meters each leg with its own CallSid and the list owner as the billed user', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await memberStatus('completed', { CallDuration: '61' });
    await leadStatus('completed', { CallDuration: '30' });
    expect(usage()).toEqual([
      { userId: 'owner-a', callSid: MEMBER_SID, leg: 'member', durationSeconds: 61 },
      { userId: 'owner-a', callSid: LEAD_SID, leg: 'lead', durationSeconds: 30 },
    ]);
  });

  it('still meters and finishes when the config was disabled mid-call, and with the kill switch off', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    setHotLeadCallEnabledOverride(false);
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, enabled: false } });
    await leadStatus('completed', { CallDuration: '30' });
    await memberStatus('completed', { CallDuration: '40' });
    expect(usage().map((u) => u.userId)).toEqual(['owner-a', 'owner-a']);
    expect(store.record?.state).toBe('finished');
  });

  it('answers 500 without writing when no member can be found to bill, so the status retry override redelivers', async () => {
    seed('member_answered');
    mock(crmDb.getLeadListById).mockResolvedValue(null);
    const res = await memberStatus('completed', { CallDuration: '30' });
    expect(res.status).toBe(500);
    expect(store.transitions).toBe(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('bills only the caller that wins the metering transition (a lost race or replay must not bill)', async () => {
    seed('member_answered');
    jest.spyOn(store, 'transition').mockResolvedValue(false);
    expect((await memberStatus('completed', { CallDuration: '30' })).status).toBe(500); // lost every attempt: redelivered
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('a metering failure is logged and does not fail the webhook or double-bill on retry', async () => {
    seed('member_answered');
    mock(recordCallUsage).mockRejectedValue(new Error('boom'));
    const res = await memberStatus('completed', { CallDuration: '30' });
    expect(res.status).toBe(200);
    await memberStatus('completed', { CallDuration: '30' });
    expect(recordCallUsage).toHaveBeenCalledTimes(1);
  });

  it('ignores a lead callback whose ParentCallSid is not the member call, and an member callback with a foreign sid', async () => {
    seed('connected');
    await post('status', { CallSid: LEAD_SID, ParentCallSid: 'CA0000000X', CallStatus: 'completed', CallDuration: '9' }, { query: `${QUERY}&leg=lead` });
    await post('status', { CallSid: LEAD_SID, CallStatus: 'completed', CallDuration: '9' }, { query: `${QUERY}&leg=lead` });
    await post('status', { CallSid: LEAD_SID, CallStatus: 'completed', CallDuration: '9' });
    await post('status', { CallSid: MEMBER_SID, ParentCallSid: MEMBER_SID, CallStatus: 'completed', CallDuration: '9' }, { query: `${QUERY}&leg=lead` });
    expect(store.transitions).toBe(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('ignores a second, different lead sid once the lead leg is known', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await post('status', { CallSid: 'CA00000099', ParentCallSid: MEMBER_SID, CallStatus: 'completed', CallDuration: '9' }, { query: `${QUERY}&leg=lead` });
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('ignores callbacks for a finished record: nothing is written or billed', async () => {
    seed('finished', { meteredLegs: ['member:1'], outcome: 'completed' });
    await memberStatus('completed', { CallDuration: '30' });
    await leadStatus('completed', { CallDuration: '30' });
    expect(recordCallUsage).not.toHaveBeenCalled();
    expect(store.transitions).toBe(0);
    expect(store.events).toHaveLength(0);
  });

  it('ignores unknown CallStatus values', async () => {
    seed('member_answered');
    await memberStatus('weird', { CallDuration: '5' });
    expect(store.transitions).toBe(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('a stuck record (the other leg never reports) stays non-terminal by design', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await memberStatus('completed', { CallDuration: '30' });
    expect(store.record?.state).toBe('connected');
    expect(store.record?.meteredLegs).toEqual(['member:1']);
  });
});

// ── request body parsing ─────────────────────────────────────────────────────

describe('request body parsing', () => {
  beforeEach(() => seed('member_ringing'));

  it('rejects an oversized body with 413 before anything is verified or written', async () => {
    const res = await post('owner', { CallSid: MEMBER_SID, Junk: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(fake.signatureChecks).toHaveLength(0);
    expect(store.transitions).toBe(0);
  });

  it('answers parse errors locally: 413/400 never reach the global error handler', async () => {
    const onError = jest.fn();
    const a = app({ errorHandler: onError });
    const big = await request(a).post(`${MOUNT}/owner?${QUERY}`).type('form').send({ Junk: 'x'.repeat(70 * 1024) });
    const bad = await request(a).post(`${MOUNT}/owner?${QUERY}`).set('Content-Type', 'application/x-www-form-urlencoded; charset=nope').send('CallSid=CA1');
    expect(big.status).toBe(413);
    expect(big.text).toBe('');
    expect(bad.status).toBe(400);
    expect(bad.text).toBe('');
    expect(onError).not.toHaveBeenCalled();
  });

  it('limits every content type: an oversized JSON body is a 413 here, not buffered by the global 50mb parser', async () => {
    const onError = jest.fn();
    const res = await request(app({ errorHandler: onError })).post(`${MOUNT}/owner?${QUERY}`).type('json').send({ Junk: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(onError).not.toHaveBeenCalled();
    expect(fake.signatureChecks).toHaveLength(0);
  });

  it('does not let malformed JSON reach the global error handler (it is just an unsigned form body)', async () => {
    const onError = jest.fn();
    setVoiceProviderForTests(null);
    mockGetCreds.mockResolvedValue({ accountSid: 'ACfake0123456789abcdef0123456789ab', authToken: 'tok' });
    const res = await request(app({ errorHandler: onError })).post(`${MOUNT}/owner?${QUERY}`).set('X-Twilio-Signature', 'bad').type('json').send('{bad');
    expect(res.status).toBe(401);
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects a JSON body with valid-looking keys as 401: it is not a flat form', async () => {
    setVoiceProviderForTests(null);
    mockGetCreds.mockResolvedValue({ accountSid: 'ACfake0123456789abcdef0123456789ab', authToken: 'tok' });
    seed('member_ringing');
    const params = { CallSid: MEMBER_SID, CallStatus: 'in-progress' };
    const res = await request(app())
      .post(`${MOUNT}/owner?${QUERY}`)
      .set('X-Twilio-Signature', getExpectedTwilioSignature('tok', `${BASE}${MOUNT}/owner?${QUERY}`, params))
      .type('json')
      .send(params);
    expect(res.status).toBe(401);
    expect(store.record?.state).toBe('member_ringing');
  });

  it('keeps bracketed keys as flat strings instead of building nested objects', async () => {
    await request(app()).post(`${MOUNT}/owner?${QUERY}`).set('X-Twilio-Signature', 'sig').type('form').send('CallSid=CA00000001&a[b]=1&a[c][d]=2');
    expect(fake.signatureChecks[0].params).toEqual({ CallSid: MEMBER_SID, 'a[b]': '1', 'a[c][d]': '2' });
  });

  it('still verifies a genuine Twilio signature through the narrow parser', async () => {
    setVoiceProviderForTests(null);
    mockGetCreds.mockResolvedValue({ accountSid: 'ACfake0123456789abcdef0123456789ab', authToken: 'tok' });
    const params = { CallSid: MEMBER_SID, 'a[b]': '1' };
    const sig = getExpectedTwilioSignature('tok', `${BASE}${MOUNT}/owner?${QUERY}`, params);
    const res = await post('owner', params, { signature: sig });
    expect(res.status).toBe(200);
    expect(store.record?.state).toBe('member_answered');
  });

  it('is mounted in app.ts before the global 50mb parsers (body-parser skips an already parsed body)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../app.ts'), 'utf8');
    const narrow = src.indexOf('app.use("/api/webhooks/twilio-voice", twilioVoiceBodyParser)');
    expect(narrow).toBeGreaterThan(0);
    expect(narrow).toBeLessThan(src.indexOf('app.use(express.json({ limit: "50mb" }))'));
    expect(narrow).toBeLessThan(src.indexOf('app.use(express.urlencoded({ limit: "50mb"'));
  });
});

describe('status retries (Twilio does not retry a 5xx unless the URL says so)', () => {
  it('a redelivery after a 500 meters the leg exactly once and the first attempt left nothing behind', async () => {
    seed('member_answered');
    mock(crmDb.getLeadListById).mockResolvedValue(null);
    expect((await memberStatus('completed', { CallDuration: '30', SequenceNumber: '1' })).status).toBe(500);
    expect(store.transitions).toBe(0);
    expect(store.record?.meteredLegs).toEqual([]);
    mock(crmDb.getLeadListById).mockResolvedValue({ listId: LIST, userId: 'owner-a' });
    expect((await memberStatus('completed', { CallDuration: '30', SequenceNumber: '1' })).status).toBe(200);
    expect((await memberStatus('completed', { CallDuration: '30', SequenceNumber: '1' })).status).toBe(200);
    expect(usage()).toHaveLength(1);
    expect(store.record?.state).toBe('finished');
  });

  it('answers 500 and logs when every attempt loses its transition, then a redelivery meters', async () => {
    seed('member_answered');
    const spy = jest.spyOn(store, 'transition').mockResolvedValue(false);
    const res = await memberStatus('completed', { CallDuration: '30' });
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(recordCallUsage).not.toHaveBeenCalled();
    expect(JSON.stringify(logSpy.flatMap((s) => s.mock.calls))).toContain('metering gave up after retries');
    spy.mockRestore();
    expect((await memberStatus('completed', { CallDuration: '30' })).status).toBe(200);
    expect(usage()).toHaveLength(1);
  });

  it('does not answer 500 for a replayed leg callback while the record is still live', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    expect((await leadStatus('completed', { CallDuration: '30', SequenceNumber: '3' })).status).toBe(200);
    expect((await leadStatus('completed', { CallDuration: '30', SequenceNumber: '3' })).status).toBe(200);
    expect(store.record?.state).toBe('connected');
    expect(JSON.stringify(logSpy.flatMap((s) => s.mock.calls))).not.toContain('gave up');
  });

  it('does not answer 500 or log gave-up on the normal already-metered and finished paths', async () => {
    seed('member_answered');
    await memberStatus('completed', { CallDuration: '30' });
    const again = await memberStatus('completed', { CallDuration: '30' });
    expect(again.status).toBe(200);
    expect(JSON.stringify(logSpy.flatMap((s) => s.mock.calls))).not.toContain('gave up');
  });

  it('validates the signature of a status URL built with the retry fragment (Twilio signs without it)', async () => {
    setVoiceProviderForTests(null);
    mockGetCreds.mockResolvedValue({ accountSid: 'ACfake0123456789abcdef0123456789ab', authToken: 'tok' });
    seed('member_answered');
    const built = buildVoiceWebhookUrl('status', { listId: LIST, leadId: LEAD, jobKey: JOB });
    expect(built).toContain('#rc=3&rp=5xx,ct');
    const [onWire] = built.split('#');
    const params = { CallSid: MEMBER_SID, CallStatus: 'completed', CallDuration: '8' };
    const res = await request(app())
      .post(onWire.slice(BASE.length))
      .set('X-Twilio-Signature', getExpectedTwilioSignature('tok', onWire, params))
      .type('form')
      .send(params);
    expect(res.status).toBe(200);
    expect(usage()).toHaveLength(1);
  });

  it('puts the retry fragment on the lead <Number> status callback only, not on the TwiML fetch URLs', async () => {
    seed('member_answered');
    const text = (await gather('1')).text;
    expect(text.match(/#rc=3&amp;rp=5xx,ct/g)).toHaveLength(1);
    expect(text).toContain('statusCallback="');
    expect(text.split('action="')[1].split('"')[0]).not.toContain('#');
  });
});

// ── aborted calls, unconfirmed placements, concurrency ───────────────────────

describe('aborted calls', () => {
  it('/owner with the kill switch off records outcome aborted, so the member final callback does not relabel it', async () => {
    seed('member_ringing');
    setHotLeadCallEnabledOverride(false);
    const res = await memberPrompt();
    expect(res.text).not.toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'member_answered', outcome: 'aborted' });
    await memberStatus('completed', { CallDuration: '6' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'aborted' });
    expect(store.eventTypes()).toEqual(['call.failed', 'call.completed']);
    expect(usage()).toHaveLength(1);
  });

  it('/owner with a disabled config aborts once even when replayed', async () => {
    seed('dialing', { memberCallSid: undefined });
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, enabled: false } });
    await memberPrompt();
    await memberPrompt();
    expect(store.record).toMatchObject({ outcome: 'aborted', memberCallSid: MEMBER_SID });
    expect(store.eventTypes()).toEqual(['call.initiated', 'call.failed']);
  });

  it('/gather with the config disabled mid-call aborts and never dials', async () => {
    seed('member_answered');
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, enabled: false } });
    const res = await gather('1');
    expect(res.text).not.toContain('<Dial');
    expect(store.record).toMatchObject({ state: 'member_answered', outcome: 'aborted' });
    await memberStatus('completed', { CallDuration: '9' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'aborted' });
  });

  it.each([
    ['removed from the team', () => ({ team: [teamMember('+14155550199', { id: 'mother00' })] })],
    ['no longer verified (phone changed)', () => ({ team: [teamMember(MEMBER_PHONE, { verifiedAt: undefined }), teamMember('+14155550199', { id: 'mother00' })] })],
  ])('/owner hangs up and aborts when the member being rung was %s', async (_label, change) => {
    seed('member_ringing');
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, ...change() } });
    const res = await memberPrompt();
    expect(res.text).not.toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'member_answered', outcome: 'aborted' });
    expect(store.eventTypes()).toEqual(['call.failed']);
  });

  it('/gather never dials the lead when the member was removed after answering', async () => {
    seed('member_answered');
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, team: [teamMember('+14155550199', { id: 'mother00' })] } });
    const res = await gather('1');
    expect(res.text).not.toContain('<Dial');
    expect(store.record).toMatchObject({ state: 'member_answered', outcome: 'aborted' });
  });

  it('serves the prompt for the member of the record even when another member leads the team', async () => {
    seed('member_ringing', { memberId: 'mother00' });
    mock(orgDb.getOrgById).mockResolvedValue({
      orgId: 'org-a',
      hotLeadCall: { ...orgConfig, team: [teamMember(MEMBER_PHONE), teamMember('+14155550199', { id: 'mother00' })] },
    });
    expect((await memberPrompt()).text).toContain('<Gather');
  });

  it('hangs up on a record that names no member (it cannot be tied to the team)', async () => {
    seed('member_ringing', { memberId: undefined });
    const res = await memberPrompt();
    expect(res.text).not.toContain('<Gather');
  });

  it('does not abort a record that does not belong to the callback (wrong job key)', async () => {
    seed('member_ringing');
    setHotLeadCallEnabledOverride(false);
    await post('owner', { CallSid: MEMBER_SID }, { query: `listId=${LIST}&leadId=${LEAD}&jobKey=old` });
    expect(store.record).toMatchObject({ state: 'member_ringing' });
    expect(store.record?.outcome).toBeUndefined();
  });
});

describe('ambiguous placements (dialing + outcome placement_unknown) and rejected ones', () => {
  it('adopts the CallSid and serves the prompt when the member picks up', async () => {
    seed('dialing', { outcome: 'placement_unknown', memberCallSid: undefined });
    const res = await memberPrompt();
    expect(res.text).toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'member_answered', memberCallSid: MEMBER_SID });
    expect(store.eventTypes()).toEqual(['call.initiated', 'call.member_answered']);
  });

  it('still records member_no_answer, meters and finishes when the member never answers', async () => {
    seed('dialing', { outcome: 'placement_unknown', memberCallSid: undefined });
    await memberStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'member_no_answer', memberCallSid: MEMBER_SID });
    expect(store.eventTypes()).toEqual(['call.initiated', 'call.member_no_answer', 'call.completed']);
    expect(usage()).toHaveLength(1);
  });

  it('still records member_declined when the member answered and hung up on the prompt', async () => {
    seed('dialing', { outcome: 'placement_unknown', memberCallSid: undefined });
    await memberPrompt();
    await memberStatus('completed', { CallDuration: '4' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'member_declined' });
  });

  it('keeps the member decision when the record carried placement_unknown', async () => {
    seed('dialing', { outcome: 'placement_unknown', memberCallSid: undefined });
    await memberPrompt();
    await gather('2');
    await memberStatus('completed', { CallDuration: '4' });
    expect(store.record?.outcome).toBe('member_declined');
  });

  it('reports a connected call as completed, not as placement_unknown', async () => {
    seed('member_answered', { outcome: 'placement_unknown' });
    await gather('1');
    await leadStatus('in-progress', { SequenceNumber: '2' });
    await screen();
    await screenResult('1');
    await leadStatus('completed', { CallDuration: '9', SequenceNumber: '3' });
    await memberStatus('completed', { CallDuration: '12' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'completed' });
  });

  it('ignores every callback for a place_rejected record (a definite non-call)', async () => {
    seed('failed', { outcome: 'place_rejected', memberCallSid: undefined });
    for (const res of [await memberPrompt(), await gather('1'), await dial('no-answer'), await memberStatus('completed', { CallDuration: '5' })]) {
      expect(res.status).toBe(200);
    }
    expect(store.record?.state).toBe('failed');
    expect(store.record?.memberCallSid).toBeUndefined();
    expect(store.transitions).toBe(0);
    expect(store.events).toHaveLength(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });
});

describe('concurrency and failures around bridging', () => {
  it('two simultaneous "1" presses produce exactly one bridge', async () => {
    seed('member_answered');
    const results = await Promise.all([gather('1'), gather('1')]);
    expect(results.filter((r) => r.text.includes('<Dial')).length).toBe(1);
    expect(store.record?.state).toBe('bridging');
  });

  it('a TwiML builder failure leaves the record member_answered, not bridging', async () => {
    seed('member_answered');
    const spy = jest.spyOn(twiml, 'connectTwiml').mockImplementation(() => { throw new Error('boom'); });
    const res = await gather('1');
    spy.mockRestore();
    expect(res.text).toContain('<Hangup/>');
    expect(store.record?.state).toBe('member_answered');
  });
});

// ── phone numbers never leak ─────────────────────────────────────────────────

describe('privacy', () => {
  it('no phone number appears in any log, timeline event or non-Dial response across a full call', async () => {
    seed('member_ringing');
    const bodies: string[] = [];
    bodies.push((await memberPrompt({ From: TWILIO_NUMBER, To: MEMBER_PHONE })).text);
    bodies.push((await gather('2', { From: TWILIO_NUMBER, To: MEMBER_PHONE })).text);
    seed('member_answered');
    const connect = (await gather('1', { From: TWILIO_NUMBER, To: MEMBER_PHONE })).text;
    bodies.push(connect.replace(`>${LEAD_PHONE}</Number>`, '></Number>').replace(`callerId="${TWILIO_NUMBER}"`, ''));
    bodies.push((await dial('no-answer', { DialCallSid: LEAD_SID, To: LEAD_PHONE })).text);
    await leadStatus('completed', { To: LEAD_PHONE, From: TWILIO_NUMBER, CallDuration: '3' });
    await memberStatus('completed', { To: MEMBER_PHONE, From: TWILIO_NUMBER, CallDuration: '3' });
    bodies.forEach(noPhoneIn);
    noPhoneIn(JSON.stringify(store.events));
    noPhoneIn(JSON.stringify(logSpy.flatMap((s) => s.mock.calls)));
    noPhoneIn(JSON.stringify(mock(recordCallUsage).mock.calls));
  });

  it('logs only a generic message when a handler throws', async () => {
    seed('member_ringing');
    mock(crmDb.getLeadListById).mockRejectedValue(new Error(`db failed for ${LEAD_PHONE}`));
    const res = await memberPrompt();
    expect(res.text).toContain('<Hangup/>');
    const logs = JSON.stringify(logSpy.flatMap((s) => s.mock.calls));
    expect(logs).toContain('handler failed');
    noPhoneIn(logs);
  });
});

// ── press 3 at the screening prompt: stop calling this person (ENG-2783) ─────────────────────────────

describe('lead presses 3: do not call again', () => {
  const GOODBYE = 'Smith &amp; Sons will not call this number again. You can reach us on 4 1 5, 5 5 5, 0 1 1 1. Goodbye.';
  const MEMBER_COPY = 'The lead asked not to be called again. Their details are in your lead alert.';
  // Computed per use: the digest key (JWT_SECRET) only exists inside each test.
  const dnc = () => dncKey('org-a', LEAD_PHONE);
  const warnings = () => JSON.stringify(logSpy.flatMap((s) => s.mock.calls));
  beforeEach(() => {
    seed('bridging', { leadCallSid: LEAD_SID });
    setDncRetryDelayForTests(async () => undefined);
  });
  afterEach(() => setDncRetryDelayForTests(null));

  it('writes the org marker (about ten years, no raw number), the lead contact status, the outcome and the event, and says goodbye', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const res = await screenResult('3');
    expect(res.text).toContain(`<Say>${GOODBYE}</Say><Hangup/>`);
    expect(res.text).not.toContain('<Response/>');
    expect(limits.claims.get(dnc())).toBeDefined();
    expect(limits.claims.get(dnc())!.expiresAtS - nowS).toBeGreaterThan(9 * 365 * 86400);
    expect(dnc()).toMatch(/^hlc#dnc#[0-9a-f]{64}$/);
    expect(JSON.stringify(limits.keysTouched)).not.toContain('4155550123');
    expect(mock(crmDb.updateLead)).toHaveBeenCalledTimes(1);
    expect(mock(crmDb.updateLead).mock.calls[0].slice(0, 2)).toEqual([LIST, LEAD]);
    expect(mock(crmDb.updateLead).mock.calls[0][2]).toMatchObject({
      contactStatus: 'do-not-contact', contactStatusReason: 'opted-out', contactStatusUpdatedBy: 'system', unsubscribedFromGroupEmail: true,
    });
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_opted_out' });
    expect(store.events).toEqual([{ type: 'call.lead_declined', detail: { reason: 'opted_out' } }]);
    expect(store.record?.lastSequence).toMatchObject({ [`${LEAD_SID}#screen`]: 1, [`${MEMBER_SID}#dial`]: 1 });
  });

  it('answers press 3 with a one-line goodbye and a Hangup: the call ends, with no further Gather or prompt', async () => {
    const res = await screenResult('3');
    expect(res.text).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${GOODBYE}</Say><Hangup/></Response>`);
    expect(res.text).not.toContain('<Gather');
    expect(res.text).not.toContain('<Dial');
  });

  it('writes the marker and the contact status before it speaks the goodbye with the number, and answers with Say + Hangup only', async () => {
    const order: string[] = [];
    mock(crmDb.updateLead).mockImplementationOnce(async () => { order.push('status'); return undefined as never; });
    const res = await screenResult('3');
    order.push('reply');
    expect(order).toEqual(['status', 'reply']);
    expect(limits.claims.get(dnc())).toBeDefined();
    expect(res.text).toContain(`<Say>${GOODBYE}</Say><Hangup/>`);
    expect(res.text).not.toMatch(/<Gather|<Dial/);
  });

  it('a later 1 cannot reverse the stop: nothing connects, the lead hears the goodbye again, and the stop is not written twice', async () => {
    await screenResult('3');
    const again = await screenResult('1');
    expect(again.text).toContain('will not call this number again');
    expect(again.text).not.toContain('<Response/>');
    expect((await screenResult('3')).text).toContain('will not call this number again');
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_opted_out' });
    expect(store.eventTypes()).toEqual(['call.lead_declined']);
    expect(mock(crmDb.updateLead)).toHaveBeenCalledTimes(1);
    expect(limits.keysTouched.filter((k) => k === dnc())).toHaveLength(1);
  });

  it('retries the marker: two failures then a success still writes it, with nothing alarming logged', async () => {
    const claim = jest.spyOn(limits, 'claim').mockRejectedValueOnce(new Error('ddb down')).mockRejectedValueOnce(new Error('ddb down'));
    const res = await screenResult('3');
    expect(res.text).toContain(GOODBYE);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(limits.claims.has(dnc())).toBe(true);
    expect(warnings()).not.toContain('do-not-call write failed');
  });

  it('waits 50 ms and then 150 ms between the three attempts', async () => {
    const waits: number[] = [];
    setDncRetryDelayForTests(async (ms) => { waits.push(ms); });
    limits.failKeyPrefix = { prefix: 'hlc#dnc#', error: new Error('ddb down') };
    await screenResult('3');
    expect(waits).toEqual([50, 150]);
  });

  it('fails all three attempts: nothing connects, the lead still hears the goodbye, the contact status is still written, an error with the stable marker (org id, no number) is logged', async () => {
    limits.failKeyPrefix = { prefix: 'hlc#dnc#', error: new Error(`ddb down for ${LEAD_PHONE}`) };
    const claim = jest.spyOn(limits, 'claim');
    const res = await screenResult('3');
    expect(res.text).toContain(GOODBYE);
    expect(res.text).not.toContain('<Response/>');
    expect(claim).toHaveBeenCalledTimes(3);
    expect(limits.claims.has(dnc())).toBe(false);
    expect(mock(crmDb.updateLead)).toHaveBeenCalledTimes(1);
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_opted_out' });
    const errors = logSpy[2].mock.calls.map((c) => String(c[0]));
    expect(errors).toContain('[hotLeadCall] do-not-call write failed org-a');
    expect(warnings()).not.toContain('4155550123');
    expect((await screenResult('1')).text).not.toContain('<Response/>');
  });

  it('with no live org context (config gone): the leg ends without a goodbye (no name to say), the outcome and contact status are still recorded, an error is logged', async () => {
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a' });
    const res = await screenResult('3');
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(limits.claims.size).toBe(0);
    expect(mock(crmDb.updateLead)).toHaveBeenCalledTimes(1);
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_opted_out' });
    expect(logSpy[2].mock.calls.map((c) => String(c[0])).some((l) => l.includes('do-not-call write failed'))).toBe(true);
  });

  it('when the lead row cannot be read: goodbye, outcome recorded, no marker (the approved number is unknown), no status write, an error logged', async () => {
    mock(crmDb.getLeadById).mockRejectedValue(new Error('ddb down'));
    const res = await screenResult('3');
    expect(res.text).toContain(GOODBYE);
    expect(store.record?.outcome).toBe('lead_opted_out');
    expect(limits.claims.size).toBe(0);
    expect(mock(crmDb.updateLead)).not.toHaveBeenCalled();
    expect(warnings()).toContain('lead not read');
    expect(logSpy[2].mock.calls.map((c) => String(c[0])).some((l) => l.includes('do-not-call write failed'))).toBe(true);
  });

  it('an email-unsubscribed lead who presses 3 becomes do-not-contact (opted-out)', async () => {
    mock(crmDb.getLeadById).mockResolvedValue({ listId: LIST, leadId: LEAD, phone: LEAD_PHONE, contactStatus: 'unsubscribed' });
    await screenResult('3');
    expect(mock(crmDb.updateLead).mock.calls[0][2]).toMatchObject({ contactStatus: 'do-not-contact', contactStatusReason: 'opted-out' });
  });

  it('still says goodbye and records the outcome when the contact status write fails as well', async () => {
    mock(crmDb.updateLead).mockRejectedValue(new Error('ddb down'));
    const res = await screenResult('3');
    expect(res.text).toContain(GOODBYE);
    expect(limits.claims.has(dnc())).toBe(true);
    expect(store.record?.outcome).toBe('lead_opted_out');
  });

  it('keeps the status of a lead that is already do-not-contact (an admin\'s reason is not overwritten)', async () => {
    mock(crmDb.getLeadById).mockResolvedValue({ listId: LIST, leadId: LEAD, phone: LEAD_PHONE, contactStatus: 'do-not-contact', contactStatusReason: 'admin-flagged' });
    await screenResult('3');
    expect(mock(crmDb.updateLead)).not.toHaveBeenCalled();
    expect(limits.claims.has(dnc())).toBe(true);
  });

  it('does not mark a number the call was not approved for (the lead\'s phone changed since the gates)', async () => {
    seed('bridging', { leadCallSid: LEAD_SID, leadPhoneMac: leadPhoneMacOf('org-a', '+14155550199') });
    const res = await screenResult('3');
    expect(res.text).toContain(GOODBYE);
    expect(limits.claims.size).toBe(0);
    expect(mock(crmDb.updateLead)).toHaveBeenCalledTimes(1);
    expect(logSpy[2].mock.calls.map((c) => String(c[0]))).toContain("[hotLeadCall] do-not-call write failed org-a: the lead's current phone is unreadable or not the one approved for this call");
  });

  it('/dial after a stop tells the member the lead asked not to be called again, and writes nothing more', async () => {
    await screenResult('3');
    const transitions = store.transitions;
    const res = await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' });
    expect(res.text).toContain(MEMBER_COPY);
    expect(store.transitions).toBe(transitions);
    expect(store.eventTypes()).toEqual(['call.lead_declined']);
  });

  it('both legs are metered and the record finishes lead_opted_out without trying another member', async () => {
    await screenResult('3');
    await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' });
    await leadStatus('completed', { CallDuration: '12' });
    await memberStatus('completed', { CallDuration: '30' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'lead_opted_out', meteredLegs: ['lead', 'member:1'] });
    expect(store.eventTypes()).toEqual(['call.lead_declined', 'call.completed']);
    expect(mock(requestNextHotLeadCallAttempt)).not.toHaveBeenCalled();
  });

  it('a 4, a 5 and no input still decline with no stop recorded (a key is answered with the callback number, no input with a bare hangup)', async () => {
    for (const digits of ['4', '5', undefined]) {
      seed('bridging', { leadCallSid: LEAD_SID });
      store.events = [];
      const res = await screenResult(digits);
      expect(res.text).toBe(digits === undefined ? '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>' : '<?xml version="1.0" encoding="UTF-8"?><Response><Say>You can reach us on 4 1 5, 5 5 5, 0 1 1 1. Goodbye.</Say><Hangup/></Response>');
      expect(store.record?.outcome).toBe('lead_declined');
    }
    expect(limits.claims.size).toBe(0);
    expect(mock(crmDb.updateLead)).not.toHaveBeenCalled();
  });

  describe('/gather re-checks the list before dialling the lead', () => {
    beforeEach(() => seed('member_answered'));

    it('refuses on the org marker (the same number pressed 3 on another lead): call.failed lead_do_not_call, unreachable copy, no Dial', async () => {
      limits.claims.set(dnc(), { token: 'dnc', expiresAtS: Math.floor(Date.now() / 1000) + 1000 });
      const res = await gather('1');
      expect(res.text).toContain('Sorry, we could not reach them. Goodbye.');
      expect(res.text).not.toContain('<Dial');
      expect(store.record).toMatchObject({ state: 'member_answered', outcome: 'lead_do_not_call' });
      expect(store.events).toEqual([{ type: 'call.failed', detail: { reason: 'lead_do_not_call' } }]);
    });

    it('refuses on the lead\'s own do-not-contact status', async () => {
      mock(crmDb.getLeadById).mockResolvedValue({ listId: LIST, leadId: LEAD, phone: LEAD_PHONE, contactStatus: 'do-not-contact' });
      const res = await gather('1');
      expect(res.text).not.toContain('<Dial');
      expect(store.record?.outcome).toBe('lead_do_not_call');
    });

    it('still dials a lead who only unsubscribed from email', async () => {
      mock(crmDb.getLeadById).mockResolvedValue({ listId: LIST, leadId: LEAD, phone: LEAD_PHONE, contactStatus: 'unsubscribed', unsubscribedFromGroupEmail: true });
      expect((await gather('1')).text).toContain('<Dial');
    });

    it('fails closed when the marker cannot be read: no Dial, nothing connects', async () => {
      limits.failNext = new Error('ddb down');
      const res = await gather('1');
      expect(res.text).not.toContain('<Dial');
      expect(store.record?.state).toBe('member_answered');
    });

    it('dials as before when the number is not on the list', async () => {
      expect((await gather('1')).text).toContain('<Dial');
    });
  });
});

describe('lead presses 2: not available now (one retry, ENG-2783)', () => {
  const HOUR = 3_600_000;
  const GOODBYE = 'Okay. Smith &amp; Sons will call you again later. You can reach us on 4 1 5, 5 5 5, 0 1 1 1. Goodbye.';
  const BARE_HANGUP = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>You can reach us on 4 1 5, 5 5 5, 0 1 1 1. Goodbye.</Say><Hangup/></Response>'; // an ordinary decline: the lead hears the callback number (64.1200(b)(2)), then the call ends
  beforeEach(() => seed('bridging', { leadCallSid: LEAD_SID }));

  it('defers once: outcome lead_deferred, a deferral at least an hour away, one call.lead_declined, the lead hears the goodbye', async () => {
    const before = Date.now();
    const res = await screenResult('2');
    expect(res.text).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${GOODBYE}</Say><Hangup/></Response>`);
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_deferred', deferral: { count: 1 } });
    // firstDueAt is written with the deferral, equal to the initial dueAt, and never changes afterwards.
    expect(store.record?.deferral?.firstDueAt).toBe(store.record?.deferral?.dueAt);
    const dueAt = Date.parse(store.record?.deferral?.dueAt ?? '');
    expect(dueAt).toBeGreaterThanOrEqual(before + HOUR);
    expect(dueAt).toBeLessThanOrEqual(Date.now() + 37 * HOUR);
    expect(store.events).toEqual([{ type: 'call.lead_declined', detail: { reason: 'not_available_now' } }]);
  });

  it('tells the member the lead is not available and that we will try again, and does not repeat the event', async () => {
    await screenResult('2');
    const res = await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' });
    expect(res.text).toContain(twiml.LEAD_DEFERRED_MEMBER_COPY);
    expect(store.eventTypes()).toEqual(['call.lead_declined']);
    expect(store.record?.outcome).toBe('lead_deferred');
  });

  it('a replay of the 2 repeats the goodbye and keeps the first deferral (no second one, no second event)', async () => {
    await screenResult('2');
    const first = store.record?.deferral;
    const replay = await screenResult('2');
    expect(replay.text).toContain(GOODBYE);
    expect(store.record?.deferral).toEqual(first);
    expect(store.eventTypes()).toEqual(['call.lead_declined']);
  });

  it('a 1 after the 2 does not connect: the lead is hung up on and the record stays deferred', async () => {
    await screenResult('2');
    const res = await screenResult('1');
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_deferred' });
    expect(store.eventTypes()).toEqual(['call.lead_declined']);
  });

  it('a 3 after the 2 still stops: do-not-call marker and contact status written, the deferral removed, the stop goodbye', async () => {
    await screenResult('2');
    const res = await screenResult('3');
    expect(res.text).toContain('will not call this number again');
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_opted_out' });
    expect(store.record?.deferral).toBeUndefined();
    expect([...limits.claims.keys()]).toEqual([dncKey('org-a', LEAD_PHONE)]);
    expect(mock(crmDb.updateLead)).toHaveBeenCalledWith(LIST, LEAD, expect.objectContaining({ contactStatus: 'do-not-contact' }));
    // The member is told the stop, not the deferral; a replay of the 3 writes nothing more.
    expect((await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' })).text).toContain('asked not to be called again');
    const writes = mock(crmDb.updateLead).mock.calls.length;
    await screenResult('3');
    expect(mock(crmDb.updateLead).mock.calls.length).toBe(writes);
  });

  it('on the retry call (the record keeps its deferral) a second 2 is an ordinary decline: the bare hangup and the ordinary member copy', async () => {
    seed('bridging', { leadCallSid: LEAD_SID, deferral: { dueAt: '2026-10-19T12:00:00.000Z', count: 1 }, retryClaimToken: 'tok' });
    const res = await screenResult('2');
    expect(res.text).toBe(BARE_HANGUP);
    expect(store.record).toMatchObject({ outcome: 'lead_declined', deferral: { count: 1 } });
    expect(store.events).toEqual([{ type: 'call.lead_declined', detail: { reason: 'not_available_no_retry' } }]);
    expect((await dial('completed', { DialCallSid: LEAD_SID, DialBridged: 'false' })).text).toContain('did not confirm');
  });

  it('with no minute inside the lead window within 36 hours the 2 is an ordinary decline and nothing is scheduled', async () => {
    mock(isInsideLeadCallWindow).mockReturnValue(false);
    const res = await screenResult('2');
    expect(res.text).toBe(BARE_HANGUP);
    expect(store.record?.outcome).toBe('lead_declined');
    expect(store.record?.deferral).toBeUndefined();
  });

  it('with the org\'s calling hours leaving no minute in 36 hours (the real lead window, not a mock) the 2 is an ordinary decline', async () => {
    mock(isInsideLeadCallWindow).mockImplementation(jest.requireActual('../services/voice/leadLocalHours').isInsideLeadCallWindow);
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, callingHours: { start: '01:00', end: '02:00', timezone: 'America/New_York' } } });
    expect((await screenResult('2')).text).toBe(BARE_HANGUP);
    expect(store.record).toMatchObject({ outcome: 'lead_declined' });
    expect(store.record?.deferral).toBeUndefined();
  });

  it('with retries switched off (HOT_LEAD_CALL_RETRY=off) a 2 promises nothing: an ordinary decline', async () => {
    process.env.HOT_LEAD_CALL_RETRY = 'off';
    try {
      expect((await screenResult('2')).text).toBe(BARE_HANGUP);
    } finally {
      delete process.env.HOT_LEAD_CALL_RETRY;
    }
    expect(store.record).toMatchObject({ outcome: 'lead_declined' });
    expect(store.record?.deferral).toBeUndefined();
  });

  it('with the global kill switch off a 2 promises nothing either', async () => {
    setHotLeadCallEnabledOverride(false);
    expect((await screenResult('2')).text).toBe(BARE_HANGUP);
    expect(store.record?.deferral).toBeUndefined();
  });

  describe('/screen offers option 2 only when a retry can happen', () => {
    const prompt = async (): Promise<string> => (await screen()).text;
    beforeEach(() => seed('bridging'));

    it('on the first call, with retries on: all three options', async () => {
      expect(await prompt()).toContain("Press 1 and we&apos;ll connect you to a person now, or press 2 and we&apos;ll call you again later.");
    });

    it('on the retry call (the record keeps its deferral): only 1 and 3', async () => {
      seed('bridging', { deferral: { dueAt: '2026-10-19T12:00:00.000Z', count: 1 }, retryClaimToken: 'tok' });
      const text = await prompt();
      expect(text).toContain("Press 1 and we&apos;ll connect you to a person now. You can also call us on");
      expect(text).not.toContain('press 2');
    });

    it('when no retry window can exist (the lead window never open within 36 hours): only 1 and 3, the same eligibility as the 2 itself', async () => {
      mock(isInsideLeadCallWindow).mockReturnValue(false);
      const text = await prompt();
      expect(text).toContain("Press 1 and we&apos;ll connect you to a person now. You can also call us on");
      expect(text).not.toContain('press 2');
    });

    it('when the org\'s calling hours leave no minute in 36 hours against the real lead window: only 1 and 3', async () => {
      mock(isInsideLeadCallWindow).mockImplementation(jest.requireActual('../services/voice/leadLocalHours').isInsideLeadCallWindow);
      mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, callingHours: { start: '01:00', end: '02:00', timezone: 'America/New_York' } } });
      expect(await prompt()).not.toContain('press 2');
    });

    it('when the lead\'s phone is no longer the one approved: only 1 and 3', async () => {
      seed('bridging', { leadPhoneMac: leadPhoneMacOf('org-a', '+14155550999') });
      expect(await prompt()).not.toContain('press 2');
    });

    it('a failing eligibility read still serves the prompt, without option 2, and logs one warning without the error text', async () => {
      mock(crmDb.getLeadById).mockRejectedValue(new Error('read failed for +14155550123'));
      const res = await screen();
      expect(res.status).toBe(200);
      expect(res.text).toContain("Press 1 and we&apos;ll connect you to a person now. You can also call us on");
      expect(res.text).not.toContain('press 2');
      expect(res.text).toContain('<Gather');
      const warns = warnSpy().mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('retry eligibility unavailable'));
      expect(warns).toEqual(['[hotLeadCall] retry eligibility unavailable, option 2 not offered: Error']);
    });

    it('with retries switched off: only 1 and 3', async () => {
      process.env.HOT_LEAD_CALL_RETRY = '0';
      try {
        expect(await prompt()).not.toContain('press 2');
      } finally {
        delete process.env.HOT_LEAD_CALL_RETRY;
      }
    });
  });

  it('a lead whose phone changed since the call was approved gets no retry', async () => {
    seed('bridging', { leadCallSid: LEAD_SID, leadPhoneMac: leadPhoneMacOf('org-a', '+14155550999') });
    expect((await screenResult('2')).text).toBe(BARE_HANGUP);
    expect(store.record?.deferral).toBeUndefined();
  });
});
