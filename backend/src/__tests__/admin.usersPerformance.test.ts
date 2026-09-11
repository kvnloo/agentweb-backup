// Exercise the real storage implementation at the DocumentClient boundary.
const mockQuery = jest.fn();
const mockScan = jest.fn();
jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: { DocumentClient: jest.fn(() => ({
    query: (params: any) => ({ promise: () => mockQuery(params) }),
    scan: (params: any) => ({ promise: () => mockScan(params) }),
    get: jest.fn(() => ({ promise: async () => ({}) })),
  })) },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({ getSecretValue: () => ({ promise: async () => ({ SecretString: 'test-secret' }) }) })),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), getAllSettings: jest.fn() },
}));
import { userDb, orgDb } from '../services/db';
import adminRoutes from '../routes/admin';
import { settingsService } from '../services/settingsService';

// Invoke the registered GET handler without opening a listening socket.
const usersRoute = (adminRoutes as any).stack.find(
  (layer: any) => layer.route?.path === '/users' && layer.route.methods.get
);
const usersHandler = usersRoute.route.stack[0].handle;
async function getAdminUsers() {
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  await usersHandler({ query: {} } as any, res, jest.fn());
  expect(res.status).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0];
}


const users = Array.from({ length: 300 }, (_, i) => ({
  userId: `user-${i}`, email: `person${i}@company.com`,
  connected_accounts: [{ platform: 'hubspot', config: { hub_id: i } }],
  orgId: `org-${i}`, displayName: `Person ${i}`,
}));
const tables = ['AW-Tasks', 'AW-Workflows', 'AW-ChatSessions'];
let rows: Record<string, any[]>;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(orgDb, 'getOrgById').mockResolvedValue(null);
  (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
  (settingsService.getAllSettings as jest.Mock).mockResolvedValue([]);
  rows = {
    'AW-Users': users,
    'AW-Tasks': users.map(u => ({ userId: u.userId })),
    'AW-Workflows': users.map(u => ({ userId: u.userId })),
    'AW-ChatSessions': users.map(u => ({ userId: u.userId })),
  };
  mockScan.mockImplementation(async ({ TableName }: any) => ({ Items: rows[TableName] }));
  mockQuery.mockResolvedValue({ Count: 1 });
});

describe('ENG-1782 batched admin user counts', () => {
  it.each(tables)('reads %s once for 300 users, without per-user queries', async table => {
    const result = await getAdminUsers();
    expect(result).toHaveLength(300);
    expect(mockScan.mock.calls.filter(([p]) => p.TableName === table)).toHaveLength(1);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockScan.mock.calls.filter(([p]) => p.TableName === 'AW-Users')).toHaveLength(1);
    expect(result.every((u: any) => u.taskCount === 1 && u.workflowCount === 1 && u.chatSessionCount === 1)).toBe(true);
  });

  it('returns no users and does not read count tables when empty', async () => {
    rows['AW-Users'] = [];
    expect(await userDb.getAllUsers()).toEqual([]);
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('follows every page, including empty pages, and retains raw caller fields for five known users', async () => {
    rows['AW-Users'] = users.slice(0, 5);
    rows['AW-Tasks'] = [{ userId: 'user-0' }, { userId: 'user-0' }, { userId: 'user-2' }];
    rows['AW-Workflows'] = [{ userId: 'user-1' }, { userId: 'user-1' }];
    rows['AW-ChatSessions'] = [{ userId: 'user-0' }, { userId: 'user-3' }, { userId: 'user-3' }];
    mockScan.mockImplementation(async ({ TableName, ExclusiveStartKey }: any) => {
      if (!ExclusiveStartKey) return { Items: [], LastEvaluatedKey: { cursor: 'empty' } };
      if (ExclusiveStartKey.cursor === 'empty') {
        return { Items: rows[TableName].slice(0, 1), LastEvaluatedKey: { cursor: 'last' } };
      }
      return { Items: rows[TableName].slice(1) };
    });
    const result = await userDb.getAllUsers();
    expect(result).toEqual(users.slice(0, 5).map((u, i) => ({
      ...u, taskCount: [2, 0, 1, 0, 0][i], workflowCount: [0, 2, 0, 0, 0][i],
      chatSessionCount: [1, 0, 0, 2, 0][i],
    })));
    for (const table of ['AW-Users', ...tables]) {
      expect(mockScan.mock.calls.filter(([p]) => p.TableName === table).map(([p]) => p.ExclusiveStartKey))
        .toEqual([undefined, { cursor: 'empty' }, { cursor: 'last' }]);
    }
  });

  it('keeps existing index membership and the non-archived chat filter with only userId projected', async () => {
    await userDb.getAllUsers();
    for (const [table, index] of [['AW-Tasks', 'UserTasksIndex'], ['AW-Workflows', 'UserWorkflowsIndex'], ['AW-ChatSessions', 'UserIdIndex']]) {
      expect(mockScan).toHaveBeenCalledWith(expect.objectContaining({
        TableName: table, IndexName: index, ProjectionExpression: 'userId',
      }));
    }
    expect(mockScan).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'AW-ChatSessions',
      FilterExpression: '(attribute_not_exists(archived) OR archived = :archivedFalse)',
      ExpressionAttributeValues: { ':archivedFalse': false },
    }));
  });

  it('excludes tombstones and optionally bot-like accounts without mutating user records', async () => {
    rows['AW-Users'] = [users[0], { userId: 'deleted_1', email: 'gone@company.com' }, { userId: 'bot', email: 'bot@mailinator.com' }];
    expect((await userDb.getAllUsers()).map(u => u.userId)).toEqual(['user-0', 'bot']);
    expect((await userDb.getAllUsers(true)).map(u => u.userId)).toEqual(['user-0']);
    expect(users[0]).not.toHaveProperty('taskCount');
  });

  it.each([null, { userId: 42, email: 'person@company.com' }, { userId: 'bad', email: {} }, {}, { userId: '' }])('rejects malformed user row %j before sibling callers', async malformed => {
    rows['AW-Users'] = [malformed, users[0]];
    await expect(userDb.getAllUsers(true)).rejects.toThrow();
  });

  it.each(tables)('ignores malformed owner IDs from %s without corrupting valid counts', async table => {
    rows[table] = [null, {}, { userId: 42 }, { userId: {} }, { userId: '' }, { userId: 'unknown' }, { userId: 'user-0' }];
    const result = await userDb.getAllUsers();
    const field = table === 'AW-Tasks' ? 'taskCount' : table === 'AW-Workflows' ? 'workflowCount' : 'chatSessionCount';
    expect(result[0][field]).toBe(1);
    expect(result[1][field]).toBe(0);
  });

  it.each(['AW-Tasks', 'AW-Workflows'])('preserves zero fallback for a failed %s read, discarding partial counts', async table => {
    mockScan.mockImplementation(async ({ TableName, ExclusiveStartKey }: any) => {
      if (TableName !== table) return { Items: rows[TableName] };
      if (!ExclusiveStartKey) return { Items: [{ userId: 'user-0' }], LastEvaluatedKey: { cursor: 'fail' } };
      throw new Error('read failed');
    });
    const result = await userDb.getAllUsers();
    const field = table === 'AW-Tasks' ? 'taskCount' : 'workflowCount';
    expect(result.every(u => u[field] === 0)).toBe(true);
  });

  it.each(['AW-Users', 'AW-ChatSessions'])('propagates %s failures', async table => {
    mockScan.mockImplementation(async ({ TableName }: any) => {
      if (TableName === table) throw new Error('read failed');
      return { Items: rows[TableName] };
    });
    await expect(userDb.getAllUsers()).rejects.toThrow('read failed');
  });
});

it('preserves AdminDashboard fields for five known users through the real storage boundary', async () => {
  rows['AW-Users'] = users.slice(0, 5).map((u, i) => ({
    ...u, orgId: 'known-org', orgRole: i === 0 ? 'owner' : 'member',
    subscriptionType: i === 0 ? 'Pro' : 'Free',
  }));
  rows['AW-Tasks'] = [{ userId: 'user-0' }, { userId: 'user-0' }, { userId: 'user-2' }];
  rows['AW-Workflows'] = [{ userId: 'user-1' }, { userId: 'user-1' }];
  rows['AW-ChatSessions'] = [{ userId: 'user-0' }, { userId: 'user-3' }, { userId: 'user-3' }];
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({
    name: 'Known Company', ownerUserId: 'user-0', shareSettings: { analytics: { enabled: true } },
  });
  (settingsService.getAllSettings as jest.Mock).mockResolvedValue(
    rows['AW-Users'].map((u: any) => ({
      settingName: `replay_sessions_${u.userId}`,
      settingValue: JSON.stringify({ replayUrl: `https://clarity.microsoft.com/replay_sessions_${u.userId}` }),
    }))
  );
  const result = await getAdminUsers();
  expect(settingsService.getAllSettings).toHaveBeenCalledTimes(1);
  expect(settingsService.getSetting).not.toHaveBeenCalled();
  expect(result).toHaveLength(5);
  rows['AW-Users'].forEach((u, i) => expect(result[i]).toMatchObject({
    userId: u.userId, email: u.email, displayName: u.displayName,
    taskCount: [2, 0, 1, 0, 0][i], workflowCount: [0, 2, 0, 0, 0][i],
    chatSessionCount: [1, 0, 0, 2, 0][i],
    orgId: 'known-org', orgRole: i === 0 ? 'owner' : 'member',
    orgName: 'Known Company', isOrgOwner: i === 0, orgShareAnalyticsWithOrg: true,
    subscriptionType: 'Pro', replayUrl: `https://clarity.microsoft.com/replay_sessions_${u.userId}`,
  }));
});

it('preserves raw account data for the real HubSpot and Calendly lookup callers', async () => {
  const { getUserIdByHubSpotPortalId, getAccountsByCalendlyUserUri } = await import('../services/connectedAccountsDb');
  const account = { platform: 'calendly', account_id: 'calendar-1', config: { user_uri: 'https://api.calendly.com/users/known' } };
  rows['AW-Users'] = [users[0], { ...users[1], connected_accounts: [account] }];
  expect(await getUserIdByHubSpotPortalId(0)).toBe('user-0');
  expect(await getAccountsByCalendlyUserUri(account.config.user_uri)).toEqual([{ userId: 'user-1', account }]);
});

it.each(['AW-Users', ...tables])('handles a malformed outer Items collection from %s without partial results', async table => {
  mockScan.mockImplementation(async ({ TableName }: any) => ({ Items: TableName === table ? {} : rows[TableName] }));
  if (table === 'AW-Users' || table === 'AW-ChatSessions') {
    await expect(userDb.getAllUsers()).rejects.toThrow(/Invalid/);
  } else {
    const result = await userDb.getAllUsers();
    const field = table === 'AW-Tasks' ? 'taskCount' : 'workflowCount';
    expect(result.every(u => u[field] === 0)).toBe(true);
  }
});
