/**
 * A store write that commits and then reports an error (a timeout after the commit), or fails before it applies,
 * at every single write of a hot-lead call (ENG-2271): the record must end terminal (after the Twilio redeliveries a
 * 5xx asks for), and no member is ever rung twice. The real orchestrator, webhooks and store run on the in-memory
 * crm; only the write under test is made to fail.
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));

import * as fs from 'fs';
import * as queue from '../services/asyncJobQueue';
import { eventsOf, flush, installWorld, nthCall, recordOf, setClock, submitLead, usageSummary, world } from './helpers/hotLeadCallE2eWorld';
import { referenceTeam } from './helpers/hotLeadCallFixtures';

installWorld();
const chicago = (hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 19, h + 5, m)).toISOString();
};
const rung = () => world.provider.placedCalls.map((p) => p.to);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rec = (id = 'lead-a') => recordOf(id) as Record<string, any>;
beforeEach(() => {
  jest.mocked(queue.markJobFailed).mockResolvedValue(undefined);
  jest.mocked(queue.markJobComplete).mockResolvedValue(undefined);
  const org = world.crm.orgs.get('org-a') as { hotLeadCall: Record<string, unknown> };
  org.hotLeadCall = { ...org.hotLeadCall, team: referenceTeam(), maxAttemptsPerLead: 3, callingHours: { start: '09:00', end: '18:00', timezone: 'America/Chicago' } };
});

/* ---------- S6: a store failure at every single write of the whole chain ---------- */
type Mode = 'before' | 'after';
const OUT = process.env.WRITE_FAILURE_LOG ?? '/dev/null';
const TARGETS: Array<[string, number]> = [['updateLeadSystemRecordIf', 30], ['createLeadSystemRecordOnce', 2], ['addLeadEngagement', 16]];

function arm(target: string, nth: number, mode: Mode): () => boolean {
  const crm = world.crm.crmDb as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const orig = crm[target].bind(world.crm.crmDb);
  let n = 0; let fired = false;
  crm[target] = async (...a: unknown[]) => {
    n++;
    if (n === nth) { fired = true; if (mode === 'before') throw new Error('injected'); await orig(...a); throw new Error('injected'); }
    return orig(...a);
  };
  return () => fired;
}

const retrying = async (f: () => Promise<{ status: number }>) => { for (let t = 0; t < 3; t++) { let r: { status: number }; try { r = await f(); } catch { return; } await flush(); if (r.status !== 500) return; } };
const noAnswerChain = async () => {
  const done = new Set<number>();
  for (let round = 0; round < 8; round++) {
    let progressed = false;
    for (let n = 1; n <= world.provider.placedCalls.length; n++) {
      if (done.has(n)) continue; done.add(n); progressed = true;
      await retrying(() => nthCall(n).memberLegEnds('no-answer', '0'));
    }
    await flush();
    if (!progressed) break;
  }
};
const scripts: Record<string, () => Promise<void>> = {
  noAnswerChain,
  declineChain: async () => {
    let call: ReturnType<typeof nthCall> | undefined;
    try { call = nthCall(1); await call.memberAnswers(); await call.memberPresses('2'); } catch { /* part of the scenario */ }
    if (call) { const c = call; await retrying(() => c.memberLegEnds('completed', '9')); }
    await noAnswerChain();
  },
  connectChain: async () => {
    let call: ReturnType<typeof nthCall> | undefined;
    try {
      call = nthCall(1);
      await call.memberAnswers(); await call.memberPresses('1'); await call.leadStatus('in-progress', 2);
      await call.leadAnswers(); await call.leadPresses('1'); await call.dialEnds('completed');
    } catch { /* part of the scenario */ }
    if (call) { const c = call; await retrying(() => c.leadStatus('completed', 3, { CallDuration: '60' })); await retrying(() => c.memberLegEnds('completed', '90')); }
    await noAnswerChain();
  },
};

for (const scriptName of Object.keys(scripts)) {
  describe(`S6 ${scriptName}`, () => {
    for (const [target, max] of TARGETS) {
      for (const mode of ['before', 'after'] as Mode[]) {
        for (let nth = 1; nth <= max; nth++) {
          it(`${target} #${nth} ${mode}`, async () => {
            setClock(chicago('16:00'));
            const fired = arm(target, nth, mode);
            await submitLead('lead-a');
            await scripts[scriptName]();
            if (!fired()) return;
            const r = rec();
            const to = rung();
            const events = eventsOf('lead-a');
            const dupMembers = new Set(to).size !== to.length;
            const stuck = !r || !['finished', 'failed', 'skipped'].includes(r.state);
            const metered = (r?.meteredLegs ?? []).length;
            const verdict = `${scriptName}|${target}#${nth}|${mode}|state=${r?.state}|outcome=${r?.outcome}|attempt=${r?.attemptNo}|rung=${to.length}|dupMember=${dupMembers}|metered=${metered}|usage=${usageSummary().length}|stuck=${stuck}|events=${events.join(',')}`;
            fs.appendFileSync(OUT, verdict + '\n');
            expect(to.length).toBeLessThanOrEqual(3);
            expect(dupMembers).toBe(false);
            // No record at all is fine (a failed create refunds the slot and a later submission can try again); a
            // record that exists must have reached an end.
            expect(r === undefined || !stuck).toBe(true);
          });
        }
      }
    }
  });
}


describe('a write that committed and then reported an error does not strand the call', () => {
  it('first attempt: the record create commits, the call is still placed once and the slots are kept', async () => {
    setClock(chicago('16:00'));
    arm('createLeadSystemRecordOnce', 1, 'after');
    await submitLead('lead-a');
    expect(rung()).toHaveLength(1);
    expect(rec()).toMatchObject({ state: 'member_ringing', attemptNo: 1 });
    expect([...world.limits.claims.keys()].filter((k) => k.startsWith('hlc#phone#'))).toHaveLength(1);
  });

  it('next attempt: the between_attempts -> dialing lock commits, the next member is still rung once', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    arm('updateLeadSystemRecordIf', 3, 'after'); // 1 = ringing, 2 = ended, 3 = the lock
    await nthCall(1).memberLegEnds('no-answer', '0');
    await flush();
    expect(rung()).toHaveLength(2);
    expect(rec()).toMatchObject({ state: 'member_ringing', attemptNo: 2 });
  });

  it('/gather: the bridging transition commits, the lead is still dialled once and the record is not left bridging with no lead leg', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    arm('updateLeadSystemRecordIf', 1, 'after');
    const reply = await call.memberPresses('1');
    expect(reply.body).toContain('<Dial');
    expect(rec()).toMatchObject({ state: 'bridging' });
  });

  it('/gather: a bridging transition that did not apply hangs up and leaves the member leg to hand over', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    arm('updateLeadSystemRecordIf', 1, 'before');
    expect((await call.memberPresses('1')).body).not.toContain('<Dial');
    await call.memberLegEnds('completed', '8');
    await flush();
    expect(rec()).toMatchObject({ state: 'member_ringing', attemptNo: 2 });
    expect(rung()).toHaveLength(2);
  });
});
