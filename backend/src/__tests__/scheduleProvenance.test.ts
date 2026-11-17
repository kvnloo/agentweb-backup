/**
 * ENG-2816 (step 3): the pure pieces of schedule provenance, the tolerant reader above all. Every place that asks "is this
 * schedule marked, and by which fields" goes through it, and it has to give the same answer whatever shape the attribute has in
 * the caller's hand: a DynamoDB String Set off the wire, an array from the db layer or the API, or absent. A value we cannot
 * read is MARKED, never "none": under-marking is the hole this whole change exists to close.
 */
import {
  MARKED_RUN_MAX_ATTEMPTS,
  SCHEDULE_PROVENANCE_FIELDS,
  SCHEDULE_WRITE_TOOL_NAMES,
  UNREADABLE_PROVENANCE,
  applyProvenancePlan,
  isScheduleMarked,
  minCallsWithoutRefused,
  planProvenanceChange,
  readScheduleProvenance,
  scheduleContentVersion,
  trackedFieldsInBody,
  withoutRefusedNames,
} from '../utils/scheduleProvenance';

// A real DynamoDBSet, built the way the db layer builds one (and the way the DocumentClient hands one back).
// (The shared aws-sdk mock has no createSet, so build the set with the real SDK.)
const realSet = (members: string[]) => new (jest.requireActual('aws-sdk').DynamoDB.DocumentClient)({ region: 'us-west-2' }).createSet(members);

describe('readScheduleProvenance (the tolerant reader)', () => {
  it('reads a real DynamoDB String Set as its members, sorted', () => {
    expect(readScheduleProvenance(realSet(['variableValues', 'startingMessage', 'keywords']))).toEqual([
      'keywords',
      'startingMessage',
      'variableValues',
    ]);
  });

  it('reads a plain array (what the db layer and the API return) and a JS Set the same way, de-duplicated', () => {
    expect(readScheduleProvenance(['b', 'a', 'b'])).toEqual(['a', 'b']);
    expect(readScheduleProvenance(new Set(['b', 'a']))).toEqual(['a', 'b']);
  });

  it('reads absent as none (every schedule that predates the change)', () => {
    expect(readScheduleProvenance(undefined)).toEqual([]);
    expect(readScheduleProvenance(null)).toEqual([]);
    expect(readScheduleProvenance([])).toEqual([]);
  });

  it('reads anything it cannot parse as MARKED, never as none', () => {
    for (const garbage of [42, true, {}, { values: 'not-a-list' }, '', '   ', () => 1]) {
      expect(readScheduleProvenance(garbage)).toEqual([UNREADABLE_PROVENANCE]);
    }
  });

  it('treats a member it cannot read as a mark, and keeps the readable ones', () => {
    expect(readScheduleProvenance(['keywords', 7, null, ''])).toEqual(['_unreadable', 'keywords']);
  });

  it('reads a lone non-empty string as that one mark', () => {
    expect(readScheduleProvenance('startingMessage')).toEqual(['startingMessage']);
  });
});

describe('isScheduleMarked', () => {
  it('is false for a schedule with no provenance, and for no schedule at all (callers decide what missing means)', () => {
    expect(isScheduleMarked({})).toBe(false);
    expect(isScheduleMarked(undefined)).toBe(false);
    expect(isScheduleMarked(null)).toBe(false);
    expect(isScheduleMarked({ provenance: [] })).toBe(false);
  });

  it('is true for a set, an array and an unreadable value alike', () => {
    expect(isScheduleMarked({ provenance: realSet(['keywords']) })).toBe(true);
    expect(isScheduleMarked({ provenance: ['keywords'] })).toBe(true);
    expect(isScheduleMarked({ provenance: 12 })).toBe(true);
  });
});

describe('tracked fields', () => {
  it('are exactly the eight content fields (selfImprove included); session_id, timing, model, name and description are not tracked', () => {
    expect([...SCHEDULE_PROVENANCE_FIELDS].sort()).toEqual([
      'emailNotifications',
      'functionCallMinCalls',
      'keywords',
      'requiredFunctionCalls',
      'selfImprove',
      'startingMessage',
      'variableValues',
      'variables',
    ]);
  });

  it('trackedFieldsInBody reports only the tracked fields the request carries (presence, not truthiness)', () => {
    expect(
      trackedFieldsInBody({
        startingMessage: 'x',
        keywords: [],
        requiredFunctionCalls: undefined,
        variableValues: {},
        sessionId: 's',
        selfImprove: false,
        nextRunTime: 'soon',
        llmModel: 'm',
        scheduleName: 'n',
        description: 'd',
      })
    ).toEqual(['startingMessage', 'keywords', 'variableValues', 'selfImprove']);
    expect(trackedFieldsInBody(undefined)).toEqual([]);
    expect(trackedFieldsInBody('nope')).toEqual([]);
  });
});

describe('marked-run helpers', () => {
  const refused = (name: string) => name === 'save_memory' || name === 'luma_get_guests';

  it('drop refused names from the required list and the min-calls map, and keep the rest in order', () => {
    expect(withoutRefusedNames(['a', 'save_memory', 'b', 'luma_get_guests'], refused)).toEqual(['a', 'b']);
    expect(withoutRefusedNames(undefined, refused)).toEqual([]);
    expect(minCallsWithoutRefused({ a: 2, save_memory: 1 }, refused)).toEqual({ a: 2 });
    expect(minCallsWithoutRefused(undefined, refused)).toEqual({});
  });

  it('a marked run gets a small attempt cap, not twenty', () => {
    expect(MARKED_RUN_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(MARKED_RUN_MAX_ATTEMPTS).toBeLessThan(20);
  });

  it('the claim-carrying tools are exactly the ones whose self-call reaches a schedule write route', () => {
    expect([...SCHEDULE_WRITE_TOOL_NAMES].sort()).toEqual([
      'create_schedule_from_template',
      'emma_schedule_recurring_work',
      'manage_schedule_template',
      'manage_scheduled_chat',
      'submit_scheduled_chat_variables',
    ]);
  });
});

describe('planProvenanceChange: marks are only ever ADDED, and only by a visitor', () => {
  it('a visitor write adds the fields it names', () => {
    expect(planProvenanceChange({ visitorWrite: true, fields: ['keywords', 'startingMessage'] })).toEqual({ provenanceAdd: ['keywords', 'startingMessage'] });
  });

  it('a visitor write that names nothing adds nothing', () => {
    expect(planProvenanceChange({ visitorWrite: true, fields: [] })).toEqual({});
  });

  it('an owner write never touches provenance, whatever it changes (no edit takes a mark off)', () => {
    expect(planProvenanceChange({ visitorWrite: false, fields: ['keywords', 'startingMessage'] })).toEqual({});
    expect(planProvenanceChange({ visitorWrite: false, fields: [] })).toEqual({});
  });

  it('the plan has no way to remove a mark', () => {
    for (const visitorWrite of [true, false]) {
      expect(planProvenanceChange({ visitorWrite, fields: ['keywords'] })).not.toHaveProperty('provenanceRemove');
    }
  });

  it('applyProvenancePlan: the marks a snapshot will carry after the write (sorted, de-duplicated)', () => {
    expect(applyProvenancePlan(['keywords'], { provenanceAdd: ['startingMessage', 'keywords'] })).toEqual(['keywords', 'startingMessage']);
    expect(applyProvenancePlan(['keywords'], {})).toEqual(['keywords']);
    expect(applyProvenancePlan([], {})).toEqual([]);
  });
});

describe('scheduleContentVersion: the digest the adopt route binds to (computed on read, never stored)', () => {
  const base = () => ({
    scheduleId: 's1', scheduleName: 'S', startingMessage: 'Hi', keywords: ['a', 'b'], requiredFunctionCalls: ['t1'],
    functionCallMinCalls: { t1: 1, t2: 2 }, variables: [{ name: 'who', description: 'd' }], variableValues: { who: 'Alice', where: 'here' },
    emailNotifications: ['o@example.com'], selfImprove: false, provenance: ['keywords', 'startingMessage'],
  });

  it('is 32 hex characters and the same for the same content', () => {
    expect(scheduleContentVersion(base())).toMatch(/^[0-9a-f]{32}$/);
    expect(scheduleContentVersion(base())).toBe(scheduleContentVersion(base()));
  });

  it('is stable across object KEY order (at any depth) and across provenance ORDER and shape (array, real Set)', () => {
    const reordered = {
      provenance: realSet(['startingMessage', 'keywords']),
      selfImprove: false, emailNotifications: ['o@example.com'],
      variableValues: { where: 'here', who: 'Alice' }, variables: [{ description: 'd', name: 'who' }],
      functionCallMinCalls: { t2: 2, t1: 1 }, requiredFunctionCalls: ['t1'], keywords: ['a', 'b'], startingMessage: 'Hi', scheduleName: 'S', scheduleId: 's1',
    };
    expect(scheduleContentVersion(reordered)).toBe(scheduleContentVersion(base()));
  });

  it('changes when ANY tracked field, or the marks, change', () => {
    const before = scheduleContentVersion(base());
    for (const change of [
      { startingMessage: 'Hi!' }, { keywords: ['b', 'a'] }, { requiredFunctionCalls: ['t1', 't2'] }, { functionCallMinCalls: { t1: 9, t2: 2 } },
      { variables: [{ name: 'who' }] }, { variableValues: { who: 'Mallory', where: 'here' } }, { emailNotifications: ['o@example.com', 'x@example.com'] },
      { selfImprove: true }, { provenance: ['keywords'] }, { provenance: ['keywords', 'startingMessage', 'variables'] }, { provenance: [] },
    ]) {
      expect(scheduleContentVersion({ ...base(), ...change })).not.toBe(before);
    }
  });

  it('does NOT change for anything that is not tracked content: updatedAt, run bookkeeping, name, model, timing, run results', () => {
    const before = scheduleContentVersion(base());
    expect(scheduleContentVersion({
      ...base(), updatedAt: '2026-11-18T00:00:00Z', lastRunTime: 'x', nextRunTime: 'y', status: 'paused', runCount: 3, runResults: [{ runId: 'r' }],
      runInFlight: { runId: 'r' }, claimedAt: 'x', claimedBy: 'i', scheduleName: 'Renamed', llmModel: 'm', timezone: 'UTC', description: 'd',
      deliveryLog: [{ at: 'x' }], promptRevisions: [{ startingMessage: 'old' }],
    })).toBe(before);
  });

  it('an absent field reads as its empty value, so a handler storing "[]" where nothing was stored changes nothing', () => {
    const bare = { startingMessage: 'Hi', provenance: ['keywords'] };
    expect(scheduleContentVersion({ ...bare, keywords: [], requiredFunctionCalls: [], functionCallMinCalls: {}, variables: [], variableValues: {}, emailNotifications: [], selfImprove: false }))
      .toBe(scheduleContentVersion(bare));
    expect(scheduleContentVersion({ ...bare, keywords: null, selfImprove: undefined })).toBe(scheduleContentVersion(bare));
  });

  it('reads an unreadable provenance as marked (and so as different from none)', () => {
    expect(scheduleContentVersion({ ...base(), provenance: 17 })).not.toBe(scheduleContentVersion({ ...base(), provenance: [] }));
  });

  it('copes with a missing schedule', () => {
    expect(scheduleContentVersion(null)).toMatch(/^[0-9a-f]{32}$/);
    expect(scheduleContentVersion(undefined)).toBe(scheduleContentVersion({}));
  });
});
