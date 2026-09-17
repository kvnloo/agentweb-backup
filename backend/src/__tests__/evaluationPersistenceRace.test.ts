import crypto from 'crypto';

const USER = 'eval_race';
let root: any;
let beforeWrite: () => void;
const persisted: any[] = [];
let credential: any;
const mockDb = {
  get: jest.fn(() => ({ promise: async () => ({ Item: credential }) })),
  query: jest.fn(() => ({ promise: async () => ({ Items: [credential] }) })),
  put: jest.fn((p: any) => ({ promise: async () => { beforeWrite(); persisted.push(p); return {}; } })),
  update: jest.fn((p: any) => ({ promise: async () => { beforeWrite(); persisted.push(p); return {}; } })),
  transactWrite: jest.fn((p: any) => ({ promise: async () => {
    beforeWrite();
    const guard = p.TransactItems.find((w: any) => w.ConditionCheck?.TableName.endsWith('AW-Evaluations'))?.ConditionCheck;
    // Evaluate the submitted root predicate at commit time, not at the earlier read.
    if (guard) {
      const values = guard.ExpressionAttributeValues;
      const expression = guard.ConditionExpression.replace(/#[a-zA-Z]+/g, (key: string) => guard.ExpressionAttributeNames[key]);
      const allowed = expression.split(' AND ').map((clause: string) => {
        const absent = /^attribute_not_exists\((\w+)\)$/.exec(clause);
        if (absent) return !root || !Object.prototype.hasOwnProperty.call(root, absent[1]);
        const match = /^(\w+) (=|>) (:\w+)$/.exec(clause);
        if (!match || !(match[3] in values)) throw new Error(`Unsupported condition: ${clause}`);
        return match[2] === '=' ? root?.[match[1]] === values[match[3]] : root?.[match[1]] > values[match[3]];
      }).every(Boolean);
      if (!allowed) throw Object.assign(new Error('inactive evaluation'), { code: 'TransactionCanceledException',
        CancellationReasons: p.TransactItems.map((w: any) => ({ Code: w.ConditionCheck === guard ? 'ConditionalCheckFailed' : 'None' })) });
    }
    persisted.push(...p.TransactItems.filter((w: any) => !w.ConditionCheck));
    return {};
  } })),
};
jest.mock('aws-sdk', () => ({ DynamoDB: { DocumentClient: jest.fn(() => mockDb) }, S3: jest.fn(), config: { update: jest.fn() } }));
jest.mock('../services/evaluationStore', () => ({ evaluationStore: { get: jest.fn(async () => ({ ...root })) } }));
import { AgentApiKeyService } from '../services/agentApiKeyService';
import { McpOAuthService } from '../mcp/oauth/oauthService';
import { DynamoMcpSessionStore } from '../mcp/server/mcpSessionStore';
import { scheduleDb } from '../services/scheduleDb';
import { scheduleDb as chatScheduleDb, scheduleTemplateDb } from '../services/db';
import { recordMcpConnectionAttempt, recordMcpOAuthAuthorized, recordMcpOAuthTokenIssued } from '../services/mcpUsageEventsService';
import { getSandboxOverlayStore } from '../services/sandbox/sandboxOverlayStore';

const auth = { userId: USER, clientId: 'client', scope: 'mcp', redirectUri: 'https://example.invalid', codeChallenge: crypto.createHash('sha256').update('verifier').digest('base64url'), codeChallengeMethod: 'S256' };
const schedule = { userId: USER, scheduleId: 'schedule', taskId: 'task', frequency: 'daily', status: 'active', nextRunTime: '2026-09-14', createdAt: '2026-09-13', updatedAt: '2026-09-13' };
const paths: [string, () => Promise<unknown>][] = [
  ['API key', () => new AgentApiKeyService().generateKey(USER, 'race')],
  ['API key usage', () => new AgentApiKeyService().updateLastUsed('key', USER)],
  ['API key direct usage', () => new AgentApiKeyService().updateLastUsed('key')],
  ['API key revocation', () => new AgentApiKeyService().revokeKey('key', USER)],
  ['authorization code', () => new McpOAuthService().createAuthorizationCode(auth)],
  ['code consumption', () => new McpOAuthService().consumeAuthorizationCode('code', 'client', auth.redirectUri, 'verifier')],
  ['token pair', () => new McpOAuthService().createTokenPair(auth)],
  ['refresh successor', () => new McpOAuthService().refreshTokens('refresh', 'client')],
  ['refresh descendant', () => { credential.tokenHash = 'child-token'; return new McpOAuthService().refreshTokens('refresh', 'client'); }],
  ['refresh replay revocation', () => { credential.revoked = true; return new McpOAuthService().refreshTokens('refresh', 'client'); }],
  ['MCP session', () => new DynamoMcpSessionStore(3600000).set({ sessionId: 'session', agentUserId: USER, isInternal: false })],
  ['MCP touch', () => new DynamoMcpSessionStore(3600000).touch('session')],
  ['task schedule', () => scheduleDb.createSchedule(schedule)],
  ['chat schedule', () => chatScheduleDb.createSchedule(schedule)],
  ['template usage', () => scheduleTemplateDb.incrementUsageCount('template', USER)],
  ['MCP connection telemetry', () => recordMcpConnectionAttempt({ userId: USER })],
  ['OAuth authorization telemetry', () => recordMcpOAuthAuthorized({ userId: USER })],
  ['OAuth token telemetry', () => recordMcpOAuthTokenIssued({ userId: USER })],
  ['overlay', () => { credential = undefined; return getSandboxOverlayStore(mockDb as any).mutate(USER, current => ({ ...current, nextId: 9 })); }],
];

beforeEach(() => {
  jest.clearAllMocks();
  root = { userId: USER, status: 'active', expiresAt: Date.now() + 3600000 };
  credential = { ...auth, code: 'code', used: false, expiresAt: Math.floor(Date.now() / 1000) + 3600,
    tokenHash: 'root-token', familyId: 'root-token', familyRevoked: false, revoked: false,
    refreshTokenHash: crypto.createHash('sha256').update('refresh').digest('hex'), refreshExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    sessionId: 'session', agentUserId: USER, ttl: Math.floor(Date.now() / 1000) + 3600 };
  beforeWrite = () => undefined;
  persisted.length = 0;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it.each(paths)('%s preserves active evaluation writes', async (_name, write) => {
  await write();
  expect(persisted.length).toBeGreaterThan(0);
});

describe.each([
  ['reset', () => { root.lifecycleState = 'resetting'; }],
  ['purge started', () => { root.lifecycleState = 'purging'; }],
  ['purged', () => { root.status = 'revoked'; root.lifecycleState = 'purged'; }],
  ['revoked', () => { root.status = 'revoked'; }],
  ['missing root', () => { root = undefined; }],
  ['null lifecycle marker', () => { root.lifecycleState = null; }],
  // Must be unambiguously in the PAST, not "expires exactly now". The guard this case
  // simulates is `expiresAt > :now`, and :now is captured when the request is built —
  // strictly before this transition runs at commit time. Date.now() here equals that
  // :now only while under a millisecond elapses between the two. On a loaded machine it
  // does not: the root then reads as still-valid, the write is allowed, and
  // "cannot persist" fails. That made this suite fail under full-suite CPU contention
  // while passing in isolation — which reads as cross-suite pollution and is not.
  ['expired root', () => { root.expiresAt = Date.now() - 3600000; }],
  ['foreign root owner', () => { root.userId = 'eval_someone-else'; }],
] as const)('%s between read and commit', (_name, transition) => {
  it.each(paths)('%s cannot persist', async (_path, write) => {
    beforeWrite = transition;
    // Some public authentication paths deliberately return null on denial.
    const failure = await write().then(() => undefined, error => error);
    if (failure) expect(failure.message).toMatch(/inactive evaluation|Evaluation access denied/);
    expect(persisted).toEqual([]);
    expect(mockDb.transactWrite).toHaveBeenCalled();
    const transactions = mockDb.transactWrite.mock.calls.map(([request]) => request);
    for (const request of transactions) {
      const guard = request.TransactItems.find((w: any) => w.ConditionCheck?.Key.evaluationKey === `evaluation/${USER}`)?.ConditionCheck;
      expect(guard).toMatchObject({ TableName: 'AW-Evaluations',
        ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':active': 'active', ':user': USER } });
      expect(guard.ConditionExpression).toContain('#status = :active');
      expect(guard.ConditionExpression).toContain('attribute_not_exists(lifecycleState)');
    }
  });
});

it('ordinary principals keep their single-item creation paths', async () => {
  const userId = 'ordinary-user';
  await new AgentApiKeyService().generateKey(userId, 'normal');
  await new McpOAuthService().createAuthorizationCode({ ...auth, userId });
  await new McpOAuthService().createTokenPair({ ...auth, userId });
  await new DynamoMcpSessionStore(3600000).set({ sessionId: 'normal', agentUserId: userId, isInternal: false });
  await scheduleDb.createSchedule({ ...schedule, userId });
  await chatScheduleDb.createSchedule({ ...schedule, userId });
  expect(mockDb.transactWrite).not.toHaveBeenCalled();
  expect(mockDb.put).toHaveBeenCalledTimes(6);
});

it.each([undefined, { userId: 42 }, { userId: '' }])('direct API key usage cannot recreate a missing or malformed credential: %p', async record => {
  credential = record;
  await new AgentApiKeyService().updateLastUsed('key');
  expect(persisted).toEqual([]);
});

it.each([42, {}, [], true, null, ''])('MCP touch rejects a malformed persisted owner: %p', async agentUserId => {
  credential.agentUserId = agentUserId;
  const store = new DynamoMcpSessionStore(3600000);
  expect(await store.get('session')).toBeNull();
  await expect(store.touch('session')).rejects.toThrow('Invalid MCP session owner');
  expect(persisted).toEqual([]);
});

it('sandbox telemetry deduplication remains a no-op and infrastructure errors propagate', async () => {
  mockDb.transactWrite.mockImplementationOnce((request: any) => ({ promise: async () => {
    throw Object.assign(new Error('duplicate'), { code: 'TransactionCanceledException',
      CancellationReasons: request.TransactItems.map((item: any) => ({ Code: item.Put ? 'ConditionalCheckFailed' : 'None' })) });
  } }));
  expect(await recordMcpOAuthAuthorized({ userId: USER })).toBe(false);
  mockDb.transactWrite.mockImplementationOnce(() => ({ promise: async () => { throw new Error('storage unavailable'); } }));
  await expect(recordMcpOAuthAuthorized({ userId: USER })).rejects.toThrow('storage unavailable');
  expect(persisted).toEqual([]);
});
