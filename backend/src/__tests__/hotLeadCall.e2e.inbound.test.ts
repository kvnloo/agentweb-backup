/**
 * Hot-lead auto-call, inbound callbacks end to end (ENG-2271 follow-up): a lead dials the org's number back.
 * Same world as hotLeadCall.e2e.test.ts: the real router with its signature guard, the real TwiML builders, the
 * real context/roster code on the fake crm, and a Twilio caller that only follows the URLs the app handed out.
 * The app is the only thing that knows the next URL, so a wrong or unsigned URL cannot be papered over here.
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
import { attrOf, sayText } from './helpers/hotLeadCallTwilioSim';
import { teamMember } from './helpers/hotLeadCallFixtures';
import { BASE, MEMBER_PHONE, TWILIO_NUMBER, callConfig, chicago, setClock, installWorld, mock, usage, world } from './helpers/hotLeadCallE2eWorld';
import { recordVendorUsage } from '../services/usageRecorderService';

installWorld();

const LEAD_CALLER = '+12125550142';
const SECOND_PHONE = '+14155550102';
const THIRD_PHONE = '+14155550103';
const FOURTH_PHONE = '+14155550104';
const FIFTH_PHONE = '+14155550105';
const SIXTH_PHONE = '+14155550106';
const CALLER_SID = 'CA10000001';
const HANGUP = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
const EMPTY_RESPONSE = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

const member = (phone: string, id: string, over = {}) => teamMember(phone, { id, ...over });

/** Replaces the org's stored config; `over` wins over the shared fixture. */
function configure(over: Record<string, unknown> = {}, orgOver: Record<string, unknown> = {}) {
  const org = world.crm.orgs.get('org-a')!;
  world.crm.orgs.set('org-a', {
    ...org,
    ownerUserId: 'owner-a',
    ...orgOver,
    hotLeadCall: { ...callConfig, team: [member(MEMBER_PHONE, 'maaaaaaa'), member(SECOND_PHONE, 'mbbbbbbb'), member(THIRD_PHONE, 'mccccccc')], ...over },
  });
}

beforeEach(() => {
  resetInboundNumberIndexForTests();
  configure();
});

const callerLeg = { AccountSid: 'AC00000000000000000000000000000000', Direction: 'inbound', From: LEAD_CALLER, To: TWILIO_NUMBER, CallSid: CALLER_SID };

/** The number is dialled: Twilio posts to the voice URL the app gave at purchase. */
const dialled = (over: Record<string, string> = {}) => world.twilio.post(inboundVoiceUrl(), { ...callerLeg, CallStatus: 'ringing', ...over });

/** What the app told Twilio to do with one member leg: the URLs of that attempt and the number rung. */
function attempt(xml: string) {
  return {
    to: />(\+\d+)<\/Number>/.exec(xml)?.[1],
    screenUrl: attrOf(xml, 'url'),
    dialUrl: attrOf(xml, 'action'),
    statusUrl: attrOf(xml, 'statusCallback'),
  };
}
const memberLeg = (sid: string, to: string) => ({ AccountSid: callerLeg.AccountSid, Direction: 'outbound-api', From: TWILIO_NUMBER, To: to, CallSid: sid });
const answers = (a: ReturnType<typeof attempt>, sid: string) => world.twilio.post(a.screenUrl, { ...memberLeg(sid, a.to!), CallStatus: 'in-progress' });
const presses = (resultUrl: string, sid: string, to: string, digits: string) =>
  world.twilio.post(resultUrl, { ...memberLeg(sid, to), CallStatus: 'in-progress', Digits: digits, FinishedOnKey: '' });
const dialEnds = (a: ReturnType<typeof attempt>, dialStatus: string, extra: Record<string, string> = {}) =>
  world.twilio.post(a.dialUrl, { ...callerLeg, CallStatus: 'in-progress', DialCallStatus: dialStatus, ...extra });
const legEnds = (a: ReturnType<typeof attempt>, sid: string, status: string, duration: string) =>
  world.twilio.post(a.statusUrl, { ...memberLeg(sid, a.to!), ParentCallSid: CALLER_SID, CallStatus: status, CallDuration: duration });

const refused = (body: string) => {
  expect(body).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${INBOUND_UNAVAILABLE_COPY}</Say><Hangup/></Response>`);
  expect(body).not.toContain('<Dial');
};

const PROMPT = 'Smith & Sons: a lead is calling back. Are you available to take the call? Press 1.';

describe('a lead calls the org number back', () => {
  it('rings the first member, asks them to press 1, and on 1 bridges the caller; the member leg is metered once', async () => {
    const first = await dialled();
    expect(first.status).toBe(200);
    expect(first.body).toContain('<Dial answerOnBridge="true"');
    expect(first.body).not.toContain('<Say>'); // the caller hears ringing, not a message, until a member accepts
    const a = attempt(first.body);
    expect(a.to).toBe(MEMBER_PHONE);
    expect(attrOf(first.body, 'callerId')).toBe(TWILIO_NUMBER);
    expect(attrOf(first.body, 'statusCallbackEvent')).toBe('completed');
    for (const url of [a.screenUrl, a.dialUrl, a.statusUrl]) {
      expect(url.startsWith(`${BASE}/api/webhooks/twilio-voice/inbound-`)).toBe(true);
      expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ orgId: 'org-a', tried: 'maaaaaaa' });
    }
    expect(new URL(a.statusUrl).hash).toBe('#rc=3&rp=5xx,ct');

    // The member answers and hears who is calling, with the org's name XML-escaped.
    const prompt = await answers(a, 'CA20000001');
    expect(prompt.body).toContain('Smith &amp; Sons');
    expect(sayText(prompt.body)).toBe(PROMPT);

    // Only a 1 connects: an empty response makes Twilio bridge.
    const result = await presses(attrOf(prompt.body, 'action'), 'CA20000001', a.to!, '1');
    expect(result.body).toBe(EMPTY_RESPONSE);

    // The bridged call ends: the Dial reports it, nobody else is rung.
    const ended = await dialEnds(a, 'completed', { DialBridged: 'true', DialCallSid: 'CA20000001' });
    expect(ended.body).toContain('<Hangup/>');
    expect(ended.body).not.toContain('<Dial');

    // Metering: the member leg only, at the outbound rate, rounded up, idempotent per its own CallSid.
    expect((await legEnds(a, 'CA20000001', 'completed', '125')).status).toBe(200);
    expect(usage()).toEqual([
      expect.objectContaining({
        userId: 'owner-a', provider: 'twilio', operation: 'voice_minute_outbound', feature: 'hot_lead_call', unit: 'minute',
        rateKey: 'voice_minute_outbound', quantity: 3, idempotencyKey: 'twilio:voice:CA20000001:member',
      }),
    ]);
    // Stateless: no lead call record or timeline event exists for it.
    expect([...world.crm.leads.values()]).toEqual([]);
    expect(world.provider.placedCalls).toHaveLength(0);
  });

  it('uses Called when To is empty, but never falls back to it when To is present and unknown', async () => {
    const viaCalled = await dialled({ To: '', Called: TWILIO_NUMBER });
    expect(attempt(viaCalled.body).to).toBe(MEMBER_PHONE);
    refused((await dialled({ To: '+14155559999', Called: TWILIO_NUMBER })).body);
  });

  it('a redelivered metering callback is billed once (same idempotency key)', async () => {
    const a = attempt((await dialled()).body);
    await legEnds(a, 'CA20000001', 'completed', '30');
    await legEnds(a, 'CA20000001', 'completed', '30');
    expect(new Set(usage().map((u) => u.idempotencyKey))).toEqual(new Set(['twilio:voice:CA20000001:member']));
  });

  it('a member who presses another key is passed over: the next member by priority is rung, the first is not rung again', async () => {
    const first = attempt((await dialled()).body);
    const prompt = await answers(first, 'CA20000001');
    const declined = await presses(attrOf(prompt.body, 'action'), 'CA20000001', first.to!, '2');
    expect(declined.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');

    // The member's leg hung up at the screen: the Dial ends unbridged, so the next member is rung.
    const next = await dialEnds(first, 'completed', { DialBridged: 'false' });
    const second = attempt(next.body);
    expect(second.to).toBe(SECOND_PHONE);
    expect(Object.fromEntries(new URL(second.dialUrl).searchParams)).toEqual({ orgId: 'org-a', tried: 'maaaaaaa,mbbbbbbb' });

    const prompt2 = await answers(second, 'CA20000002');
    expect((await presses(attrOf(prompt2.body, 'action'), 'CA20000002', second.to!, '1')).body).toBe(EMPTY_RESPONSE);
  });

  it.each([['no-answer'], ['busy'], ['failed']])('a member leg that ends %s hands over to the next member', async (status) => {
    const first = attempt((await dialled()).body);
    expect(attempt((await dialEnds(first, status)).body).to).toBe(SECOND_PHONE);
  });

  it('a member who does not press anything (the prompt times out and hangs up) is passed over too', async () => {
    const first = attempt((await dialled()).body);
    const prompt = await answers(first, 'CA20000001');
    expect(prompt.body).toMatch(/<Say>We did not get a response\. Goodbye\.<\/Say><Hangup\/>/);
    expect(attempt((await dialEnds(first, 'completed', { DialBridged: 'false' })).body).to).toBe(SECOND_PHONE);
  });

  it('stops at the org\'s maxAttemptsPerLead and tells the caller nobody can take the call (no voicemail, no recording)', async () => {
    configure({ maxAttemptsPerLead: 2 });
    const first = attempt((await dialled()).body);
    const second = attempt((await dialEnds(first, 'no-answer')).body);
    expect(second.to).toBe(SECOND_PHONE);
    const last = await dialEnds(second, 'no-answer');
    expect(last.body).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${INBOUND_NOBODY_COPY}</Say><Hangup/></Response>`);
    expect(last.body).not.toMatch(/<Record|<Dial|<Gather/);
  });

  it('runs out of available members before the cap: the caller is told, and the chain ends', async () => {
    configure({ team: [member(MEMBER_PHONE, 'maaaaaaa'), member(SECOND_PHONE, 'mbbbbbbb', { verifiedAt: undefined })] });
    const first = attempt((await dialled()).body);
    const end = await dialEnds(first, 'no-answer');
    expect(sayText(end.body)).toBe(INBOUND_NOBODY_COPY);
    expect(end.body).toContain('<Hangup/>');
  });

  it('honours priority and availability at this instant: members outside their window, and unverified ones, are never rung', async () => {
    configure({
      team: [
        member(MEMBER_PHONE, 'maaaaaaa', { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '11:00' }] }),
        member(SECOND_PHONE, 'mbbbbbbb', { verifiedAt: undefined }),
        member(THIRD_PHONE, 'mccccccc'),
        member(FOURTH_PHONE, 'mddddddd'),
      ],
    });
    const first = attempt((await dialled()).body); // 12:00 Chicago: A is off shift, B unverified
    expect(first.to).toBe(THIRD_PHONE);
    expect(attempt((await dialEnds(first, 'no-answer')).body).to).toBe(FOURTH_PHONE);
  });

  it('evaluates availability at each step: a member whose window closes while the caller waits is not rung', async () => {
    configure({
      team: [
        member(MEMBER_PHONE, 'maaaaaaa'),
        member(SECOND_PHONE, 'mbbbbbbb', { windows: [{ days: [1], start: '12:00', end: '12:01' }] }),
      ],
    });
    const first = attempt((await dialled()).body);
    setClock(chicago('12:05'));
    expect(sayText((await dialEnds(first, 'no-answer')).body)).toBe(INBOUND_NOBODY_COPY);
  });

  it('outside the calling hours nobody is rung and the caller is told so', async () => {
    setClock(chicago('22:00'));
    const res = await dialled();
    expect(sayText(res.body)).toBe(INBOUND_NOBODY_COPY);
    expect(res.body).not.toContain('<Dial');
  });

  it('a caller who hangs up while it rings (canceled) or a bridged call that completes does not ring anyone else', async () => {
    const first = attempt((await dialled()).body);
    expect((await dialEnds(first, 'canceled')).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect((await dialEnds(first, 'completed')).body).not.toContain('<Dial'); // completed with no DialBridged: cannot tell, so do not ring on
    expect((await dialEnds(first, 'completed', { DialBridged: 'true' })).body).not.toContain('<Dial');
  });

  it('replaying a step repeats the same decision and never extends the chain', async () => {
    const first = attempt((await dialled()).body);
    const one = (await dialEnds(first, 'no-answer')).body;
    const two = (await dialEnds(first, 'no-answer')).body;
    expect(attempt(two)).toEqual(attempt(one));
  });
});

describe('inbound callbacks fail closed', () => {  it.each([
    ['an unknown number', () => undefined, { To: '+14155559999' }],
    ['a missing To', () => undefined, { To: '' }],
    ['the kill switch off', () => setHotLeadCallEnabledOverride(false), {}],
    ['a plan without the feature', () => setHotLeadCallEntitledOverride(false), {}],
    ['a disabled config', () => configure({ enabled: false }), {}],
    ['an invalid config', () => configure({ team: [] }), {}],
    ['an org without an owner', () => configure({}, { ownerUserId: '' }), {}],
  ])('%s: a polite message and a hangup, no member is rung', async (_what, arrange, over) => {
    arrange();
    refused((await dialled(over)).body);
  });

  it('a failing org lookup refuses the call (and logs only the error name)', async () => {
    world.crm.listFails = true;
    refused((await dialled()).body);
    const logged = JSON.stringify(world.consoleSpies.flatMap((s) => s.mock.calls));
    expect(logged).toContain('inbound handler failed');
    expect(logged).not.toContain('scan failed');
  });

  it('a step after the feature is switched off ends the chain instead of ringing on', async () => {
    const first = attempt((await dialled()).body);
    setHotLeadCallEnabledOverride(false);
    refused((await dialEnds(first, 'no-answer')).body);
    const prompt = await answers(first, 'CA20000001');
    expect(prompt.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });

  it('a member removed or no longer verified while the call rings is not asked, and is not connected on a stale 1', async () => {
    const first = attempt((await dialled()).body);
    const prompt = await answers(first, 'CA20000001');
    configure({ team: [member(MEMBER_PHONE, 'maaaaaaa', { verifiedAt: undefined }), member(SECOND_PHONE, 'mbbbbbbb')] });
    expect((await presses(attrOf(prompt.body, 'action'), 'CA20000001', first.to!, '1')).body).toContain('<Hangup/>');
    expect((await answers(first, 'CA20000001')).body).toContain('<Hangup/>');
  });

  it('the number must still be the org\'s: a replaced number is not served from a stale index', async () => {
    await dialled(); // warms the index with the old number
    configure({ twilioNumber: '+14155550122' });
    refused((await dialled()).body);
  });

  it('does not serve a number held by two orgs', async () => {
    world.crm.addOrg({ orgId: 'org-b', ownerUserId: 'owner-b', hotLeadCall: { ...callConfig, team: [member(SECOND_PHONE, 'mbbbbbbb')] } }, [{ userId: 'owner-b' }], []);
    refused((await dialled()).body);
  });

  it('rejects unsigned and forged requests before looking anything up', async () => {
    world.provider.signatureValid = false;
    const forged = await dialled();
    expect(forged.status).toBe(401);
    const unsigned = await world.twilio.post(inboundVoiceUrl(), callerLeg, { signWith: null });
    expect(unsigned.status).toBe(401);
    const wrongToken = await world.twilio.post(inboundVoiceUrl(), callerLeg, { signWith: 'another-token' });
    expect(wrongToken.status).toBe(401);
    expect(world.crm.callsTo('listHotLeadCallNumbers')).toBe(0);
  });

  it('a signed /inbound that carries a query string is refused and never dials; the plain URL still dials', async () => {
    refused((await world.twilio.post(`${inboundVoiceUrl()}?orgId=org-a`, { ...callerLeg, CallStatus: 'ringing' })).body);
    refused((await world.twilio.post(`${inboundVoiceUrl()}?x=`, { ...callerLeg, CallStatus: 'ringing' })).body);
    expect(world.crm.callsTo('listHotLeadCallNumbers')).toBe(0);
    expect((await dialled()).body).toContain('<Dial');
  });

  it('rejects a signature made for another URL (a replay on a different step) and one whose params were altered', async () => {
    world.provider.signatureValid = true;
    const first = attempt((await dialled()).body);
    const other = await world.twilio.post(first.dialUrl, { ...callerLeg, DialCallStatus: 'no-answer' }, { signedUrl: first.statusUrl });
    expect(other.status).toBe(401);
  });

  it('answers 503 and processes nothing when the credentials cannot be loaded', async () => {
    world.provider.failNextEnsureCredentials();
    expect((await dialled()).status).toBe(503);
    expect(world.crm.callsTo('listHotLeadCallNumbers')).toBe(0);
  });

  it.each([
    ['inbound-dial', 'orgId=org-a&tried=bad'],
    ['inbound-dial', 'orgId=org-a&tried=maaaaaaa,maaaaaaa'],
    ['inbound-dial', 'orgId=org-a&tried=maaaaaaa&x=1'],
    ['inbound-dial', 'tried=maaaaaaa'],
    ['inbound-dial', 'orgId=a%20b&tried=maaaaaaa'],
  ])('%s with the query %s is refused, ringing nobody', async (step, query) => {
    const res = await world.twilio.post(`${BASE}/api/webhooks/twilio-voice/${step}?${query}`, { ...callerLeg, DialCallStatus: 'no-answer' });
    expect(res.status).toBe(200);
    refused(res.body);
  });

  it('the metering callback needs a valid query, a terminal status and a parent call, and answers 5xx only when billing fails', async () => {
    const a = attempt((await dialled()).body);
    const sid = 'CA20000001';
    expect((await world.twilio.post(a.statusUrl, { ...memberLeg(sid, a.to!), ParentCallSid: CALLER_SID, CallStatus: 'in-progress' })).status).toBe(200);
    expect((await world.twilio.post(a.statusUrl, { ...memberLeg(sid, a.to!), CallStatus: 'completed', CallDuration: '60' })).status).toBe(200);
    expect((await world.twilio.post(`${BASE}/api/webhooks/twilio-voice/inbound-status?orgId=org-a&tried=nope`, { ...memberLeg(sid, a.to!), ParentCallSid: CALLER_SID, CallStatus: 'completed', CallDuration: '60' })).status).toBe(200);
    expect(mock(recordVendorUsage)).not.toHaveBeenCalled();
    mock(recordVendorUsage).mockRejectedValueOnce(new Error('ledger down'));
    expect((await legEnds(a, sid, 'completed', '60')).status).toBe(500);
    expect((await legEnds(a, sid, 'completed', '60')).status).toBe(200);
    expect(usage()).toHaveLength(2); // the failed attempt and the redelivery share one idempotency key
    expect(new Set(usage().map((u) => u.idempotencyKey)).size).toBe(1);
  });

  it('no leg, a zero-second leg or a missing duration bills nothing', async () => {
    const a = attempt((await dialled()).body);
    await legEnds(a, 'CA20000001', 'no-answer', '0');
    await world.twilio.post(a.statusUrl, { ...memberLeg('CA20000002', a.to!), ParentCallSid: CALLER_SID, CallStatus: 'completed' });
    expect(mock(recordVendorUsage)).not.toHaveBeenCalled();
  });

  it('entitlement lost mid-chain: the next step tells the caller and rings nobody', async () => {
    const first = attempt((await dialled()).body);
    setHotLeadCallEntitledOverride(false);
    refused((await dialEnds(first, 'no-answer')).body);
  });

  it('kill switch off: a 1 on the screening step is a bare hangup, not the bridging response', async () => {
    const first = attempt((await dialled()).body);
    const prompt = await answers(first, 'CA20000001');
    setHotLeadCallEnabledOverride(false);
    const res = await presses(attrOf(prompt.body, 'action'), 'CA20000001', first.to!, '1');
    expect(res.body).toBe(HANGUP);
    expect(res.body).not.toBe(EMPTY_RESPONSE);
  });

  it.each([[''], ['11'], ['2'], ['*']])('the digits %j do not bridge', async (digits) => {
    const first = attempt((await dialled()).body);
    const prompt = await answers(first, 'CA20000001');
    expect((await presses(attrOf(prompt.body, 'action'), 'CA20000001', first.to!, digits)).body).toBe(HANGUP);
  });

  it.each([
    ['a bad member id', 'orgId=org-a&tried=bad'],
    ['a duplicate member id', 'orgId=org-a&tried=maaaaaaa,maaaaaaa'],
    ['an extra key', 'orgId=org-a&tried=maaaaaaa&x=1'],
    ['no orgId', 'tried=maaaaaaa'],
  ])('the screening steps hang up on a query with %s', async (_what, query) => {
    for (const step of ['inbound-screen', 'inbound-screen-result']) {
      const res = await world.twilio.post(`${BASE}/api/webhooks/twilio-voice/${step}?${query}`, { ...memberLeg('CA20000001', MEMBER_PHONE), Digits: '1' });
      expect(res.status).toBe(200);
      expect(res.body).toBe(HANGUP);
    }
  });

  it('a signed URL whose query was altered afterwards is rejected with 401 on every step', async () => {
    const first = attempt((await dialled()).body);
    for (const url of [first.screenUrl, first.dialUrl, first.statusUrl]) {
      const altered = url.replace('tried=maaaaaaa', 'tried=mbbbbbbb');
      expect(altered).not.toBe(url);
      const res = await world.twilio.post(altered, { ...memberLeg('CA20000001', MEMBER_PHONE), Digits: '1', DialCallStatus: 'no-answer' }, { signedUrl: url });
      expect(res.status).toBe(401);
    }
    expect(world.provider.signatureChecks.length).toBeGreaterThan(0);
  });

  it('a tried list of 6 ids is refused even though each id is valid', async () => {
    const six = ['maaaaaaa', 'mbbbbbbb', 'mccccccc', 'mddddddd', 'meeeeeee', 'mfffffff'].join(',');
    const res = await world.twilio.post(`${BASE}/api/webhooks/twilio-voice/inbound-dial?orgId=org-a&tried=${six}`, { ...callerLeg, DialCallStatus: 'no-answer' });
    refused(res.body);
  });

  it('with maxAttemptsPerLead at its largest (5) five members are rung and the sixth is not', async () => {
    configure({
      maxAttemptsPerLead: 5,
      team: [
        member(MEMBER_PHONE, 'maaaaaaa'), member(SECOND_PHONE, 'mbbbbbbb'), member(THIRD_PHONE, 'mccccccc'),
        member(FOURTH_PHONE, 'mddddddd'), member(FIFTH_PHONE, 'meeeeeee'), member(SIXTH_PHONE, 'mfffffff'),
      ],
    });
    let reply = await dialled();
    const rung: Array<string | undefined> = [];
    for (let i = 0; i < 5; i++) {
      const a = attempt(reply.body);
      rung.push(a.to);
      reply = await dialEnds(a, 'no-answer');
    }
    expect(rung).toEqual([MEMBER_PHONE, SECOND_PHONE, THIRD_PHONE, FOURTH_PHONE, FIFTH_PHONE]);
    expect(sayText(reply.body)).toBe(INBOUND_NOBODY_COPY);
  });

  it('the metering callback is not gated: the leg is still billed after the kill switch is turned off', async () => {
    const first = attempt((await dialled()).body);
    setHotLeadCallEnabledOverride(false);
    setHotLeadCallEntitledOverride(false);
    expect((await legEnds(first, 'CA20000001', 'completed', '61')).status).toBe(200);
    expect(usage()).toEqual([expect.objectContaining({ quantity: 2, idempotencyKey: 'twilio:voice:CA20000001:member' })]);
  });

  it('the metering callback for an org with no owner is acknowledged, bills nobody and says it was not metered', async () => {
    const first = attempt((await dialled()).body);
    configure({}, { ownerUserId: '' });
    expect((await legEnds(first, 'CA20000001', 'completed', '61')).status).toBe(200);
    expect(mock(recordVendorUsage)).not.toHaveBeenCalled();
    expect(JSON.stringify(world.consoleSpies.flatMap((s) => s.mock.calls))).toContain('not metered');
  });
});
