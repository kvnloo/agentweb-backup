/**
 * End-to-end coverage for ENG-1596's client_id admin scoping, through the real
 * tool registry — read-only (list_tasks, manage_leads action:'list'/'get').
 * resolveClientScopedContext itself is unit-tested in
 * mcp.adminClientScope.test.ts; this file proves the wiring from a tool's
 * `args.client_id` through to what mcpFetch actually receives as
 * `context.overrideToken`.
 *
 * Writes (manage_leads action:'add'/'update'/'delete') are deliberately NOT
 * scoped by client_id — cross-account mutation needs its own authorization
 * review (ENG-1557: staff roles, attribution, audit) before it ships. Those
 * actions must reject client_id loudly rather than silently ignoring it or
 * writing to the wrong account.
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

  describe('read path — manage_leads action:list / action:get', () => {
    it('reaches the target client\'s list via a minted delegate token for action:list', async () => {
      mockUserDb.getUserById.mockResolvedValue(admin as any);
      mockUserDb.getUserByEmail.mockResolvedValue(target as any);
      mockMcpFetch.mockResolvedValue({ leads: [] });

      await mcpToolRegistry.execute('manage_leads', {
        action: 'list',
        list_id: 'list-1',
        client_id: 'client@example.com',
      }, callerContext);

      const call = mockMcpFetch.mock.calls[0][0];
      expect(call.method).toBe('GET');
      expect(call.path).toBe('/api/crm/lists/list-1/leads');
      const decoded = jwt.verify(call.context.overrideToken!, 'test-secret') as any;
      expect(decoded.userId).toBe('target-1');
    });

    it('reaches the target client\'s lead via a minted delegate token for action:get', async () => {
      mockUserDb.getUserById.mockResolvedValue(admin as any);
      mockUserDb.getUserByEmail.mockResolvedValue(target as any);
      mockMcpFetch.mockResolvedValue({ leadId: 'lead-1' });

      await mcpToolRegistry.execute('manage_leads', {
        action: 'get',
        list_id: 'list-1',
        lead_id: 'lead-1',
        client_id: 'client@example.com',
      }, callerContext);

      const call = mockMcpFetch.mock.calls[0][0];
      expect(call.path).toBe('/api/crm/lists/list-1/leads/lead-1');
      const decoded = jwt.verify(call.context.overrideToken!, 'test-secret') as any;
      expect(decoded.userId).toBe('target-1');
    });
  });

  // ENG-1557: writes via client_id are out of scope until the authorization
  // contract (staff roles, attribution, audit) is reviewed. Rejected loudly,
  // BEFORE any admin check or DB lookup — this isn't "not authorized for you
  // specifically," it's "not supported for this action at all yet."
  describe('write path — manage_leads action:add/update/delete (blocked, ENG-1557)', () => {
    it('rejects client_id on action:add before any DB lookup or write, even for a real admin', async () => {
      await expect(
        mcpToolRegistry.execute('manage_leads', {
          action: 'add',
          list_id: 'list-1',
          leads: [{ email: 'lead@example.com' }],
          client_id: 'client@example.com',
        }, callerContext)
      ).rejects.toThrow('client_id is not supported for manage_leads action "add"');

      expect(mockUserDb.getUserById).not.toHaveBeenCalled();
      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    it('rejects client_id on action:update', async () => {
      await expect(
        mcpToolRegistry.execute('manage_leads', {
          action: 'update',
          list_id: 'list-1',
          lead_id: 'lead-1',
          updates: { stage: 'in_deal' },
          client_id: 'client@example.com',
        }, callerContext)
      ).rejects.toThrow('client_id is not supported for manage_leads action "update"');

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    it('rejects client_id on action:delete', async () => {
      await expect(
        mcpToolRegistry.execute('manage_leads', {
          action: 'delete',
          list_id: 'list-1',
          lead_ids: ['lead-1'],
          client_id: 'client@example.com',
        }, callerContext)
      ).rejects.toThrow('client_id is not supported for manage_leads action "delete"');

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    it('still writes to the caller\'s own list, unaffected, when client_id is omitted', async () => {
      mockMcpFetch.mockResolvedValue({ added: 1 });

      await mcpToolRegistry.execute('manage_leads', {
        action: 'add',
        list_id: 'list-1',
        leads: [{ email: 'lead@example.com' }],
      }, callerContext);

      expect(mockUserDb.getUserById).not.toHaveBeenCalled();
      const call = mockMcpFetch.mock.calls[0][0];
      expect(call.context.overrideToken).toBeUndefined();
      expect(call.context.userId).toBe('admin-1');
    });
  });
});
