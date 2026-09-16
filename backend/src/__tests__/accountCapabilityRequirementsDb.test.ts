/**
 * ENG-1541 remainder (items 1-2). Unit tests for the persisted capability-requirement table's
 * read/write logic and the suppression formula — the exact mechanism 9 rounds of design review
 * found real bugs in before any of this was code (wrong field in the suppression check, an
 * unstated bootstrap value, a write location that would've silently broken 3 of 4 branches, a
 * `correctionExpiresAt` that was proposed but never wired in). These tests pin the design that
 * survived that review, against real DynamoDB call shapes, not the generic auto-mock everything
 * else in this test suite gets for free (that mock resolves every call to `{}`, which would make
 * every one of these tests pass regardless of whether the logic is right).
 */

jest.mock('aws-sdk', () => {
  const mockGet = jest.fn();
  const mockUpdate = jest.fn();
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({ get: mockGet, update: mockUpdate })),
    },
    config: { update: jest.fn() },
  };
});

import AWS from 'aws-sdk';
import {
  getAccountCapabilityRequirement,
  upsertAccountCapabilityStatus,
  setAccountCapabilityCorrection,
  isSuppressed,
  type AccountCapabilityRequirement,
} from '../services/accountCapabilityRequirementsDb';

const DAY_MS = 24 * 60 * 60 * 1000;

let mockDynamoDB: any;

beforeEach(() => {
  jest.clearAllMocks();
  const DocumentClient = AWS.DynamoDB.DocumentClient as any;
  mockDynamoDB = new DocumentClient();
});

const ok = (attrs: any = {}) => ({ promise: jest.fn().mockResolvedValue(attrs) });

function row(overrides: Partial<AccountCapabilityRequirement> = {}): AccountCapabilityRequirement {
  return {
    userId: 'u1',
    capability: 'ad_platform_integration',
    requiredSince: '2026-01-01T00:00:00.000Z',
    source: 'paid_ads_intent',
    sourceDetail: 'goal',
    status: 'unhealthy',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
    lastVerifiedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('getAccountCapabilityRequirement', () => {
  it('returns null when no row exists', async () => {
    mockDynamoDB.get.mockReturnValue(ok({}));
    const result = await getAccountCapabilityRequirement('u1', 'ad_platform_integration');
    expect(result).toBeNull();
  });

  it('returns the row when one exists', async () => {
    const r = row();
    mockDynamoDB.get.mockReturnValue(ok({ Item: r }));
    const result = await getAccountCapabilityRequirement('u1', 'ad_platform_integration');
    expect(result).toEqual(r);
  });
});

describe('upsertAccountCapabilityStatus', () => {
  it('creates a new row with requiredSince/source set, statusChangedAt bootstrapped to now — not left undefined', async () => {
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: row({ requiredSince: '2026-03-01T00:00:00.000Z', statusChangedAt: '2026-03-01T00:00:00.000Z' }) }));
    await upsertAccountCapabilityStatus(null, 'u1', 'ad_platform_integration', 'unhealthy', 'goal', '2026-03-01T00:00:00.000Z');

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toContain('requiredSince = :now');
    expect(params.ExpressionAttributeNames['#source']).toBe('source');
    expect(params.ExpressionAttributeValues[':statusChangedAt']).toBe('2026-03-01T00:00:00.000Z');
  });

  it('does NOT move statusChangedAt when status is unchanged from the existing row', async () => {
    const existing = row({ status: 'unhealthy', statusChangedAt: '2026-01-01T00:00:00.000Z' });
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: existing }));
    await upsertAccountCapabilityStatus(existing, 'u1', 'ad_platform_integration', 'unhealthy', 'goal', '2026-03-01T00:00:00.000Z');

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ExpressionAttributeValues[':statusChangedAt']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('DOES move statusChangedAt to now when status actually differs from the existing row', async () => {
    const existing = row({ status: 'healthy', statusChangedAt: '2026-01-01T00:00:00.000Z' });
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: existing }));
    await upsertAccountCapabilityStatus(existing, 'u1', 'ad_platform_integration', 'unhealthy', 'goal', '2026-03-01T00:00:00.000Z');

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ExpressionAttributeValues[':statusChangedAt']).toBe('2026-03-01T00:00:00.000Z');
  });

  it('does not include requiredSince/source when updating an existing row', async () => {
    const existing = row();
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: existing }));
    await upsertAccountCapabilityStatus(existing, 'u1', 'ad_platform_integration', 'healthy', 'goal');

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).not.toContain('requiredSince');
    expect(params.ExpressionAttributeNames?.['#source']).toBeUndefined();
  });

  it('preserves the existing sourceDetail when passed null (the not_required transition)', async () => {
    const existing = row({ sourceDetail: 'emma_help_interests' });
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: { ...existing, status: 'not_required' } }));
    await upsertAccountCapabilityStatus(existing, 'u1', 'ad_platform_integration', 'not_required', null);

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).not.toContain('sourceDetail');
  });

  it('uses attribute-scoped UpdateItem, never a full-object Put — the correction fields are never in the SET clause', async () => {
    const existing = row({ correctedAt: '2026-02-01T00:00:00.000Z', correctedBy: 'admin@example.com' });
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: existing }));
    await upsertAccountCapabilityStatus(existing, 'u1', 'ad_platform_integration', 'unhealthy', 'goal');

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).not.toContain('correctedAt');
    expect(params.UpdateExpression).not.toContain('correctedBy');
  });

  it('clears (REMOVEs, not SET-to-null) the correction fields once correctionExpiresAt has passed', async () => {
    const existing = row({
      correctedAt: '2026-01-01T00:00:00.000Z',
      correctedBy: 'admin@example.com',
      correctionNote: 'false positive',
      correctionExpiresAt: '2026-02-01T00:00:00.000Z',
    });
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: existing }));
    await upsertAccountCapabilityStatus(existing, 'u1', 'ad_platform_integration', 'unhealthy', 'goal', '2026-03-01T00:00:00.000Z');

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toContain('REMOVE correctedAt, correctedBy, correctionNote, correctionExpiresAt');
  });

  it('does NOT clear correction fields when correctionExpiresAt has not yet passed', async () => {
    const existing = row({
      correctedAt: '2026-01-01T00:00:00.000Z',
      correctionExpiresAt: '2026-06-01T00:00:00.000Z',
    });
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: existing }));
    await upsertAccountCapabilityStatus(existing, 'u1', 'ad_platform_integration', 'unhealthy', 'goal', '2026-03-01T00:00:00.000Z');

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).not.toContain('REMOVE');
  });

  it('returns the post-write row from ReturnValues, not the pre-write one passed in', async () => {
    const existing = row({ status: 'healthy', statusChangedAt: '2026-01-01T00:00:00.000Z' });
    const postWrite = { ...existing, status: 'unhealthy', statusChangedAt: '2026-03-01T00:00:00.000Z' };
    mockDynamoDB.update.mockReturnValue(ok({ Attributes: postWrite }));

    const result = await upsertAccountCapabilityStatus(existing, 'u1', 'ad_platform_integration', 'unhealthy', 'goal', '2026-03-01T00:00:00.000Z');

    expect(result.statusChangedAt).toBe('2026-03-01T00:00:00.000Z');
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ReturnValues).toBe('ALL_NEW');
  });
});

describe('setAccountCapabilityCorrection', () => {
  it('sets correctedAt/correctedBy/correctionExpiresAt, guarded by attribute_exists(userId)', async () => {
    mockDynamoDB.update.mockReturnValue(ok({}));
    await setAccountCapabilityCorrection('u1', 'ad_platform_integration', 'admin@example.com', 'false positive', 30);

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toBe('attribute_exists(userId)');
    expect(params.ExpressionAttributeValues[':correctedBy']).toBe('admin@example.com');
    expect(params.ExpressionAttributeValues[':note']).toBe('false positive');
  });

  it('omits correctionNote entirely (not SET-to-null) when none is given', async () => {
    mockDynamoDB.update.mockReturnValue(ok({}));
    await setAccountCapabilityCorrection('u1', 'ad_platform_integration', 'admin@example.com', undefined, 30);

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).not.toContain('correctionNote');
    expect(params.ExpressionAttributeValues[':note']).toBeUndefined();
  });

  it('sets correctionExpiresAt to now + the given lifetime in days', async () => {
    mockDynamoDB.update.mockReturnValue(ok({}));
    const before = Date.now();
    await setAccountCapabilityCorrection('u1', 'ad_platform_integration', 'admin@example.com', undefined, 30);
    const params = mockDynamoDB.update.mock.calls[0][0];
    const expiresAt = new Date(params.ExpressionAttributeValues[':expiresAt']).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 29 * DAY_MS);
    expect(expiresAt).toBeLessThanOrEqual(before + 31 * DAY_MS);
  });
});

describe('isSuppressed — the formula 9 rounds of review caught 2 real bugs in', () => {
  it('is false when correctedAt is not set', () => {
    expect(isSuppressed(row({ correctedAt: undefined }))).toBe(false);
  });

  it('is false for a null row', () => {
    expect(isSuppressed(null)).toBe(false);
  });

  it('is true when corrected and status has not changed since, and not expired', () => {
    const r = row({
      statusChangedAt: '2026-01-01T00:00:00.000Z',
      correctedAt: '2026-01-02T00:00:00.000Z',
      correctionExpiresAt: '2026-02-01T00:00:00.000Z',
    });
    const now = new Date('2026-01-15T00:00:00.000Z').getTime();
    expect(isSuppressed(r, now)).toBe(true);
  });

  it('is false once status changes again after the correction — statusChangedAt moves past correctedAt (real recurrence)', () => {
    const r = row({
      statusChangedAt: '2026-01-10T00:00:00.000Z', // moved AFTER correctedAt below
      correctedAt: '2026-01-02T00:00:00.000Z',
      correctionExpiresAt: '2026-02-01T00:00:00.000Z',
    });
    const now = new Date('2026-01-15T00:00:00.000Z').getTime();
    expect(isSuppressed(r, now)).toBe(false);
  });

  it('is false once correctionExpiresAt has passed, even if status never changed — round 1/7\'s core finding, pinned directly', () => {
    const r = row({
      statusChangedAt: '2026-01-01T00:00:00.000Z',
      correctedAt: '2026-01-02T00:00:00.000Z',
      correctionExpiresAt: '2026-02-01T00:00:00.000Z',
    });
    const now = new Date('2026-03-01T00:00:00.000Z').getTime(); // well past expiry
    expect(isSuppressed(r, now)).toBe(false);
  });

  it('regression pin: using lastVerifiedAt instead of statusChangedAt would wrongly suppress-defeat every run — this must use statusChangedAt', () => {
    // lastVerifiedAt advances on every touch regardless of a real status change.
    // If isSuppressed used it instead of statusChangedAt, this case (status truly
    // unchanged, corrected, not expired) would flip to false the moment
    // lastVerifiedAt ticks past correctedAt on the very next run — exactly the
    // bug round 1 of design review found and round 7 confirmed fixed.
    const r = row({
      statusChangedAt: '2026-01-01T00:00:00.000Z', // never moved — status genuinely unchanged
      lastVerifiedAt: '2026-01-20T00:00:00.000Z', // moved every run regardless
      correctedAt: '2026-01-02T00:00:00.000Z',
      correctionExpiresAt: '2026-02-01T00:00:00.000Z',
    });
    const now = new Date('2026-01-20T00:00:00.000Z').getTime();
    expect(isSuppressed(r, now)).toBe(true);
  });
});
