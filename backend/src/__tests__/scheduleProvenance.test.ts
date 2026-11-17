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
  isScheduleMarked,
  minCallsWithoutRefused,
  readScheduleProvenance,
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
  it('are exactly the seven content fields; session_id, self_improve, timing, model, name and description are not tracked', () => {
    expect([...SCHEDULE_PROVENANCE_FIELDS].sort()).toEqual([
      'emailNotifications',
      'functionCallMinCalls',
      'keywords',
      'requiredFunctionCalls',
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
        selfImprove: true,
        nextRunTime: 'soon',
        llmModel: 'm',
        scheduleName: 'n',
        description: 'd',
      })
    ).toEqual(['startingMessage', 'keywords', 'variableValues']);
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
