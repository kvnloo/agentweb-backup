/**
 * End-to-end coverage for ENG-1596's client_id admin scoping, through the real
 * tool registry — covering both a read (list_tasks) and a write (manage_leads
 * action:'add'), since AC #2 explicitly requires both. resolveClientScopedContext
 * itself is unit-tested in mcp.adminClientScope.test.ts; this file proves the
 * wiring from a tool's `args.client_id` through to what mcpFetch actually
 * receives as `context.overrideToken`.
 */

import jwt from 'jsonwebtoken';

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
  },
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { userDb } from '../services/db';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

describe('admin client_id scoping — end to end (ENG-1596)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  const admin = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
  const target = { userId: 'target-1', email: 'client@example.com', roles: ['customer'] };
  const callerContext = { userId: 'admin-1', agentUserId: 'admin-1' };

  describe('read path — list_tasks', () => {
    it('reaches the target client\'s data via a minted delegate token, not the admin\'s own', async () => {
      mockUserDb.getUserById.mockResolvedValue(admin as any);
      mockUserDb.getUserByEmail.mockResolvedValue(target as any);
      mockMcpFetch.mockResolvedValue([{ taskId: 'client-task-1' }]);

      await mcpToolRegistry.execute('list_tasks', { client_id: 'client@example.com' }, callerContext);

      expect(mockMcpFetch).toHaveBeenCalledTimes(1);
      const call = mockMcpFetch.mock.calls[0][0];
      expect(call.path).toBe('/api/tasks');
      expect(call.context.overrideToken).toBeDefined();

      const decoded = jwt.verify(call.context.overrideToken!, 'test-secret') as any;
      expect(decoded.userId).toBe('target-1');
      expect(decoded.delegateAccess.adminUserId).toBe('admin-1');
      expect(decoded.delegateAccess.targetUserId).toBe('target-1');
    });

    it('rejects a non-admin caller before calling mcpFetch at all', async () => {
      mockUserDb.getUserById.mockResolvedValue({ userId: 'caller-1', isAdmin: false } as any);

      await expect(
        mcpToolRegistry.execute('list_tasks', { client_id: 'client@example.com' }, { userId: 'caller-1' })
      ).rejects.toThrow('client_id is admin-only');

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    it('keeps caller-scoped behavior unchanged when client_id is omitted', async () => {
      mockMcpFetch.mockResolvedValue([]);

      await mcpToolRegistry.execute('list_tasks', {}, callerContext);

      expect(mockUserDb.getUserById).not.toHaveBeenCalled();
      const call = mockMcpFetch.mock.calls[0][0];
      expect(call.context.overrideToken).toBeUndefined();
      expect(call.context.userId).toBe('admin-1');
    });
  });

  describe('write path — manage_leads action:add', () => {
    it('mutates the target client\'s list, not the admin\'s own', async () => {
      mockUserDb.getUserById.mockResolvedValue(admin as any);
      mockUserDb.getUserByEmail.mockResolvedValue(target as any);
      mockMcpFetch.mockResolvedValue({ added: 1 });

      await mcpToolRegistry.execute('manage_leads', {
        action: 'add',
        list_id: 'list-1',
        leads: [{ email: 'lead@example.com' }],
        client_id: 'client@example.com',
      }, callerContext);

      expect(mockMcpFetch).toHaveBeenCalledTimes(1);
      const call = mockMcpFetch.mock.calls[0][0];
      expect(call.method).toBe('POST');
      expect(call.path).toBe('/api/crm/lists/list-1/leads');
      expect(call.context.overrideToken).toBeDefined();

      const decoded = jwt.verify(call.context.overrideToken!, 'test-secret') as any;
      expect(decoded.userId).toBe('target-1');
    });

    it('rejects a non-admin caller before any write occurs', async () => {
      mockUserDb.getUserById.mockResolvedValue({ userId: 'caller-1', isAdmin: false } as any);

      await expect(
        mcpToolRegistry.execute('manage_leads', {
          action: 'add',
          list_id: 'list-1',
          leads: [{ email: 'lead@example.com' }],
          client_id: 'client@example.com',
        }, { userId: 'caller-1' })
      ).rejects.toThrow('client_id is admin-only');

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });
  });
});
