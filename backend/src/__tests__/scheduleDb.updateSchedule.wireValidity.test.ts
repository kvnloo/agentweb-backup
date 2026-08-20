/**
 * ENG-1217 — is what `updateSchedule` builds a request DynamoDB will actually accept?
 *
 * The undo bug was not a logic error. The logic read correctly; the REQUEST was
 * malformed. `SET #llmModel = :llmModel` went out with `:llmModel` stripped by the
 * marshaller, and DynamoDB rejected the whole write. Every unit test passed,
 * because they asserted the arguments handed to a mock.
 *
 * So this suite does not assert arguments and does not assert my own idea of the
 * expression. It captures the params the REAL builder produces and validates them
 * against the request-level rules DynamoDB enforces server-side — the rules that
 * are invisible to a mock and are exactly where the bug lived:
 *
 *   1. every `:value` referenced by an expression survives REAL marshalling
 *      (`jest.requireActual('aws-sdk')`, not a stand-in) — the original bug;
 *   2. every `#name` referenced by an expression is defined;
 *   3. every defined `#name` is REFERENCED — DynamoDB rejects unused entries with
 *      "Value provided in ExpressionAttributeNames unused in expressions", which
 *      is easy to introduce when one code path adds a name and another decides
 *      not to emit the clause that used it;
 *   4. `ExpressionAttributeValues` is absent rather than empty, and no clause is
 *      emitted with nothing after it — both are validation errors;
 *   5. the AWS SDK itself can serialize the request.
 *
 * The scenario matrix is taken from the real call sites rather than invented:
 * ~28 callers pass two arguments; `expect` and `shedRunResults` come only from
 * `applyScheduleEditWithConsentNarrowing`; `removeAttributes` comes only from
 * `llmModelChangeService`. The combination of `removeAttributes` with
 * `shedRunResults` has NO caller today — it is covered because both write into
 * one REMOVE clause, and a latent clobber there would surface as data loss the
 * first time some future caller combined them.
 */

const updateParams: any[] = [];

jest.mock('aws-sdk', () => {
  class DocumentClient {
    update(params: any) {
      updateParams.push(params);
      return { promise: async () => ({ Attributes: {} }) };
    }
    get() {
      return { promise: async () => ({ Item: undefined }) };
    }
    query() {
      return { promise: async () => ({ Items: [] }) };
    }
    put() {
      return { promise: async () => ({}) };
    }
    delete() {
      return { promise: async () => ({}) };
    }
  }
  return {
    DynamoDB: { DocumentClient },
    S3: class {
      upload() { return { promise: async () => ({}) }; }
      getObject() { return { promise: async () => ({}) }; }
      deleteObject() { return { promise: async () => ({}) }; }
    },
    SecretsManager: class { getSecretValue() { return { promise: async () => ({}) }; } },
    config: { update: jest.fn() },
  };
});

import { scheduleDb, EXPECT_UNSET } from '../services/db';

/** The genuine SDK, not the mock above — its marshaller is the thing under test. */
const realAws = jest.requireActual('aws-sdk');

const PLACEHOLDER = /:[A-Za-z0-9_]+/g;
const NAME_REF = /#[A-Za-z0-9_]+/g;

/**
 * Apply the request-level rules DynamoDB enforces. Returns the problems found so a
 * failure names the actual defect instead of "expected true, got false".
 */
function requestProblems(params: any): string[] {
  const problems: string[] = [];
  const expressions = [params.UpdateExpression, params.ConditionExpression].filter(Boolean) as string[];
  const joined = expressions.join(' ');

  // (1) Values must survive REAL marshalling — the original bug, exactly.
  const marshalled = params.ExpressionAttributeValues
    ? realAws.DynamoDB.Converter.marshall(params.ExpressionAttributeValues)
    : {};
  // `marshall` keys keep their leading colon, matching how the expression names them.
  for (const placeholder of joined.match(PLACEHOLDER) || []) {
    if (!(placeholder in marshalled)) {
      problems.push(`${placeholder} is referenced but does not survive marshalling`);
    }
  }

  // (2) + (3) Names must be defined, and definitions must be used.
  const definedNames = Object.keys(params.ExpressionAttributeNames || {});
  const referencedNames = new Set(joined.match(NAME_REF) || []);
  for (const ref of referencedNames) {
    if (!definedNames.includes(ref)) problems.push(`${ref} is referenced but not defined`);
  }
  for (const defined of definedNames) {
    if (!referencedNames.has(defined)) {
      problems.push(`${defined} is defined but unused — DynamoDB rejects this`);
    }
  }

  // (4) Empty maps and empty clauses are validation errors.
  if (params.ExpressionAttributeValues && Object.keys(params.ExpressionAttributeValues).length === 0) {
    problems.push('ExpressionAttributeValues present but empty');
  }
  if (/\bSET\s*(REMOVE|$)/.test(params.UpdateExpression || '')) problems.push('empty SET clause');
  if (/\bREMOVE\s*$/.test(params.UpdateExpression || '')) problems.push('empty REMOVE clause');

  // (5) The SDK must be able to serialize it.
  try {
    const client = new realAws.DynamoDB.DocumentClient({
      region: 'us-west-2',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const req = client.update(params);
    req.build(() => {});
    if (!req.httpRequest.body) problems.push('SDK produced an empty request body');
  } catch (err: any) {
    problems.push(`SDK could not serialize the request: ${err.message}`);
  }

  return problems;
}

/** The one write this call produced. */
function soleRequest(): any {
  expect(updateParams).toHaveLength(1);
  return updateParams[0];
}

beforeEach(() => {
  updateParams.length = 0;
});

describe('updateSchedule builds requests DynamoDB accepts', () => {
  it('a plain two-argument edit — the ~28 ordinary call sites', async () => {
    await scheduleDb.updateSchedule('sch-1', { scheduleName: 'Weekly digest', status: 'active' });

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.UpdateExpression).toContain('SET');
    expect(params.UpdateExpression).not.toContain('REMOVE');
  });

  it('restoring inheritance — removal only, the path that was broken', async () => {
    // No SET at all. The old code emitted `SET #llmModel = :llmModel` here with a
    // value the marshaller dropped, which is what rule (1) catches.
    await scheduleDb.updateSchedule('sch-2', {}, undefined, undefined, ['llmModel']);

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.UpdateExpression).toBe('REMOVE #llmModel');
    expect(params.ExpressionAttributeValues).toBeUndefined();
  });

  it('a stray undefined is a no-op, not a malformed SET', async () => {
    await scheduleDb.updateSchedule('sch-3', { scheduleName: 'Kept', description: undefined } as never);

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.UpdateExpression).not.toContain('description');
  });

  it('a wholly-undefined update writes nothing at all', async () => {
    // Not merely "valid" — the request must not be sent. An UpdateExpression with
    // no clauses is rejected outright, so returning early is the only correct move.
    const result = await scheduleDb.updateSchedule('sch-4', { llmModel: undefined } as never);

    expect(updateParams).toHaveLength(0);
    expect(result).toBeUndefined();
  });

  it('setting and removing in one write', async () => {
    await scheduleDb.updateSchedule(
      'sch-5',
      { scheduleName: 'Renamed', updatedAt: '2026-08-18T00:00:00.000Z' },
      undefined,
      undefined,
      ['llmModel'],
    );

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.UpdateExpression).toMatch(/^SET .* REMOVE #llmModel$/);
  });

  it('an explicit removal beats a SET of the same key, and leaves no orphan value', async () => {
    // The dangerous shape: one key in both lists. If the SET were dropped without
    // also dropping `:llmModel`, the value map would carry an entry nothing
    // references — which trips rule (3)'s mirror image and, worse, could leave the
    // attribute written instead of removed.
    await scheduleDb.updateSchedule(
      'sch-6',
      { llmModel: 'anthropic.claude-opus-5', status: 'active' },
      undefined,
      undefined,
      ['llmModel'],
    );

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.UpdateExpression).toContain('REMOVE #llmModel');
    expect(params.UpdateExpression).not.toContain('#llmModel = :llmModel');
    expect(params.ExpressionAttributeValues).not.toHaveProperty(':llmModel');
  });

  it('a conditional edit — the consent-narrowing path', async () => {
    await scheduleDb.updateSchedule(
      'sch-7',
      { requiredFunctionCalls: ['post_to_linkedin'] },
      { autopublishAuthorized: true },
    );

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.ConditionExpression).toBeTruthy();
  });

  it('a conditional edit expecting an attribute to still be ABSENT', async () => {
    // `undefined` in `expect` means attribute_not_exists — it must NOT become a
    // value comparison against a dropped placeholder.
    await scheduleDb.updateSchedule('sch-8', { status: 'paused' }, { autopublishAuthorized: undefined });

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.ConditionExpression).toContain('attribute_not_exists');
  });

  it('an edit that also sheds run history — the trim path', async () => {
    await scheduleDb.updateSchedule(
      'sch-9',
      { scheduleName: 'Trimmed' },
      undefined,
      { count: 2, expectedLength: 10, expectedLast: { runId: 'r-10' } },
    );

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.UpdateExpression).toContain('REMOVE #runResults[0], #runResults[1]');
    expect(params.ConditionExpression).toContain('size(#runResults)');
  });

  it('shedding zero results adds no clause and no orphan name', async () => {
    // `count: 0` must not define `#runResults` — a name defined without a clause
    // to use it is rule (3), and would fail every such write.
    await scheduleDb.updateSchedule(
      'sch-10',
      { scheduleName: 'Untrimmed' },
      undefined,
      { count: 0, expectedLength: 3 },
    );

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.UpdateExpression).not.toContain('runResults');
  });

  it('a removal and a history shed share ONE merged REMOVE clause', async () => {
    // No caller combines these today. It is covered because both write into a
    // single REMOVE — DynamoDB permits only one per expression — so if either
    // assigned rather than appended, the other would vanish silently. Silently
    // dropping a history trim is data loss, and silently dropping an attribute
    // removal is the undo bug all over again.
    await scheduleDb.updateSchedule(
      'sch-11',
      { scheduleName: 'Both' },
      undefined,
      { count: 1, expectedLength: 4 },
      ['llmModel'],
    );

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect((params.UpdateExpression.match(/REMOVE/g) || [])).toHaveLength(1);
    expect(params.UpdateExpression).toContain('#llmModel');
    expect(params.UpdateExpression).toContain('#runResults[0]');
  });

  it('every optional argument at once', async () => {
    await scheduleDb.updateSchedule(
      'sch-12',
      { scheduleName: 'Everything', status: 'active', description: undefined } as never,
      { autopublishAuthorized: true },
      { count: 2, expectedLength: 6, expectedLast: { runId: 'r-6' } },
      ['llmModel', 'llmBackupModel'],
    );

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
  });

  it('ENG-1363: expecting an attribute to be UNSET emits a valid disjunction', async () => {
    // The condition this adds is the first one in the file with an OR, and the
    // first to compare against an EMPTY STRING. Both are places a request can be
    // rejected server-side while every mock happily accepts it: an unbalanced or
    // mis-parenthesised disjunction is a syntax error, and a value the marshaller
    // dropped would leave `:expected0` dangling — which is the ORIGINAL ENG-1217
    // bug's exact shape, now on the condition instead of the update.
    await scheduleDb.updateSchedule('sch-14', { llmModel: 'gemini-3.1-flash-lite' }, {
      llmModel: EXPECT_UNSET,
    } as never);

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.ConditionExpression).toMatch(
      /^\(attribute_not_exists\(#\w+\) OR #\w+ = :\w+\)$/,
    );
    // The empty string must be REAL and present, not dropped and not coerced to
    // null — `#a = :a` against a missing value is the failure mode this file exists
    // for, and against null it would never match the rows it is meant to match.
    const values = Object.values(params.ExpressionAttributeValues as Record<string, unknown>);
    expect(values).toContain('');
  });

  it('ENG-1363: an UNSET expectation composes with an ordinary one', async () => {
    // Two entries in `expect` join with AND. If the disjunction were emitted
    // without its parentheses, AND would bind tighter than OR and the condition
    // would quietly mean something else entirely — still valid SQL-ish syntax, so
    // nothing would error; it would just stop guarding.
    await scheduleDb.updateSchedule('sch-15', { llmModel: 'gemini-3.1-flash-lite' }, {
      llmModel: EXPECT_UNSET,
      status: 'active',
    } as never);

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.ConditionExpression).toContain(' AND ');
    expect(params.ConditionExpression).toMatch(/\(attribute_not_exists\(#\w+\) OR #\w+ = :\w+\)/);
  });

  it('removing an attribute that is also expected to hold a value', async () => {
    // The condition names the attribute via its own alias while REMOVE names it
    // directly, so both aliases must be defined AND used.
    await scheduleDb.updateSchedule(
      'sch-13',
      {},
      { llmModel: 'anthropic.claude-opus-5' },
      undefined,
      ['llmModel'],
    );

    const params = soleRequest();
    expect(requestProblems(params)).toEqual([]);
    expect(params.ConditionExpression).toBeTruthy();
    expect(params.UpdateExpression).toBe('REMOVE #llmModel');
  });
});
