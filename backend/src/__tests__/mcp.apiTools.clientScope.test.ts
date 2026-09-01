/**
 * End-to-end coverage for ENG-1596's client_id admin scoping, through the real
 * tool registry — read-only (list_tasks, manage_leads action:'list'/'get'),
 * plus ENG-1557 v1's cross-account manage_leads action:'add' (feature-flagged,
 * dry-run-first). resolveClientScopedContext itself is unit-tested in
 * mcp.adminClientScope.test.ts; this file proves the wiring from a tool's
 * `args.client_id` through to what mcpFetch actually receives as
 * `context.overrideToken`.
 *
 * manage_leads action:'update'/'delete' are still deliberately NOT scoped by
 * client_id — that broader cross-account mutation needs its own authorization
 * review (ENG-1557: staff roles, attribution, audit) before it ships. Those
 * actions must reject client_id loudly rather than silently ignoring it or
 * writing to the wrong account. action:'add' graduated out under ENG-1557 v1
 * — scoped narrowly, feature-flagged, dry-run-first.
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
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadByEmail: jest.fn(),
  },
}));

jest.mock('../services/crmAccessControl', () => ({
  canDestructiveCrmList: jest.fn(),
  CRM_EDITOR_REQUIRED_MESSAGE: 'You need CRM-editor access to this list.',
}));

const mockRecordAdminAudit = jest.fn();
jest.mock('../services/adminAuditLog', () => ({
  recordAdminAudit: (...a: any[]) => mockRecordAdminAudit(...a),
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { userDb, crmDb } from '../services/db';
import { canDestructiveCrmList } from '../services/crmAccessControl';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockCanDestructiveCrmList = canDestructiveCrmList as jest.MockedFunction<typeof canDestructiveCrmList>;

describe('admin client_id scoping — end to end (ENG-1596 / ENG-1557 v1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED;
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED;
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

  // ENG-1557: broader cross-account mutation (update/delete) is still out of
  // scope until the full authorization contract (staff roles, attribution,
  // audit) is reviewed. Rejected loudly, BEFORE any admin check or DB lookup
  // — this isn't "not authorized for you specifically," it's "not supported
  // for this action at all yet." action:'add' graduated out — see the
  // "write path — manage_leads action:add + client_id" describe block below.
  describe('write path — manage_leads action:update/delete (still blocked, ENG-1557)', () => {
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
  });

  describe('write path — manage_leads action:add + client_id (ENG-1557 v1)', () => {
    beforeEach(() => {
      mockUserDb.getUserById.mockResolvedValue(admin as any);
      mockUserDb.getUserByEmail.mockResolvedValue(target as any);
    });

    const addArgs = (extra: Record<string, any> = {}) => ({
      action: 'add',
      list_id: 'list-1',
      leads: [{ email: 'lead@example.com' }],
      client_id: 'client@example.com',
      ...extra,
    });

    it('rejects a malformed (non-string) client_id — via the same validation list/get already use', async () => {
      await expect(
        mcpToolRegistry.execute('manage_leads', addArgs({ client_id: 12345 }), callerContext)
      ).rejects.toThrow('client_id must be a non-blank string');

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    it('rejects a non-admin caller before any flag/dry_run logic runs, for either dry_run value', async () => {
      mockUserDb.getUserById.mockResolvedValue({ userId: 'caller-1', isAdmin: false } as any);

      await expect(
        mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: true }), callerContext)
      ).rejects.toThrow('client_id is admin-only');
      await expect(
        mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: false }), callerContext)
      ).rejects.toThrow('client_id is admin-only');

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    it('dry_run:true previews without mutating, regardless of the flag being unset', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', name: 'My List', userId: 'target-1' } as any);
      mockCanDestructiveCrmList.mockResolvedValue(true);
      mockCrmDb.getLeadByEmail.mockResolvedValue(null);

      const result = await mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: true }), callerContext);

      expect(mockMcpFetch).not.toHaveBeenCalled();
      expect(JSON.parse((result as any).content[0].text).wouldSucceed).toBe(true);
      expect(mockCanDestructiveCrmList).toHaveBeenCalledWith('target-1', expect.objectContaining({ userId: 'target-1' }));
      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'planned', dryRun: true, targetUserId: 'target-1' }));
    });

    it('dry_run:true previews without mutating, even when the flag is enabled — dry_run wins', async () => {
      process.env.MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED = 'true';
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', name: 'My List', userId: 'target-1' } as any);
      mockCanDestructiveCrmList.mockResolvedValue(true);
      mockCrmDb.getLeadByEmail.mockResolvedValue(null);

      await mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: true }), callerContext);

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    it('dry_run:false with the flag unset is blocked and audited, never reaches mcpFetch', async () => {
      await expect(
        mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: false }), callerContext)
      ).rejects.toThrow('MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED');

      expect(mockMcpFetch).not.toHaveBeenCalled();
      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked_by_flag', dryRun: false }));
    });

    it('dry_run:false with the flag enabled actually writes to the DELEGATED target, not the admin', async () => {
      process.env.MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED = 'true';
      mockMcpFetch.mockResolvedValue({ leadId: 'new-lead-1' });

      await mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: false }), callerContext);

      expect(mockMcpFetch).toHaveBeenCalledTimes(1);
      const call = mockMcpFetch.mock.calls[0][0];
      expect(call.method).toBe('POST');
      expect(call.path).toBe('/api/crm/lists/list-1/leads');
      // Regression guard for the {leads:[...]} payload-shape bug — the real
      // route reads req.body as a single lead's fields directly.
      expect(call.body).toEqual({ email: 'lead@example.com' });

      const decoded = jwt.verify(call.context.overrideToken!, 'test-secret') as any;
      expect(decoded.userId).toBe('target-1');
      expect(decoded.delegateAccess.targetUserId).toBe('target-1');

      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'planned', dryRun: false }));
      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'created', leadId: 'new-lead-1' }));
    });

    it('records a failed-outcome audit and rethrows when the real write itself fails', async () => {
      process.env.MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED = 'true';
      mockMcpFetch.mockRejectedValue(new Error('downstream 500'));

      await expect(
        mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: false }), callerContext)
      ).rejects.toThrow('downstream 500');

      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', error: 'downstream 500' }));
    });
  });

  describe('manage_leads action:add — self-scoped (no client_id), regression guards', () => {
    it('sends the single lead object directly, not {leads:[...]} — the original payload-shape bug', async () => {
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
      expect(call.body).toEqual({ email: 'lead@example.com' });
    });

    it('rejects a leads array that is empty or has more than one entry', async () => {
      await expect(
        mcpToolRegistry.execute('manage_leads', { action: 'add', list_id: 'list-1', leads: [] }, callerContext)
      ).rejects.toThrow('exactly one lead per call');

      await expect(
        mcpToolRegistry.execute('manage_leads', {
          action: 'add',
          list_id: 'list-1',
          leads: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
        }, callerContext)
      ).rejects.toThrow('exactly one lead per call');

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    it('dry_run:true previews the caller\'s own would-be add, with no client_id involved', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', name: 'My List', userId: 'admin-1' } as any);
      mockCanDestructiveCrmList.mockResolvedValue(true);
      mockCrmDb.getLeadByEmail.mockResolvedValue(null);

      const result = await mcpToolRegistry.execute('manage_leads', {
        action: 'add',
        list_id: 'list-1',
        leads: [{ email: 'lead@example.com' }],
        dry_run: true,
      }, callerContext);

      expect(mockMcpFetch).not.toHaveBeenCalled();
      expect(mockUserDb.getUserById).not.toHaveBeenCalled(); // no client_id — no admin check needed
      expect(JSON.parse((result as any).content[0].text).wouldSucceed).toBe(true);
    });
  });
});
