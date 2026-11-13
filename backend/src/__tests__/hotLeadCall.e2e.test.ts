/**
 * Hot-lead auto-call, end to end (ENG-2271): the call itself. Everything of ours is real: dispatchLeadCreated,
 * the orchestrator and its gates, the limit reservation, the LeadCallStore (on an in-memory fake of the crmDb
 * primitives), the express webhook router with its guard sequence, the TwiML builders and recordCallUsage.
 * Only the outside world is faked: Twilio (a strict FakeVoiceProvider whose signature check is Twilio's own
 * HMAC, driven by a caller that follows the URLs the app hands out), DynamoDB, the job queue, Slack and the
 * usage ledger. Time is a fixed Date, so calling hours and cooldowns are deterministic.
 * Gates and limits are in hotLeadCall.e2e.gates.test.ts; both files share helpers/hotLeadCallE2eWorld.
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));

import * as queue from '../services/asyncJobQueue';
import { recordVendorUsage } from '../services/usageRecorderService';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { LEAD_UNREACHABLE_COPY } from '../services/voice/twiml';
import { leadPhoneMacOf } from '../services/voice/leadPhoneMac';
import { attrOf, sayText, MOUNT } from './helpers/hotLeadCallTwilioSim';
import { dncKey } from '../services/voice/hotLeadCallDnc';
import {
  BASE, LEAD_E164, callConfig, advanceMinutes, LEAD_PHONE_AS_TYPED, LIST, MEMBER_PHONE, TWILIO_NUMBER, eventsOf, installWorld, mock, placedCall, recordOf, submitLead,
  twilioCall, usage, usageSummary, world, bridgedCall, setClock,
} from './helpers/hotLeadCallE2eWorld';

installWorld();

// ── the call ────────────────────────────────────────────────────────────────

describe('a hot lead rings the member and, on 1, bridges the lead', () => {
  it('runs the whole call: one member call, a signed webhook sequence, both legs metered once, ordered timeline', async () => {
    await submitLead('lead-a');

    // The orchestrator placed exactly one call, from the org's number to the first available member.
    expect(world.provider.placedCalls).toHaveLength(1);
    const placed = placedCall();
    expect(placed).toMatchObject({ to: MEMBER_PHONE, from: TWILIO_NUMBER, timeoutSeconds: 25 });
    for (const url of [placed.url, placed.statusCallbackUrl]) {
      expect(url.startsWith(`${BASE}${MOUNT}/`)).toBe(true);
      expect([...new URL(url).searchParams.keys()].sort()).toEqual(['jobKey', 'leadId', 'listId']);
    }
    expect(placed.statusCallbackUrl).toMatch(/#rc=3&rp=5xx,ct$/);
    expect(recordOf('lead-a')).toMatchObject({ state: 'member_ringing', memberCallSid: 'CA00000001', meteredLegs: [] });

    // The member picks up and hears the fixed prompt, with the org's name XML-escaped.
    const call = twilioCall(placed);
    const prompt = await call.memberAnswers();
    expect(prompt.status).toBe(200);
    expect(prompt.body).toContain('Smith &amp; Sons');
    expect(sayText(prompt.body)).toBe('New lead from Smith & Sons. Are you available to take the call now? Press 1.');
    expect(recordOf('lead-a')?.state).toBe('member_answered');

    // Pressing 1 bridges: caller ID is the org's number, the lead's number is read from the lead row.
    const connect = await call.memberPresses('1');
    expect(attrOf(connect.body, 'callerId')).toBe(TWILIO_NUMBER);
    expect(connect.body).toContain(`>${LEAD_E164}</Number>`);
    expect(attrOf(connect.body, 'statusCallbackEvent')).toContain('completed');
    expect(connect.body).toContain('<Dial answerOnBridge="true"');
    expect(new URL(attrOf(connect.body, 'url')).pathname).toBe(`${MOUNT}/screen`);
    const statusUrl = new URL(call.leadStatusUrl);
    expect(statusUrl.searchParams.get('leg')).toBe('lead');
    expect(statusUrl.hash).toBe('#rc=3&rp=5xx,ct');
    expect(recordOf('lead-a')?.state).toBe('bridging');

    // The lead's leg progresses; answering is not a connection until the lead presses 1 at the screening prompt.
    await call.leadStatus('initiated', 0);
    await call.leadStatus('ringing', 1);
    await call.leadStatus('in-progress', 2);
    expect(recordOf('lead-a')).toMatchObject({ state: 'bridging', leadCallSid: 'CA00000002' });
    const screening = await call.leadAnswers();
    expect(sayText(screening.body)).toBe('This is an automated call from Smith & Sons about the enquiry you sent us. To reach a person at Smith & Sons, call 4 1 5, 5 5 5, 0 1 1 1. Press 1 to be connected now, press 2 if you are not available and we will call you again later, or press 3 to stop these calls.');
    expect((await call.leadPresses('1')).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(recordOf('lead-a')).toMatchObject({ state: 'connected', leadCallSid: 'CA00000002' });
    expect((await call.dialEnds('completed', { DialCallDuration: '125' })).body).toContain('<Hangup/>');

    // Both legs end; the last one finishes the call.
    expect((await call.leadStatus('completed', 3, { CallDuration: '125' })).status).toBe(200);
    expect(recordOf('lead-a')?.state).toBe('connected');
    expect((await call.memberLegEnds('completed', '301')).status).toBe(200);

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'completed', memberCallSid: 'CA00000001', leadCallSid: 'CA00000002' });
    expect([...(recordOf('lead-a')?.meteredLegs as string[])].sort()).toEqual(['lead', 'member:1']);
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.connected', 'call.completed']);
    expect(world.provider.placedCalls).toHaveLength(1);
    // Per-leg minutes, rounded up (125s -> 3, 301s -> 6), one idempotent usage event per leg's own CallSid.
    expect(usage()).toEqual([
      expect.objectContaining({ userId: 'owner-a', provider: 'twilio', operation: 'voice_minute_outbound', feature: 'hot_lead_call', unit: 'minute', rateKey: 'voice_minute_outbound', quantity: 6, idempotencyKey: 'twilio:voice:CA00000001:member' }),
      expect.objectContaining({ userId: 'owner-a', quantity: 3, idempotencyKey: 'twilio:voice:CA00000002:lead' }),
    ]);
  });

  it('leaves the Slack lead alert exactly as it was: one post, its own marker, no claim by the call', async () => {
    await bridgedCall();
    expect(world.postMessage).toHaveBeenCalledTimes(1);
    expect(world.postMessage.mock.calls[0][0]).toMatchObject({ channel: 'C123' });
    expect(world.crm.callsTo('claimLeadStepOnce')).toBe(1);
    expect(Object.keys(world.crm.lead(LIST, 'lead-a').system ?? {}).sort()).toEqual(['callConsent', 'hot_lead_call', expect.stringMatching(/^leadNotification_/)]);
    expect(mock(queue.enqueueJob).mock.calls.map(([source]) => source).sort()).toEqual(['hot_lead_call', 'org_lead_notification']);
  });

  it('the member declines with 2: no lead is dialed, the member leg alone is metered, outcome member_declined', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    const reply = await call.memberPresses('2');
    expect(reply.body).toContain('<Hangup/>');
    expect(reply.body).not.toContain('<Dial');
    await call.memberLegEnds('completed', '12');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'member_declined' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.member_declined', 'call.completed']);
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(usage()).toEqual([expect.objectContaining({ quantity: 1, idempotencyKey: 'twilio:voice:CA00000001:member' })]);
  });

  it('the member never answers: member_no_answer, finished, nothing billed for a zero-second leg', async () => {
    await submitLead('lead-a');
    await twilioCall(placedCall()).memberLegEnds('no-answer', '0');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'member_no_answer', meteredLegs: ['member:1'] });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_no_answer', 'call.completed']);
    expect(recordVendorUsage).not.toHaveBeenCalled();
  });

  it('the lead does not answer after the member pressed 1: lead_no_answer, member told, only the member leg billed', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('initiated', 0);
    await call.leadStatus('ringing', 1);
    const told = await call.dialEnds('no-answer');
    expect(sayText(told.body)).toBe(LEAD_UNREACHABLE_COPY);
    await call.leadStatus('no-answer', 2, { CallDuration: '0' });
    await call.memberLegEnds('completed', '38');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'lead_no_answer' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.lead_no_answer', 'call.completed']);
    expect(usage()).toEqual([expect.objectContaining({ quantity: 1, idempotencyKey: 'twilio:voice:CA00000001:member' })]);
  });

  it('the lead presses 4 (not an option) at the screening prompt: never bridged, lead_declined, the member is told, both legs billed', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    expect((await call.leadPresses('4')).body).toContain('<Hangup/>');
    const told = await call.dialEnds('completed', { DialBridged: 'false' });
    expect(sayText(told.body)).toBe('The lead did not confirm. Their details are in your lead alert.');
    await call.leadStatus('completed', 3, { CallDuration: '12' });
    await call.memberLegEnds('completed', '40');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'lead_declined' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.lead_declined', 'call.completed']);
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 1], ['twilio:voice:CA00000002:lead', 1]]);
  });

  it('the lead presses 3: the stop is recorded everywhere, the member is told, and a new lead with that number in the same org is skipped while another org\'s is called', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    const goodbye = await call.leadPresses('3');
    expect(sayText(goodbye.body)).toBe('Understood. Smith & Sons will not call this number again. Goodbye.');
    expect(goodbye.body).not.toContain('<Response/>');
    const told = await call.dialEnds('completed', { DialBridged: 'false' });
    expect(sayText(told.body)).toBe('The lead asked not to be called again. Their details are in your lead alert.');
    await call.leadStatus('completed', 3, { CallDuration: '12' });
    await call.memberLegEnds('completed', '40');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'lead_opted_out', meteredLegs: expect.arrayContaining(['lead', 'member:1']) });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.lead_declined', 'call.completed']);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 1], ['twilio:voice:CA00000002:lead', 1]]); // each leg once
    expect(world.crm.lead(LIST, 'lead-a')).toMatchObject({ contactStatus: 'do-not-contact', contactStatusReason: 'opted-out' });
    expect([...world.limits.claims.keys()].filter((k) => k.startsWith('hlc#dnc#'))).toEqual([dncKey('org-a', LEAD_E164)]);

    // The same person fills the form again as a NEW lead of the same org: no call, no slot beyond the first lead's.
    advanceMinutes(5);
    const counters = JSON.stringify([...world.limits.counters]);
    await submitLead('lead-new');
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(recordOf('lead-new')).toBeUndefined();
    expect(world.crm.lead(LIST, 'lead-new').engagements?.find((e) => e.eventType === 'call.skipped')?.eventData).toEqual({ reason: 'do_not_call' });
    expect(JSON.stringify([...world.limits.counters])).toBe(counters);

    // Another org with the same number is unaffected (the marker is keyed by org).
    world.crm.addOrg({ orgId: 'org-b', hotLeadCall: callConfig }, [{ userId: 'owner-b' }], [{ listId: 'list-b', userId: 'owner-b' }]);
    await submitLead('lead-b', { listId: 'list-b' });
    expect(world.provider.placedCalls).toHaveLength(2);
  });

  it('the lead answers but never presses anything (voicemail, hang-up): /dial reports DialBridged=false and the lead counts as declined', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    const told = await call.dialEnds('completed', { DialBridged: 'false' });
    expect(sayText(told.body)).toBe('The lead did not confirm. Their details are in your lead alert.');
    await call.leadStatus('completed', 3, { CallDuration: '9' });
    await call.memberLegEnds('completed', '35');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'lead_declined' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.lead_declined', 'call.completed']);
  });

  it('the lead window closed while the member was answering (real clock check, not mocked): nobody is dialed, lead_outside_hours', async () => {
    setClock('2026-10-19T21:55:00.000Z'); // 17:55 EDT: the lead window (13:00-18:00 Eastern for a 212 number) is open
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    setClock('2026-10-19T22:00:00.000Z'); // 18:00 EDT: closed before the member presses 1
    const reply = await call.memberPresses('1');
    expect(reply.body).not.toContain('<Dial');
    expect(reply.body).not.toContain(LEAD_E164.slice(2));
    expect(sayText(reply.body)).toBe(LEAD_UNREACHABLE_COPY);
    await call.memberLegEnds('completed', '20');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'lead_outside_hours' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.failed', 'call.completed']);
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(mock(queue.enqueueJob).mock.calls.filter(([source]) => source === 'hot_lead_call_next')).toHaveLength(0);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 1]]); // no lead leg
  });

  it('the lead phone was overwritten between dispatch and the member pressing 1: nobody is dialed, lead_phone_changed', async () => {
    await submitLead('lead-a');
    expect(recordOf('lead-a')?.leadPhoneMac).toBe(leadPhoneMacOf('org-a', LEAD_E164)); // stored by the orchestrator when the call passed the gates
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    world.crm.lead(LIST, 'lead-a').phone = '(212) 555-0199';
    const reply = await call.memberPresses('1');
    expect(reply.body).not.toContain('<Dial');
    expect(sayText(reply.body)).toBe('We could not reach the lead. Their details are in your lead alert.');
    await call.memberLegEnds('completed', '20');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'lead_phone_changed' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.failed', 'call.completed']);
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 1]]);
  });

  it('a definite Twilio rejection ends the record as failed and is never retried, even by a repeat submission', async () => {
    world.provider.failNextPlaceCall('no');
    await submitLead('lead-a');
    expect(recordOf('lead-a')).toMatchObject({ state: 'failed', outcome: 'place_rejected' });
    expect(eventsOf('lead-a')).toEqual(['call.failed']);

    advanceMinutes(25 * 60); // past the 24h phone marker, so only the permanent record stops the repeat
    await submitLead('lead-a', { submission: true });
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(eventsOf('lead-a')).toEqual(['call.failed']);
  });

  it('an ambiguous placement keeps the record dialing; the member callback adopts the CallSid and the call is metered', async () => {
    world.provider.failNextPlaceCall('unknown');
    await submitLead('lead-a');
    expect(recordOf('lead-a')).toMatchObject({ state: 'dialing', outcome: 'placement_unknown' });
    expect(recordOf('lead-a')?.memberCallSid).toBeUndefined();
    expect(eventsOf('lead-a')).toEqual(['call.failed']);
    expect(world.postMessage).toHaveBeenCalledTimes(1);

    // Twilio had in fact placed the call (its sid was never recorded); its signed callbacks arrive.
    const call = twilioCall(placedCall(), 'CA0000000A9', 'CA0000000B9');
    expect((await call.memberAnswers()).body).toContain('<Gather');
    expect(recordOf('lead-a')).toMatchObject({ state: 'member_answered', memberCallSid: 'CA0000000A9' });
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    await call.leadAnswers();
    await call.leadPresses('1');
    await call.leadStatus('completed', 3, { CallDuration: '30' });
    await call.memberLegEnds('completed', '61');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(eventsOf('lead-a')).toEqual(['call.failed', 'call.initiated', 'call.member_answered', 'call.connected', 'call.completed']);
    expect(usageSummary()).toEqual([['twilio:voice:CA0000000A9:member', 2], ['twilio:voice:CA0000000B9:lead', 1]]);
    expect(world.provider.placedCalls).toHaveLength(1);
  });
});

describe('calls that end off the happy path', () => {
  it('the member ignores the prompt (Gather times out, no /gather): member_declined when the member leg ends', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    expect((await call.memberAnswers()).body).toContain('<Gather');
    await call.memberLegEnds('completed', '14');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'member_declined' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.member_declined', 'call.completed']);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 1]]);
  });

  it.each([
    ['while the phone is still ringing', 'ring', ['call.initiated', 'call.failed', 'call.completed']],
    ['while the member is on the prompt', 'prompt', ['call.initiated', 'call.member_answered', 'call.failed', 'call.completed']],
  ])('the kill switch is flipped %s: the member hears a hangup, no lead is dialed, the member leg is still billed', async (_when, at, events) => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    if (at === 'prompt') await call.memberAnswers();
    setHotLeadCallEnabledOverride(false);
    const reply = at === 'prompt' ? await call.memberPresses('1') : await call.memberAnswers();
    expect(reply.body).toContain('<Hangup/>');
    expect(reply.body).not.toContain('<Dial');
    await call.memberLegEnds('completed', '20');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'aborted' });
    expect(eventsOf('lead-a')).toEqual(events);
    expect((world.crm.lead(LIST, 'lead-a').engagements ?? []).find((e) => e.eventType === 'call.failed')?.eventData).toEqual({ reason: 'aborted' });
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 1]]);
  });

  it('the lead leg ends but /dial never arrives: bridge_unconfirmed, both legs still billed', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('initiated', 0);
    await call.leadStatus('completed', 1, { CallDuration: '20' });
    expect(recordOf('lead-a')?.state).toBe('bridging');
    await call.memberLegEnds('completed', '45');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'bridge_unconfirmed' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.completed']);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 1], ['twilio:voice:CA00000002:lead', 1]]);
  });

  it('the lead row no longer has a callable phone when the member presses 1: lead_phone_invalid, nobody is dialed', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    world.crm.lead(LIST, 'lead-a').phone = '12345';
    const reply = await call.memberPresses('1');
    expect(sayText(reply.body)).toBe(LEAD_UNREACHABLE_COPY);
    expect(reply.body).not.toContain('<Dial');
    await call.memberLegEnds('completed', '25');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'lead_phone_invalid' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.failed', 'call.completed']);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 1]]);
  });
});

// ── replays and ordering ────────────────────────────────────────────────────

describe('Twilio retries and reorders callbacks', () => {
  it('a replay of every callback changes nothing: one event per step, one bridge, each leg billed once', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    const twice = async <T>(send: () => Promise<T>): Promise<[T, T]> => [await send(), await send()];

    const [firstPrompt, secondPrompt] = await twice(() => call.memberAnswers());
    expect(secondPrompt.body).toBe(firstPrompt.body);
    const [bridge, replayedBridge] = await twice(() => call.memberPresses('1'));
    expect(bridge.body).toContain('<Dial');
    expect(replayedBridge.body).not.toContain('<Dial');
    await twice(() => call.leadStatus('in-progress', 2));
    const [screenPrompt, replayedPrompt] = await twice(() => call.leadAnswers());
    expect(replayedPrompt.body).toBe(screenPrompt.body);
    const [accepted, replayedAccept] = await twice(() => call.leadPresses('1'));
    expect(replayedAccept.body).toBe(accepted.body);
    await twice(() => call.dialEnds('completed'));
    await twice(() => call.leadStatus('completed', 3, { CallDuration: '70' }));
    await twice(() => call.memberLegEnds('completed', '90'));
    // And once more after the call is over.
    expect((await call.memberLegEnds('completed', '90')).status).toBe(200);
    expect((await call.memberPresses('1')).body).not.toContain('<Dial');

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.connected', 'call.completed']);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 2], ['twilio:voice:CA00000002:lead', 2]]);
  });

  it('out-of-order callbacks: a stale lead "in-progress" after its "completed", and the member leg ending first', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.dialEnds('completed'); // connects the call before any lead status callback has arrived
    await call.memberLegEnds('completed', '100');
    expect(recordOf('lead-a')?.state).toBe('connected'); // the lead leg is still to be metered
    await call.leadStatus('completed', 3, { CallDuration: '95' });
    expect(recordOf('lead-a')?.state).toBe('finished');
    await call.leadStatus('in-progress', 2);
    await call.leadStatus('ringing', 1);

    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.connected', 'call.completed']);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 2], ['twilio:voice:CA00000002:lead', 2]]);
  });
});

describe('simultaneous and failed deliveries', () => {
  it('two identical status callbacks fired together are processed once (smoke; the winner rules are mutation-tested in twilioVoiceWebhook.test.ts)', async () => {
    const call = await bridgedCall();
    const [a, b] = await Promise.all([call.leadStatus('completed', 3, { CallDuration: '61' }), call.leadStatus('completed', 3, { CallDuration: '61' })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await Promise.all([call.memberLegEnds('completed', '90'), call.memberLegEnds('completed', '90')]);

    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 2], ['twilio:voice:CA00000002:lead', 2]]);
    expect(recordOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(eventsOf('lead-a').filter((e) => e === 'call.completed')).toHaveLength(1);
  });

  it('a replayed "1" fired together with the first is processed once (smoke; the winner rules are mutation-tested in twilioVoiceWebhook.test.ts)', async () => {
    await submitLead('lead-a');
    const call = twilioCall(placedCall());
    await call.memberAnswers();
    const replies = await Promise.all([call.memberPresses('1'), call.memberPresses('1')]);
    expect(replies.filter((r) => r.body.includes('<Dial'))).toHaveLength(1);
  });

  it('a status callback answered 500 is redelivered by Twilio and then meters once', async () => {
    const call = await bridgedCall();
    jest.spyOn(world.crm.crmDb, 'updateLeadSystemRecordIf').mockRejectedValueOnce(new Error('dynamo unavailable'));
    const failed = await call.leadStatus('completed', 3, { CallDuration: '61' });
    expect(failed.status).toBe(500);
    expect(usage()).toEqual([]);
    expect(recordOf('lead-a')?.meteredLegs).toEqual([]);

    expect((await call.leadStatus('completed', 3, { CallDuration: '61' })).status).toBe(200);
    expect((await call.leadStatus('completed', 3, { CallDuration: '61' })).status).toBe(200);
    expect(usageSummary()).toEqual([['twilio:voice:CA00000002:lead', 2]]);
  });

  it('treats an empty CallDuration as missing: warned about and not billed, not silently read as zero seconds', async () => {
    const call = await bridgedCall();
    await call.leadStatus('completed', 3, { CallDuration: '' });
    expect(JSON.stringify(world.consoleSpies.flatMap((s) => s.mock.calls))).toContain('[hotLeadCall] non-finite call duration');
    await call.memberLegEnds('completed', '30');
    expect(usageSummary()).toEqual([['twilio:voice:CA00000001:member', 1]]);
    expect(recordOf('lead-a')?.state).toBe('finished');
  });
});

// ── the webhook guard ───────────────────────────────────────────────────────

describe('the webhooks trust only signed requests for this call', () => {
  it('rejects a missing, forged or wrong-URL signature with 401 and writes nothing', async () => {
    await submitLead('lead-a');
    const placed = placedCall();
    const before = JSON.stringify(world.crm.lead(LIST, 'lead-a'));
    const params = { CallSid: 'CA00000001', CallStatus: 'completed', CallDuration: '600' };
    const tamperedUrl = placed.statusCallbackUrl.replace(/jobKey=[0-9a-f]+/, 'jobKey=deadbeef');

    const replies = [
      await world.twilio.post(placed.url, { CallSid: 'CA00000001' }, { signWith: null }),
      await world.twilio.post(placed.url, { CallSid: 'CA00000001' }, { signWith: 'not-the-account-token' }),
      await world.twilio.post(placed.statusCallbackUrl, params, { signWith: null }),
      await world.twilio.post(placed.statusCallbackUrl, params, { signWith: 'not-the-account-token' }),
      // Signed for a different URL than the one requested: the signature binds the query string.
      await world.twilio.post(placed.statusCallbackUrl, params, { signedUrl: tamperedUrl }),
      // A signature that is right for these exact params but over another host: the URL is rebuilt from BACKEND_URL.
      await world.twilio.post(placed.statusCallbackUrl, params, { signedUrl: `https://evil.example${new URL(placed.statusCallbackUrl).pathname}` }),
    ];

    expect(replies.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(JSON.stringify(world.crm.lead(LIST, 'lead-a'))).toBe(before);
    expect(recordVendorUsage).not.toHaveBeenCalled();
    // Control: the same request, correctly signed with the account token, is accepted.
    expect((await world.twilio.post(placed.statusCallbackUrl, params)).status).toBe(200);
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
  });

  it('answers 503 and processes nothing when the credentials cannot be loaded', async () => {
    await submitLead('lead-a');
    world.provider.ensureCredentials = async () => { throw new Error('secrets down'); };
    const reply = await world.twilio.post(placedCall().url, { CallSid: 'CA00000001', CallStatus: 'in-progress' });
    expect(reply.status).toBe(503);
    expect(recordOf('lead-a')?.state).toBe('member_ringing');
  });

  it("hangs up on a validly signed callback for another org's lead or another job, and writes nothing", async () => {
    world.crm.addOrg({ orgId: 'org-b' }, [{ userId: 'owner-b' }], [{ listId: 'list-b', userId: 'owner-b' }]);
    world.crm.addLead({ listId: 'list-b', leadId: 'lead-b', phone: LEAD_PHONE_AS_TYPED });
    await submitLead('lead-a');
    const placed = placedCall();
    const jobKey = new URL(placed.url).searchParams.get('jobKey')!;
    const before = JSON.stringify([world.crm.lead(LIST, 'lead-a'), world.crm.lead('list-b', 'lead-b')]);
    const at = (kind: string, query: string) => `${BASE}${MOUNT}/${kind}?${query}`;
    const member = { CallSid: 'CA00000001', CallStatus: 'in-progress' };

    const foreignList = await world.twilio.post(at('owner', `listId=list-b&leadId=lead-b&jobKey=${jobKey}`), member);
    const foreignLead = await world.twilio.post(at('gather', `listId=${LIST}&leadId=lead-b&jobKey=${jobKey}`), { ...member, Digits: '1' });
    const otherJob = await world.twilio.post(at('owner', `listId=${LIST}&leadId=lead-a&jobKey=${'0'.repeat(64)}`), member);
    const otherCall = await world.twilio.post(placed.url, { ...member, CallSid: 'CA00000099' });
    const staleStatus = await world.twilio.post(at('status', `listId=${LIST}&leadId=lead-a&jobKey=${'0'.repeat(64)}`), { ...member, CallStatus: 'completed', CallDuration: '600' });

    for (const reply of [foreignList, foreignLead, otherJob, otherCall]) {
      expect(reply.status).toBe(200);
      expect(reply.body).toContain('<Hangup/>');
      expect(reply.body).not.toContain('<Dial');
    }
    expect(staleStatus.status).toBe(200);
    expect(JSON.stringify([world.crm.lead(LIST, 'lead-a'), world.crm.lead('list-b', 'lead-b')])).toBe(before);
    expect(recordVendorUsage).not.toHaveBeenCalled();
  });
});
