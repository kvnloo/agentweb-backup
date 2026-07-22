/**
 * Unit tests for the enrollment claim/release conditional-update helpers that
 * prevent the drip worker from double-sending a step if the process is
 * killed between sending and advancing an enrollment (mirrors db.ts's
 * claimAction pattern used by the social engagement executor).
 */
const mockUpdate = jest.fn();
jest.mock('aws-sdk', () => {
  const client = () => ({ update: mockUpdate });
  return {
    __esModule: true,
    default: {
      DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
      config: { update: jest.fn() },
    },
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(client) },
    config: { update: jest.fn() },
  };
});

import { dripSequenceDb } from '../services/dripSequenceDb';

const ok = () => ({ promise: () => Promise.resolve({}) });
const conditionalFail = () => ({
  promise: () =>
    Promise.reject(Object.assign(new Error('conditional failed'), { code: 'ConditionalCheckFailedException' })),
});

beforeEach(() => {
  mockUpdate.mockReset();
});

describe('dripSequenceDb.claimEnrollment', () => {
  it('claims an unclaimed enrollment', async () => {
    mockUpdate.mockReturnValue(ok());

    const result = await dripSequenceDb.claimEnrollment('enr-1', 'instance-a');

    expect(result).toBe(true);
    const params = mockUpdate.mock.calls[0][0];
    expect(params.UpdateExpression).toMatch(/claimedAt = :now/);
    expect(params.ConditionExpression).toBe(
      'attribute_not_exists(claimedAt) OR claimedAt <= :staleThreshold',
    );
    expect(params.ExpressionAttributeValues[':instanceId']).toBe('instance-a');
  });

  it('fails to claim an enrollment already claimed within the stale window', async () => {
    mockUpdate.mockReturnValue(conditionalFail());

    const result = await dripSequenceDb.claimEnrollment('enr-1', 'instance-a');

    expect(result).toBe(false);
  });

  it('propagates unexpected DynamoDB errors instead of swallowing them', async () => {
    mockUpdate.mockReturnValue({
      promise: () =>
        Promise.reject(Object.assign(new Error('throttled'), { code: 'ProvisionedThroughputExceededException' })),
    });

    await expect(dripSequenceDb.claimEnrollment('enr-1', 'instance-a')).rejects.toThrow('throttled');
  });

  it('derives the stale-window boundary from the given threshold', async () => {
    mockUpdate.mockReturnValue(ok());
    const before = Date.now();

    await dripSequenceDb.claimEnrollment('enr-1', 'instance-a', 5000);

    const params = mockUpdate.mock.calls[0][0];
    const staleThreshold = new Date(params.ExpressionAttributeValues[':staleThreshold']).getTime();
    expect(staleThreshold).toBeGreaterThanOrEqual(before - 5000 - 1000);
    expect(staleThreshold).toBeLessThanOrEqual(before - 5000 + 1000);
  });
});

describe('dripSequenceDb.releaseEnrollmentClaim', () => {
  it('removes the claim', async () => {
    mockUpdate.mockReturnValue(ok());

    await dripSequenceDb.releaseEnrollmentClaim('enr-1');

    const params = mockUpdate.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('REMOVE claimedAt');
    expect(params.Key).toEqual({ enrollmentId: 'enr-1' });
  });

  it('does not throw when the underlying update fails (best-effort release)', async () => {
    mockUpdate.mockReturnValue({ promise: () => Promise.reject(new Error('network blip')) });

    await expect(dripSequenceDb.releaseEnrollmentClaim('enr-1')).resolves.toBeUndefined();
  });
});
