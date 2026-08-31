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

import { fixRequiredFunctionMismatch, SCHEDULE_ID, EXPECTED_OWNER_ID } from '../scripts/fix-eng1404-schedule-required-function';

/**
 * ENG-1404 / ENG-1599 — exercised against the REAL scheduleDb.getScheduleById /
 * scheduleDb.updateSchedule, not the injected mocks the rest of
 * fixEng1404ScheduleRequiredFunction.test.ts uses.
 *
 * That other suite proves the script's own decision logic (owner check, stale-shape
 * check, already-corrected check). This suite proves the resulting patch and
 * expectation actually turn into the DynamoDB UpdateExpression / ConditionExpression
 * this script depends on for its "fail closed on a concurrent change" guarantee —
 * mirroring the harness grantScheduleAutopublish.realDbWrite.test.ts already
 * established for the sibling ENG-1404 script.
 */
describe('ENG-1404 fix-eng1404-schedule-required-function — against the real scheduleDb', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB = new (AWS.DynamoDB as any).DocumentClient();
  });

  const scheduleItem = {
    scheduleId: SCHEDULE_ID,
    userId: EXPECTED_OWNER_ID,
    requiredFunctionCalls: ['twitter_outreach', 'twitter_manage_post'],
  };

  it('reads the schedule via a real DynamoDB GetItem, keyed only on scheduleId', async () => {
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: scheduleItem }) });

    await fixRequiredFunctionMismatch({ apply: false });

    expect(mockDynamoDB.get).toHaveBeenCalledTimes(1);
    const params = mockDynamoDB.get.mock.calls[0][0];
    expect(params.Key).toEqual({ scheduleId: SCHEDULE_ID });
  });

  it('sends a real DynamoDB UpdateItem with the corrected array and a matching ConditionExpression', async () => {
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: scheduleItem }) });
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Attributes: {} }) });

    const result = await fixRequiredFunctionMismatch({ apply: true });

    expect(result.applied).toBe(true);
    expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);
    const params = mockDynamoDB.update.mock.calls[0][0];

    expect(params.Key).toEqual({ scheduleId: SCHEDULE_ID });

    const names = params.ExpressionAttributeNames;
    const requiredFnsSetAlias = Object.keys(names).find(
      (k) => names[k] === 'requiredFunctionCalls' && params.UpdateExpression.includes(`${k} = :${k.slice(1)}`)
    );
    expect(requiredFnsSetAlias).toBeDefined();
    expect(params.ExpressionAttributeValues[`:${requiredFnsSetAlias!.slice(1)}`]).toEqual([
      'twitter_outreach',
      'post_on_connected_account',
    ]);

    // The condition must pin the EXACT array this run read (the stale value), not
    // the corrected one being written — that's what makes a concurrent edit fail
    // closed instead of being silently overwritten.
    expect(params.ConditionExpression).toContain('#expected');
    const expectedAliases = Object.keys(names).filter((k) => params.ConditionExpression.includes(k));
    const requiredFnsExpectAlias = expectedAliases.find((k) => names[k] === 'requiredFunctionCalls');
    const userIdExpectAlias = expectedAliases.find((k) => names[k] === 'userId');
    expect(requiredFnsExpectAlias).toBeDefined();
    expect(userIdExpectAlias).toBeDefined();
    expect(params.ExpressionAttributeValues[`:${requiredFnsExpectAlias!.slice(1)}`]).toEqual([
      'twitter_outreach',
      'twitter_manage_post',
    ]);
    expect(params.ExpressionAttributeValues[`:${userIdExpectAlias!.slice(1)}`]).toBe(EXPECTED_OWNER_ID);
  });

  it('a real ConditionalCheckFailedException (schedule changed since it was read) surfaces rather than being swallowed', async () => {
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: scheduleItem }) });
    const err: any = new Error('The conditional request failed');
    err.code = 'ConditionalCheckFailedException';
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(err) });

    await expect(fixRequiredFunctionMismatch({ apply: true })).rejects.toThrow('The conditional request failed');
  });

  it('a dry run against the real default never calls UpdateItem', async () => {
    mockDynamoDB.get.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: scheduleItem }) });

    const result = await fixRequiredFunctionMismatch({ apply: false });

    expect(result.applied).toBe(false);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });
});
