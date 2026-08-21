/**
 * ENG-1217 — what does `updateSchedule` actually send when a value is undefined?
 *
 * `applyModelChange`'s compensation path and `undoModelChange` both pass
 * `{ llmModel: modelBefore ?? undefined }`, intending to REMOVE the attribute and
 * so restore inheritance. Two thirds of production schedules (66 of 91 active)
 * store no model at all, so this is the majority path for undo, not an edge case.
 *
 * This test pins what is really emitted, because the intent above is only correct
 * if `undefined` becomes a REMOVE. `Object.entries({ llmModel: undefined })` still
 * yields the key, so the builder produces `SET #llmModel = :llmModel` — and the
 * DocumentClient marshaller DROPS undefined values, so `:llmModel` never reaches
 * DynamoDB while the expression still references it. That combination is a
 * ValidationException at runtime, not a removal.
 */

const updateParams: any[] = [];

jest.mock('aws-sdk', () => {
  class DocumentClient {
    update(params: any) {
      updateParams.push(params);
      return { promise: async () => ({}) };
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
  }
  class S3 {
    upload() { return { promise: async () => ({}) }; }
    getObject() { return { promise: async () => ({}) }; }
    deleteObject() { return { promise: async () => ({}) }; }
  }
  return {
    DynamoDB: { DocumentClient },
    S3,
    SecretsManager: class { getSecretValue() { return { promise: async () => ({}) }; } },
    config: { update: jest.fn() },
  };
});

import { scheduleDb } from '../services/db';

beforeEach(() => {
  updateParams.length = 0;
});

describe('scheduleDb.updateSchedule — undefined values and explicit removal', () => {
  it('never emits a SET referencing an undefined value', async () => {
    // The original bug: `SET #llmModel = :llmModel` where the marshaller dropped
    // `:llmModel`, so DynamoDB rejected the entire write. Undo hit this for every
    // schedule that had been inheriting the platform default -- the majority.
    await scheduleDb.updateSchedule('sch-1', { llmModel: undefined } as never);

    for (const params of updateParams) {
      const values = params.ExpressionAttributeValues || {};
      for (const [placeholder, value] of Object.entries(values)) {
        expect(value).not.toBeUndefined();
        expect(params.UpdateExpression).toContain(placeholder);
      }
      // Every placeholder the expression references must actually be supplied.
      for (const placeholder of String(params.UpdateExpression).match(/:[A-Za-z0-9_]+/g) || []) {
        expect(values).toHaveProperty(placeholder);
      }
    }
  });

  it('REMOVEs an attribute when asked explicitly, restoring "never set"', async () => {
    await scheduleDb.updateSchedule('sch-1', {}, undefined, undefined, ['llmModel']);

    expect(updateParams).toHaveLength(1);
    const params = updateParams[0];
    expect(params.UpdateExpression).toBe('REMOVE #llmModel');
    // A bare `SET ` is a syntax error, so a removal-only update must omit it.
    expect(params.UpdateExpression).not.toContain('SET');
    expect(params.ExpressionAttributeNames['#llmModel']).toBe('llmModel');
    // An empty value map is itself a validation error.
    expect(params.ExpressionAttributeValues).toBeUndefined();
  });

  it('combines a SET and a REMOVE into one valid expression', async () => {
    await scheduleDb.updateSchedule('sch-1', { status: 'active' } as never, undefined, undefined, [
      'llmModel',
    ]);

    const params = updateParams[0];
    expect(params.UpdateExpression).toBe('SET #status = :status REMOVE #llmModel');
    expect(params.ExpressionAttributeValues[':status']).toBe('active');
  });

  it('lets an explicit removal win over a SET of the same attribute', async () => {
    // Both in one expression is rejected by DynamoDB outright, so one has to give
    // way; the caller naming it for removal is the clearer intent.
    await scheduleDb.updateSchedule(
      'sch-1',
      { llmModel: 'gemini-3.1-flash-lite' } as never,
      undefined,
      undefined,
      ['llmModel'],
    );

    const params = updateParams[0];
    expect(params.UpdateExpression).toBe('REMOVE #llmModel');
    expect(params.ExpressionAttributeValues).toBeUndefined();
  });

  it('writes nothing at all when there is nothing to write', async () => {
    await scheduleDb.updateSchedule('sch-1', {} as never);
    expect(updateParams).toHaveLength(0);
  });

  it('still SETs a real value normally', async () => {
    await scheduleDb.updateSchedule('sch-1', { llmModel: 'gemini-3.1-flash-lite' } as never);

    const params = updateParams[0];
    expect(params.UpdateExpression).toBe('SET #llmModel = :llmModel');
    expect(params.ExpressionAttributeValues[':llmModel']).toBe('gemini-3.1-flash-lite');
  });
});
