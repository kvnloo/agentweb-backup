// Tests for userDb.updateUser's optional ConditionExpression (ENG-792).
//
// Callers that decide WHETHER to write from a prior read — the onboarding
// ad-image axis, where only the run that owns `adImageStartedAt` may publish a
// terminal state — cannot express that decision with a read plus an
// unconditional update: a competing run can stamp the axis in between and gets
// stomped by the very write the ownership check exists to prevent. The
// condition carries the decision into the write itself, and an unmet condition
// is the caller's guard firing, not a DynamoDB fault, so it must come back
// untouched (and unlogged) for the caller to handle.

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    query: jest.fn(),
    update: jest.fn(),
  };

  const mockS3 = {
    putObject: jest.fn().mockReturnThis(),
    getObject: jest.fn().mockReturnThis(),
    deleteObject: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({}),
  };

  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDynamoDB),
    },
    S3: jest.fn(() => mockS3),
    config: {
      update: jest.fn(),
    },
  };
});

import AWS from 'aws-sdk';
import { userDb } from '../services/db';

describe('userDb.updateUser — optional ConditionExpression', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDynamoDB = new DocumentClient();
    mockDynamoDB.query.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [{ userId: 'u1', email: 'u1@example.com' }],
      }),
    });
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Attributes: { userId: 'u1' } }),
    });
  });

  it('omits ConditionExpression entirely when no condition is passed', async () => {
    await userDb.updateUser('u1', { adImageStatus: 'failed' } as any);

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.ConditionExpression).toBeUndefined();
  });

  it('passes the condition expression and merges its names and values', async () => {
    await userDb.updateUser('u1', { adImageStatus: 'failed' } as any, {
      condition: {
        expression: '#axisStart = :axisStart',
        names: { '#axisStart': 'adImageStartedAt' },
        values: { ':axisStart': '2026-08-04T00:00:00.000Z' },
      },
    });

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.ConditionExpression).toBe('#axisStart = :axisStart');
    // Merged alongside the update's own placeholders, not replacing them.
    expect(call.ExpressionAttributeNames).toEqual({
      '#adImageStatus': 'adImageStatus',
      '#axisStart': 'adImageStartedAt',
    });
    expect(call.ExpressionAttributeValues).toEqual({
      ':adImageStatus': 'failed',
      ':axisStart': '2026-08-04T00:00:00.000Z',
    });
  });

  it('supports a values-less condition (attribute_not_exists) without inventing an empty values map', async () => {
    // A REMOVE-only update plus an existence check has no values at all, and
    // DynamoDB rejects an empty ExpressionAttributeValues map.
    await userDb.updateUser('u1', { adImageError: null } as any, {
      condition: {
        expression: 'attribute_not_exists(#axisStart)',
        names: { '#axisStart': 'adImageStartedAt' },
      },
    });

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.ConditionExpression).toBe('attribute_not_exists(#axisStart)');
    expect(call.UpdateExpression).toBe('REMOVE #adImageError');
    expect(call.ExpressionAttributeValues).toBeUndefined();
  });

  it('re-throws a ConditionalCheckFailedException verbatim, without logging it as an error', async () => {
    const conditionalFailure = Object.assign(new Error('The conditional request failed'), {
      code: 'ConditionalCheckFailedException',
    });
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockRejectedValue(conditionalFailure),
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      userDb.updateUser('u1', { adImageStatus: 'failed' } as any, {
        condition: { expression: 'attribute_not_exists(#axisStart)', names: { '#axisStart': 'adImageStartedAt' } },
      }),
    ).rejects.toBe(conditionalFailure);
    expect(errSpy).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('still logs and re-throws other DynamoDB errors on a conditional write', async () => {
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockRejectedValue(
        Object.assign(new Error('boom'), { code: 'ProvisionedThroughputExceededException' }),
      ),
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      userDb.updateUser('u1', { adImageStatus: 'failed' } as any, {
        condition: { expression: 'attribute_not_exists(#axisStart)', names: { '#axisStart': 'adImageStartedAt' } },
      }),
    ).rejects.toThrow('boom');
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it('logs a ConditionalCheckFailedException on an UNconditional write — there it really is a fault', async () => {
    mockDynamoDB.update.mockReturnValue({
      promise: jest.fn().mockRejectedValue(
        Object.assign(new Error('The conditional request failed'), {
          code: 'ConditionalCheckFailedException',
        }),
      ),
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      userDb.updateUser('u1', { adImageStatus: 'failed' } as any),
    ).rejects.toThrow('The conditional request failed');
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });
});
