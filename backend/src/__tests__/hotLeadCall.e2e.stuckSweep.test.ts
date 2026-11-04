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

  it('the summary line is an error when something failed, and never carries a phone number', async () => {
    await ringing();
    advanceMinutes(20);
    world.provider.failNextFetchCall('unknown');
    await runStuckCallSweepCron();
    const errors = (console.error as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(errors).toContain('stuck call sweep completed with failures');
  });
});
