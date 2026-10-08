/**
 * ENG-2309 T3 — behavioural contract: forward-lead's session path must converge on the TRUE latest
 * funnel state / click data whatever order a visitor's events arrive in.
 *
 * `fakeRow` re-implements, in memory, only the documented semantics of crmDb.mergeSessionLeadEvent
 * (last-write-wins scalars; each guarded group applied iff its stored counter is absent / non-numeric /
 * <= the incoming one). The exact DynamoDB request shapes are pinned in crmDb.mergeSessionLeadEvent.test.ts
 * and the real-service behaviour was proved against dynamodb-local (see the PR).
 */
jest.mock('../services/db', () => ({ crmDb: { createLead: jest.fn(), mergeSessionLeadEvent: jest.fn() } }));

import { crmDb } from '../services/db';
import { upsertSessionLead } from '../services/sessionUpsertService';

const identity = { sessionId: 'abcd1234-ef56-7890', sessionStartMs: 1_780_000_000_000 };

let row: Record<string, any> | null;
function fakeRow() {
  row = null;
  (crmDb.createLead as jest.Mock).mockImplementation(async (_l: string, d: any) => {
    if (row) throw Object.assign(new Error('exists'), { leadAlreadyExists: true });
    row = { ...d.customFields };
    return d;
  });
  (crmDb.mergeSessionLeadEvent as jest.Mock).mockImplementation(async (_l: string, _id: string, plan: any) => {
    Object.assign(row!, plan.customFields);
    const groups = plan.monotonic ? (Array.isArray(plan.monotonic) ? plan.monotonic : [plan.monotonic]) : [];
    for (const g of groups) {
      const stored = row![g.counterKey];
      if (stored === undefined || typeof stored !== 'number' || stored <= g.counter) Object.assign(row!, g.fields);
    }
    return { exists: true, changed: true, guardApplied: true };
  });
}

/** One DramaBreak-shaped flat event: progress fields on every event, click fields only on clicks. */
const ev = (eventCount: number | string, stage: string, extra: Record<string, any> = {}) => ({
  sessionId: identity.sessionId, eventCount, journey: `j${eventCount}`, lastEvent: stage, furthestStage: stage,
  [`${stage}_at`]: `t${eventCount}`, ...extra,
});
const send = (customFields: Record<string, any>) => upsertSessionLead({
  listId: 'L1', identity, customFields, callerSuppliedSource: false,
  leadData: { firstName: '', lastName: '', phone: '', company: '', title: '', notes: '', customFields },
});

beforeEach(() => { jest.clearAllMocks(); fakeRow(); });

describe('forward-lead session path: out-of-order delivery', () => {
  it('(a) furthestStage / lastEvent / lastEp follow eventCount, not arrival order', async () => {
    await send(ev(3, 'app_cta_click', { lastEp: 7 }));
    await send(ev(2, 'play_start', { lastEp: 5 }));
    await send(ev(1, 'lp_view', { lastEp: 1 }));
    expect(row).toMatchObject({ eventCount: 3, journey: 'j3', furthestStage: 'app_cta_click', lastEvent: 'app_cta_click', lastEp: 7 });
    // per-event scalars are still key-union / last-write-wins
    expect(row).toMatchObject({ lp_view_at: 't1', play_start_at: 't2', app_cta_click_at: 't3' });
  });

  it('(b) a click event overtaken by a later NON-click event keeps its click data', async () => {
    await send(ev(1, 'lp_view'));
    await send(ev(3, 'page_exit', { dwellSec: 40 })); // newer, but carries no click fields
    await send(ev(2, 'app_cta_click', {
      clickCount: 1, clickLog: ['cta'], showsClicked: ['s1'], lastClickLabel: 'Play', lastClickShow: 's1',
      lastClickSection: 'hero', lastClickUrl: 'https://x/y',
    }));
    expect(row).toMatchObject({
      eventCount: 3, lastEvent: 'page_exit', clickCount: 1, clickLog: ['cta'], showsClicked: ['s1'],
      lastClickLabel: 'Play', lastClickShow: 's1', lastClickSection: 'hero', lastClickUrl: 'https://x/y',
    });
  });

  it('clicks are ordered by clickCount: an older click arriving late does not regress the click data', async () => {
    await send(ev(5, 'app_cta_click', { clickCount: 2, clickLog: ['a', 'b'], lastClickLabel: 'B' }));
    await send(ev(4, 'app_cta_click', { clickCount: 1, clickLog: ['a'], lastClickLabel: 'A' }));
    expect(row).toMatchObject({ clickCount: 2, clickLog: ['a', 'b'], lastClickLabel: 'B', eventCount: 5 });
  });

  it('digit-string counters are coerced for BOTH groups, so the guards compare numerically', async () => {
    await send(ev('3', 'app_cta_click', { clickCount: '2', clickLog: ['a', 'b'] }));
    await send(ev('2', 'play_start', { clickCount: '1', clickLog: ['a'] }));
    expect(row).toMatchObject({ eventCount: 3, clickCount: 2, clickLog: ['a', 'b'], furthestStage: 'app_cta_click' });
    expect(typeof row!.clickCount).toBe('number');
  });

  it('(iv) an event with no counters (page_exit) still merges its scalars and never regresses a group', async () => {
    await send(ev(3, 'app_cta_click'));
    await send({ sessionId: identity.sessionId, dwellSec: 55, page_exit_at: 'tx' });
    expect(row).toMatchObject({ dwellSec: 55, page_exit_at: 'tx', eventCount: 3, furthestStage: 'app_cta_click' });
  });

  it('a group with no usable counter degrades to last-write-wins instead of being dropped', async () => {
    await send(ev(3, 'play_start'));
    await send({ sessionId: identity.sessionId, furthestStage: 'x', clickLog: ['z'], clickCount: 'n/a' });
    expect(row).toMatchObject({ furthestStage: 'x', clickLog: ['z'] });
  });
});
