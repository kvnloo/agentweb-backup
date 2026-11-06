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

import { resetInboundNumberIndexForTests } from '../services/voice/inboundNumberIndex';
import { inboundVoiceUrl } from '../services/voice/voiceUrls';
import { INBOUND_NOBODY_COPY, INBOUND_UNAVAILABLE_COPY } from '../services/voice/twiml';
import { CALLER_MAX_PER_DAY, CALLER_MAX_PER_HOUR, inboundCallerE164, inboundCallMarkerKey, reserveInboundSlot } from '../services/voice/inboundLimits';
import type { HotLeadCallConfig } from '../services/hotLeadCallConfig';
import { attrOf, sayText } from './helpers/hotLeadCallTwilioSim';
import { teamMember } from './helpers/hotLeadCallFixtures';
import { MEMBER_PHONE, TWILIO_NUMBER, advanceMinutes, callConfig, installWorld, world } from './helpers/hotLeadCallE2eWorld';

installWorld();

const CALLER = '+12125550142';
const OTHER_CALLER = '+12125550143';
const THIRD_CALLER = '+12125550144';
const SECOND_PHONE = '+14155550102';
const CALLER_DIGITS = '2125550142';
const MARKER_TTL_S = 3600;

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
const callParams = (callSid: string | undefined, from: string | undefined): Record<string, string> => ({
  AccountSid: 'AC00000000000000000000000000000000', Direction: 'inbound', To: TWILIO_NUMBER, CallStatus: 'ringing',
  ...(callSid === undefined ? {} : { CallSid: callSid }),
  ...(from === undefined ? {} : { From: from }),
});
/** One inbound call from `from` (a fresh CallSid unless given). */
const callFrom = (from: string | undefined, callSid: string | undefined = nextSid()) => world.twilio.post(inboundVoiceUrl(), callParams(callSid, from));
const rings = (body: string) => body.includes('<Dial answerOnBridge="true"');
const capped = (body: string) => expect(sayText(body)).toBe(INBOUND_NOBODY_COPY);
const unavailable = (body: string) => {
  expect(sayText(body)).toBe(INBOUND_UNAVAILABLE_COPY);
  expect(body).not.toContain('<Dial');
};
const warns = () => world.warnSpy.mock.calls.map((c) => c.join(' '));
const counter = (prefix: string) => [...world.limits.counters].filter(([k]) => k.startsWith(prefix));
const held = () => [...world.limits.counters].filter(([, n]) => n > 0);
const nowS = () => Math.floor(Date.now() / 1000);
const reserveConfig = (over: Partial<HotLeadCallConfig> = {}) => ({ maxCallsPerHour: 6, maxCallsPerDay: 20, ...over }) as HotLeadCallConfig;

describe('per-caller caps', () => {
  it('allows 3 calls an hour from one caller and refuses the next with the nobody copy', async () => {
    for (let i = 0; i < CALLER_MAX_PER_HOUR; i++) expect(rings((await callFrom(CALLER)).body)).toBe(true);
    const refused = await callFrom(CALLER);
    capped(refused.body);
    expect(refused.body).not.toContain('<Dial');
    expect(warns()).toContain('[hotLeadCall] inbound capped caller_hourly org-a');
  });

  it('allows 6 calls a local day (spread over hours), refuses the next, and the next local day starts over', async () => {
    advanceMinutes(0);
    for (let h = 0; h < CALLER_MAX_PER_DAY; h++) {
      expect(rings((await callFrom(CALLER)).body)).toBe(true);
      advanceMinutes(60);
    }
    capped((await callFrom(CALLER)).body);
    expect(warns()).toContain('[hotLeadCall] inbound capped caller_daily org-a');
    advanceMinutes(24 * 60);
    expect(rings((await callFrom(CALLER)).body)).toBe(true);
  });

  it('a different caller is unaffected by another caller reaching the cap', async () => {
    for (let i = 0; i < 4; i++) await callFrom(CALLER);
    expect(rings((await callFrom(OTHER_CALLER)).body)).toBe(true);
  });

  it('a caller_hourly refusal never touches the org counters', async () => {
    for (let i = 0; i < CALLER_MAX_PER_HOUR; i++) await callFrom(CALLER);
    const before = [...world.limits.counters];
    const sid = nextSid();
    capped((await callFrom(CALLER, sid)).body);
    expect([...world.limits.counters]).toEqual(before);
    expect(world.limits.claims.has(inboundCallMarkerKey(sid))).toBe(false);
    expect(counter('hlc#cap#ih#').map(([, n]) => n)).toEqual([CALLER_MAX_PER_HOUR]);
  });

  it('a caller_daily refusal releases the caller hourly slot it had taken', async () => {
    for (let h = 0; h < CALLER_MAX_PER_DAY; h++) {
      await callFrom(CALLER);
      advanceMinutes(60);
    }
    const before = held();
    capped((await callFrom(CALLER)).body);
    expect(held()).toEqual(before);
  });
});

describe('org caps (twice the outbound caps)', () => {
  it('trips the hourly cap at 2 x maxCallsPerHour and not before', async () => {
    configure({ maxCallsPerHour: 1 });
    expect(rings((await callFrom(CALLER)).body)).toBe(true);
    expect(rings((await callFrom(OTHER_CALLER)).body)).toBe(true);
    capped((await callFrom(THIRD_CALLER)).body);
    expect(warns()).toContain('[hotLeadCall] inbound capped org_hourly org-a');
  });

  it('trips the daily cap at 2 x maxCallsPerDay and not before', async () => {
    configure({ maxCallsPerDay: 1 });
    expect(rings((await callFrom(CALLER)).body)).toBe(true);
    expect(rings((await callFrom(OTHER_CALLER)).body)).toBe(true);
    capped((await callFrom(THIRD_CALLER)).body);
    expect(warns()).toContain('[hotLeadCall] inbound capped org_daily org-a');
  });

  it('an org_daily refusal gives back the caller and org-hourly slots taken before it', async () => {
    configure({ maxCallsPerDay: 1 });
    await callFrom(CALLER);
    await callFrom(OTHER_CALLER);
    const before = held();
    capped((await callFrom(THIRD_CALLER)).body);
    expect(held()).toEqual(before);
    expect(counter('hlc#cap#ih#').map(([, n]) => n)).toEqual([2]);
  });

  it('a new UTC hour starts a fresh hourly count for the org and for the caller', async () => {
    configure({ maxCallsPerHour: 1 });
    await callFrom(CALLER);
    await callFrom(OTHER_CALLER);
    capped((await callFrom(THIRD_CALLER)).body);
    advanceMinutes(60);
    expect(rings((await callFrom(THIRD_CALLER)).body)).toBe(true);

    configure();
    for (let i = 0; i < CALLER_MAX_PER_HOUR; i++) await callFrom(CALLER);
    capped((await callFrom(CALLER)).body);
    advanceMinutes(60);
    expect(rings((await callFrom(CALLER)).body)).toBe(true);
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

  it('accepts only an exact E.164 number, of any country', () => {
    expect(inboundCallerE164(CALLER)).toBe(CALLER);
    expect(inboundCallerE164('+447911123456')).toBe('+447911123456');
    expect(inboundCallerE164(CALLER_DIGITS.padStart(11, '1'))).toBeNull(); // digits without '+'
    expect(inboundCallerE164('(212) 555-0142')).toBeNull();
    expect(inboundCallerE164('anonymous')).toBeNull();
    expect(inboundCallerE164(undefined)).toBeNull();
  });
});

describe('redelivery and the retry marker', () => {
  it('a redelivery of an admitted call is admitted and counted once', async () => {
    const sid = nextSid();
    expect(rings((await callFrom(CALLER, sid)).body)).toBe(true);
    for (let i = 0; i < 5; i++) expect(rings((await callFrom(CALLER, sid)).body)).toBe(true);
    expect(counter('hlc#cap#ih#').map(([, n]) => n)).toEqual([1]);
    expect(counter('hlc#in#p#h#').map(([, n]) => n)).toEqual([1]);
    expect(world.limits.claims.get(inboundCallMarkerKey(sid))?.token).toBe(sid);
  });

  it('a redelivery of the call admitted at the cap boundary is still admitted and not counted twice', async () => {
    for (let i = 0; i < CALLER_MAX_PER_HOUR - 1; i++) await callFrom(CALLER);
    const last = nextSid();
    expect(rings((await callFrom(CALLER, last)).body)).toBe(true); // the 3rd: exactly at the cap
    expect(rings((await callFrom(CALLER, last)).body)).toBe(true);
    expect(counter('hlc#in#p#h#').map(([, n]) => n)).toEqual([CALLER_MAX_PER_HOUR]);
    capped((await callFrom(CALLER)).body); // a new call is still refused
  });

  it('a redelivery of a refused call is evaluated again: refused again, then admitted once room exists', async () => {
    for (let i = 0; i < CALLER_MAX_PER_HOUR; i++) await callFrom(CALLER);
    const refusedSid = nextSid();
    capped((await callFrom(CALLER, refusedSid)).body);
    capped((await callFrom(CALLER, refusedSid)).body);
    expect(world.limits.claims.has(inboundCallMarkerKey(refusedSid))).toBe(false);
    advanceMinutes(60);
    expect(rings((await callFrom(CALLER, refusedSid)).body)).toBe(true);
  });

  it('two deliveries racing: the one that loses the marker claim gives its counts back and is admitted', async () => {
    const sid = nextSid();
    const realClaim = world.limits.claim.bind(world.limits);
    world.limits.claim = async (key, token, expiresAtS, now) => {
      if (key === inboundCallMarkerKey(sid)) await realClaim(key, sid, expiresAtS, now); // the other delivery wins first
      return realClaim(key, token, expiresAtS, now);
    };
    expect(rings((await callFrom(CALLER, sid)).body)).toBe(true);
    expect(held()).toEqual([]); // the winner's counts are not simulated; the loser kept none
    expect(world.limits.claims.get(inboundCallMarkerKey(sid))?.token).toBe(sid);
  });

  it('a marker held by a different token fails closed and keeps no counts', async () => {
    const sid = nextSid();
    world.limits.claims.set(inboundCallMarkerKey(sid), { token: 'someone-else', expiresAtS: nowS() + 600 });
    unavailable((await callFrom(CALLER, sid)).body);
    expect(held()).toEqual([]);
    expect(warns()).toContain('[hotLeadCall] inbound limits unavailable Error');
  });

  it.each([[undefined], [''], ['not-a-sid'], ['CA1']])('CallSid %p fails closed with the unavailable copy and touches no limit', async (sid) => {
    unavailable((await world.twilio.post(inboundVoiceUrl(), callParams(sid, CALLER))).body);
    expect(world.limits.keysTouched).toEqual([]);
  });
});

describe('keys, TTLs and failure', () => {
  it('never puts the caller number in a key, and uses the specified prefixes and clock-derived windows', async () => {
    const sid = nextSid();
    await callFrom(CALLER, sid);
    const keys = world.limits.keysTouched;
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toContain(CALLER_DIGITS);
      expect(k).toMatch(/^hlc#(cap#ih#|cap#id#|in#p#h#|in#p#d#|in#c#)/);
    }
    const hour = new Date().toISOString().slice(0, 13);
    const localDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    expect(counter('hlc#cap#ih#').map(([k]) => k)).toEqual([`hlc#cap#ih#org-a#${hour}`]);
    expect(counter('hlc#cap#id#').map(([k]) => k)).toEqual([`hlc#cap#id#org-a#${localDate}`]);
    expect(counter('hlc#in#p#h#')[0][0]).toMatch(new RegExp(`^hlc#in#p#h#[0-9a-f]{64}#${hour}$`));
    expect(counter('hlc#in#p#d#')[0][0]).toMatch(new RegExp(`^hlc#in#p#d#[0-9a-f]{64}#${localDate}$`));
  });

  it('expires hourly counters after 2h, daily counters after 2 days and the retry marker after 1h', async () => {
    const sid = nextSid();
    await callFrom(CALLER, sid);
    const ttlOf = (prefix: string) => [...world.limits.counterExpiresAtS].find(([k]) => k.startsWith(prefix))![1] - nowS();
    expect(ttlOf('hlc#cap#ih#')).toBe(2 * 3600);
    expect(ttlOf('hlc#in#p#h#')).toBe(2 * 3600);
    expect(ttlOf('hlc#cap#id#')).toBe(2 * 86400);
    expect(ttlOf('hlc#in#p#d#')).toBe(2 * 86400);
    expect(world.limits.claims.get(inboundCallMarkerKey(sid))!.expiresAtS - nowS()).toBe(MARKER_TTL_S);
  });

  it('fails closed with the unavailable copy when the store throws, and logs no number', async () => {
    world.limits.failNext = new Error(`boom CA-secret +1${CALLER_DIGITS}`);
    const res = await callFrom(CALLER);
    unavailable(res.body);
    expect(warns().find((w) => w.includes('inbound limits unavailable'))).toBe('[hotLeadCall] inbound limits unavailable Error');
    expect(world.limits.counters.size).toBe(0);
  });

  it('a store failure after some slots were taken gives them back', async () => {
    const real = world.limits.incrementBelow.bind(world.limits);
    let n = 0;
    world.limits.incrementBelow = async (...a) => { if (++n === 3) throw new Error('late'); return real(...a); };
    unavailable((await callFrom(CALLER)).body);
    expect(held()).toEqual([]);
    expect(world.limits.claims.size).toBe(0);
  });
});

describe('reserveInboundSlot directly', () => {
  it('two orgs keep independent counters for the same caller number', async () => {
    const now = new Date();
    for (let i = 0; i < CALLER_MAX_PER_HOUR; i++) expect(await reserveInboundSlot({ orgId: 'org-x', callSid: nextSid(), callerE164: CALLER, config: reserveConfig(), now })).toEqual({ ok: true });
    expect(await reserveInboundSlot({ orgId: 'org-x', callSid: nextSid(), callerE164: CALLER, config: reserveConfig(), now })).toEqual({ ok: false, reason: 'caller_hourly' });
    expect(await reserveInboundSlot({ orgId: 'org-y', callSid: nextSid(), callerE164: CALLER, config: reserveConfig(), now })).toEqual({ ok: true });
  });

  it('follows UTC when the config has no calling hours', async () => {
    const now = new Date('2026-10-20T02:00:00Z'); // still 19 Oct in Chicago
    await reserveInboundSlot({ orgId: 'org-a', callSid: nextSid(), callerE164: null, config: reserveConfig(), now });
    expect(counter('hlc#cap#id#').map(([k]) => k)).toEqual(['hlc#cap#id#org-a#2026-10-20']);
    await reserveInboundSlot({ orgId: 'org-b', callSid: nextSid(), callerE164: null, config: reserveConfig({ callingHours: { start: '08:00', end: '21:00', timezone: 'America/Chicago' } }), now });
    expect(counter('hlc#cap#id#org-b').map(([k]) => k)).toEqual(['hlc#cap#id#org-b#2026-10-19']);
  });
});

describe('placement', () => {
  it('claims no slot when nobody would be rung', async () => {
    configure({ team: [teamMember(MEMBER_PHONE, { id: 'maaaaaaa', windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '11:00' }] })] }); // off shift at 12:00
    capped((await callFrom(CALLER)).body);
    expect(world.limits.keysTouched).toEqual([]);
  });

  it('handing over to the second member takes no further slot', async () => {
    const first = await callFrom(CALLER);
    const before = [...world.limits.counters];
    const next = await world.twilio.post(attrOf(first.body, 'action'), { ...callParams(nextSid(), CALLER), CallStatus: 'in-progress', DialCallStatus: 'no-answer' });
    expect(next.body).toContain(SECOND_PHONE);
    expect([...world.limits.counters]).toEqual(before);
  });

  it('a signed /inbound with a query string is still refused and touches no limit', async () => {
    const res = await world.twilio.post(`${inboundVoiceUrl()}?x=`, callParams(nextSid(), CALLER));
    unavailable(res.body);
    expect(world.limits.keysTouched).toEqual([]);
  });
});
