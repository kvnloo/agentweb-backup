/**
 * Hot-lead auto-call, end to end (ENG-2271): everything that must stop a call before it is dialed (kill
 * switch, config, calling hours, staleness, dedupe, cooldown, caps, unsafe ids) and the silent refusals. Same real
 * pieces and fakes as hotLeadCall.e2e.test.ts, via helpers/hotLeadCallE2eWorld.
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));

import * as queue from '../services/asyncJobQueue';
import { setHotLeadCallEnabledOverride } from '../services/voice/hotLeadCallMode';
import { dncKey, markNumberDoNotCall } from '../services/voice/hotLeadCallDnc';
import {
  callConfig, advanceMinutes, eventsOf, LEAD_E164, installWorld, leadPhone, recordOf, setClock, skipReason, submitLead, world,
} from './helpers/hotLeadCallE2eWorld';

installWorld();

// ── gates before any call ───────────────────────────────────────────────────

describe('nothing is dialed when a gate says no', () => {
  it('kill switch off: no hot-lead read, write, queue job, limit key or call (the Slack path alone reads)', async () => {
    world.crm.orgs.set('org-a', { orgId: 'org-a', hotLeadCall: callConfig }); // no Slack, so only the Slack routing lookup remains
    setHotLeadCallEnabledOverride(false);
    await submitLead('lead-a');

    expect(world.crm.calls).toEqual(['getLeadListById', 'getUserById', 'getOrgById']);
    expect(world.provider.placedCalls).toEqual([]);
    expect(world.limits.keysTouched).toEqual([]);
    expect(queue.enqueueJob).not.toHaveBeenCalled();
    expect(recordOf('lead-a')).toBeUndefined();
  });

  it('an org without a hotLeadCall config: only the routing reads (no lead read, no limit key, no event, no call)', async () => {
    world.crm.orgs.set('org-a', { orgId: 'org-a' });
    await submitLead('lead-a');

    expect(world.crm.calls.sort()).toEqual(['getLeadListById', 'getLeadListById', 'getOrgById', 'getOrgById', 'getUserById', 'getUserById']);
    expect(world.provider.placedCalls).toEqual([]);
    expect(world.limits.keysTouched).toEqual([]);
    expect(eventsOf('lead-a')).toEqual([]);
  });

  it.each([
    ['03:00 local', '2026-10-19T08:00:00.000Z'],
    ['21:00 local, the window end (exclusive)', '2026-10-20T02:00:00.000Z'],
  ])('outside the call window (%s): call.skipped, no record, no limit slot, Slack still alerts', async (_name, at) => {
    setClock(at);
    await submitLead('lead-a');

    expect(eventsOf('lead-a')).toEqual(['call.skipped']);
    expect(skipReason('lead-a')).toEqual({ reason: 'outside_calling_hours' });
    expect(world.provider.placedCalls).toEqual([]);
    expect(recordOf('lead-a')).toBeUndefined();
    expect(world.limits.keysTouched).toEqual([]);
    expect(world.postMessage).toHaveBeenCalledTimes(1);
  });

  it('inside the window just before it closes the call is placed (control for the boundary above)', async () => {
    // The org window ends 18:00 Eastern here so the lead (a 212 number, inside 10:00-18:00 Eastern and Pacific only
    // from 13:00 to 18:00 Eastern) is also inside: with the default Chicago 21:00 end the lead window would close first.
    world.crm.orgs.set('org-a', { ...world.crm.orgs.get('org-a'), hotLeadCall: { ...callConfig, callingHours: { start: '08:00', end: '18:00', timezone: 'America/New_York' } } });
    setClock('2026-10-19T21:59:00.000Z'); // 17:59 EDT
    await submitLead('lead-a');
    expect(world.provider.placedCalls).toHaveLength(1);
  });

  it('control: the org gate reports outside_calling_hours at its exact minute when the lead window is open at both instants', async () => {
    world.crm.orgs.set('org-a', { ...world.crm.orgs.get('org-a'), hotLeadCall: { ...callConfig, callingHours: { start: '08:00', end: '16:30', timezone: 'America/Chicago' } } });
    setClock('2026-10-19T21:29:00.000Z'); // 16:29 CDT = 17:29 EDT: both windows open
    await submitLead('lead-a');
    expect(world.provider.placedCalls).toHaveLength(1);

    setClock('2026-10-19T21:30:00.000Z'); // 16:30 CDT = 17:30 EDT: the org window has closed, the lead window has not
    await submitLead('lead-b', { phone: leadPhone(2) });
    expect(skipReason('lead-b')).toEqual({ reason: 'outside_calling_hours' });
    expect(world.provider.placedCalls).toHaveLength(1);
  });

  it('a Canadian lead is refused as country_not_allowed even though the stored config allows CA: no record, no slot, Slack still alerts', async () => {
    world.crm.orgs.set('org-a', { ...world.crm.orgs.get('org-a'), hotLeadCall: { ...callConfig, allowedCountries: ['US', 'CA'] } });
    await submitLead('lead-ca', { phone: '+14165550142' });

    expect(skipReason('lead-ca')).toEqual({ reason: 'country_not_allowed' });
    expect(world.provider.placedCalls).toEqual([]);
    expect(recordOf('lead-ca')).toBeUndefined();
    expect(world.limits.keysTouched).toEqual([]);
    expect(world.postMessage).toHaveBeenCalledTimes(1);
  });

  describe('do-not-call (ENG-2783)', () => {
    const expectRefused = () => {
      expect(eventsOf('lead-a')).toEqual(['call.skipped']);
      expect(skipReason('lead-a')).toEqual({ reason: 'do_not_call' });
      expect(world.provider.placedCalls).toEqual([]);
      expect(recordOf('lead-a')).toBeUndefined();
      // No slot: no counter, and the only claim ever taken is the marker itself.
      expect([...world.limits.counters.keys()]).toEqual([]);
      expect([...world.limits.claims.keys()].every((k) => k.startsWith('hlc#dnc#'))).toBe(true);
      expect(world.limits.keysTouched.filter((k) => !k.startsWith('hlc#dnc#'))).toEqual([]);
      expect(world.postMessage).toHaveBeenCalledTimes(1);
    };

    it('the org marker holds the number (a lead pressed 3 before): call.skipped, no record, no slot, Slack still alerts', async () => {
      await markNumberDoNotCall('org-a', LEAD_E164);
      await submitLead('lead-a');
      expectRefused();
      expect([...world.limits.claims.keys()]).toEqual([dncKey('org-a', LEAD_E164)]);
    });

    it('the lead is do-not-contact: call.skipped, no record, no slot, Slack still alerts', async () => {
      await submitLead('lead-a', { lead: { contactStatus: 'do-not-contact' } });
      expectRefused();
    });

    it('a lead who only unsubscribed from email is called', async () => {
      await submitLead('lead-a', { lead: { contactStatus: 'unsubscribed', unsubscribedFromGroupEmail: true } });
      expect(world.provider.placedCalls).toHaveLength(1);
    });
  });

  describe('lead-local hours (outside_lead_hours)', () => {
    // The org window is open all day here, so only the lead's own window (Eastern AND Pacific, 13:00-18:00 Eastern) decides.
    const allDay = { ...callConfig, callingHours: { start: '00:00', end: '23:59', timezone: 'America/Chicago' } };
    beforeEach(() => world.crm.orgs.set('org-a', { ...world.crm.orgs.get('org-a'), hotLeadCall: allDay }));

    it.each([
      ['12:59 Eastern (09:59 Pacific)', '2026-10-19T16:59:00.000Z'],
      ['18:00 Eastern, the end (exclusive)', '2026-10-19T22:00:00.000Z'],
    ])('%s: call.skipped, no record, no limit slot, Slack still alerts', async (_name, at) => {
      setClock(at);
      await submitLead('lead-a');

      expect(eventsOf('lead-a')).toEqual(['call.skipped']);
      expect(skipReason('lead-a')).toEqual({ reason: 'outside_lead_hours' });
      expect(world.provider.placedCalls).toEqual([]);
      expect(recordOf('lead-a')).toBeUndefined();
      expect(world.limits.keysTouched).toEqual([]);
      expect(world.postMessage).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['13:00 Eastern, the start (inclusive)', '2026-10-19T17:00:00.000Z'],
      ['17:59 Eastern', '2026-10-19T21:59:00.000Z'],
    ])('%s: the call is placed', async (_name, at) => {
      setClock(at);
      await submitLead('lead-a');
      expect(world.provider.placedCalls).toHaveLength(1);
    });
  });

  it('a second lead with the same phone is skipped as duplicate_phone; the first call stands', async () => {
    await submitLead('lead-a');
    await submitLead('lead-b');

    expect(world.provider.placedCalls).toHaveLength(1);
    expect(eventsOf('lead-b')).toEqual(['call.skipped']);
    expect(skipReason('lead-b')).toEqual({ reason: 'duplicate_phone' });
    expect(recordOf('lead-b')).toBeUndefined();
    expect(world.postMessage).toHaveBeenCalledTimes(2);
  });

  it('two leads inside the member cooldown ring the member once; a lead after the cooldown rings again', async () => {
    await submitLead('lead-a', { phone: leadPhone(1) });
    await submitLead('lead-b', { phone: leadPhone(2) });
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(skipReason('lead-b')).toEqual({ reason: 'member_cooldown' });
    expect(recordOf('lead-b')).toBeUndefined();

    advanceMinutes(3); // default memberCooldownMinutes is 2
    await submitLead('lead-c', { phone: leadPhone(3) });
    expect(world.provider.placedCalls).toHaveLength(2);
    expect(recordOf('lead-c')).toMatchObject({ state: 'member_ringing' });
  });

  it('a repeat submission inside the 24h phone window places no second call and adds nothing to the timeline', async () => {
    await submitLead('lead-a');
    await submitLead('lead-a', { submission: true }); // a new submission id: a distinct queue job, same lead and phone
    await submitLead('lead-a'); // the very same job again: the queue row is a duplicate

    expect(world.provider.placedCalls).toHaveLength(1);
    expect(eventsOf('lead-a')).toEqual(['call.initiated']);
  });

  it('a repeat submission after the 24h phone window still cannot dial: a lead gets one call record, ever', async () => {
    await submitLead('lead-a');
    advanceMinutes(25 * 60);
    await submitLead('lead-a', { submission: true });

    expect(world.provider.placedCalls).toHaveLength(1);
    expect(eventsOf('lead-a')).toEqual(['call.initiated']);
  });

  it('a lead id the webhooks would reject is skipped before any call, and the Slack alert still goes out', async () => {
    await submitLead('lead with spaces');

    expect(skipReason('lead with spaces')).toEqual({ reason: 'unsafe_id' });
    expect(world.provider.placedCalls).toEqual([]);
    expect(world.limits.keysTouched).toEqual([]);
    expect(world.postMessage).toHaveBeenCalledTimes(1);
  });
});


describe('limits and silent refusals', () => {
  const configWith = (limits: Record<string, number>) => world.crm.orgs.set('org-a', { ...world.crm.orgs.get('org-a'), hotLeadCall: { ...callConfig, ...limits } });

  it.each([
    ['maxCallsPerHour', 'org_hourly_cap'],
    ['maxCallsPerDay', 'org_daily_cap'],
    ['maxCallsPerMonth', 'org_monthly_cap'],
  ])('%s reached: the next lead (after the cooldown) is skipped as %s with no record', async (field, reason) => {
    configWith({ [field]: 1 });
    await submitLead('lead-a', { phone: leadPhone(1) });
    advanceMinutes(3);
    await submitLead('lead-b', { phone: leadPhone(2) });

    expect(world.provider.placedCalls).toHaveLength(1);
    expect(skipReason('lead-b')).toEqual({ reason });
    expect(recordOf('lead-b')).toBeUndefined();
    expect(eventsOf('lead-b')).toEqual(['call.skipped']);
    // The Slack alert goes out for every lead, called or skipped.
    expect(world.postMessage).toHaveBeenCalledTimes(2);
  });

  it('a lead older than maxAgeMinutes by the time it is processed is skipped as too_old', async () => {
    await submitLead('lead-a', { lead: { createdAt: new Date(Date.now() - 11 * 60_000).toISOString() } });
    expect(skipReason('lead-a')).toEqual({ reason: 'too_old' });
    expect(world.provider.placedCalls).toEqual([]);
    expect(world.limits.keysTouched).toEqual([]);
  });

  it('an enabled config without a caller number is invalid as a whole: silent, Slack only (so no_caller_number is unreachable here)', async () => {
    world.crm.orgs.set('org-a', { ...world.crm.orgs.get('org-a'), hotLeadCall: { ...callConfig, twilioNumber: undefined } });
    await submitLead('lead-a');
    expect(eventsOf('lead-a')).toEqual([]);
    expect(world.provider.placedCalls).toEqual([]);
    expect(world.postMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a smoke-test lead', {}, { email: 'smoke-test+1760000000000@agentweb.pro' }],
    ['a progressive-capture draft', {}, { customFields: { stage: 'email' } }],
    ['a lead that is not a form fill', { origin: 'manual' as const }, {}],
  ])('%s is refused silently: no event, record, limit key or call', async (_name, opts, lead) => {
    await submitLead('lead-a', { ...opts, lead });
    expect(eventsOf('lead-a')).toEqual([]);
    expect(recordOf('lead-a')).toBeUndefined();
    expect(world.provider.placedCalls).toEqual([]);
    expect(world.limits.keysTouched).toEqual([]);
  });
});
