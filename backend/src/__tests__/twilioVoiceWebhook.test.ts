/**
 * Twilio voice webhooks (ENG-2271 WP5b): signature guard, per-endpoint state machine, metering.
 * The store is an in-memory fake with the same conditional semantics as LeadCallStore.transition.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { getExpectedTwilioSignature } from 'twilio';

const mockGetCreds = jest.fn();
jest.mock('../utils/secretsManager', () => ({ getTwilioCredentials: (...a: unknown[]) => mockGetCreds(...a) }));
jest.mock('../services/db', () => ({
  crmDb: { getLeadListById: jest.fn(), getLeadById: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/voice/voiceUsage', () => ({ recordCallUsage: jest.fn() }));

import { crmDb, orgDb, userDb } from '../services/db';
import { recordCallUsage } from '../services/voice/voiceUsage';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { setLeadCallStoreForTests } from '../services/voice/leadCallStore';
import { setVoiceProviderForTests } from '../services/voice/voiceProvider';
import { FakeVoiceProvider } from '../services/voice/fakeVoiceProvider';
import type { HotLeadCallEventType, HotLeadCallRecord, HotLeadCallState, LeadCallStore } from '../services/voice/leadCallStore.types';
import * as twiml from '../services/voice/twiml';
import { buildVoiceWebhookUrl } from '../services/voice/voiceUrls';
import twilioVoiceWebhookRoutes, { twilioVoiceBodyParser } from '../routes/twilioVoiceWebhook';

const mock = (fn: unknown) => fn as jest.Mock;
const BASE = 'https://api.example.test';
const MOUNT = '/api/webhooks/twilio-voice';
const LIST = 'list-a';
const LEAD = 'lead-a';
const JOB = 'job-1';
const OWNER_SID = 'CA00000001';
const LEAD_SID = 'CA00000002';
const OWNER_PHONE = '+14155550100';
const TWILIO_NUMBER = '+14155550111';
const LEAD_PHONE = '+14155550123';
const QUERY = `listId=${LIST}&leadId=${LEAD}&jobKey=${JOB}`;
const TERMINAL: HotLeadCallState[] = ['finished', 'failed', 'skipped'];

const orgConfig = {
  enabled: true,
  destinationPhone: OWNER_PHONE,
  destinationVerifiedAt: '2026-01-01T00:00:00.000Z',
  twilioNumber: TWILIO_NUMBER,
  announcedName: 'Smith & Sons',
  quietHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' },
};

class MemoryStore implements LeadCallStore {
  record: HotLeadCallRecord | null = null;
  events: Array<{ type: HotLeadCallEventType; detail?: unknown }> = [];
  transitions = 0;
  async get() { return this.record ? structuredClone(this.record) : null; }
  async create(_l: string, _i: string, record: HotLeadCallRecord) {
    if (this.record) return false;
    this.record = { meteredLegs: [], lastSequence: {}, ...structuredClone(record) };
    return true;
  }
  async transition(_l: string, _i: string, from: HotLeadCallState[], patch: Partial<HotLeadCallRecord> & { state: HotLeadCallState }) {
    const r = this.record;
    if (!r || from.length === 0 || from.some((s) => TERMINAL.includes(s)) || !from.includes(r.state)) return false;
    const seq = patch.lastSequence ?? {};
    if (Object.entries(seq).some(([k, v]) => r.lastSequence?.[k] !== undefined && r.lastSequence[k] >= v)) return false;
    const legs = [...new Set(patch.meteredLegs ?? [])];
    if (legs.some((l) => r.meteredLegs?.includes(l))) return false;
    for (const key of ['state', 'jobKey', 'ownerCallSid', 'leadCallSid', 'outcome'] as const) {
      if (patch[key] !== undefined) (r as unknown as Record<string, unknown>)[key] = patch[key];
    }
    r.lastSequence = { ...r.lastSequence, ...seq };
    r.meteredLegs = [...(r.meteredLegs ?? []), ...legs];
    this.transitions++;
    return true;
  }
  async addEvent(_l: string, _i: string, type: HotLeadCallEventType, detail?: Record<string, string | number | boolean>) {
    this.events.push({ type, detail });
  }
  eventTypes() { return this.events.map((e) => e.type); }
}

let store: MemoryStore;
let fake: FakeVoiceProvider;
let logSpy: jest.SpyInstance[];

function seed(state: HotLeadCallState, extra: Partial<HotLeadCallRecord> = {}) {
  store.record = {
    state, jobKey: JOB, startedAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
    ownerCallSid: OWNER_SID, meteredLegs: [], lastSequence: {}, ...extra,
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
const owner = (extra: Record<string, string> = {}) => post('owner', { CallSid: OWNER_SID, CallStatus: 'in-progress', ...extra });
const gather = (digits?: string, extra: Record<string, string> = {}) =>
  post('gather', { CallSid: OWNER_SID, ...(digits === undefined ? {} : { Digits: digits }), ...extra });
const dial = (status: string, extra: Record<string, string> = {}) =>
  post('dial', { CallSid: OWNER_SID, DialCallStatus: status, ...extra });
const ownerStatus = (callStatus: string, extra: Record<string, string> = {}) =>
  post('status', { CallSid: OWNER_SID, CallStatus: callStatus, ...extra });
const leadStatus = (callStatus: string, extra: Record<string, string> = {}) =>
  post('status', { CallSid: LEAD_SID, ParentCallSid: OWNER_SID, CallStatus: callStatus, ...extra }, { query: `${QUERY}&leg=lead` });

const usage = () => mock(recordCallUsage).mock.calls.map((c) => c[0]);

beforeEach(() => {
  jest.resetAllMocks();
  process.env.BACKEND_URL = `${BASE}/`;
  store = new MemoryStore();
  setLeadCallStoreForTests(store);
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
  setHotLeadCallEnabledOverride(null);
  logSpy.forEach((s) => s.mockRestore());
  delete process.env.BACKEND_URL;
});

const digitsOf = (s: string) => s.replace(/\D/g, '');
const noPhoneIn = (text: string) => {
  for (const p of [OWNER_PHONE, LEAD_PHONE, TWILIO_NUMBER]) expect(digitsOf(text)).not.toContain(digitsOf(p));
};

// ── guard ────────────────────────────────────────────────────────────────────

const ENDPOINTS: Array<[string, () => request.Test]> = [
  ['owner', () => owner()],
  ['gather', () => gather('1')],
  ['dial', () => dial('no-answer')],
  ['status', () => ownerStatus('completed', { CallDuration: '30' })],
];

describe.each(ENDPOINTS)('%s guard', (name, call) => {
  beforeEach(() => seed('owner_answered', { meteredLegs: [] }));

  it('answers 503 and processes nothing when credentials cannot be loaded', async () => {
    fake.ensureCredentials = async () => { throw new Error('secrets down'); };
    const res = await call();
    expect(res.status).toBe(503);
    expect(fake.signatureChecks).toHaveLength(0);
    expect(store.transitions).toBe(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('logs only the error name when it cannot verify (no message, no params)', async () => {
    fake.ensureCredentials = async () => { throw new Error(`secret ${LEAD_PHONE}`); };
    await call();
    const logs = JSON.stringify(logSpy.flatMap((s) => s.mock.calls));
    expect(logs).toContain('cannot verify callback');
    expect(logs).not.toContain('secret');
  });

  it('answers 401 when the signature header is missing', async () => {
    const res = await post(name, { CallSid: OWNER_SID }, { signature: null });
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
    await post(name, { CallSid: OWNER_SID }, { host: 'evil.example' });
    expect(fake.signatureChecks).toHaveLength(1);
    expect(fake.signatureChecks[0].url).toBe(`${BASE}${MOUNT}/${name}?${QUERY}`);
    expect(fake.signatureChecks[0].params).toEqual({ CallSid: OWNER_SID });
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
    const res = await post(name, { CallSid: OWNER_SID, Digits: '1', DialCallStatus: 'no-answer', CallStatus: 'completed' }, { query });
    expect(res.status).toBe(200);
    if (name === 'status') expect(res.text).toBe('');
    else expect(res.text).toContain('<Hangup/>');
    expect(store.transitions).toBe(0);
    expect(store.events).toHaveLength(0);
  });

  it('ignores a callback whose jobKey is not the record\'s', async () => {
    const res = await post(name, { CallSid: OWNER_SID, Digits: '1', DialCallStatus: 'no-answer', CallStatus: 'completed' }, { query: `listId=${LIST}&leadId=${LEAD}&jobKey=old-job` });
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
    seed('owner_ringing');
  });
  const signed = (query: string, params: Record<string, string>, token = TOKEN) =>
    getExpectedTwilioSignature(token, `${BASE}${MOUNT}/owner?${query}`, params);

  it('loads credentials, then accepts a genuine Twilio signature', async () => {
    const params = { CallSid: OWNER_SID, CallStatus: 'in-progress' };
    const res = await post('owner', params, { signature: signed(QUERY, params) });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Gather');
    expect(mockGetCreds).toHaveBeenCalled();
    expect(store.record?.state).toBe('owner_answered');
  });

  it.each([
    ['a tampered query', (p: Record<string, string>) => ({ query: `listId=${LIST}&leadId=other&jobKey=${JOB}`, sig: signed(QUERY, p), params: p })],
    ['a tampered body', (p: Record<string, string>) => ({ query: QUERY, sig: signed(QUERY, p), params: { ...p, CallStatus: 'completed' } })],
    ['the wrong auth token', (p: Record<string, string>) => ({ query: QUERY, sig: signed(QUERY, p, 'other-token'), params: p })],
  ])('rejects %s with 401 and writes nothing', async (_label, build) => {
    const { query, sig, params } = build({ CallSid: OWNER_SID, CallStatus: 'in-progress' });
    const res = await post('owner', params, { query, signature: sig });
    expect(res.status).toBe(401);
    expect(store.record?.state).toBe('owner_ringing');
    expect(store.events).toHaveLength(0);
  });

  it('answers 503 when credentials are unavailable, even with a valid-looking signature', async () => {
    mockGetCreds.mockRejectedValue(new Error('no secret'));
    const params = { CallSid: OWNER_SID };
    const res = await post('owner', params, { signature: signed(QUERY, params) });
    expect(res.status).toBe(503);
    expect(store.record?.state).toBe('owner_ringing');
  });
});

// ── /owner ───────────────────────────────────────────────────────────────────

describe('POST /owner', () => {
  it('moves owner_ringing to owner_answered once and answers the escaped prompt as text/xml', async () => {
    seed('owner_ringing');
    const res = await owner();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('New lead from Smith &amp; Sons. Press 1 to connect to them now.');
    expect(res.text).toContain(`action="${BASE}${MOUNT}/gather?${QUERY}"`.replace(/&/g, '&amp;'));
    expect(store.record?.state).toBe('owner_answered');
    expect(store.eventTypes()).toEqual(['call.owner_answered']);
    noPhoneIn(res.text);
  });

  it('serves the same prompt again on a Twilio retry without a second event', async () => {
    seed('owner_ringing');
    await owner();
    const res = await owner();
    expect(res.text).toContain('<Gather');
    expect(store.eventTypes()).toEqual(['call.owner_answered']);
  });

  it.each(['bridging', 'connected', 'finished'] as const)('hangs up when the record is already %s', async (state) => {
    seed(state);
    const res = await owner();
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(store.record?.state).toBe(state);
    expect(store.events).toHaveLength(0);
  });

  it.each([
    ['disabled', { ...orgConfig, enabled: false }],
    ['invalid', { ...orgConfig, maxCallsPerDay: 9999 }],
  ])('hangs up without a prompt when the org config is now %s, recording only the aborted outcome', async (_label, cfg) => {
    seed('owner_ringing');
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: cfg });
    const res = await owner();
    expect(res.text).not.toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'owner_answered', outcome: 'aborted' });
    expect(store.eventTypes()).toEqual(['call.failed']);
  });
});

describe('records still in dialing (orchestrator has not stored the owner CallSid yet)', () => {
  beforeEach(() => seed('dialing', { ownerCallSid: undefined }));

  it('/owner adopts the CallSid of the signed callback and answers the prompt', async () => {
    const res = await owner();
    expect(res.text).toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'owner_answered', ownerCallSid: OWNER_SID });
    expect(store.eventTypes()).toEqual(['call.initiated', 'call.owner_answered']);
  });

  it('writes call.initiated once, by the winning adoption only, even when callbacks race', async () => {
    await Promise.all([owner(), owner(), ownerStatus('in-progress')]);
    expect(store.eventTypes().filter((t) => t === 'call.initiated')).toHaveLength(1);
    expect(store.record?.ownerCallSid).toBe(OWNER_SID);
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
    await Promise.all([owner(), post('owner', { CallSid: 'CA00000077' })]);
    expect(store.eventTypes().filter((t) => t === 'call.initiated')).toHaveLength(1);
  });

  it('adoption moves the record to owner_ringing, so the orchestrator\'s late settle loses and call.initiated is written once', async () => {
    await ownerStatus('in-progress');
    expect(store.record).toMatchObject({ state: 'owner_ringing', ownerCallSid: OWNER_SID });
    // The orchestrator's settle (dialing -> owner_ringing, then call.initiated).
    const settled = await store.transition(LIST, LEAD, ['dialing'], { state: 'owner_ringing', ownerCallSid: OWNER_SID });
    if (settled) await store.addEvent(LIST, LEAD, 'call.initiated');
    expect(settled).toBe(false);
    expect(store.eventTypes()).toEqual(['call.initiated']);
  });

  it('keeps the orchestrator\'s placement_unknown outcome untouched when adopting', async () => {
    seed('dialing', { outcome: 'placement_unknown', ownerCallSid: undefined });
    await ownerStatus('in-progress');
    expect(store.record).toMatchObject({ state: 'owner_ringing', outcome: 'placement_unknown' });
  });

  it('the first adopted sid wins: a racing callback with another sid cannot replace it', async () => {
    await Promise.all([owner(), post('owner', { CallSid: 'CA00000077' })]);
    expect(['CA00000077', OWNER_SID]).toContain(store.record?.ownerCallSid);
    const first = store.record?.ownerCallSid;
    await post('owner', { CallSid: first === OWNER_SID ? 'CA00000077' : OWNER_SID });
    expect(store.record?.ownerCallSid).toBe(first);
  });

  it('does not adopt for a callback whose jobKey is not the record\'s', async () => {
    const res = await post('owner', { CallSid: OWNER_SID }, { query: `listId=${LIST}&leadId=${LEAD}&jobKey=other-job` });
    expect(res.text).not.toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'dialing' });
    expect(store.record?.ownerCallSid).toBeUndefined();
  });

  it('does not adopt a malformed CallSid', async () => {
    const res = await post('owner', { CallSid: 'not-a-sid' });
    expect(res.text).not.toContain('<Gather');
    expect(store.record?.ownerCallSid).toBeUndefined();
  });

  it('keeps the adopted sid: a later callback with another sid is ignored', async () => {
    await owner();
    const res = await post('owner', { CallSid: 'CA09999999' });
    expect(res.text).not.toContain('<Gather');
    expect(store.record?.ownerCallSid).toBe(OWNER_SID);
  });

  it('/gather and /dial never adopt a sid or act on a record that has not been answered', async () => {
    await gather('1');
    await dial('no-answer');
    expect(store.record?.ownerCallSid).toBeUndefined();
    expect(store.events).toHaveLength(0);
  });

  it('a lead-leg callback does not adopt anything', async () => {
    await leadStatus('completed', { CallDuration: '5' });
    expect(store.record?.ownerCallSid).toBeUndefined();
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('the owner final status adopts the sid, meters under it and finishes an unanswered call', async () => {
    await ownerStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'owner_no_answer', ownerCallSid: OWNER_SID });
    expect(usage()).toEqual([{ userId: 'owner-a', callSid: OWNER_SID, leg: 'owner', durationSeconds: 0 }]);
  });
});

// ── /gather ──────────────────────────────────────────────────────────────────

describe('POST /gather', () => {
  beforeEach(() => seed('owner_answered'));

  it('bridges on Digits=1: state bridging, Dial with the lead number from the lead row, status callback with leg=lead', async () => {
    const res = await gather('1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(store.record?.state).toBe('bridging');
    expect(res.text).toContain('Connecting you now.');
    expect(res.text).toContain(`callerId="${TWILIO_NUMBER}"`);
    expect(res.text).toContain(`>${LEAD_PHONE}</Number>`);
    expect(res.text).toContain(`${MOUNT}/status?${QUERY.replace(/&/g, '&amp;')}&amp;leg=lead#rc=3&amp;rp=5xx,ct"`);
    expect(res.text).toContain(`${MOUNT}/dial?${QUERY.replace(/&/g, '&amp;')}`);
    // The lead number appears in the <Number> element and nowhere else.
    expect(res.text.split(LEAD_PHONE)).toHaveLength(2);
    expect(res.text).not.toContain(OWNER_PHONE);
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

  it.each([['2'], ['11'], [' 1'], ['#'], ['']])('declines on Digits=%j: outcome owner_declined, one event, hangup', async (digits) => {
    const res = await gather(digits);
    expect(res.text).toContain('<Hangup/>');
    expect(res.text).not.toContain('<Dial');
    expect(store.record).toMatchObject({ state: 'owner_answered', outcome: 'owner_declined' });
    expect(store.eventTypes()).toEqual(['call.owner_declined']);
  });

  it('treats a missing Digits field as a decline', async () => {
    const res = await gather(undefined);
    expect(res.text).not.toContain('<Dial');
    expect(store.eventTypes()).toEqual(['call.owner_declined']);
  });

  it('does not repeat the decline event on replay, and a later "1" cannot reverse it', async () => {
    await gather('2');
    await gather('2');
    const late = await gather('1');
    expect(late.text).not.toContain('<Dial');
    expect(store.record?.state).toBe('owner_answered');
    expect(store.eventTypes()).toEqual(['call.owner_declined']);
  });

  it.each(['owner_ringing', 'bridging', 'connected', 'finished'] as const)('hangs up when the record is %s', async (state) => {
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
    expect(store.record).toMatchObject({ state: 'owner_answered', outcome: 'lead_phone_invalid' });
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
    expect(store.record?.state).toBe('owner_answered');
    expect(store.record?.outcome).toBe('aborted');
    expect(store.eventTypes()).toEqual(['call.failed']); // once, the second press is a replay of the decision
  });
});

// ── /dial ────────────────────────────────────────────────────────────────────

describe('POST /dial', () => {
  beforeEach(() => seed('bridging'));

  it.each(['no-answer', 'busy', 'failed', 'canceled'])('records lead_no_answer once for DialCallStatus=%s and apologises', async (status) => {
    const res = await dial(status, { DialCallSid: LEAD_SID });
    expect(res.text).toContain('could not reach them');
    expect(res.text).toContain('<Hangup/>');
    expect(store.record).toMatchObject({ state: 'bridging', outcome: 'lead_no_answer', leadCallSid: LEAD_SID });
    await dial(status, { DialCallSid: LEAD_SID });
    expect(store.eventTypes()).toEqual(['call.lead_no_answer']);
  });

  it('records a lead that never started (no DialCallSid) without a lead sid', async () => {
    await dial('failed');
    expect(store.record?.leadCallSid).toBeUndefined();
    expect(store.eventTypes()).toEqual(['call.lead_no_answer']);
  });

  it('moves bridging to connected once on completed, with one call.connected', async () => {
    const res = await dial('completed', { DialCallSid: LEAD_SID });
    expect(res.text).toContain('<Hangup/>');
    await dial('completed', { DialCallSid: LEAD_SID });
    expect(store.record).toMatchObject({ state: 'connected', leadCallSid: LEAD_SID });
    expect(store.eventTypes()).toEqual(['call.connected']);
  });

  it('does not downgrade a connected call or repeat the connected event when the answered callback came first', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await dial('completed', { DialCallSid: LEAD_SID });
    await dial('no-answer', { DialCallSid: LEAD_SID });
    expect(store.record).toMatchObject({ state: 'connected' });
    expect(store.record?.outcome).toBeUndefined();
    expect(store.events).toHaveLength(0);
  });

  it('ignores an unknown DialCallStatus and a DialCallSid equal to the owner sid', async () => {
    await dial('weird', { DialCallSid: OWNER_SID });
    await dial('failed', { DialCallSid: OWNER_SID });
    expect(store.record?.leadCallSid).toBeUndefined();
    expect(store.eventTypes()).toEqual(['call.lead_no_answer']);
  });

  it.each(['owner_answered', 'owner_ringing'] as const)('writes nothing when the record is %s', async (state) => {
    seed(state);
    await dial('completed');
    await dial('no-answer');
    expect(store.events).toHaveLength(0);
    expect(store.record?.state).toBe(state);
  });
});

// ── /status ──────────────────────────────────────────────────────────────────

describe('POST /status', () => {
  it.each(['no-answer', 'busy', 'failed', 'canceled'])('owner never answered (%s): meters the owner leg once, records owner_no_answer and finishes', async (status) => {
    seed('owner_ringing');
    const res = await ownerStatus(status, { CallDuration: '0', SequenceNumber: '1' });
    expect(res.status).toBe(200);
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'owner_no_answer', meteredLegs: ['owner'] });
    expect(usage()).toEqual([{ userId: 'owner-a', callSid: OWNER_SID, leg: 'owner', durationSeconds: 0 }]);
  });

  it('records the timeline events for an unanswered owner exactly once, even when replayed', async () => {
    seed('owner_ringing');
    await ownerStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    await ownerStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    expect(store.eventTypes()).toEqual(['call.owner_no_answer', 'call.completed']);
    expect(recordCallUsage).toHaveBeenCalledTimes(1);
  });

  it('full call: lead answered, lead ends first, owner ends last. Meters each leg once; the last callback finishes', async () => {
    seed('owner_answered');
    await gather('1');
    await leadStatus('initiated', { SequenceNumber: '0' });
    await leadStatus('ringing', { SequenceNumber: '1' });
    await leadStatus('in-progress', { SequenceNumber: '2' });
    expect(store.record).toMatchObject({ state: 'connected', leadCallSid: LEAD_SID });
    await leadStatus('completed', { SequenceNumber: '3', CallDuration: '125' });
    expect(store.record?.state).toBe('connected'); // owner leg not metered yet
    expect(usage()).toEqual([{ userId: 'owner-a', callSid: LEAD_SID, leg: 'lead', durationSeconds: 125 }]);
    await ownerStatus('completed', { CallDuration: '140', SequenceNumber: '1' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'completed', meteredLegs: ['lead', 'owner'] });
    expect(usage()).toHaveLength(2);
    expect(usage()[1]).toEqual({ userId: 'owner-a', callSid: OWNER_SID, leg: 'owner', durationSeconds: 140 });
    expect(store.eventTypes()).toEqual(['call.connected', 'call.completed']);
  });

  it('full call with the owner leg ending first: the lead callback is the one that finishes', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await ownerStatus('completed', { CallDuration: '90' });
    expect(store.record?.state).toBe('connected');
    expect(store.events).toHaveLength(0);
    await leadStatus('completed', { CallDuration: '85', SequenceNumber: '3' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(usage().map((u) => u.leg).sort()).toEqual(['lead', 'owner']);
  });

  it('terminal rule: a leg-terminal callback never finishes the record while the other dialed leg is unmetered', async () => {
    seed('bridging');
    await ownerStatus('completed', { CallDuration: '20' });
    expect(store.record?.state).toBe('bridging');
    expect(store.record?.meteredLegs).toEqual(['owner']);
    // The late lead callback can still be metered because the record never went terminal.
    await leadStatus('no-answer', { CallDuration: '0', SequenceNumber: '2' });
    // No /dial result was ever seen, so the lead outcome is not claimed.
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'bridge_unconfirmed', meteredLegs: ['owner', 'lead'] });
    expect(store.eventTypes()).toEqual(['call.completed']);
    expect(usage()).toHaveLength(2);
  });

  it('does not wait for a lead leg that was never created (dial failed without a sid)', async () => {
    seed('bridging');
    await dial('failed');
    await ownerStatus('completed', { CallDuration: '30' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'lead_no_answer', meteredLegs: ['owner'] });
    expect(usage()).toHaveLength(1);
  });

  it('waits for the lead leg when /dial reported a lead sid', async () => {
    seed('bridging');
    await dial('no-answer', { DialCallSid: LEAD_SID });
    await ownerStatus('completed', { CallDuration: '30' });
    expect(store.record?.state).toBe('bridging');
    await leadStatus('no-answer', { CallDuration: '0', SequenceNumber: '2' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'lead_no_answer' });
  });

  it('owner declined: the owner leg final callback meters and finishes with owner_declined', async () => {
    seed('owner_answered');
    await gather('2');
    expect(store.record?.state).toBe('owner_answered');
    await ownerStatus('completed', { CallDuration: '12' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'owner_declined' });
    expect(store.eventTypes()).toEqual(['call.owner_declined', 'call.completed']);
    expect(usage()).toHaveLength(1);
  });

  it('owner hung up on the prompt without pressing anything: owner_declined, once', async () => {
    seed('owner_answered');
    await ownerStatus('completed', { CallDuration: '4' });
    await ownerStatus('completed', { CallDuration: '4' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'owner_declined' });
    expect(store.eventTypes()).toEqual(['call.owner_declined', 'call.completed']);
  });

  it('never meters a leg twice: replays of the same terminal callback bill once', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    for (let i = 0; i < 3; i++) await leadStatus('completed', { CallDuration: '60', SequenceNumber: '3' });
    expect(usage()).toHaveLength(1);
    // Same callback without a SequenceNumber (guarded by meteredLegs alone).
    for (let i = 0; i < 3; i++) await ownerStatus('completed', { CallDuration: '70' });
    expect(usage().map((u) => u.leg)).toEqual(['lead', 'owner']);
    expect(store.eventTypes()).toEqual(['call.completed']);
  });

  it('meters exactly once when the same terminal callback arrives concurrently', async () => {
    seed('connected', { leadCallSid: LEAD_SID, meteredLegs: ['lead'] });
    await Promise.all([1, 2, 3].map(() => ownerStatus('completed', { CallDuration: '70', SequenceNumber: '1' })));
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

  it('a lead "answered" callback moves bridging to connected exactly once', async () => {
    seed('bridging');
    await leadStatus('in-progress', { SequenceNumber: '2' });
    await leadStatus('in-progress', { SequenceNumber: '2' });
    expect(store.eventTypes()).toEqual(['call.connected']);
    expect(store.record?.leadCallSid).toBe(LEAD_SID);
  });

  it('does not default a missing CallDuration to 0: the duration reaches the meter as NaN', async () => {
    seed('owner_answered');
    await ownerStatus('completed');
    expect(usage()).toHaveLength(1);
    expect(Number.isNaN(usage()[0].durationSeconds)).toBe(true);
  });

  it('passes through a garbled CallDuration as NaN too', async () => {
    seed('owner_answered');
    await ownerStatus('completed', { CallDuration: 'abc' });
    expect(Number.isNaN(usage()[0].durationSeconds)).toBe(true);
  });

  it.each(['', '   '])('treats an empty or blank CallDuration (%j) as missing, not as 0 seconds', async (blank) => {
    seed('owner_answered');
    await ownerStatus('completed', { CallDuration: blank });
    expect(usage()).toHaveLength(1);
    expect(Number.isNaN(usage()[0].durationSeconds)).toBe(true);
  });

  it('meters each leg with its own CallSid and the list owner as the billed user', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await ownerStatus('completed', { CallDuration: '61' });
    await leadStatus('completed', { CallDuration: '30' });
    expect(usage()).toEqual([
      { userId: 'owner-a', callSid: OWNER_SID, leg: 'owner', durationSeconds: 61 },
      { userId: 'owner-a', callSid: LEAD_SID, leg: 'lead', durationSeconds: 30 },
    ]);
  });

  it('still meters and finishes when the config was disabled mid-call, and with the kill switch off', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    setHotLeadCallEnabledOverride(false);
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, enabled: false } });
    await leadStatus('completed', { CallDuration: '30' });
    await ownerStatus('completed', { CallDuration: '40' });
    expect(usage().map((u) => u.userId)).toEqual(['owner-a', 'owner-a']);
    expect(store.record?.state).toBe('finished');
  });

  it('answers 500 without writing when no owner can be found to bill, so the status retry override redelivers', async () => {
    seed('owner_answered');
    mock(crmDb.getLeadListById).mockResolvedValue(null);
    const res = await ownerStatus('completed', { CallDuration: '30' });
    expect(res.status).toBe(500);
    expect(store.transitions).toBe(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('bills only the caller that wins the metering transition (a lost race or replay must not bill)', async () => {
    seed('owner_answered');
    jest.spyOn(store, 'transition').mockResolvedValue(false);
    expect((await ownerStatus('completed', { CallDuration: '30' })).status).toBe(500); // lost every attempt: redelivered
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('a metering failure is logged and does not fail the webhook or double-bill on retry', async () => {
    seed('owner_answered');
    mock(recordCallUsage).mockRejectedValue(new Error('boom'));
    const res = await ownerStatus('completed', { CallDuration: '30' });
    expect(res.status).toBe(200);
    await ownerStatus('completed', { CallDuration: '30' });
    expect(recordCallUsage).toHaveBeenCalledTimes(1);
  });

  it('ignores a lead callback whose ParentCallSid is not the owner call, and an owner callback with a foreign sid', async () => {
    seed('connected');
    await post('status', { CallSid: LEAD_SID, ParentCallSid: 'CA0000000X', CallStatus: 'completed', CallDuration: '9' }, { query: `${QUERY}&leg=lead` });
    await post('status', { CallSid: LEAD_SID, CallStatus: 'completed', CallDuration: '9' }, { query: `${QUERY}&leg=lead` });
    await post('status', { CallSid: LEAD_SID, CallStatus: 'completed', CallDuration: '9' });
    await post('status', { CallSid: OWNER_SID, ParentCallSid: OWNER_SID, CallStatus: 'completed', CallDuration: '9' }, { query: `${QUERY}&leg=lead` });
    expect(store.transitions).toBe(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('ignores a second, different lead sid once the lead leg is known', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await post('status', { CallSid: 'CA00000099', ParentCallSid: OWNER_SID, CallStatus: 'completed', CallDuration: '9' }, { query: `${QUERY}&leg=lead` });
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('ignores callbacks for a finished record: nothing is written or billed', async () => {
    seed('finished', { meteredLegs: ['owner'], outcome: 'completed' });
    await ownerStatus('completed', { CallDuration: '30' });
    await leadStatus('completed', { CallDuration: '30' });
    expect(recordCallUsage).not.toHaveBeenCalled();
    expect(store.transitions).toBe(0);
    expect(store.events).toHaveLength(0);
  });

  it('ignores unknown CallStatus values', async () => {
    seed('owner_answered');
    await ownerStatus('weird', { CallDuration: '5' });
    expect(store.transitions).toBe(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });

  it('a stuck record (the other leg never reports) stays non-terminal by design', async () => {
    seed('connected', { leadCallSid: LEAD_SID });
    await ownerStatus('completed', { CallDuration: '30' });
    expect(store.record?.state).toBe('connected');
    expect(store.record?.meteredLegs).toEqual(['owner']);
  });
});

// ── request body parsing ─────────────────────────────────────────────────────

describe('request body parsing', () => {
  beforeEach(() => seed('owner_ringing'));

  it('rejects an oversized body with 413 before anything is verified or written', async () => {
    const res = await post('owner', { CallSid: OWNER_SID, Junk: 'x'.repeat(70 * 1024) });
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
    seed('owner_ringing');
    const params = { CallSid: OWNER_SID, CallStatus: 'in-progress' };
    const res = await request(app())
      .post(`${MOUNT}/owner?${QUERY}`)
      .set('X-Twilio-Signature', getExpectedTwilioSignature('tok', `${BASE}${MOUNT}/owner?${QUERY}`, params))
      .type('json')
      .send(params);
    expect(res.status).toBe(401);
    expect(store.record?.state).toBe('owner_ringing');
  });

  it('keeps bracketed keys as flat strings instead of building nested objects', async () => {
    await request(app()).post(`${MOUNT}/owner?${QUERY}`).set('X-Twilio-Signature', 'sig').type('form').send('CallSid=CA00000001&a[b]=1&a[c][d]=2');
    expect(fake.signatureChecks[0].params).toEqual({ CallSid: OWNER_SID, 'a[b]': '1', 'a[c][d]': '2' });
  });

  it('still verifies a genuine Twilio signature through the narrow parser', async () => {
    setVoiceProviderForTests(null);
    mockGetCreds.mockResolvedValue({ accountSid: 'ACfake0123456789abcdef0123456789ab', authToken: 'tok' });
    const params = { CallSid: OWNER_SID, 'a[b]': '1' };
    const sig = getExpectedTwilioSignature('tok', `${BASE}${MOUNT}/owner?${QUERY}`, params);
    const res = await post('owner', params, { signature: sig });
    expect(res.status).toBe(200);
    expect(store.record?.state).toBe('owner_answered');
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
    seed('owner_answered');
    mock(crmDb.getLeadListById).mockResolvedValue(null);
    expect((await ownerStatus('completed', { CallDuration: '30', SequenceNumber: '1' })).status).toBe(500);
    expect(store.transitions).toBe(0);
    expect(store.record?.meteredLegs).toEqual([]);
    mock(crmDb.getLeadListById).mockResolvedValue({ listId: LIST, userId: 'owner-a' });
    expect((await ownerStatus('completed', { CallDuration: '30', SequenceNumber: '1' })).status).toBe(200);
    expect((await ownerStatus('completed', { CallDuration: '30', SequenceNumber: '1' })).status).toBe(200);
    expect(usage()).toHaveLength(1);
    expect(store.record?.state).toBe('finished');
  });

  it('answers 500 and logs when every attempt loses its transition, then a redelivery meters', async () => {
    seed('owner_answered');
    const spy = jest.spyOn(store, 'transition').mockResolvedValue(false);
    const res = await ownerStatus('completed', { CallDuration: '30' });
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(recordCallUsage).not.toHaveBeenCalled();
    expect(JSON.stringify(logSpy.flatMap((s) => s.mock.calls))).toContain('metering gave up after retries');
    spy.mockRestore();
    expect((await ownerStatus('completed', { CallDuration: '30' })).status).toBe(200);
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
    seed('owner_answered');
    await ownerStatus('completed', { CallDuration: '30' });
    const again = await ownerStatus('completed', { CallDuration: '30' });
    expect(again.status).toBe(200);
    expect(JSON.stringify(logSpy.flatMap((s) => s.mock.calls))).not.toContain('gave up');
  });

  it('validates the signature of a status URL built with the retry fragment (Twilio signs without it)', async () => {
    setVoiceProviderForTests(null);
    mockGetCreds.mockResolvedValue({ accountSid: 'ACfake0123456789abcdef0123456789ab', authToken: 'tok' });
    seed('owner_answered');
    const built = buildVoiceWebhookUrl('status', { listId: LIST, leadId: LEAD, jobKey: JOB });
    expect(built).toContain('#rc=3&rp=5xx,ct');
    const [onWire] = built.split('#');
    const params = { CallSid: OWNER_SID, CallStatus: 'completed', CallDuration: '8' };
    const res = await request(app())
      .post(onWire.slice(BASE.length))
      .set('X-Twilio-Signature', getExpectedTwilioSignature('tok', onWire, params))
      .type('form')
      .send(params);
    expect(res.status).toBe(200);
    expect(usage()).toHaveLength(1);
  });

  it('puts the retry fragment on the lead <Number> status callback only, not on the TwiML fetch URLs', async () => {
    seed('owner_answered');
    const text = (await gather('1')).text;
    expect(text.match(/#rc=3&amp;rp=5xx,ct/g)).toHaveLength(1);
    expect(text).toContain('statusCallback="');
    expect(text.split('action="')[1].split('"')[0]).not.toContain('#');
  });
});

// ── aborted calls, unconfirmed placements, concurrency ───────────────────────

describe('aborted calls', () => {
  it('/owner with the kill switch off records outcome aborted, so the owner final callback does not relabel it', async () => {
    seed('owner_ringing');
    setHotLeadCallEnabledOverride(false);
    const res = await owner();
    expect(res.text).not.toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'owner_answered', outcome: 'aborted' });
    await ownerStatus('completed', { CallDuration: '6' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'aborted' });
    expect(store.eventTypes()).toEqual(['call.failed', 'call.completed']);
    expect(usage()).toHaveLength(1);
  });

  it('/owner with a disabled config aborts once even when replayed', async () => {
    seed('dialing', { ownerCallSid: undefined });
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, enabled: false } });
    await owner();
    await owner();
    expect(store.record).toMatchObject({ outcome: 'aborted', ownerCallSid: OWNER_SID });
    expect(store.eventTypes()).toEqual(['call.initiated', 'call.failed']);
  });

  it('/gather with the config disabled mid-call aborts and never dials', async () => {
    seed('owner_answered');
    mock(orgDb.getOrgById).mockResolvedValue({ orgId: 'org-a', hotLeadCall: { ...orgConfig, enabled: false } });
    const res = await gather('1');
    expect(res.text).not.toContain('<Dial');
    expect(store.record).toMatchObject({ state: 'owner_answered', outcome: 'aborted' });
    await ownerStatus('completed', { CallDuration: '9' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'aborted' });
  });

  it('does not abort a record that does not belong to the callback (wrong job key)', async () => {
    seed('owner_ringing');
    setHotLeadCallEnabledOverride(false);
    await post('owner', { CallSid: OWNER_SID }, { query: `listId=${LIST}&leadId=${LEAD}&jobKey=old` });
    expect(store.record).toMatchObject({ state: 'owner_ringing' });
    expect(store.record?.outcome).toBeUndefined();
  });
});

describe('ambiguous placements (dialing + outcome placement_unknown) and rejected ones', () => {
  it('adopts the CallSid and serves the prompt when the owner picks up', async () => {
    seed('dialing', { outcome: 'placement_unknown', ownerCallSid: undefined });
    const res = await owner();
    expect(res.text).toContain('<Gather');
    expect(store.record).toMatchObject({ state: 'owner_answered', ownerCallSid: OWNER_SID });
    expect(store.eventTypes()).toEqual(['call.initiated', 'call.owner_answered']);
  });

  it('still records owner_no_answer, meters and finishes when the owner never answers', async () => {
    seed('dialing', { outcome: 'placement_unknown', ownerCallSid: undefined });
    await ownerStatus('no-answer', { CallDuration: '0', SequenceNumber: '1' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'owner_no_answer', ownerCallSid: OWNER_SID });
    expect(store.eventTypes()).toEqual(['call.initiated', 'call.owner_no_answer', 'call.completed']);
    expect(usage()).toHaveLength(1);
  });

  it('still records owner_declined when the owner answered and hung up on the prompt', async () => {
    seed('dialing', { outcome: 'placement_unknown', ownerCallSid: undefined });
    await owner();
    await ownerStatus('completed', { CallDuration: '4' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'owner_declined' });
  });

  it('keeps the owner decision when the record carried placement_unknown', async () => {
    seed('dialing', { outcome: 'placement_unknown', ownerCallSid: undefined });
    await owner();
    await gather('2');
    await ownerStatus('completed', { CallDuration: '4' });
    expect(store.record?.outcome).toBe('owner_declined');
  });

  it('reports a connected call as completed, not as placement_unknown', async () => {
    seed('owner_answered', { outcome: 'placement_unknown' });
    await gather('1');
    await leadStatus('in-progress', { SequenceNumber: '2' });
    await leadStatus('completed', { CallDuration: '9', SequenceNumber: '3' });
    await ownerStatus('completed', { CallDuration: '12' });
    expect(store.record).toMatchObject({ state: 'finished', outcome: 'completed' });
  });

  it('ignores every callback for a place_rejected record (a definite non-call)', async () => {
    seed('failed', { outcome: 'place_rejected', ownerCallSid: undefined });
    for (const res of [await owner(), await gather('1'), await dial('no-answer'), await ownerStatus('completed', { CallDuration: '5' })]) {
      expect(res.status).toBe(200);
    }
    expect(store.record?.state).toBe('failed');
    expect(store.record?.ownerCallSid).toBeUndefined();
    expect(store.transitions).toBe(0);
    expect(store.events).toHaveLength(0);
    expect(recordCallUsage).not.toHaveBeenCalled();
  });
});

describe('concurrency and failures around bridging', () => {
  it('two simultaneous "1" presses produce exactly one bridge', async () => {
    seed('owner_answered');
    const results = await Promise.all([gather('1'), gather('1')]);
    expect(results.filter((r) => r.text.includes('<Dial')).length).toBe(1);
    expect(store.record?.state).toBe('bridging');
  });

  it('a TwiML builder failure leaves the record owner_answered, not bridging', async () => {
    seed('owner_answered');
    const spy = jest.spyOn(twiml, 'connectTwiml').mockImplementation(() => { throw new Error('boom'); });
    const res = await gather('1');
    spy.mockRestore();
    expect(res.text).toContain('<Hangup/>');
    expect(store.record?.state).toBe('owner_answered');
  });
});

// ── phone numbers never leak ─────────────────────────────────────────────────

describe('privacy', () => {
  it('no phone number appears in any log, timeline event or non-Dial response across a full call', async () => {
    seed('owner_ringing');
    const bodies: string[] = [];
    bodies.push((await owner({ From: TWILIO_NUMBER, To: OWNER_PHONE })).text);
    bodies.push((await gather('2', { From: TWILIO_NUMBER, To: OWNER_PHONE })).text);
    seed('owner_answered');
    const connect = (await gather('1', { From: TWILIO_NUMBER, To: OWNER_PHONE })).text;
    bodies.push(connect.replace(`>${LEAD_PHONE}</Number>`, '></Number>').replace(`callerId="${TWILIO_NUMBER}"`, ''));
    bodies.push((await dial('no-answer', { DialCallSid: LEAD_SID, To: LEAD_PHONE })).text);
    await leadStatus('completed', { To: LEAD_PHONE, From: TWILIO_NUMBER, CallDuration: '3' });
    await ownerStatus('completed', { To: OWNER_PHONE, From: TWILIO_NUMBER, CallDuration: '3' });
    bodies.forEach(noPhoneIn);
    noPhoneIn(JSON.stringify(store.events));
    noPhoneIn(JSON.stringify(logSpy.flatMap((s) => s.mock.calls)));
    noPhoneIn(JSON.stringify(mock(recordCallUsage).mock.calls));
  });

  it('logs only a generic message when a handler throws', async () => {
    seed('owner_ringing');
    mock(crmDb.getLeadListById).mockRejectedValue(new Error(`db failed for ${LEAD_PHONE}`));
    const res = await owner();
    expect(res.text).toContain('<Hangup/>');
    const logs = JSON.stringify(logSpy.flatMap((s) => s.mock.calls));
    expect(logs).toContain('handler failed');
    noPhoneIn(logs);
  });
});
