import {
  DYNAMO_MAX_ITEM_BYTES,
  SCHEDULE_ITEM_BUDGET_BYTES,
  estimateDynamoItemBytes,
  isDynamoItemSizeError,
  trimListToItemBudget,
} from '../dynamoItemBudget';

describe('estimateDynamoItemBytes', () => {
  // FAIL: an empty item costs nothing
  it('returns 0 for an empty item', () => {
    expect(estimateDynamoItemBytes({})).toBe(0);
  });

  // FAIL: a string attribute costs its name + its UTF-8 bytes
  it('counts attribute names and string values in UTF-8 bytes', () => {
    // 'ab' (2) + 'xyz' (3)
    expect(estimateDynamoItemBytes({ ab: 'xyz' })).toBe(5);
    // multi-byte characters count as their encoded length, not their JS length
    expect(estimateDynamoItemBytes({ a: '€' })).toBe(1 + 3);
  });

  // FAIL: nested lists/maps are walked, not stringified
  it('counts nested lists and maps', () => {
    const flat = estimateDynamoItemBytes({ a: 'xx' });
    const nested = estimateDynamoItemBytes({ a: [{ b: 'xx' }] });
    expect(nested).toBeGreaterThan(flat);
    // list overhead (3) + element overhead (1) + map overhead (3) + 'b' (1) + 1 + 'xx' (2)
    expect(nested).toBe(1 + 3 + 1 + 3 + 1 + 1 + 2);
  });

  // FAIL: undefined attributes are not persisted, so they cost nothing
  it('ignores undefined values, including inside a nested map', () => {
    expect(estimateDynamoItemBytes({ a: undefined })).toBe(0);
    expect(estimateDynamoItemBytes({ a: { b: undefined } })).toBe(1 + 3);
  });

  // SUCCESS: booleans, nulls and numbers are small fixed costs
  it('counts scalars with their DynamoDB overheads', () => {
    expect(estimateDynamoItemBytes({ a: true })).toBe(1 + 1);
    expect(estimateDynamoItemBytes({ a: null })).toBe(1 + 1);
    expect(estimateDynamoItemBytes({ a: 12 })).toBe(1 + 2);
  });

  // SUCCESS: binary is its raw byte length; unrepresentable values cost nothing
  it('counts binary values and ignores unrepresentable ones', () => {
    expect(estimateDynamoItemBytes({ a: Buffer.alloc(16) })).toBe(1 + 16);
    expect(estimateDynamoItemBytes({ a: () => undefined })).toBe(1);
  });

  // SUCCESS: a missing item is zero-sized rather than a crash
  it('tolerates a null item', () => {
    expect(estimateDynamoItemBytes(null as any)).toBe(0);
  });
});

describe('isDynamoItemSizeError', () => {
  // FAIL: unrelated errors must not be mistaken for an overflow
  it('returns false for unrelated errors', () => {
    expect(isDynamoItemSizeError(new Error('boom'))).toBe(false);
    expect(isDynamoItemSizeError({ code: 'ProvisionedThroughputExceededException' })).toBe(false);
    expect(isDynamoItemSizeError(undefined)).toBe(false);
    // neither `code` nor `name`
    expect(isDynamoItemSizeError({ message: 'Item size has exceeded the maximum allowed size' })).toBe(false);
    // right class, no message
    expect(isDynamoItemSizeError({ code: 'ValidationException' })).toBe(false);
  });

  // FAIL: a ValidationException that is NOT about size is not an overflow
  it('returns false for a non-size ValidationException', () => {
    expect(isDynamoItemSizeError({
      code: 'ValidationException',
      message: 'ExpressionAttributeValues contains invalid key',
    })).toBe(false);
  });

  // SUCCESS: the real DynamoDB overflow error is recognised
  it('recognises the item-size ValidationException', () => {
    expect(isDynamoItemSizeError({
      code: 'ValidationException',
      message: 'Item size has exceeded the maximum allowed size',
    })).toBe(true);
    // AWS SDK v3 surfaces `name` rather than `code`
    expect(isDynamoItemSizeError({
      name: 'ValidationException',
      message: 'Item size to update has exceeded the maximum allowed size',
    })).toBe(true);
  });
});

describe('trimListToItemBudget', () => {
  const entry = (id: number, bytes: number) => ({ id, blob: 'x'.repeat(bytes) });

  // FAIL: an over-budget item sheds its OLDEST entries until it fits
  it('drops the oldest entries until the item fits the budget', () => {
    const list = [entry(0, 100), entry(1, 100), entry(2, 100), entry(3, 100)];
    const item = { other: 'y'.repeat(50), history: list };

    const { kept, dropped } = trimListToItemBudget(item, 'history', list, 300);

    expect(dropped).toBeGreaterThan(0);
    expect(kept.length).toBe(list.length - dropped);
    // the newest entries survive
    expect(kept[kept.length - 1].id).toBe(3);
    expect(estimateDynamoItemBytes({ ...item, history: kept })).toBeLessThanOrEqual(300);
  });

  // FAIL: nothing fits → empty list, everything reported as dropped
  it('returns an empty list when even the newest entry does not fit', () => {
    const list = [entry(0, 500), entry(1, 500)];
    const item = { other: 'y'.repeat(400), history: list };

    const { kept, dropped } = trimListToItemBudget(item, 'history', list, 400);

    expect(kept).toEqual([]);
    expect(dropped).toBe(2);
  });

  // FAIL: an already-fitting list is returned untouched
  it('keeps every entry when the item is already within budget', () => {
    const list = [entry(0, 10), entry(1, 10)];
    const item = { history: list };

    const { kept, dropped } = trimListToItemBudget(item, 'history', list, DYNAMO_MAX_ITEM_BYTES);

    expect(kept).toEqual(list);
    expect(dropped).toBe(0);
  });

  // SUCCESS: the ENG-1048 schedule shape — ~35KB prompts, 10 revisions, at the ceiling
  it('brings a 400KB-ceiling schedule back under budget', () => {
    const revisions = Array.from({ length: 10 }, (_, i) => ({
      startingMessage: 'p'.repeat(33000),
      updatedAt: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
    }));
    const schedule = {
      scheduleId: 'sched-1',
      startingMessage: 'p'.repeat(35000),
      runResults: [{ blob: 'r'.repeat(57000) }],
      promptRevisions: revisions,
    };

    expect(estimateDynamoItemBytes(schedule)).toBeGreaterThan(SCHEDULE_ITEM_BUDGET_BYTES);

    const { kept, dropped } = trimListToItemBudget(schedule, 'promptRevisions', revisions);

    expect(dropped).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThan(0);
    expect(estimateDynamoItemBytes({ ...schedule, promptRevisions: kept }))
      .toBeLessThanOrEqual(SCHEDULE_ITEM_BUDGET_BYTES);
  });

  // SUCCESS: a missing/non-array list or item is treated as empty
  it('tolerates a missing list or item', () => {
    expect(trimListToItemBudget({ history: undefined }, 'history', undefined as any))
      .toEqual({ kept: [], dropped: 0 });
    expect(trimListToItemBudget(null as any, 'history', [])).toEqual({ kept: [], dropped: 0 });
  });

  // SUCCESS: the default budget leaves headroom under DynamoDB's hard ceiling
  it('defaults to a budget below the DynamoDB item limit', () => {
    expect(SCHEDULE_ITEM_BUDGET_BYTES).toBeLessThan(DYNAMO_MAX_ITEM_BYTES);
    expect(DYNAMO_MAX_ITEM_BYTES).toBe(400 * 1024);
  });
});
