/**
 * A store write that fails before it applies, commits and then reports an error (a timeout after the commit), or
 * commits and then reports that it lost (the SDK retried it after losing the response), at every single write of a
 * hot-lead call: the record must end terminal (after the Twilio redeliveries a
 * 5xx asks for), and no member is ever rung twice. The real orchestrator, webhooks and store run on the in-memory
 * crm; only the write under test is made to fail.
 */
jest.mock('../services/db', () => ({ ENGAGED_EVENT_KEYWORDS: jest.requireActual('../services/db').ENGAGED_EVENT_KEYWORDS, ...jest.requireActual('./helpers/hotLeadCallFakeCrm').dbMock }));
jest.mock('../services/asyncJobQueue', () => ({
  enqueueJob: jest.fn(), markJobComplete: jest.fn(), markJobFailed: jest.fn(), startHeartbeat: jest.fn(), registerProcessor: jest.fn(), clearFailedJob: jest.fn(),
}));
jest.mock('../services/usageRecorderService', () => ({ ...jest.requireActual('../services/usageRecorderService'), recordVendorUsage: jest.fn() }));
jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
jest.mock('@slack/web-api', () => ({ WebClient: jest.fn() }));

import * as queue from '../services/asyncJobQueue';
import { chicago, flush, installWorld, nthCall, record, rungPhones, setClock, submitLead, usageSummary, world } from './helpers/hotLeadCallE2eWorld';
import { REFERENCE_ID as ID, REFERENCE_PHONE as PHONE, referenceTeam } from './helpers/hotLeadCallFixtures';

installWorld();
beforeEach(() => {
  const org = world.crm.orgs.get('org-a') as { hotLeadCall: Record<string, unknown> };
  org.hotLeadCall = { ...org.hotLeadCall, team: referenceTeam(), maxAttemptsPerLead: 3, callingHours: { start: '09:00', end: '18:00', timezone: 'America/Chicago' } };
});

type Mode = 'before' | 'after' | 'afterFalse';
type Target = 'updateLeadSystemRecordIf' | 'createLeadSystemRecordOnce' | 'addLeadEngagement';
type Writer = (...args: unknown[]) => Promise<unknown>;
const writers = () => world.crm.crmDb as unknown as Record<Target, Writer>;

/**
 * Makes the nth call of a store write fail: `before` throws without writing, `after` writes and then throws,
 * `afterFalse` writes and then answers false (a conditional write that lost to its own first try). Returns whether it fired.
 */
function arm(target: Target, nth: number, mode: Mode): () => boolean {
  const original = writers()[target].bind(world.crm.crmDb);
  let calls = 0;
  let fired = false;
  writers()[target] = async (...args) => {
    calls++;
    if (calls !== nth) return original(...args);
    fired = true;
    if (mode === 'before') throw new Error('injected');
    await original(...args);
    if (mode === 'after') throw new Error('injected');
    return false;
  };
  return () => fired;
}

/** Counts the calls of every store write while a script runs unharmed. */
function countWrites(): () => Record<Target, number> {
  const counts: Record<Target, number> = { updateLeadSystemRecordIf: 0, createLeadSystemRecordOnce: 0, addLeadEngagement: 0 };
  for (const target of Object.keys(counts) as Target[]) {
    const original = writers()[target].bind(world.crm.crmDb);
    writers()[target] = async (...args) => { counts[target]++; return original(...args); };
  }
  return () => counts;
}

/** Sends a webhook, and sends it again (as Twilio does for a 5xx) until it is answered. */
const retrying = async (send: () => Promise<{ status: number }>): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await send();
    await flush();
    if (reply.status !== 500) return;
  }
};

const noAnswerChain = async (): Promise<void> => {
  const done = new Set<number>();
  for (let round = 0; round < 8 && done.size < world.provider.placedCalls.length; round++) {
    for (let n = 1; n <= world.provider.placedCalls.length; n++) {
      if (done.has(n)) continue;
      done.add(n);
      await retrying(() => nthCall(n).memberLegEnds('no-answer', '0'));
    }
    await flush();
  }
};

const scripts = {
  noAnswerChain,
  declineChain: async (): Promise<void> => {
    if (world.provider.placedCalls.length > 0) {
      const call = nthCall(1);
      // A prompt that was not served (the call was aborted) leaves nothing to press.
      if ((await call.memberAnswers()).body.includes('<Gather')) await call.memberPresses('2');
      await retrying(() => call.memberLegEnds('completed', '9'));
    }
    await noAnswerChain();
  },
  connectChain: async (): Promise<void> => {
    if (world.provider.placedCalls.length > 0) {
      const call = nthCall(1);
      let dialled = false;
      if ((await call.memberAnswers()).body.includes('<Gather')) {
        // Each step is only taken when the one before it asked for it: no Dial means no lead leg to play.
        dialled = (await call.memberPresses('1')).body.includes('<Dial');
      }
      if (dialled) {
        await call.leadStatus('in-progress', 2);
        if ((await call.leadAnswers()).body.includes('<Gather')) await call.leadPresses('1');
        await call.dialEnds('completed');
        await retrying(() => call.leadStatus('completed', 3, { CallDuration: '60' }));
      }
      await retrying(() => call.memberLegEnds('completed', '90'));
    }
    await noAnswerChain();
  },
};
type ScriptName = keyof typeof scripts;

/** How many times each script calls each write when nothing fails; a test below keeps this table honest. */
const WRITES: Record<ScriptName, Record<Target, number>> = {
  noAnswerChain: { updateLeadSystemRecordIf: 6, createLeadSystemRecordOnce: 1, addLeadEngagement: 5 },
  declineChain: { updateLeadSystemRecordIf: 8, createLeadSystemRecordOnce: 1, addLeadEngagement: 6 },
  connectChain: { updateLeadSystemRecordIf: 9, createLeadSystemRecordOnce: 1, addLeadEngagement: 4 },
};
// A write that answers false cannot be told apart from a lost race unless it is a conditional one.
const MODES: Record<Target, Mode[]> = {
  updateLeadSystemRecordIf: ['before', 'after', 'afterFalse'],
  createLeadSystemRecordOnce: ['before', 'after', 'afterFalse'],
  addLeadEngagement: ['before', 'after'],
};

describe('the write counts of each script', () => {
  it.each(Object.keys(scripts) as ScriptName[])('%s makes the writes the table below says', async (name) => {
    setClock(chicago('16:00'));
    const counted = countWrites();
    await submitLead('lead-a');
    await scripts[name]();
    expect(counted()).toEqual(WRITES[name]);
  });
});

describe('a store failure at every write', () => {
  for (const name of Object.keys(scripts) as ScriptName[]) {
    for (const target of Object.keys(MODES) as Target[]) {
      for (const mode of MODES[target]) {
        for (let nth = 1; nth <= WRITES[name][target]; nth++) {
          it(`${name}: ${target} #${nth} ${mode}`, async () => {
            setClock(chicago('16:00'));
            const fired = arm(target, nth, mode);
            await submitLead('lead-a');
            await scripts[name]();

            expect(fired()).toBe(true);
            const phones = rungPhones();
            expect(phones.length).toBeLessThanOrEqual(3);
            expect(new Set(phones).size).toBe(phones.length);
            // No record at all is fine (a failed create gives the slots back and a later submission can try
            // again); a record that exists must have reached an end.
            const state = world.crm.lead('list-a', 'lead-a').system?.hot_lead_call ? record().state : undefined;
            expect([undefined, 'finished', 'failed', 'skipped']).toContain(state);
            expect(usageSummary().length).toBeLessThanOrEqual(3);
          });
        }
      }
    }
  }
});

describe.each(['after', 'afterFalse'] as const)('a write that committed and then reported %s does not strand the call', (mode) => {
  it('first attempt: the record create landed, the call is still placed once and the slots are kept', async () => {
    setClock(chicago('16:00'));
    arm('createLeadSystemRecordOnce', 1, mode);
    await submitLead('lead-a');
    expect(rungPhones()).toHaveLength(1);
    expect(record()).toMatchObject({ state: 'member_ringing', attemptNo: 1 });
    expect([...world.limits.claims.keys()].filter((k) => k.startsWith('hlc#phone#'))).toHaveLength(1);
  });

  it('next attempt: the between_attempts -> dialing lock landed, the next member is still rung once', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    arm('updateLeadSystemRecordIf', 3, mode); // 1 = ringing, 2 = ended, 3 = the lock
    await nthCall(1).memberLegEnds('no-answer', '0');
    await flush();
    expect(rungPhones()).toHaveLength(2);
    expect(record()).toMatchObject({ state: 'member_ringing', attemptNo: 2 });
  });

  it('/gather: the bridging transition landed, the lead is still dialled once', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    arm('updateLeadSystemRecordIf', 1, mode);
    const reply = await call.memberPresses('1');
    expect(reply.body).toContain('<Dial');
    expect(record()).toMatchObject({ state: 'bridging' });
    // The same press again must not dial a second time.
    expect((await call.memberPresses('1')).body).not.toContain('<Dial');
  });
});

describe.each(['before', 'after', 'afterFalse'] as const)('a rejected placement whose record update fails (%s)', (mode) => {
  it('is recorded anyway and the pass goes on to the next member', async () => {
    setClock(chicago('16:00'));
    world.provider.failNextPlaceCall('no'); // C is rejected
    arm('updateLeadSystemRecordIf', 1, mode); // 1 = the move dialing -> between_attempts
    await submitLead('lead-a');
    expect(rungPhones()).toEqual([PHONE.c, PHONE.d]); // C was tried and rejected
    expect(record()).toMatchObject({ state: 'member_ringing', attemptNo: 2, memberId: ID.d });
  });
});

describe('a write that did not land', () => {
  it('/gather: a bridging transition that failed hangs up and leaves the member leg to hand over', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    const call = nthCall(1);
    await call.memberAnswers();
    arm('updateLeadSystemRecordIf', 1, 'before');
    expect((await call.memberPresses('1')).body).not.toContain('<Dial');
    await call.memberLegEnds('completed', '8');
    await flush();
    expect(record()).toMatchObject({ state: 'member_ringing', attemptNo: 2 });
    expect(rungPhones()).toHaveLength(2);
  });

  it('first attempt: a duplicate dispatch that loses the create (another record exists) places no call', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    await submitLead('lead-a', { submission: true });
    expect(rungPhones()).toHaveLength(1);
  });
});

/** Makes the write that takes the next attempt (between_attempts -> dialing) fail before it applies, once. */
function failLockWriteOnce(): void {
  const original = writers().updateLeadSystemRecordIf.bind(world.crm.crmDb);
  let failed = false;
  writers().updateLeadSystemRecordIf = async (...args) => {
    const op = args[3] as { stateIn: string[]; set?: { state?: string } };
    if (!failed && op.stateIn.includes('between_attempts') && op.set?.state === 'dialing') {
      failed = true;
      throw new Error('injected');
    }
    return original(...args);
  };
}

/** Makes the next `times` writes that close a record waiting between attempts fail before they apply. */
function failClosingWrites(times: number): void {
  const original = writers().updateLeadSystemRecordIf.bind(world.crm.crmDb);
  let left = times;
  writers().updateLeadSystemRecordIf = async (...args) => {
    const op = args[3] as { stateIn: string[]; set?: { state?: string } };
    const closes = op.stateIn.length === 1 && op.stateIn[0] === 'between_attempts' && (op.set?.state === 'finished' || op.set?.state === 'failed');
    if (closes && left > 0) {
      left--;
      throw new Error('injected');
    }
    return original(...args);
  };
}

describe('a double fault: the lock write fails and so do both writes that close the record', () => {
  const endsFirstAttempt: Record<string, () => Promise<unknown>> = {
    'the member did not answer': () => nthCall(1).memberLegEnds('no-answer', '0'),
    'the member pressed 2': async () => {
      const call = nthCall(1);
      await call.memberAnswers();
      await call.memberPresses('2');
      return call.memberLegEnds('completed', '9');
    },
  };

  it.each(Object.keys(endsFirstAttempt))('%s: the lock fails, the close fails twice, and the replayed final callback still ends the record', async (how) => {
    setClock(chicago('16:00'));
    failLockWriteOnce();
    failClosingWrites(2);
    await submitLead('lead-a');
    await endsFirstAttempt[how]();
    await flush();
    // Nothing is left to run by itself: the record waits between attempts and the queue row is failed.
    expect(record().state).toBe('between_attempts');
    expect(rungPhones()).toHaveLength(1);

    // Twilio (or an operator) replays the final callback of the attempt that ended.
    await retrying(() => nthCall(1).memberLegEnds('completed', '9'));
    await noAnswerChain();

    expect(['finished', 'failed']).toContain(record().state);
    expect(new Set(rungPhones()).size).toBe(rungPhones().length);
  });

  it('a running next-attempt job is left alone by a replayed callback', async () => {
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    // The job starts and then waits for ever on the member's cooldown, like a worker that is still busy.
    jest.spyOn(world.limits, 'claim').mockImplementation(() => new Promise<boolean>(() => undefined));
    await nthCall(1).memberLegEnds('no-answer', '0');
    await flush();
    expect(record().state).toBe('between_attempts');
    const before = JSON.stringify(record());

    await nthCall(1).memberLegEnds('no-answer', '0');
    await flush();

    expect(queue.clearFailedJob).toHaveBeenCalledTimes(1);
    await expect(jest.mocked(queue.clearFailedJob).mock.results[0].value).resolves.toBe('not-failed');
    expect(JSON.stringify(record())).toBe(before);
    expect(rungPhones()).toHaveLength(1);
  });
});
