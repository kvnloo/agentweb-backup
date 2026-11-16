/**
 * Hot-lead call stuck-record sweep, end to end (ENG-2271): real orchestrator, webhooks, store, metering and sweep on the
 * in-memory CRM; only Twilio, DynamoDB, the queue, Slack and the usage ledger are faked. A stuck record is made the way
 * production makes one: the call is driven up to some step and the final status callbacks never arrive.
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
import { runStuckCallSweep } from '../services/voice/stuckCallSweep';
import { getLeadCallStore } from '../services/voice/leadCallStore';
import { meterLeg } from '../services/voice/callFinalisation';
import { runStuckCallSweepCron } from '../cron/stuckCallSweepCron';
import { LIST, advanceMinutes, eventsOf, installWorld, mock, placedCall, record, recordOf, submitLead, twilioCall, usageSummary, world } from './helpers/hotLeadCallE2eWorld';
import { callRecord } from './helpers/hotLeadCallFixtures';

installWorld();

const MEMBER = 'CA00000001';
const LEAD = 'CA00000002';
const ENV = 'HOT_LEAD_CALL_STUCK_SWEEP';

beforeEach(() => { process.env[ENV] = 'close'; });
afterEach(() => { delete process.env[ENV]; });

const snapshot = () => JSON.stringify([...world.crm.leads.values()]);
const nextJobs = () => mock(queue.enqueueJob).mock.calls.filter(([source]) => source === 'hot_lead_call_next');
const sweep = () => runStuckCallSweep(new Date());
/** The call is placed and rings; no callback ever follows. */
async function ringing() {
  await submitLead('lead-a');
  return twilioCall(placedCall());
}
/** Member and lead are bridged; neither final callback ever arrives. */
async function bridged() {
  const call = await ringing();
  await call.memberAnswers();
  await call.memberPresses('1');
  await call.leadStatus('in-progress', 2);
  await call.leadAnswers();
  await call.leadPresses('1');
  return call;
}

describe('stuck member_ringing', () => {
  it('Twilio says nobody answered: finished as member_no_answer, nothing billed, nobody else is rung', async () => {
    await ringing();
    advanceMinutes(20);
    world.provider.setCall(MEMBER, { status: 'no-answer' });
    const placed = world.provider.placedCalls.length;

    expect(await sweep()).toMatchObject({ mode: 'close', found: 1, closed: 1, failed: 0 });
    expect(record()).toMatchObject({ state: 'finished', outcome: 'member_no_answer', meteredLegs: ['member:1'] });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_no_answer', 'call.completed']);
    expect(usageSummary()).toEqual([]);
    expect(world.provider.placedCalls).toHaveLength(placed);
    expect(nextJobs()).toHaveLength(0);
  });

  it('a call that did connect is billed from its duration, once', async () => {
    await ringing();
    advanceMinutes(20);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 61 });
    await sweep();
    expect(usageSummary()).toEqual([[`twilio:voice:${MEMBER}:member`, 2]]);
  });

  it('Twilio says the call is still live: untouched', async () => {
    await ringing();
    advanceMinutes(20);
    world.provider.setCall(MEMBER, { status: 'in-progress' });
    const before = snapshot();
    expect(await sweep()).toMatchObject({ found: 1, stillLive: 1, closed: 0 });
    expect(snapshot()).toBe(before);
  });

  it('a record younger than its threshold is not even looked at', async () => {
    await ringing();
    advanceMinutes(5);
    expect(await sweep()).toMatchObject({ found: 0, notStuck: 0 });
    expect(world.provider.fetchedSids).toEqual([]);
  });
});

describe('stuck bridged calls', () => {
  it('connected, both legs ended: both billed, finished as completed', async () => {
    await bridged();
    advanceMinutes(60);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 90 });
    world.provider.setCall(LEAD, { status: 'completed', durationSeconds: 60 });

    expect(await sweep()).toMatchObject({ found: 1, closed: 1 });
    expect(record()).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.connected', 'call.completed']);
    expect(usageSummary()).toEqual([[`twilio:voice:${MEMBER}:member`, 2], [`twilio:voice:${LEAD}:lead`, 1]]);
  });

  it('connected for less than the bridged-call limit is live: untouched, Twilio not asked', async () => {
    await bridged();
    advanceMinutes(30);
    expect(await sweep()).toMatchObject({ notStuck: 1, closed: 0 });
    expect(world.provider.fetchedSids).toEqual([]);
  });

  it('a lead leg still live keeps the record, even though the member leg ended', async () => {
    await bridged();
    advanceMinutes(60);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 90 });
    world.provider.setCall(LEAD, { status: 'in-progress' });
    const before = snapshot();
    expect(await sweep()).toMatchObject({ stillLive: 1, closed: 0 });
    expect(snapshot()).toBe(before);
    expect(usageSummary()).toEqual([]);
  });

  it('bridging with no /dial result ends as bridge_unconfirmed', async () => {
    const call = await ringing();
    await call.memberAnswers();
    await call.memberPresses('1');
    await call.leadStatus('in-progress', 2);
    expect(record()).toMatchObject({ state: 'bridging', leadCallSid: LEAD });
    advanceMinutes(60);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 30 });
    world.provider.setCall(LEAD, { status: 'no-answer' });
    await sweep();
    expect(record()).toMatchObject({ state: 'finished', outcome: 'bridge_unconfirmed' });
    expect(usageSummary()).toEqual([[`twilio:voice:${MEMBER}:member`, 1]]);
  });

  it('bridging whose lead call was never recorded is left for a human', async () => {
    const call = await ringing();
    await call.memberAnswers();
    await call.memberPresses('1');
    advanceMinutes(60);
    const before = snapshot();
    expect(await sweep()).toMatchObject({ found: 1, needsHuman: 1, closed: 0 });
    expect(snapshot()).toBe(before);
    expect(world.provider.fetchedSids).toEqual([]);
  });

  it('an ended call with no duration cannot be billed: nothing is changed', async () => {
    await bridged();
    advanceMinutes(60);
    world.provider.setCall(MEMBER, { status: 'completed' });
    world.provider.setCall(LEAD, { status: 'completed', durationSeconds: 60 });
    const before = snapshot();
    expect(await sweep()).toMatchObject({ needsHuman: 1, closed: 0 });
    expect(snapshot()).toBe(before);
    expect(usageSummary()).toEqual([]);
  });
});

describe('records with nothing to ask Twilio', () => {
  it('dialing after an ambiguous placement is left for a human, and nobody is dialed', async () => {
    world.provider.failNextPlaceCall('unknown');
    await submitLead('lead-a');
    expect(record()).toMatchObject({ state: 'dialing', outcome: 'placement_unknown' });
    advanceMinutes(20);
    const before = snapshot();
    const placed = world.provider.placedCalls.length;
    expect(await sweep()).toMatchObject({ found: 1, needsHuman: 1, closed: 0 });
    expect(snapshot()).toBe(before);
    expect(world.provider.placedCalls).toHaveLength(placed);
  });

  it('between_attempts that nothing moved on is closed as next_attempt_failed, with no dial', async () => {
    world.crm.addLead({ listId: LIST, leadId: 'lead-b' });
    const old = new Date(Date.now() - 80 * 60_000).toISOString();
    world.crm.lead(LIST, 'lead-b').system = {
      hot_lead_call: callRecord({ state: 'between_attempts', outcome: 'member_declined', startedAt: old, updatedAt: old, meteredLegs: ['member:1'], lastSequence: {}, memberCallSid: MEMBER }),
    };
    expect(await sweep()).toMatchObject({ found: 1, closed: 1 });
    expect(recordOf('lead-b')).toMatchObject({ state: 'failed', outcome: 'next_attempt_failed' });
    expect(eventsOf('lead-b')).toEqual(['call.failed']);
    expect(world.provider.placedCalls).toHaveLength(0);
    expect(world.provider.fetchedSids).toEqual([]);
    expect(nextJobs()).toHaveLength(0);
  });

  it('between_attempts inside the lead-age window is left to its job', async () => {
    world.crm.addLead({ listId: LIST, leadId: 'lead-b' });
    const recent = new Date(Date.now() - 30 * 60_000).toISOString();
    world.crm.lead(LIST, 'lead-b').system = { hot_lead_call: callRecord({ state: 'between_attempts', startedAt: recent, updatedAt: recent }) };
    expect(await sweep()).toMatchObject({ notStuck: 1, closed: 0 });
  });
});

describe('which orgs are swept', () => {
  /** A connected call whose final callbacks never came, seeded on a list of org `id`. */
  function seedStuck(id: string, hotLeadCall?: Record<string, unknown>) {
    world.crm.addOrg({ orgId: id, ...(hotLeadCall ? { hotLeadCall } : {}) }, [{ userId: `owner-${id}` }], [{ listId: `list-${id}`, userId: `owner-${id}` }]);
    world.crm.addLead({ listId: `list-${id}`, leadId: 'lead-x' });
    const old = new Date(Date.now() - 120 * 60_000).toISOString();
    world.crm.lead(`list-${id}`, 'lead-x').system = {
      hot_lead_call: callRecord({ state: 'connected', startedAt: old, updatedAt: old, memberCallSid: `CAM${id}`, leadCallSid: `CAL${id}`, meteredLegs: [], lastSequence: {} }),
    };
    world.provider.setCall(`CAM${id}`, { status: 'completed', durationSeconds: 60 });
    world.provider.setCall(`CAL${id}`, { status: 'completed', durationSeconds: 60 });
  }
  // What releasing a number leaves behind: the config with calling off and the number fields removed.
  const released = { enabled: false, team: [], announcedName: 'Acme' };

  it('an org that released its number is reported in report-only mode and closed in close mode', async () => {
    seedStuck('org-r', released);
    process.env[ENV] = 'report';
    const before = snapshot();
    expect(await sweep()).toMatchObject({ found: 1, wouldClose: 1, closed: 0 });
    expect(snapshot()).toBe(before);

    process.env[ENV] = 'close';
    expect(await sweep()).toMatchObject({ found: 1, closed: 1 });
    expect(world.crm.lead('list-org-r', 'lead-x').system?.hot_lead_call).toMatchObject({ state: 'finished', outcome: 'completed' });
  });

  it('an org with no hot-lead attribute is not read or touched', async () => {
    seedStuck('org-n');
    const before = snapshot();
    expect(await sweep()).toMatchObject({ found: 0, closed: 0 });
    expect(snapshot()).toBe(before);
    expect(world.provider.fetchedSids).toEqual([]);
  });
});

describe('modes and safety', () => {
  it.each([undefined, 'report', 'yes'])('report-only (HOT_LEAD_CALL_STUCK_SWEEP=%s) writes nothing but still reads Twilio', async (value) => {
    if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
    await ringing();
    advanceMinutes(20);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 61 });
    const before = snapshot();
    expect(await sweep()).toMatchObject({ mode: 'report', found: 1, wouldClose: 1, closed: 0 });
    expect(world.provider.fetchedSids).toEqual([MEMBER]);
    expect(snapshot()).toBe(before);
    expect(usageSummary()).toEqual([]);
  });

  it('off does nothing at all', async () => {
    process.env[ENV] = 'off';
    await ringing();
    advanceMinutes(20);
    expect(await sweep()).toMatchObject({ mode: 'off', found: 0 });
    expect(world.crm.callsTo('findLeadsBySystemRecord')).toBe(0);
    expect(world.provider.fetchedSids).toEqual([]);
  });

  it('closes with the global kill switch off, and still dials nobody', async () => {
    await ringing();
    advanceMinutes(20);
    setHotLeadCallEnabledOverride(false);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 61 });
    const placed = world.provider.placedCalls.length;
    expect(await sweep()).toMatchObject({ closed: 1 });
    expect(record()).toMatchObject({ state: 'finished' });
    expect(usageSummary()).toEqual([[`twilio:voice:${MEMBER}:member`, 2]]);
    expect(world.provider.placedCalls).toHaveLength(placed);
  });

  it('a Twilio failure changes nothing and is counted', async () => {
    await bridged();
    advanceMinutes(60);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 90 });
    world.provider.failNextFetchCall('unknown', 'timeout');
    const before = snapshot();
    expect(await sweep()).toMatchObject({ found: 1, failed: 1, closed: 0 });
    expect(snapshot()).toBe(before);
    expect(usageSummary()).toEqual([]);
  });

  it('a second run, and a late real callback, change nothing and bill nothing again', async () => {
    const call = await bridged();
    advanceMinutes(60);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 90 });
    world.provider.setCall(LEAD, { status: 'completed', durationSeconds: 60 });
    await sweep();
    const settled = snapshot();
    const billed = usageSummary();

    expect(await sweep()).toMatchObject({ found: 0, closed: 0 });
    await call.leadStatus('completed', 3, { CallDuration: '60' });
    await call.memberLegEnds('completed', '90');
    expect(snapshot()).toBe(settled);
    expect(usageSummary()).toEqual(billed);
  });

  it('the summary line is an error when something failed, and no logged line carries a phone number', async () => {
    await ringing();
    advanceMinutes(20);
    world.provider.failNextFetchCall('unknown');
    await runStuckCallSweepCron();
    const errors = (console.error as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(errors).toContain('stuck call sweep completed with failures');
    const everything = world.consoleSpies.flatMap((spy) => spy.mock.calls.map((c) => JSON.stringify(c))).join('\n');
    expect(everything).not.toMatch(/\+\d{7,}|\(\d{3}\) ?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b/);
  });
});

// ── review round: races, caps, discovery, Twilio statuses ─────────────────────────────────────────────

/** Seeds a stuck record (written two hours ago) on a lead of `listId`. */
function seed(listId: string, leadId: string, over: Parameters<typeof callRecord>[0] = {}) {
  const old = new Date(Date.now() - 120 * 60_000).toISOString();
  if (!world.crm.hasLead(listId, leadId)) world.crm.addLead({ listId, leadId });
  world.crm.lead(listId, leadId).system = {
    hot_lead_call: callRecord({ state: 'connected', startedAt: old, updatedAt: old, memberCallSid: `CAM-${leadId}`, leadCallSid: `CAL-${leadId}`, meteredLegs: [], lastSequence: {}, ...over }),
  };
}
const endBoth = (leadId: string) => {
  world.provider.setCall(`CAM-${leadId}`, { status: 'completed', durationSeconds: 60 });
  world.provider.setCall(`CAL-${leadId}`, { status: 'completed', durationSeconds: 60 });
};
const stateOf = (leadId: string, listId = LIST) => (recordOf(leadId, listId) as { state: string; outcome?: string; attemptNo: number; meteredLegs: string[] });

describe('a record that moves on while the sweep works', () => {
  it('a late callback that starts attempt 2 after Twilio was asked: the sweep writes nothing and counts it as moved', async () => {
    await ringing();
    advanceMinutes(20);
    world.provider.setCall(MEMBER, { status: 'no-answer' });
    const fetch = world.provider.fetchCall.bind(world.provider);
    jest.spyOn(world.provider, 'fetchCall').mockImplementationOnce(async (sid) => {
      const store = getLeadCallStore();
      await store.transition(LIST, 'lead-a', ['member_ringing'], { state: 'between_attempts', outcome: 'member_no_answer', meteredLegs: ['member:1'], lastSequence: { [`${MEMBER}#ended`]: 1 } });
      await store.transition(LIST, 'lead-a', ['between_attempts'], { state: 'dialing', attemptNo: 2, memberId: 'mbbbbbbb', triedMemberIds: ['mbbbbbbb'], clear: ['memberCallSid', 'outcome'] });
      return fetch(sid);
    });
    expect(await sweep()).toMatchObject({ found: 1, moved: 1, closed: 0 });
    expect(stateOf('lead-a')).toMatchObject({ state: 'dialing', attemptNo: 2, meteredLegs: ['member:1'] });
    expect(usageSummary()).toEqual([]);
  });

  it('meterLeg with a sid that is no longer the record\'s writes and bills nothing (webhooks pass none and are unchanged)', async () => {
    await ringing();
    const result = await meterLeg({ q: { listId: LIST, leadId: 'lead-a', jobKey: record().jobKey as string, leg: 'member' }, callSid: 'CA-stale', sequence: undefined, durationSeconds: 120, expectSid: 'CA-stale' });
    expect(result).toEqual({ status: 'done' });
    expect(stateOf('lead-a').meteredLegs).toEqual([]);
    expect(usageSummary()).toEqual([]);
  });

  it('between_attempts that a job takes first is not closed: moved, the attempt guard holds', async () => {
    seed(LIST, 'lead-b', { state: 'between_attempts', outcome: 'member_declined', memberCallSid: undefined, leadCallSid: undefined, meteredLegs: ['member:1'] });
    const read = world.crm.crmDb.getLeadById;
    let reads = 0;
    jest.spyOn(world.crm.crmDb, 'getLeadById').mockImplementation(async (listId: string, leadId: string) => {
      const lead = await read(listId, leadId);
      // The job locks the record for attempt 2 right after the sweep's second (pre-write) read.
      if (++reads === 2) Object.assign(world.crm.lead(listId, leadId).system?.hot_lead_call as object, { state: 'dialing', attemptNo: 2 });
      return lead;
    });
    expect(await sweep()).toMatchObject({ found: 1, moved: 1, closed: 0 });
    expect(stateOf('lead-b')).toMatchObject({ state: 'dialing', attemptNo: 2 });
    expect(eventsOf('lead-b')).toEqual([]);
  });

  it('a lead deleted between discovery and the re-read is not stuck', async () => {
    seed(LIST, 'lead-b');
    jest.spyOn(world.crm.crmDb, 'getLeadById').mockResolvedValueOnce(undefined as never);
    expect(await sweep()).toMatchObject({ found: 1, notStuck: 1, closed: 0 });
  });
});

describe('caps', () => {
  it('writes are capped at 50 per run; the rest wait and truncated says so', async () => {
    for (let i = 0; i < 51; i++) { seed(LIST, `lead-${String(i).padStart(2, '0')}`); endBoth(`lead-${String(i).padStart(2, '0')}`); }
    expect(await sweep()).toMatchObject({ found: 51, closed: 50, truncated: true });
    expect(await sweep()).toMatchObject({ found: 1, closed: 1, truncated: false });
  });

  it('records left for a human do not use up the cap', async () => {
    for (let i = 0; i < 60; i++) seed(LIST, `lead-h${String(i).padStart(2, '0')}`, { state: 'dialing', memberCallSid: undefined, leadCallSid: undefined });
    for (let i = 0; i < 3; i++) { seed(LIST, `lead-w${i}`); endBoth(`lead-w${i}`); }
    expect(await sweep()).toMatchObject({ found: 63, needsHuman: 60, closed: 3, truncated: false });
  });

  it('at most 200 records are handled per run, whatever they came to', async () => {
    for (let i = 0; i < 201; i++) seed(LIST, `lead-${String(i).padStart(3, '0')}`, { state: 'dialing', memberCallSid: undefined, leadCallSid: undefined });
    expect(await sweep()).toMatchObject({ found: 201, needsHuman: 200, truncated: true });
  });

  it('a list is read for at most 500 leads: an older stuck record is not seen and truncated says so', async () => {
    for (let i = 0; i < 500; i++) world.crm.addLead({ listId: LIST, leadId: `lead-9${String(i).padStart(3, '0')}` });
    seed(LIST, 'lead-0000'); // the oldest of 501
    expect(await sweep()).toMatchObject({ found: 0, leadsRead: 500, truncated: true });
  });

  it('a run reads at most 10,000 leads: the next list is not started', async () => {
    const lists = Array.from({ length: 21 }, (_, i) => ({ listId: `big-${i}`, userId: 'owner-big' }));
    world.crm.addOrg({ orgId: 'org-big', hotLeadCall: { enabled: false } }, [{ userId: 'owner-big' }], lists);
    for (const { listId } of lists) for (let i = 0; i < 500; i++) world.crm.addLead({ listId, leadId: `lead-${i}` });
    // LIST (empty) plus 20 big lists use the 10,000; the 21st big list is not started.
    expect(await sweep()).toMatchObject({ leadsRead: 10_000, lists: 21, truncated: true });
  });
});

describe('discovery', () => {
  it('an org with members but no lists, and a session list, give nothing and cost no lead reads', async () => {
    world.crm.addOrg({ orgId: 'org-empty', hotLeadCall: { enabled: false } }, [{ userId: 'owner-empty' }], []);
    world.crm.lists.set('list-session', { listId: 'list-session', userId: 'owner-a', listType: 'session' });
    seed('list-session', 'lead-s');
    const summary = await sweep();
    expect(summary).toMatchObject({ orgs: 2, lists: 1, found: 0 });
    expect(world.crm.callsTo('findLeadsBySystemRecord')).toBe(1); // only LIST
  });

  it('a list returned for two members is read once', async () => {
    world.crm.users.set('owner-a2', { userId: 'owner-a2', orgId: 'org-a' });
    seed(LIST, 'lead-b'); endBoth('lead-b');
    const lists = world.crm.crmDb.getLeadListsByUserId;
    jest.spyOn(world.crm.crmDb, 'getLeadListsByUserId').mockImplementation(async () => lists('owner-a'));
    expect(await sweep()).toMatchObject({ lists: 1, found: 1, closed: 1 });
    expect(world.crm.callsTo('findLeadsBySystemRecord')).toBe(1);
  });

  it('one org failing to read does not stop the next, and is counted', async () => {
    world.crm.addOrg({ orgId: 'org-z', hotLeadCall: { enabled: false } }, [{ userId: 'owner-z' }], [{ listId: 'list-z', userId: 'owner-z' }]);
    seed('list-z', 'lead-z'); endBoth('lead-z');
    jest.spyOn(world.crm.orgDb, 'getOrgMembers').mockRejectedValueOnce(new Error('throttled'));
    expect(await sweep()).toMatchObject({ orgs: 2, failed: 1, closed: 1 });
    expect(stateOf('lead-z', 'list-z').state).toBe('finished');
  });

  it('the org list failing is counted, not thrown', async () => {
    jest.spyOn(world.crm.orgDb, 'listHotLeadCallOrgIds').mockRejectedValueOnce(new Error('scan failed'));
    expect(await sweep()).toMatchObject({ orgs: 0, failed: 1 });
  });
});

describe('what Twilio says', () => {
  it.each(['queued', 'ringing', 'in-progress', 'some-new-status'])('%s on the member leg: live, untouched', async (status) => {
    await ringing();
    advanceMinutes(20);
    world.provider.setCall(MEMBER, { status });
    const before = snapshot();
    expect(await sweep()).toMatchObject({ stillLive: 1, closed: 0 });
    expect(snapshot()).toBe(before);
  });

  it.each(['queued', 'ringing'])('%s on the lead leg with the member leg ended: live, nothing written', async (status) => {
    await bridged();
    advanceMinutes(60);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 90 });
    world.provider.setCall(LEAD, { status });
    const before = snapshot();
    expect(await sweep()).toMatchObject({ stillLive: 1, closed: 0 });
    expect(snapshot()).toBe(before);
  });

  it('the lead leg ended while the member leg is live: nothing written, nothing billed', async () => {
    await bridged();
    advanceMinutes(60);
    world.provider.setCall(LEAD, { status: 'completed', durationSeconds: 60 });
    world.provider.setCall(MEMBER, { status: 'in-progress' });
    const before = snapshot();
    expect(await sweep()).toMatchObject({ stillLive: 1, closed: 0 });
    expect(snapshot()).toBe(before);
    expect(usageSummary()).toEqual([]);
  });

  it.each(['busy', 'failed', 'canceled'])('%s with no duration bills 0 on the member leg', async (status) => {
    await ringing();
    advanceMinutes(20);
    world.provider.setCall(MEMBER, { status });
    expect(await sweep()).toMatchObject({ closed: 1 });
    expect(usageSummary()).toEqual([]);
  });

  it.each(['busy', 'failed', 'canceled'])('%s with no duration bills 0 on the lead leg; the member leg is still billed', async (status) => {
    await bridged();
    advanceMinutes(60);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 61 });
    world.provider.setCall(LEAD, { status });
    expect(await sweep()).toMatchObject({ closed: 1 });
    expect(usageSummary()).toEqual([[`twilio:voice:${MEMBER}:member`, 2]]);
  });

  it('completed with no duration on the LEAD leg is for a human, and the member leg is not billed either', async () => {
    await bridged();
    advanceMinutes(60);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 90 });
    world.provider.setCall(LEAD, { status: 'completed' });
    const before = snapshot();
    expect(await sweep()).toMatchObject({ needsHuman: 1, closed: 0 });
    expect(snapshot()).toBe(before);
    expect(usageSummary()).toEqual([]);
  });

  it('completed after 0 seconds closes the record and records no usage event', async () => {
    await ringing();
    advanceMinutes(20);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 0 });
    expect(await sweep()).toMatchObject({ closed: 1 });
    expect(usageSummary()).toEqual([]);
  });

  it('a call Twilio has no record of (404) is for a human, not a failure, and the summary stays info', async () => {
    await ringing();
    advanceMinutes(20); // no setCall: the fake answers 404
    const before = snapshot();
    expect(await sweep()).toMatchObject({ needsHuman: 1, failed: 0, closed: 0 });
    expect(snapshot()).toBe(before);
    await runStuckCallSweepCron();
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('completed with failures'), expect.anything());
  });

  it('other Twilio errors stay failures', async () => {
    await ringing();
    advanceMinutes(20);
    world.provider.failNextFetchCall('no', 'rate limited', 429);
    expect(await sweep()).toMatchObject({ failed: 1, needsHuman: 0 });
  });
});

describe('outcomes of settled records', () => {
  it('a stuck member_answered record (prompt never answered) ends as member_declined, with its event, billed for the minutes', async () => {
    const call = await ringing();
    await call.memberAnswers();
    advanceMinutes(20);
    world.provider.setCall(MEMBER, { status: 'completed', durationSeconds: 15 });
    expect(await sweep()).toMatchObject({ closed: 1 });
    expect(stateOf('lead-a')).toMatchObject({ state: 'finished', outcome: 'member_declined' });
    expect(eventsOf('lead-a')).toEqual(['call.initiated', 'call.member_answered', 'call.member_declined', 'call.completed']);
    expect(usageSummary()).toEqual([[`twilio:voice:${MEMBER}:member`, 1]]);
  });

  it('a stuck second attempt that ended unanswered finishes as no_member_available, and nobody else is rung', async () => {
    seed(LIST, 'lead-b', { state: 'member_ringing', attemptNo: 2, triedMemberIds: ['maaaaaaa', 'mbbbbbbb'], leadCallSid: undefined, meteredLegs: ['member:1'] });
    world.provider.setCall('CAM-lead-b', { status: 'no-answer' });
    expect(await sweep()).toMatchObject({ closed: 1 });
    expect(stateOf('lead-b')).toMatchObject({ state: 'finished', outcome: 'no_member_available' });
    expect(eventsOf('lead-b')).toEqual(['call.member_no_answer', 'call.completed']);
    expect(world.provider.placedCalls).toHaveLength(0);
    expect(nextJobs()).toHaveLength(0);
  });

  it('a record whose legs are all metered only needs its finish, and Twilio is not asked', async () => {
    seed(LIST, 'lead-b', { meteredLegs: ['member:1', 'lead'] });
    expect(await sweep()).toMatchObject({ closed: 1 });
    expect(stateOf('lead-b')).toMatchObject({ state: 'finished', outcome: 'completed' });
    expect(world.provider.fetchedSids).toEqual([]);
  });
});
