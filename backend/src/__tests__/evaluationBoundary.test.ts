import { ToolRegistry } from '../mcp/client/toolRegistry';
import { McpToolRegistry } from '../mcp/server/registry';
import { getUserFromToken } from '../middleware/auth';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';

jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_name: string, context: unknown) => context,
}));
jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'synthetic-test-signing-secret-only' }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByEmailConsistent: jest.fn() } }));
jest.mock('../services/evaluationStore', () => ({
  evaluationStore: { get: jest.fn().mockResolvedValue({ userId: 'eval_test', status: 'active', expiresAt: Date.now() + 60000 }) },
}));

describe('ENG-1870 acceptance: production side effects cannot execute', () => {
  const execute = jest.fn().mockResolvedValue({ success: true });
  const context = { userId: 'eval_test', sessionId: 's', llmModel: 'test', service: {}, isDelegatedAdmin: true, mockMode: true };
  beforeEach(() => execute.mockClear());

  it.each(['create_meta_campaign', 'send_email', 'browser_run_code', 'unknown_future_tool'])(
    'Emma denies %s even with inherited admin and mock-mode flags', async name => {
      const registry = new ToolRegistry();
      registry.register({ name, definition: {}, execute });
      await expect(registry.execute(name, { userId: 'staff', client_id: 'other' }, context)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('MCP denies indirect execution and credential installation', async () => {
    const registry = new McpToolRegistry();
    registry.register({ name: 'install_mcp_server', definition: {}, execute });
    await expect(registry.execute('install_mcp_server', {}, context)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('an evaluation service token cannot inherit staff authorization', async () => {
    const token = jwt.sign({ userId: 'eval_test', email: 'test@example.invalid', isAdmin: true, _svc: true }, 'synthetic-test-signing-secret-only');
    const result = await getUserFromToken({ headers: { authorization: `Bearer ${token}` } } as any);
    expect(result.user).toBeNull();
  });

  it('ordinary customer tool execution is unchanged', async () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'create_meta_campaign', definition: {}, execute });
    await expect(registry.execute('create_meta_campaign', {}, { ...context, userId: 'customer' })).resolves.toEqual({ success: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('a just-provisioned evaluation authenticates through its primary record before its GSI catches up', async () => {
    const { evaluationStore } = await import('../services/evaluationStore');
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: 'case@example.invalid', status: 'active', expiresAt: Date.now() + 60000 });
    (userDb.getUserById as jest.Mock).mockResolvedValue(undefined);
    (userDb.getUserByEmailConsistent as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: 'case@example.invalid', isActive: true, isAdmin: false });
    const token = jwt.sign({ userId: 'eval_test', email: 'case@example.invalid' }, 'synthetic-test-signing-secret-only');
    const result = await getUserFromToken({ headers: { authorization: `Bearer ${token}` } } as any);
    expect(result.user).toMatchObject({ userId: 'eval_test', isAdmin: false, roles: ['customer'] });
  });
});
