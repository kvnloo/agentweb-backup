/**
 * Expiry of a press-2 retry through the REAL entry point (ENG-2783): runHotLeadCallRetryCron() over the real
 * DynamoLeadCallStore on the in-memory CRM, the real discovery and the real gates. An automated QA reported that a retry more
 * than six hours late was "pushed back instead of given up"; these fixtures are exactly the ones it used. Contract: a retry is
 * placed within 6 hours of its FIRST due time or given up with a call.skipped retry_expired note, claimed, with no reschedule
 * and no call, whatever the windows or the stored dueAt say.
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));

import { resetHotLeadCallRetryCronForTests, runHotLeadCallRetryCron } from '../cron/hotLeadCallRetryCron';
import { resetRetrySweepRotationForTests } from '../services/voice/hotLeadCallRetrySweep';
import { leadPhoneMacOf } from '../services/voice/leadPhoneMac';
import { MEMBER_ID } from './helpers/hotLeadCallFixtures';
import { LEAD_E164, LEAD_PHONE_AS_TYPED, LIST, callConfig, installWorld, setClock, world } from './helpers/hotLeadCallE2eWorld';

installWorld();

const HOUR = 3_600_000;
// 12:00 Eastern on 2026-10-19 (EDT): the lead window (13:00-18:00 Eastern) is CLOSED, the org's hours are open all day.
const NOW = '2026-10-19T16:00:00.000Z';
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const ahead = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

beforeEach(() => {
  resetRetrySweepRotationForTests();
  resetHotLeadCallRetryCronForTests();
  world.crm.orgs.set('org-a', { ...world.crm.orgs.get('org-a')!, hotLeadCall: { ...callConfig, callingHours: { start: '00:00', end: '23:59', timezone: 'America/New_York' } } });
  setClock(NOW);
});

/** A finished lead_deferred record, as press 2 leaves it, with exactly the stored deferral given. */
function seed(deferral: Record<string, unknown>): void {
  world.crm.addLead({ listId: LIST, leadId: 'lead-a', phone: LEAD_PHONE_AS_TYPED, firstName: 'J', email: 'a@example.com', createdAt: ago(30 * HOUR), customFields: { stage: 'complete' } });
  world.crm.lead(LIST, 'lead-a').system = {
    ...world.crm.lead(LIST, 'lead-a').system,
    hot_lead_call: {
      state: 'finished', outcome: 'lead_deferred', jobKey: 'job-1', startedAt: ago(30 * HOUR), updatedAt: ago(7 * HOUR), attemptNo: 1, memberId: MEMBER_ID,
      triedMemberIds: [MEMBER_ID], meteredLegs: [], lastSequence: {}, leadPhoneMac: leadPhoneMacOf('org-a', LEAD_E164), deferral,
    },
  };
}
const sidecar = () => world.crm.lead(LIST, 'lead-a').system?.hot_lead_call as Record<string, unknown>;
const expiryNotes = () => (world.crm.lead(LIST, 'lead-a').engagements ?? []).filter((e) => e.eventType === 'call.skipped' && (e.eventData as { reason: string }).reason === 'retry_expired');

describe('a retry past six hours from its first due time is given up by the real cron', () => {
  it.each([
    ['(i) dueAt moved 11 minutes ago, firstDueAt 7h ago, lead window closed', () => ({ dueAt: ago(11 * 60_000), count: 1, firstDueAt: ago(7 * HOUR) })],
    ['(ii) a record without firstDueAt whose dueAt is 6.5h ago', () => ({ dueAt: ago(6.5 * HOUR), count: 1 })],
    ['(iii) a dueAt in the FUTURE but a firstDueAt older than 6h (an operator-written or older-shape record)', () => ({ dueAt: ahead(2 * HOUR), count: 1, firstDueAt: ago(7 * HOUR) })],
  ])('%s: claimed, one retry_expired note, no reschedule, no call', async (_name, deferral) => {
    const stored = deferral();
    seed(stored);
    const summary = await runHotLeadCallRetryCron();
    expect(summary).toMatchObject({ enabled: true, killSwitchOn: true, orgs: 1, lists: 1, found: 1, expired: 1, rescheduled: 0, attempted: 0, notDue: 0, failed: 0 });
    expect(sidecar().retryClaimToken).toEqual(expect.any(String));
    expect(sidecar().deferral).toEqual(stored);
    expect(sidecar()).toMatchObject({ state: 'finished', outcome: 'lead_deferred' });
    expect(expiryNotes()).toHaveLength(1);
    expect(world.provider.placedCalls).toHaveLength(0);
    // Spent: the next tick finds nothing.
    expect(await runHotLeadCallRetryCron()).toMatchObject({ found: 0 });
    expect(expiryNotes()).toHaveLength(1);
  });

  it('control: inside its six hours with the same closed window the same record is moved, not given up', async () => {
    seed({ dueAt: ago(11 * 60_000), count: 1, firstDueAt: ago(2 * HOUR) });
    expect(await runHotLeadCallRetryCron()).toMatchObject({ expired: 0, rescheduled: 1 });
    // Exactly the lead window's opening (13:00 EDT = 17:00Z): from now, with no extra 60 minutes (that would be 18:00Z).
    expect(sidecar().deferral).toEqual({ dueAt: '2026-10-19T17:00:00.000Z', count: 1, firstDueAt: ago(2 * HOUR) });
    expect(sidecar().retryClaimToken).toBeUndefined();
    expect(expiryNotes()).toHaveLength(0);
  });

  it('a garbage firstDueAt falls back to dueAt: dueAt 6.5h ago is given up (claimed, one retry_expired note)', async () => {
    seed({ dueAt: ago(6.5 * HOUR), count: 1, firstDueAt: 'not-a-date' });
    expect(await runHotLeadCallRetryCron()).toMatchObject({ found: 1, expired: 1, rescheduled: 0, attempted: 0, failed: 0 });
    expect(sidecar().retryClaimToken).toEqual(expect.any(String));
    expect(expiryNotes()).toHaveLength(1);
    expect(world.provider.placedCalls).toHaveLength(0);
  });

  it('a garbage firstDueAt with dueAt 2h ago inside the lead window is retried normally (no early expiry)', async () => {
    setClock('2026-10-19T19:00:00.000Z'); // 15:00 EDT: both windows open
    seed({ dueAt: new Date(Date.parse('2026-10-19T19:00:00.000Z') - 2 * HOUR).toISOString(), count: 1, firstDueAt: 'not-a-date' });
    expect(await runHotLeadCallRetryCron()).toMatchObject({ attempted: 1, expired: 0 });
    expect(expiryNotes()).toHaveLength(0);
    expect(world.provider.placedCalls).toHaveLength(1);
  });

  it('control: a future-dated deferral that is still inside its six hours is simply not due', async () => {
    seed({ dueAt: ahead(2 * HOUR), count: 1, firstDueAt: ago(HOUR) });
    expect(await runHotLeadCallRetryCron()).toMatchObject({ found: 1, notDue: 1, expired: 0 });
    expect(sidecar().retryClaimToken).toBeUndefined();
  });
});

describe('a due retry whose window is closed is moved to the next open minute counted from NOW (no extra 60 minutes)', () => {
  it('15:30 Eastern with an org opening 15:40-16:00 and a give-up at 16:00: moved to 15:40, then placed', async () => {
    world.crm.orgs.set('org-a', { ...world.crm.orgs.get('org-a')!, hotLeadCall: { ...callConfig, callingHours: { start: '15:40', end: '16:00', timezone: 'America/New_York' } } });
    setClock('2026-10-19T19:30:00.000Z'); // 15:30 EDT
    const first = '2026-10-19T14:00:00.000Z'; // 10:00 EDT: give-up at 16:00 EDT
    seed({ dueAt: '2026-10-19T19:00:00.000Z', count: 1, firstDueAt: first });
    expect(await runHotLeadCallRetryCron()).toMatchObject({ rescheduled: 1, expired: 0, attempted: 0 });
    expect(sidecar().deferral).toEqual({ dueAt: '2026-10-19T19:40:00.000Z', count: 1, firstDueAt: first });
    expect(sidecar().retryClaimToken).toBeUndefined();
    expect(expiryNotes()).toHaveLength(0);
    setClock('2026-10-19T19:40:00.000Z');
    expect(await runHotLeadCallRetryCron()).toMatchObject({ attempted: 1 });
    expect(world.provider.placedCalls).toHaveLength(1);
  });
});
