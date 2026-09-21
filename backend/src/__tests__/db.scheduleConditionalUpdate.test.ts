import AWS from 'aws-sdk';

jest.mock('aws-sdk', () => {
  const mockDynamoDB = {
    get: jest.fn(),
    update: jest.fn(),
  };
  const mockS3 = {
    putObject: jest.fn().mockReturnThis(),
    getObject: jest.fn().mockReturnThis(),
    deleteObject: jest.fn().mockReturnThis(),
    promise: jest.fn().mockResolvedValue({}),
  };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDynamoDB) },
    S3: jest.fn(() => mockS3),
    config: { update: jest.fn() },
  };
});

import { scheduleDb } from '../services/db';

/**
 * ENG-827 — updateSchedule's optional expectation clause.
 *
 * A caller that DERIVES what it writes from what it read cannot write
 * unconditionally: a concurrent edit between the read and the write turns the write
 * into a decision nobody made. The publish-consent grant is exactly that shape — it
 * records a tool scope computed from the schedule's required functions — so the check
 * and the write have to be one operation, which on DynamoDB means a ConditionExpression.
 */
describe('ENG-827 — scheduleDb.updateSchedule conditional writes', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB = new (AWS.DynamoDB as any).DocumentClient();
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Attributes: {} }) });
  });

  it('sends no ConditionExpression when nothing is expected', async () => {
    await scheduleDb.updateSchedule('sc-1', { scheduleName: 'Renamed' } as any);

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toBeUndefined();
  });

  it('asserts the expected value without disturbing the update itself', async () => {
    await scheduleDb.updateSchedule(
      'sc-1',
      { autopublishAuthorized: true } as any,
      { requiredFunctionCalls: ['post_on_connected_account'] }
    );

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toBe('#expected0 = :expected0');
    expect(params.ExpressionAttributeNames['#expected0']).toBe('requiredFunctionCalls');
    expect(params.ExpressionAttributeValues[':expected0']).toEqual(['post_on_connected_account']);
    // The SET clause must still be exactly the caller's updates.
    expect(params.UpdateExpression).toBe('SET #autopublishAuthorized = :autopublishAuthorized');
  });

  it('expects absence when the expected value is undefined', async () => {
    await scheduleDb.updateSchedule(
      'sc-1',
      { autopublishAuthorized: true } as any,
      { autopublishAuthorizedBy: undefined }
    );

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toBe('attribute_not_exists(#expected0)');
    // An absence check must not bind a value — DynamoDB rejects unused values.
    expect(params.ExpressionAttributeValues[':expected0']).toBeUndefined();
  });

  it('ANDs several expectations together', async () => {
    await scheduleDb.updateSchedule(
      'sc-1',
      { autopublishAuthorized: true } as any,
      { requiredFunctionCalls: ['a'], status: 'active' }
    );

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ConditionExpression).toBe('#expected0 = :expected0 AND #expected1 = :expected1');
  });

  it('does not collide with an update to the same attribute', async () => {
    // The alias namespace has to be separate from the updates', or a caller expecting
    // the OLD value of a field it is also writing would overwrite its own condition.
    await scheduleDb.updateSchedule(
      'sc-1',
      { status: 'paused' } as any,
      { status: 'active' }
    );

    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.ExpressionAttributeValues[':status']).toBe('paused');
    expect(params.ExpressionAttributeValues[':expected0']).toBe('active');
    expect(params.UpdateExpression).toBe('SET #status = :status');
    expect(params.ConditionExpression).toBe('#expected0 = :expected0');
  });

  it('lets ConditionalCheckFailedException reach the caller intact', async () => {
    const err: any = new Error('The conditional request failed');
    err.code = 'ConditionalCheckFailedException';
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(err) });

    // The caller distinguishes "someone edited it underneath me" from a real outage,
    // so the error must not be flattened on the way out.
    await expect(
      scheduleDb.updateSchedule('sc-1', { autopublishAuthorized: true } as any, { requiredFunctionCalls: ['a'] })
    ).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
  });
});
