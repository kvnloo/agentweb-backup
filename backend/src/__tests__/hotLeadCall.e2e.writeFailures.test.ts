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
import { processHotLeadCallJob } from '../services/hotLeadCallService';
import { processHotLeadCallNextAttempt as processNextAttemptJob } from '../services/hotLeadCallAttempts';
import { LIST, chicago, flush, installWorld, nthCall, record, rungPhones, setClock, submitLead, usageSummary, world } from './helpers/hotLeadCallE2eWorld';
import { REFERENCE_ID as ID, REFERENCE_PHONE as PHONE, referenceMember, referenceTeam } from './helpers/hotLeadCallFixtures';

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

/** How many member calls Twilio accepted (a rejected placement is not a call). */
const acceptedCalls = () => world.provider.placedSids.filter((sid) => sid !== null).length;

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
  for (let round = 0; round < 8 && done.size < acceptedCalls(); round++) {
    for (let n = 1; n <= acceptedCalls(); n++) {
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
    if (acceptedCalls() > 0) {
      const call = nthCall(1);
      // A prompt that was not served (the call was aborted) leaves nothing to press.
      if ((await call.memberAnswers()).body.includes('<Gather')) await call.memberPresses('2');
      await retrying(() => call.memberLegEnds('completed', '9'));
    }
    await noAnswerChain();
  },
  connectChain: async (): Promise<void> => {
    if (acceptedCalls() > 0) {
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

describe('a rejected placement followed by a failure in the same first-attempt job', () => {
  it.each([
    ['before', [PHONE.c], 'failed'],
    ['after', [PHONE.c, PHONE.d], 'member_ringing'],
    ['afterFalse', [PHONE.c, PHONE.d], 'member_ringing'],
  ] as const)('the next member\'s lock write fails (%s): the record is not left waiting', async (mode, phones, state) => {
    setClock(chicago('16:00'));
    world.provider.failNextPlaceCall('no'); // C is rejected
    arm('updateLeadSystemRecordIf', 2, mode); // 1 = the rejection is recorded, 2 = D's lock
    await submitLead('lead-a');
    expect(rungPhones()).toEqual(phones);
    expect(record().state).toBe(state);
    if (state === 'failed') expect(record().outcome).toBe('next_attempt_failed');
  });

  it('the limit store fails when the next member\'s cooldown is claimed: the record is closed, nobody else is rung', async () => {
    setClock(chicago('16:00'));
    world.provider.failNextPlaceCall('no');
    const claim = world.limits.claim.bind(world.limits);
    let claims = 0;
    jest.spyOn(world.limits, 'claim').mockImplementation(async (...args) => {
      if (++claims === 3) throw new Error('limit store down'); // 1 = phone marker, 2 = C's cooldown, 3 = D's cooldown
      return claim(...args);
    });
    await submitLead('lead-a');
    expect(rungPhones()).toEqual([PHONE.c]);
    expect(record()).toMatchObject({ state: 'failed', outcome: 'next_attempt_failed' });
  });

  it('the job dies with the record waiting (the close fails too): the poller\'s re-run hands it on instead of losing it', async () => {
    setClock(chicago('16:00'));
    world.provider.failNextPlaceCall('no');
    failLockWriteOnce();
    failClosingWrites(2);
    await submitLead('lead-a');
    expect(record().state).toBe('between_attempts');

    // What the queue poller does with a row left processing: run the same job again.
    await processHotLeadCallJob({ orgId: 'org-a', listId: LIST, leadId: 'lead-a', origin: 'form_fill' });
    await flush();
    await noAnswerChain();

    expect(['finished', 'failed']).toContain(record().state);
    expect(new Set(rungPhones()).size).toBe(rungPhones().length);
  });
});

/**
 * Fails, in order, the writes that record a rejected placement (dialing -> between_attempts, outcome place_rejected) of
 * the first rejection only: the nth matching write gets modes[n]; later ones pass.
 */
function failSettleWrites(modes: Mode[]): void {
  const original = writers().updateLeadSystemRecordIf.bind(world.crm.crmDb);
  let matched = 0;
  writers().updateLeadSystemRecordIf = async (...args) => {
    const op = args[3] as { stateIn: string[]; set?: { outcome?: string } };
    const mode = op.stateIn.includes('dialing') && op.set?.outcome === 'place_rejected' ? modes[matched++] : undefined;
    if (mode === undefined) return original(...args);
    if (mode === 'before') throw new Error('injected');
    await original(...args);
    if (mode === 'after') throw new Error('injected');
    return false;
  };
}

/** Each script runs a whole call in which Twilio rejects some placements; `arm` is called just before the first rejection. */
const rejectedScripts: Record<string, (arm: () => void) => Promise<void>> = {
  'rejected first': async (arm) => {
    arm();
    world.provider.failNextPlaceCall('no');
    await submitLead('lead-a');
  },
  'rejected second': async (arm) => {
    await submitLead('lead-a');
    arm();
    world.provider.failNextPlaceCall('no');
    await nthCall(1).memberLegEnds('no-answer', '0');
    await flush();
  },
  'rejected twice': async (arm) => {
    arm();
    world.provider.failNextPlaceCall('no');
    world.provider.failNextPlaceCall('no');
    await submitLead('lead-a');
  },
  'rejected all': async (arm) => {
    arm();
    for (let i = 0; i < 3; i++) world.provider.failNextPlaceCall('no');
    await submitLead('lead-a');
  },
};

describe('a rejected placement whose record update fails more than once', () => {
  const sequences: Mode[][] = [
    ['before', 'after'], ['before', 'afterFalse'], ['before', 'before'], ['before', 'before', 'before'], ['before', 'before', 'after'],
  ];
  for (const script of Object.keys(rejectedScripts)) {
    for (const modes of sequences) {
      it(`${script}: settle writes ${modes.join(' then ')} leave the record ended, not waiting`, async () => {
        setClock(chicago('16:00'));
        await rejectedScripts[script](() => failSettleWrites(modes));
        await noAnswerChain();

        const phones = rungPhones();
        expect(new Set(phones).size).toBe(phones.length);
        expect(['finished', 'failed']).toContain(record().state);
      });
    }
  }
});

describe('a next-attempt job that dies after its own lock was rejected', () => {
  // Attempt 1 (C) rings and ends; the job for attempt 1 locks attempt 2 (D), Twilio rejects it, and the pass hangs at
  // the next member's cooldown claim (the process dies there). The record waits at a later attempt with no call sid.
  it.each([1, 2])('%i rejected placement(s): the poller\'s re-run of the attempt-1 job carries the chain on', async (rejections) => {
    const org = world.crm.orgs.get('org-a') as { hotLeadCall: Record<string, unknown> };
    org.hotLeadCall = { ...org.hotLeadCall, team: [referenceMember('c', '15:00', '18:00'), referenceMember('d', '14:00', '19:00'), referenceMember('e', '09:00', '19:00'), referenceMember('a', '09:00', '19:00')], maxAttemptsPerLead: 4 };
    setClock(chicago('16:00'));
    await submitLead('lead-a');
    for (let i = 0; i < rejections; i++) world.provider.failNextPlaceCall('no');
    const claim = world.limits.claim.bind(world.limits);
    let claims = 0;
    const spy = jest.spyOn(world.limits, 'claim').mockImplementation((...args) => (++claims > rejections ? new Promise<boolean>(() => undefined) : claim(...args)));
    await nthCall(1).memberLegEnds('no-answer', '0');
    await flush();
    const waiting = record();
    expect(waiting).toMatchObject({ state: 'between_attempts', attemptNo: 1 + rejections });
    expect(waiting.memberCallSid).toBeUndefined();

    // A replay of the final callback cannot help (the record has no call sid); only the job can.
    await nthCall(1).memberLegEnds('no-answer', '0');
    await flush();
    expect(record()).toMatchObject({ state: 'between_attempts', attemptNo: 1 + rejections });

    spy.mockRestore();
    await processNextAttemptJob({ orgId: 'org-a', listId: LIST, leadId: 'lead-a', jobKey: String(waiting.jobKey), attemptNo: 1 });
    await flush();

    const phones = rungPhones();
    expect(new Set(phones).size).toBe(phones.length);
    expect(phones.length).toBeLessThanOrEqual(4);
    expect(record()).toMatchObject({ state: 'member_ringing', attemptNo: 2 + rejections });
    await noAnswerChain();
    expect(['finished', 'failed']).toContain(record().state);
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

    expect(record().state).toBe('finished');
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
