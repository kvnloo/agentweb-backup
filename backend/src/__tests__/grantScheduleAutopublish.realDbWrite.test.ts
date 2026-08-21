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

import { backfillPublishConsent } from '../scripts/grant-schedule-autopublish';

/**
 * ENG-1245 — the `tools=` grant path exercised against the REAL
 * scheduleDb.updateSchedule, not the hand-rolled `update` mock the rest of
 * grantScheduleAutopublish.test.ts injects.
 *
 * That other suite proves backfillPublishConsent's OWN decision logic (who is
 * eligible, who is confirmed, what patch gets built) — every case there
 * supplies its own `update: jest.fn()`, so a bug in how the resulting patch
 * and expectation actually get turned into a DynamoDB UpdateExpression /
 * ConditionExpression (attribute names, value binding, attribute_not_exists
 * for an absent `autopublishAuthorized`) would pass every one of those tests
 * and still fail — or silently write something else — against production.
 *
 * This suite calls backfillPublishConsent with NO `update` override, so it
 * falls through to its real default (scheduleDb.updateSchedule), and inspects
 * the actual params handed to the mocked AWS SDK client — the same harness
 * db.scheduleConditionalUpdate.test.ts already uses to pin updateSchedule's
 * conditional-write behavior. `listSchedules` is still injected (plain test
 * data, not a live scan) — this suite is about the WRITE path specifically.
 */
describe('ENG-1245 — grant-schedule-autopublish tools= against the real scheduleDb.updateSchedule', () => {
  let mockDynamoDB: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB = new (AWS.DynamoDB as any).DocumentClient();
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Attributes: {} }) });
  });

  // Harsha's exact schedule shape: never asked (autopublishAuthorized absent),
  // requiredFunctionCalls names no publish tool, so this is un-grantable without
  // tools=.
  const harshaSchedule = {
    scheduleId: '1d001fba-0fb7-4bcd-80f6-6041b244a442',
    scheduleName: 'Harsha Daily X Post (Autonomous)',
    userId: '1743956381327',
    status: 'active',
    requiredFunctionCalls: ['twitter_outreach'],
  };

  const consent = [
    {
      scheduleId: '1d001fba-0fb7-4bcd-80f6-6041b244a442',
      ownerUserId: '1743956381327',
      tools: ['post_on_connected_account'],
      note: 'Harsha confirmed via Linear ENG-1404 on 2026-08-20',
    },
  ];

  it('sends a real DynamoDB update with the explicit tools, not the (empty) requiredFunctionCalls-derived scope', async () => {
    await backfillPublishConsent({
      apply: true,
      confirmedBy: 'Harsha',
      allowlist: consent,
      listSchedules: async () => [harshaSchedule],
    });

    expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);
    const params = mockDynamoDB.update.mock.calls[0][0];

    expect(params.Key).toEqual({ scheduleId: '1d001fba-0fb7-4bcd-80f6-6041b244a442' });
    expect(params.ExpressionAttributeValues[':autopublishAuthorized']).toBe(true);
    expect(params.ExpressionAttributeValues[':autopublishAuthorizedTools']).toEqual(['post_on_connected_account']);
    expect(params.ExpressionAttributeValues[':autopublishAuthorizedBy']).toBe('1743956381327');
  });

  it('conditions the write on the schedule not having moved since the scan — a real ConditionExpression, not just a mock call', async () => {
    await backfillPublishConsent({
      apply: true,
      confirmedBy: 'Harsha',
      allowlist: consent,
      listSchedules: async () => [harshaSchedule],
    });

    const params = mockDynamoDB.update.mock.calls[0][0];
    // requiredFunctionCalls and status are asserted equal; requirePublishApproval and
    // autopublishAuthorized are asserted ABSENT (attribute_not_exists) — undefined at
    // scan time on this schedule.
    expect(params.ConditionExpression).toContain('#expected');
    expect(params.ConditionExpression).toMatch(/attribute_not_exists/);
    const names = params.ExpressionAttributeNames;
    const requiredFnsAlias = Object.keys(names).find((k) => names[k] === 'requiredFunctionCalls');
    const statusAlias = Object.keys(names).find((k) => names[k] === 'status');
    expect(requiredFnsAlias).toBeDefined();
    expect(statusAlias).toBeDefined();
    expect(params.ExpressionAttributeValues[`:${requiredFnsAlias!.slice(1)}`]).toEqual(['twitter_outreach']);
    expect(params.ExpressionAttributeValues[`:${statusAlias!.slice(1)}`]).toBe('active');
  });

  it('a real ConditionalCheckFailedException from the SDK is reported as rejected, not thrown past the caller', async () => {
    const err: any = new Error('The conditional request failed');
    err.code = 'ConditionalCheckFailedException';
    mockDynamoDB.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(err) });

    const result = await backfillPublishConsent({
      apply: true,
      confirmedBy: 'Harsha',
      allowlist: consent,
      listSchedules: async () => [harshaSchedule],
    });

    expect(result.granted).toEqual([]);
    expect(result.rejected[0]).toMatchObject({
      scheduleId: '1d001fba-0fb7-4bcd-80f6-6041b244a442',
      reason: expect.stringMatching(/changed after it was read/),
    });
  });

  it('a dry run against the real default never calls the SDK at all', async () => {
    await backfillPublishConsent({
      apply: false,
      confirmedBy: '',
      allowlist: consent,
      listSchedules: async () => [harshaSchedule],
    });

    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });
});
