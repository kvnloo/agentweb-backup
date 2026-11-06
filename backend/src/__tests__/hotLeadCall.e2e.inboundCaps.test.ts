/**
 * Caps on inbound hot-lead callbacks (ENG-2784), end to end on the real router and TwiML, with the in-memory limit
 * store: org hourly/daily, per-caller hourly/daily, the CallSid retry marker, release on refusal and fail-closed.
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));

import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { setHotLeadCallEntitledOverride } from '../services/voice/hotLeadCallEntitlement';
import { resetInboundNumberIndexForTests } from '../services/voice/inboundNumberIndex';
import { inboundVoiceUrl } from '../services/voice/voiceUrls';
import { INBOUND_NOBODY_COPY, INBOUND_UNAVAILABLE_COPY } from '../services/voice/twiml';
import { inboundCallerE164, inboundCallMarkerKey } from '../services/voice/inboundLimits';
import { sayText } from './helpers/hotLeadCallTwilioSim';
import { teamMember } from './helpers/hotLeadCallFixtures';
import { MEMBER_PHONE, TWILIO_NUMBER, callConfig, chicago, installWorld, setClock, world } from './helpers/hotLeadCallE2eWorld';

installWorld();

const CALLER = '+12125550142';
const OTHER_CALLER = '+12125550143';
const SECOND_PHONE = '+14155550102';

function configure(over: Record<string, unknown> = {}) {
  const org = world.crm.orgs.get('org-a')!;
  world.crm.orgs.set('org-a', {
    ...org,
    ownerUserId: 'owner-a',
    hotLeadCall: { ...callConfig, team: [teamMember(MEMBER_PHONE, { id: 'maaaaaaa' }), teamMember(SECOND_PHONE, { id: 'mbbbbbbb' })], ...over },
  });
}

beforeEach(() => {
  resetInboundNumberIndexForTests();
  configure();
});

let sidSeq = 0;
const nextSid = () => `CA3${String(++sidSeq).padStart(7, '0')}`;
/** One inbound call from `from` (a fresh CallSid unless given). */
const callFrom = (from: string | undefined, callSid = nextSid()) =>
  world.twilio.post(inboundVoiceUrl(), {
    AccountSid: 'AC00000000000000000000000000000000', Direction: 'inbound', To: TWILIO_NUMBER, CallSid: callSid, CallStatus: 'ringing',
    ...(from === undefined ? {} : { From: from }),
  });
const rings = (body: string) => body.includes('<Dial answerOnBridge="true"');
const capped = (body: string) => expect(sayText(body)).toBe(INBOUND_NOBODY_COPY);
const warns = () => world.consoleSpies[1].mock.calls.map((c) => c.join(' '));
const counter = (prefix: string) => [...world.limits.counters].filter(([k]) => k.startsWith(prefix));

describe('per-caller caps', () => {
  it('allows 3 calls an hour from one caller and refuses the 4th with the nobody copy', async () => {
    for (let i = 0; i < 3; i++) expect(rings((await callFrom(CALLER)).body)).toBe(true);
    const fourth = await callFrom(CALLER);
    capped(fourth.body);
    expect(fourth.body).not.toContain('<Dial');
    expect(warns()).toContain('[hotLeadCall] inbound capped caller_hourly org-a');
  });

  it('allows 6 calls a local day from one caller (spread over hours) and refuses the 7th', async () => {
    for (let h = 12; h < 18; h++) {
      setClock(chicago(`${h}:00`));
      expect(rings((await callFrom(CALLER)).body)).toBe(true);
    }
    setClock(chicago('18:00'));
    capped((await callFrom(CALLER)).body);
    expect(warns()).toContain('[hotLeadCall] inbound capped caller_daily org-a');
    setClock(chicago('12:00').replace('-19T', '-20T')); // the next local day starts over
    expect(rings((await callFrom(CALLER)).body)).toBe(true);
  });

  it('a different caller is unaffected by another caller reaching the cap', async () => {
    for (let i = 0; i < 4; i++) await callFrom(CALLER);
    expect(rings((await callFrom(OTHER_CALLER)).body)).toBe(true);
  });

  it('a caller-cap refusal gives back the org slots and takes no retry marker', async () => {
    for (let i = 0; i < 3; i++) await callFrom(CALLER);
    const before = [...world.limits.counters];
    const sid = nextSid();
    capped((await callFrom(CALLER, sid)).body);
    expect([...world.limits.counters]).toEqual(before);
    expect(world.limits.claims.has(inboundCallMarkerKey(sid))).toBe(false);
    expect(counter('hlc#cap#ih#').map(([, n]) => n)).toEqual([3]);
    expect(counter('hlc#cap#id#').map(([, n]) => n)).toEqual([3]);
  });
});

describe('org caps (twice the outbound caps)', () => {
  it('trips the hourly cap at 2 x maxCallsPerHour and not before', async () => {
    configure({ maxCallsPerHour: 1 });
    expect(rings((await callFrom(CALLER)).body)).toBe(true);
    expect(rings((await callFrom(OTHER_CALLER)).body)).toBe(true);
    capped((await callFrom('+12125550144')).body);
    expect(warns()).toContain('[hotLeadCall] inbound capped org_hourly org-a');
  });

  it('trips the daily cap at 2 x maxCallsPerDay and not before', async () => {
    configure({ maxCallsPerDay: 1 });
    expect(rings((await callFrom(CALLER)).body)).toBe(true);
    expect(rings((await callFrom(OTHER_CALLER)).body)).toBe(true);
    capped((await callFrom('+12125550144')).body);
    expect(warns()).toContain('[hotLeadCall] inbound capped org_daily org-a');
  });

  it('an org-daily refusal gives back the hourly slot it took first', async () => {
    configure({ maxCallsPerDay: 1 });
    await callFrom(CALLER);
    await callFrom(OTHER_CALLER);
    await callFrom('+12125550144');
    expect(counter('hlc#cap#ih#').map(([, n]) => n)).toEqual([2]);
    expect(counter('hlc#in#p#')).toHaveLength(4); // two callers x hourly+daily; the refused caller never got that far
  });
});

describe('callers without a usable number', () => {
  it.each([['anonymous'], ['unknown'], ['+1'], [''], [undefined]])('From %p skips the caller counters but still hits the org cap', async (from) => {
    configure({ maxCallsPerHour: 1 });
    for (let i = 0; i < 2; i++) expect(rings((await callFrom(from)).body)).toBe(true);
    capped((await callFrom(from)).body);
    expect(counter('hlc#in#p#')).toEqual([]);
    expect(warns()).toContain('[hotLeadCall] inbound capped org_hourly org-a');
  });

  it('normalises only an exact E.164 number', () => {
    expect(inboundCallerE164(CALLER)).toBe(CALLER);
    expect(inboundCallerE164('(212) 555-0142')).toBeNull();
    expect(inboundCallerE164('anonymous')).toBeNull();
    expect(inboundCallerE164(undefined)).toBeNull();
  });
});

describe('retries, keys and failure', () => {
  it('a Twilio retry of the same CallSid is admitted and counted once', async () => {
    const sid = nextSid();
    expect(rings((await callFrom(CALLER, sid)).body)).toBe(true);
    for (let i = 0; i < 5; i++) expect(rings((await callFrom(CALLER, sid)).body)).toBe(true);
    expect(counter('hlc#cap#ih#').map(([, n]) => n)).toEqual([1]);
    expect(counter('hlc#in#p#h#').map(([, n]) => n)).toEqual([1]);
    expect(world.limits.claims.get(inboundCallMarkerKey(sid))?.token).toBe(sid);
  });

  it('never puts the caller number in a key, and keeps the key prefixes and TTLs', async () => {
    await callFrom(CALLER);
    const keys = world.limits.keysTouched;
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toContain('2125550142');
      expect(k).toMatch(/^hlc#(cap#ih#|cap#id#|in#p#h#|in#p#d#|in#c#)/);
    }
    expect(counter('hlc#cap#id#')[0][0]).toBe('hlc#cap#id#org-a#2026-10-19');
    const ttl = (prefix: string) => [...world.limits.counterExpiresAtS].find(([k]) => k.startsWith(prefix))![1] - Date.now() / 1000;
    expect(Math.round(ttl('hlc#cap#ih#'))).toBe(2 * 3600);
    expect(Math.round(ttl('hlc#in#p#d#'))).toBe(2 * 86400);
  });

  it('fails closed with the unavailable copy when the store throws, and logs no number', async () => {
    world.limits.failNext = new Error('boom CA-secret +12125550142');
    const res = await callFrom(CALLER);
    expect(sayText(res.body)).toBe(INBOUND_UNAVAILABLE_COPY);
    expect(res.body).not.toContain('<Dial');
    const line = warns().find((w) => w.includes('inbound limits unavailable'))!;
    expect(line).toBe('[hotLeadCall] inbound limits unavailable Error');
    expect(world.limits.counters.size).toBe(0);
  });

  it('a store failure after some slots were taken gives them back', async () => {
    const real = world.limits.incrementBelow.bind(world.limits);
    let n = 0;
    world.limits.incrementBelow = async (...a) => { if (++n === 3) throw new Error('late'); return real(...a); };
    expect(sayText((await callFrom(CALLER)).body)).toBe(INBOUND_UNAVAILABLE_COPY);
    expect([...world.limits.counters.values()].every((v) => v === 0)).toBe(true);
    expect(world.limits.claims.size).toBe(0);
  });
});

describe('placement', () => {
  it('claims no slot when nobody would be rung', async () => {
    configure({ team: [teamMember(MEMBER_PHONE, { id: 'maaaaaaa', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '11:00' }] })] }); // off shift at 12:00
    capped((await callFrom(CALLER)).body);
    expect(world.limits.keysTouched).toEqual([]);
  });

  it('a signed /inbound with a query string is still refused and touches no limit', async () => {
    const res = await world.twilio.post(`${inboundVoiceUrl()}?x=`, {
      AccountSid: 'AC00000000000000000000000000000000', Direction: 'inbound', From: CALLER, To: TWILIO_NUMBER, CallSid: nextSid(), CallStatus: 'ringing',
    });
    expect(sayText(res.body)).toBe(INBOUND_UNAVAILABLE_COPY);
    expect(world.limits.keysTouched).toEqual([]);
  });
});
