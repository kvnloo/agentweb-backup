/**
 * ENG-2783: the call-consent gate through the real dispatch path (real LeadCallStore, orchestrator and gates over the in-memory CRM).
 * A form-fill lead WITH a `system.callConsent` record is called; one WITHOUT is skipped as `no_call_consent`, takes no slot and no record,
 * and that gate runs before the hours gates so it shows at any hour. The retry pass is covered in hotLeadCall.e2e.retry.test.ts
 * (permanent refusal `no_call_consent`).
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));

import { callConfig, eventsOf, installWorld, LIST, recordOf, setClock, skipReason, submitLead, world } from './helpers/hotLeadCallE2eWorld';

installWorld();

describe('call consent gate (no_call_consent)', () => {
  it('a form-fill lead WITH consent is called', async () => {
    await submitLead('lead-a');
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(recordOf('lead-a')).toBeDefined();
  });

  it('a form-fill lead WITHOUT consent: call.skipped no_call_consent, nothing dialed, no record, no limit slot', async () => {
    await submitLead('lead-a', { consent: false });
    expect(eventsOf('lead-a')).toEqual(['call.skipped']);
    expect(skipReason('lead-a')).toEqual({ reason: 'no_call_consent' });
    expect(world.provider.placedCalls).toEqual([]);
    expect(recordOf('lead-a')).toBeUndefined();
    expect(world.limits.keysTouched).toEqual([]);
  });

  it.each([['the string "true"', 'true'], ['false', false], ['an empty record', undefined]])('a stored granted of %s is not consent', async (_n, granted) => {
    await submitLead('lead-a', { lead: { system: { callConsent: { granted } } } });
    expect(skipReason('lead-a')).toEqual({ reason: 'no_call_consent' });
    expect(world.provider.placedCalls).toEqual([]);
  });

  it('has no record to retry: a later submission without consent is skipped again (one skip event) and still nothing is dialed', async () => {
    await submitLead('lead-a', { consent: false });
    await submitLead('lead-a', { consent: false, submission: true });
    expect(eventsOf('lead-a')).toEqual(['call.skipped']);
    expect(world.provider.placedCalls).toEqual([]);
    expect(recordOf('lead-a')).toBeUndefined();
  });

  it('a repeat submission that brings consent (recorded before dispatch, as forward-lead does) calls the lead; the earlier skip stays on the timeline', async () => {
    await submitLead('lead-a', { consent: false });
    expect(world.provider.placedCalls).toEqual([]);
    world.crm.lead(LIST, 'lead-a').system = { callConsent: { granted: true, text: 'x'.repeat(60) + ' call', capturedAt: new Date().toISOString(), source: 'form' } };
    await submitLead('lead-a', { submission: true });
    expect(world.provider.placedCalls).toHaveLength(1);
    expect(eventsOf('lead-a')[0]).toBe('call.skipped');
  });

  it('shows at any hour: outside the lead window a lead WITHOUT consent gets no_call_consent, one WITH consent gets outside_lead_hours', async () => {
    // Org hours open all day; 12:00 Eastern is before the lead window (13:00-18:00 Eastern).
    world.crm.orgs.set('org-a', { ...world.crm.orgs.get('org-a')!, hotLeadCall: { ...callConfig, callingHours: { start: '00:00', end: '23:59', timezone: 'America/New_York' } } });
    setClock('2026-10-19T16:00:00.000Z');
    await submitLead('lead-a', { consent: false });
    await submitLead('lead-b', { phone: '(212) 555-0111' });
    expect(skipReason('lead-a')).toEqual({ reason: 'no_call_consent' });
    expect(skipReason('lead-b')).toEqual({ reason: 'outside_lead_hours' });
    expect(world.provider.placedCalls).toEqual([]);
  });

  it('shows outside the org calling hours too (03:00 Chicago)', async () => {
    setClock('2026-10-19T08:00:00.000Z');
    await submitLead('lead-a', { consent: false });
    expect(skipReason('lead-a')).toEqual({ reason: 'no_call_consent' });
  });
});
