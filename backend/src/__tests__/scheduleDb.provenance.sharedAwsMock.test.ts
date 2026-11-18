/**
 * ENG-2816 (step 3): the shared manual `aws-sdk` mock (src/__mocks__/aws-sdk.ts) has a `createSet`, so code that writes a schedule's
 * `provenance` does not throw a TypeError in the many suites that reach createSchedule / updateSchedule through that mock.
 * (No jest.mock factory here: this is the default mock every test file gets.)
 */

type Client = { put: jest.Mock; update: jest.Mock; createSet: (list: unknown) => any };

/** A fresh copy of db.ts over a fresh copy of the shared mock (jest's clearMocks would otherwise wipe what its module-load built). */
function loadDb() {
  let aws: any;
  let db: any;
  jest.isolateModules(() => {
    aws = require('aws-sdk');
    db = require('../services/db');
  });
  const clients = (): Client[] => aws.DynamoDB.DocumentClient.mock.results.map((result: { value: Client }) => result.value);
  const firstCall = (method: 'put' | 'update') => clients().map((client) => client[method].mock.calls[0]).find(Boolean)![0];
  return { scheduleDb: db.scheduleDb, clients, firstCall };
}

describe('the shared aws-sdk mock understands String Sets', () => {
  it('createSet returns an object shaped like the real DynamoDBSet, and refuses an empty list like the real one', () => {
    const { clients } = loadDb();
    const { createSet } = clients()[0];
    expect(createSet(['b', 'a'])).toMatchObject({ wrapperName: 'Set', type: 'String', values: ['b', 'a'] });
    expect(JSON.stringify(createSet(['a']))).toBe('["a"]');
    expect(() => createSet([])).toThrow(/Sets can contain/);
  });

  it('scheduleDb.createSchedule with provenance writes a Set instead of throwing', async () => {
    const { scheduleDb, firstCall } = loadDb();
    await scheduleDb.createSchedule({
      scheduleId: 's1', taskId: 'global', userId: 'owner', frequency: 'daily', nextRunTime: 'x', status: 'active', createdAt: 'x',
      provenance: ['startingMessage'],
    } as any);
    expect(firstCall('put').Item.provenance).toMatchObject({ wrapperName: 'Set', values: ['startingMessage'] });
  });

  it('scheduleDb.updateSchedule with provenanceAdd sends an ADD with a Set instead of throwing', async () => {
    const { scheduleDb, firstCall } = loadDb();
    await scheduleDb.updateSchedule('s1', { keywords: ['a'], provenanceAdd: ['keywords'] });
    const params = firstCall('update');
    expect(params.UpdateExpression).toBe('SET #keywords = :keywords ADD #provenance :provenanceAdd');
    expect(params.ExpressionAttributeValues[':provenanceAdd']).toMatchObject({ wrapperName: 'Set', values: ['keywords'] });
  });
});
