/**
 * Hot-lead auto-call, end to end: the platform-wide daily ceiling (ENG-2783). The real dispatch path, the real limit
 * logic on the in-memory store, and a fake clock across the UTC day boundary.
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));

import { eventsOf, installWorld, leadPhone, recordOf, setClock, skipReason, submitLead, world } from './helpers/hotLeadCallE2eWorld';

installWorld();

// The lead-local window (13:00-18:00 Eastern) never contains UTC midnight, so the day boundary is crossed by a clock jump:
// 20:40Z-20:55Z on 2026-10-19 (15:40 Chicago, 16:40 Eastern) to 17:05Z on 2026-10-20 (12:05 Chicago, 13:05 Eastern).
const DAY1 = (m: number) => `2026-10-19T20:${m}:00.000Z`;
const DAY2 = '2026-10-20T17:05:00.000Z';
const submitAt = async (iso: string, id: string, n: number) => { setClock(iso); await submitLead(id, { phone: leadPhone(n) }); };
const errorSpy = () => world.consoleSpies[2]; // consoleSpies = [log, warn, error, info]
const platformMarkers = () => errorSpy().mock.calls.map(c => String(c[0])).filter(m => m.includes('PLATFORM daily cap'));

beforeEach(() => { process.env.HOT_LEAD_CALL_PLATFORM_DAILY_MAX = '5'; delete process.env.HOT_LEAD_CALL_ALERT_EMAIL; });
afterEach(() => { delete process.env.HOT_LEAD_CALL_PLATFORM_DAILY_MAX; });

describe('platform daily ceiling through the real dispatch path', () => {
  it('skips the (cap+1)-th lead of the UTC day as platform_daily_cap, then calls again after the UTC midnight', async () => {
    const times = [40, 43, 46, 49, 52];
    for (const [i, t] of times.entries()) {
      await submitAt(DAY1(t), `lead-${i + 1}`, i + 1);
      expect(recordOf(`lead-${i + 1}`)).toBeDefined();
    }
    expect(world.provider.placedCalls).toHaveLength(5);
    expect(world.limits.counters.get('hlc#cap#g#2026-10-19')).toBe(5);
    // 80% (ceil(4)=4) and 100% (the fifth lead reached the cap) each alerted exactly once.
    expect(platformMarkers().map(m => m.match(/cap (\d+)%/)?.[1])).toEqual(['80', '100']);

    await submitAt(DAY1(55), 'lead-6', 6);
    expect(skipReason('lead-6')).toEqual({ reason: 'platform_daily_cap' });
    expect(eventsOf('lead-6')).toEqual(['call.skipped']);
    expect(recordOf('lead-6')).toBeUndefined();
    expect(world.provider.placedCalls).toHaveLength(5); // no member and no lead was rung
    expect(world.postMessage).toHaveBeenCalledTimes(6); // the Slack alert still goes out for the skipped lead
    expect(platformMarkers()).toHaveLength(2); // the 100% alert is de-duplicated
    // Rolled back: the refused lead holds no org slot, no phone marker, no platform slot.
    expect(world.limits.counters.get('hlc#cap#g#2026-10-19')).toBe(5);
    expect(world.limits.counters.get('hlc#cap#d#org-a#2026-10-19')).toBe(5);
    expect([...world.limits.claims.keys()].filter(k => k.startsWith('hlc#phone#'))).toHaveLength(5);

    // Next UTC day: a fresh platform counter. The org's Chicago day also rolled, so its daily counter restarts too.
    await submitAt(DAY2, 'lead-7', 7);
    expect(recordOf('lead-7')).toBeDefined();
    expect(world.provider.placedCalls).toHaveLength(6);
    expect(world.limits.counters.get('hlc#cap#g#2026-10-20')).toBe(1);
    expect(world.limits.counters.get('hlc#cap#d#org-a#2026-10-20')).toBe(1);
  });

  it('leaves leads before the cap and other days untouched, with no alert below 80%', async () => {
    for (let i = 1; i <= 3; i++) await submitAt(DAY1(40 + i * 3), `lead-${i}`, i);
    expect(world.provider.placedCalls).toHaveLength(3);
    expect(platformMarkers()).toEqual([]);
    expect(world.limits.counters.get('hlc#cap#g#2026-10-19')).toBe(3);
  });

  it('ignores an invalid env value (default 300 applies): nothing is refused', async () => {
    process.env.HOT_LEAD_CALL_PLATFORM_DAILY_MAX = 'lots';
    for (let i = 1; i <= 3; i++) await submitAt(DAY1(40 + i * 3), `lead-${i}`, i);
    expect(world.provider.placedCalls).toHaveLength(3);
  });
});
