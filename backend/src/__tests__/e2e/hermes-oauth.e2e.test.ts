/** Native Hermes/Emma protocol proof. Run explicitly with HERMES_REPO; no live credentials or AWS. */
import express from 'express';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const mockRows = new Map<string, any>();
const mockKey = (table: string, item: any) => `${table}:${item.clientId && !item.code && !item.tokenHash ? item.clientId : item.code || item.tokenHash}`;
jest.mock('aws-sdk', () => ({ __esModule: true, default: {
  DynamoDB: { DocumentClient: jest.fn(() => ({
    put: ({ TableName, Item }: any) => ({ promise: async () => { mockRows.set(mockKey(TableName, Item), { ...Item }); } }),
    get: ({ TableName, Key }: any) => ({ promise: async () => ({ Item: mockRows.get(mockKey(TableName, Key)) }) }),
    update: ({ TableName, Key, ConditionExpression, ExpressionAttributeValues: v }: any) => ({ promise: async () => {
      const row = mockRows.get(mockKey(TableName, Key));
      if (ConditionExpression && (!row || row.used || row.expiresAt <= v[':now'])) {
        throw Object.assign(new Error('Conditional failure'), { code: 'ConditionalCheckFailedException' });
      }
      row.used = true;
    } }),
  })) },
} }));
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer fixture-login') return res.sendStatus(401);
    req.user = { userId: 'fixture-user' };
    next();
  },
  getUserFromToken: jest.fn(),
}));
// The module-owned rate limiter has a private timer; retain its real check logic
// but disable only its cleanup interval so this fixture can tear down cleanly.
jest.mock('../../middleware/rateLimiter', () => {
  const { RateLimiter, rateLimiter } = jest.requireActual('../../middleware/rateLimiter');
  rateLimiter.destroy();
  return { RateLimiter: class extends RateLimiter {
    constructor() { super(); this.destroy(); }
  } };
});
jest.mock('../../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: async () => null } }));
jest.mock('../../services/mcpUsageEventsService', () => ({
  classifyMcpClient: () => 'hermes', recordMcpOAuthStarted: async () => true,
  recordMcpOAuthAuthorized: async () => true, recordMcpOAuthTokenIssued: async () => true,
  recordMcpConnectionAttempt: async () => true,
}));
// Keep the production transport + authentication, replace only the business tool inventory.
jest.mock('../../mcp/server/mcpServerCore', () => ({ createMcpServer: (_name: string, context: any) => {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'fixture_identity', inputSchema: { type: 'object' } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [
    { type: 'text', text: `${context.agentUserId}:${context.isInternal}` },
  ] }));
  return server;
} }));
import { setupMcpOAuth } from '../../mcp/oauth/oauthRoutes';
import { setupMcpServer } from '../../mcp/server/mcpServer';
import { InMemoryMcpSessionStore } from '../../mcp/server/mcpSessionStore';

test('Hermes discovery → DCR → consent → native callback paste → tokens → authenticated MCP', async () => {
  const hermes = process.env.HERMES_REPO;
  if (!hermes) throw new Error('Set HERMES_REPO to a read-only Hermes checkout with its venv installed');
  delete process.env.MCP_OAUTH_SKIP_CONSENT;
  delete process.env.MCP_ACCESS_TOKEN;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  setupMcpOAuth(app);
  setupMcpServer(app, new InMemoryMcpSessionStore(60000));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.BACKEND_URL = base;
  process.env.CUSTOMER_FRONTEND_URL = 'https://consent.example';
  try {
    const { stdout } = await promisify(execFile)(path.join(hermes, 'venv/bin/python'),
      [path.join(__dirname, 'fixtures/hermes-oauth-client.py'), base], {
        env: { ...process.env, PYTHONPATH: hermes, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 20000,
      });
    expect(stdout.trim()).toBe('PASS: native paste, state rejection, PKCE, replay, MCP identity');
    const token = [...mockRows.values()].find(row => row.tokenHash);
    expect(token).toMatchObject({ userId: 'fixture-user', scope: 'mcp:tools' });
    expect(token).not.toHaveProperty('accessToken');
    expect(token).not.toHaveProperty('refreshToken');
  } finally {
    await (app as any).mcpShutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    delete process.env.BACKEND_URL;
    delete process.env.CUSTOMER_FRONTEND_URL;
  }
}, 30000);
