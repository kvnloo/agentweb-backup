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

// ENG-2840: every add now runs the do-not-contact inheritance the bulk imports run. Its own behaviour is tested in mcp.manageLeads.writes.test.ts;
// here it is a recorded stub, so what is pinned is WHO it acts for and WITH WHICH token.
jest.mock('../services/leadImportFollowups', () => ({
  applyLeadImportFollowups: jest.fn().mockResolvedValue({ inheritedDoNotContact: [], doNotContactCheckFailed: 0 }),
}));

const mockRecordAdminAudit = jest.fn();
jest.mock('../services/adminAuditLog', () => ({
  recordAdminAudit: (...a: any[]) => mockRecordAdminAudit(...a),
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { applyLeadImportFollowups } from '../services/leadImportFollowups';
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

    // Adversarial-review finding (round 3): a malformed leads/dry_run value
    // that fails AFTER a real admin is correctly scoped to a real target
    // previously left no trace beyond the generic "admin scoped to customer"
    // event — the manage_leads_cross_account_add audit trail itself never
    // recorded that an add was attempted or why it failed.
    it('audits an invalid payload (malformed leads or dry_run) instead of leaving no trace', async () => {
      await expect(
        mcpToolRegistry.execute('manage_leads', addArgs({ leads: [null] }), callerContext)
      ).rejects.toThrow('requires the single lead to be an object');
      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'invalid_payload',
        targetUserId: 'target-1',
      }));

      mockRecordAdminAudit.mockClear();

      await expect(
        mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: 'true' as any }), callerContext)
      ).rejects.toThrow('dry_run must be a boolean');
      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'invalid_payload',
        targetUserId: 'target-1',
      }));

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
      // Adversarial-review finding (round 3): the real-write branch logs a
      // terminal 'created' outcome; the dry-run branch previously stopped at
      // 'planned' with no record of the actual verdict it computed.
      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'previewed', wouldSucceed: true }));
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

      // The write, then the list read the do-not-contact inheritance needs (the owner of the list). Both travel as the DELEGATED target.
      expect(mockMcpFetch).toHaveBeenCalledTimes(2);
      const call = mockMcpFetch.mock.calls[0][0];
      expect(call.method).toBe('POST');
      expect(call.path).toBe('/api/crm/lists/list-1/leads');
      const listRead = mockMcpFetch.mock.calls[1][0];
      expect({ method: listRead.method, path: listRead.path }).toEqual({ method: 'GET', path: '/api/crm/lists/list-1' });
      expect(listRead.context.overrideToken).toBe(call.context.overrideToken);
      // The inheritance flags the new lead on behalf of the ADMIN who acted (the audit identity), not the customer.
      expect(applyLeadImportFollowups).toHaveBeenCalledWith('list-1', expect.any(String), [{ leadId: 'new-lead-1', email: 'lead@example.com' }], { actingUserId: 'admin-1', validate: false });
      // Regression guard for the {leads:[...]} payload-shape bug — the real
      // route reads req.body as a single lead's fields directly.
      expect(call.body).toEqual({ email: 'lead@example.com' });

      const decoded = jwt.verify(call.context.overrideToken!, 'test-secret') as any;
      expect(decoded.userId).toBe('target-1');
      expect(decoded.delegateAccess.targetUserId).toBe('target-1');

      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'planned', dryRun: false }));
      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'created', leadId: 'new-lead-1' }));
    });

    it('when the do-not-contact check fails on the admin add, the answer names the lead that was NOT checked', async () => {
      process.env.MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED = 'true';
      mockMcpFetch.mockResolvedValue({ leadId: 'new-lead-1' });
      (applyLeadImportFollowups as jest.Mock).mockResolvedValueOnce({ inheritedDoNotContact: [], doNotContactCheckFailed: 1 });

      const result: any = await mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: false }), callerContext);
      const body = JSON.parse(result.content[0].text);
      expect(body).toMatchObject({ leadId: 'new-lead-1', doNotContactCheckFailed: 1, doNotContactUnchecked: ['new-lead-1'] });
    });

    it('records a failed-outcome audit and rethrows when the real write itself fails', async () => {
      process.env.MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED = 'true';
      mockMcpFetch.mockRejectedValue(new Error('downstream 500'));

      await expect(
        mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: false }), callerContext)
      ).rejects.toThrow('downstream 500');

      expect(mockRecordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', error: 'downstream 500' }));
    });

    // Adversarial-review finding: `dry_run` is this tool's advertised safety
    // valve for the flag-gated write. A truthy-but-not-boolean value (a
    // caller-side typo, e.g. the string "true") must never silently coerce to
    // `false` and fall through to a real write once the flag is on.
    it('rejects a non-boolean dry_run instead of silently treating it as false', async () => {
      process.env.MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED = 'true';

      await expect(
        mcpToolRegistry.execute('manage_leads', addArgs({ dry_run: 'true' as any }), callerContext)
      ).rejects.toThrow('dry_run must be a boolean');

      expect(mockMcpFetch).not.toHaveBeenCalled();
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

    // ENG-2840: the self-scoped add now takes up to 100 leads (counted honestly, manageLeadsWrites.ts). Exactly one lead is still required
    // for a dry_run preview and for the admin client_id path, whose audit trail and flag are written for a single lead.
    it('rejects an empty leads array, more than 100 leads, and several leads for a preview', async () => {
      await expect(
        mcpToolRegistry.execute('manage_leads', { action: 'add', list_id: 'list-1', leads: [] }, callerContext)
      ).rejects.toThrow('leads must be a non-empty array');

      await expect(
        mcpToolRegistry.execute('manage_leads', {
          action: 'add',
          list_id: 'list-1',
          leads: Array.from({ length: 101 }, (_, i) => ({ email: `l${i}@example.com` })),
        }, callerContext)
      ).rejects.toThrow('at most 100 per call');

      await expect(
        mcpToolRegistry.execute('manage_leads', {
          action: 'add',
          list_id: 'list-1',
          leads: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
          dry_run: true,
        }, callerContext)
      ).rejects.toThrow('exactly one lead per call');

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    // Adversarial-review finding: a non-object entry (null, a string, an
    // array) previously reached mcpFetch as-is. `null`/`undefined` are falsy,
    // so httpClient's `if (body && ...)` guard skips sending a body at all —
    // silently creating an EMPTY lead on a real write instead of erroring.
    it('rejects a non-object lead entry (null, string, array) instead of silently sending an empty body', async () => {
      await expect(
        mcpToolRegistry.execute('manage_leads', { action: 'add', list_id: 'list-1', leads: [null] }, callerContext)
      ).rejects.toThrow('must be an object with fields');

      await expect(
        mcpToolRegistry.execute('manage_leads', { action: 'add', list_id: 'list-1', leads: ['not-an-object'] }, callerContext)
      ).rejects.toThrow('must be an object with fields');

      await expect(
        mcpToolRegistry.execute('manage_leads', { action: 'add', list_id: 'list-1', leads: [['nested', 'array']] }, callerContext)
      ).rejects.toThrow('must be an object with fields');

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean dry_run instead of silently treating it as false', async () => {
      await expect(
        mcpToolRegistry.execute('manage_leads', {
          action: 'add',
          list_id: 'list-1',
          leads: [{ email: 'lead@example.com' }],
          dry_run: 'true' as any,
        }, callerContext)
      ).rejects.toThrow('dry_run must be a boolean');

      expect(mockMcpFetch).not.toHaveBeenCalled();
    });

    // Adversarial-review finding: the dry-run preview must check permissions
    // for the SAME identity that the real write (a moment later, via mcpFetch
    // -> httpClient.ts's `context.userId || context.agentUserId`) will
    // actually execute as. An internal service-to-service caller can
    // legitimately set userId and agentUserId to different values
    // (mcpServerCore.ts) — the preview must not silently check the wrong one.
    it('previews using the same acting identity the real write would use (userId over agentUserId)', async () => {
      mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'list-1', name: 'My List', userId: 'target-user-x' } as any);
      mockCanDestructiveCrmList.mockResolvedValue(true);
      mockCrmDb.getLeadByEmail.mockResolvedValue(null);

      await mcpToolRegistry.execute('manage_leads', {
        action: 'add',
        list_id: 'list-1',
        leads: [{ email: 'lead@example.com' }],
        dry_run: true,
      }, { userId: 'target-user-x', agentUserId: 'internal-service-y' });

      expect(mockCanDestructiveCrmList).toHaveBeenCalledWith('target-user-x', expect.anything());
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
