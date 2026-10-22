import '../emma/tools';
import { mcpToolRegistry } from '../mcp/server/registry';
import { agentModeService, ADMIN_SKILL_TOOL_NAMES } from '../services/agentModeService';
import { userDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';
import { runFunnelStatusOperation, MAX_FUNNEL_STATUS_BATCH } from '../services/adminFunnelStatusService';

const actor = { actorUserId: 'admin-1', actorEmail: 'admin@agentweb.pro', accountableOwner: 'harsha@agentweb.pro' };

function makeDeps(users: Record<string, { userId: string; funnelStatus?: string | null }>) {
  const store = new Map(Object.entries(users).map(([email, u]) => [email, { ...u, email }]));
  const updates: Array<[string, string | null]> = [];
  const audits: any[] = [];
  return {
    updates,
    audits,
    deps: {
      getUserByEmail: jest.fn(async (email: string) => store.get(email)),
      updateFunnelStatus: jest.fn(async (userId: string, status: string | null) => {
        updates.push([userId, status]);
        for (const u of store.values()) if (u.userId === userId) u.funnelStatus = status;
      }),
      audit: jest.fn((e: any) => audits.push(e)),
      now: () => new Date('2026-10-20T00:00:00.000Z'),
    },
  };
}

describe('ENG-752 admin funnelStatus capability', () => {
  it('resolves by email and reads current value without writing', async () => {
    const { deps, updates } = makeDeps({ 'a@x.com': { userId: 'u1', funnelStatus: 'activation' } });
    const res = await runFunnelStatusOperation('read', [{ email: 'A@X.com' }, { email: 'none@x.com' }], actor, deps);
    expect(res.rows).toEqual([
      { email: 'a@x.com', userId: 'u1', before: 'activation', outcome: 'read' },
      { email: 'none@x.com', outcome: 'unresolved', reason: 'no user with this email' },
    ]);
    expect(updates).toEqual([]);
  });

  it('rejects values outside the approved vocabulary and allows null', async () => {
    const { deps, updates } = makeDeps({ 'a@x.com': { userId: 'u1', funnelStatus: 'activation' }, 'b@x.com': { userId: 'u2', funnelStatus: 'parked' } });
    const res = await runFunnelStatusOperation('apply', [{ email: 'a@x.com', funnel_status: 'super_vip' }, { email: 'b@x.com', funnel_status: null }], actor, deps);
    expect(res.rows[0]).toMatchObject({ outcome: 'invalid' });
    expect(res.rows[1]).toMatchObject({ outcome: 'updated', before: 'parked', after: null });
    expect(updates).toEqual([['u2', null]]);
  });

  it('refuses empty/whitespace strings and undefined instead of clearing (only null clears)', async () => {
    const { deps, updates, audits } = makeDeps({ 'a@x.com': { userId: 'u1', funnelStatus: 'follow_up' }, 'b@x.com': { userId: 'u2', funnelStatus: 'follow_up' }, 'c@x.com': { userId: 'u3', funnelStatus: 'follow_up' } });
    const res = await runFunnelStatusOperation('apply', [{ email: 'a@x.com', funnel_status: '' }, { email: 'b@x.com', funnel_status: '   ' }, { email: 'c@x.com', funnel_status: undefined }], actor, deps);
    expect(res.rows.map((r) => r.outcome)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(res.rows[0].reason).toContain('follow_up');
    expect(updates).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('preview does not write; apply writes once, audits, and is idempotent', async () => {
    const { deps, updates, audits } = makeDeps({ 'a@x.com': { userId: 'u1', funnelStatus: 'follow_up' } });
    const rows = [{ email: 'a@x.com', funnel_status: 'activation' }];
    const preview = await runFunnelStatusOperation('preview', rows, actor, deps);
    expect(preview.rows[0]).toMatchObject({ outcome: 'would_update', before: 'follow_up', after: 'activation' });
    expect(updates).toEqual([]);

    const applied = await runFunnelStatusOperation('apply', rows, actor, deps);
    expect(applied.summary).toEqual({ updated: 1 });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'user_funnel_status_update',
        actorUserId: 'admin-1',
        actorEmail: 'admin@agentweb.pro',
        accountableOwner: 'harsha@agentweb.pro',
        targetUserId: 'u1',
        before: 'follow_up',
        after: 'activation',
        changedAt: '2026-10-20T00:00:00.000Z',
      }),
    ]);

    const again = await runFunnelStatusOperation('apply', rows, actor, deps);
    expect(again.summary).toEqual({ skipped_unchanged: 1 });
    expect(updates).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('bounds batch size and rejects duplicates / missing target', async () => {
    const { deps } = makeDeps({});
    const big = Array.from({ length: MAX_FUNNEL_STATUS_BATCH + 1 }, (_, i) => ({ email: `${i}@x.com`, funnel_status: null }));
    await expect(runFunnelStatusOperation('preview', big, actor, deps)).rejects.toThrow(/At most/);
    await expect(runFunnelStatusOperation('preview', [], actor, deps)).rejects.toThrow(/non-empty/);
    const res = await runFunnelStatusOperation('preview', [{ email: 'a@x.com' }, { email: 'b@x.com', funnel_status: null }, { email: 'B@x.com', funnel_status: null }], actor, deps);
    expect(res.rows.map((r) => r.outcome)).toEqual(['invalid', 'unresolved', 'invalid']);
  });
});

describe('ENG-752 manage_user_funnel_status tool access', () => {
  afterEach(() => jest.restoreAllMocks());
  const tool = () => mcpToolRegistry.getTool('manage_user_funnel_status')!;

  it('is registered and classified admin-only', () => {
    expect(mcpToolRegistry.getTool('manage_user_funnel_status')).toBeDefined();
    expect(ADMIN_SKILL_TOOL_NAMES).toContain('manage_user_funnel_status');
    expect(agentModeService.getAdminToolNames()).toContain('manage_user_funnel_status');
  });

  it('fails closed for customer sessions, customer delegated access, and external MCP', async () => {
    const byId = jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'cust', email: 'c@x.com', isAdmin: false } as any);
    const byEmail = jest.spyOn(userDb, 'getUserByEmail').mockResolvedValue(undefined as any);
    const update = jest.spyOn(userDb, 'updateUser').mockResolvedValue({} as any);
    const args = { mode: 'apply', rows: [{ email: 'a@x.com', funnel_status: 'parked' }] };
    await expect(tool().execute(args, { userId: 'cust' })).rejects.toThrow(/Admin access required/);
    await expect(tool().execute(args, { userId: 'cust', isDelegatedAccess: true })).rejects.toThrow(/Admin access required/);
    byId.mockResolvedValue({ userId: 'adm', email: 'adm@agentweb.pro', isAdmin: true } as any);
    await expect(tool().execute(args, { userId: 'adm', externalMcp: true })).rejects.toThrow(/Admin access required/);
    expect(byEmail).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('applies for an admin via the same userDb.updateUser write as the admin route, and audits', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'adm', email: 'adm@agentweb.pro', isAdmin: true } as any);
    jest.spyOn(userDb, 'getUserByEmail').mockResolvedValue({ userId: 'u1', email: 'a@x.com', funnelStatus: 'follow_up' } as any);
    const update = jest.spyOn(userDb, 'updateUser').mockResolvedValue({} as any);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const res: any = await tool().execute({ mode: 'apply', rows: [{ email: 'a@x.com', funnel_status: 'activation' }] }, { userId: 'adm' });
    expect(res.rows[0]).toMatchObject({ outcome: 'updated', before: 'follow_up', after: 'activation' });
    expect(update).toHaveBeenCalledWith('u1', { funnelStatus: 'activation' });
    expect(log.mock.calls.some(([line]) => String(line).includes('[admin-audit]') && String(line).includes('"accountableOwner":"adm@agentweb.pro"'))).toBe(true);
  });

  it('applies for a real admin on the socket sidebar path (isDelegatedAdmin without adminEmail)', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'adm', email: 'adm@agentweb.pro', isAdmin: true } as any);
    jest.spyOn(userDb, 'getUserByEmail').mockResolvedValue({ userId: 'u1', email: 'a@x.com', funnelStatus: 'parked' } as any);
    const update = jest.spyOn(userDb, 'updateUser').mockResolvedValue({} as any);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const res: any = await tool().execute({ mode: 'apply', rows: [{ email: 'a@x.com', funnel_status: 'follow_up' }] }, { userId: 'adm', isDelegatedAdmin: true });
    expect(res.rows[0]).toMatchObject({ outcome: 'updated', after: 'follow_up' });
    expect(update).toHaveBeenCalledWith('u1', { funnelStatus: 'follow_up' });
  });

  it('audits the delegating administrator, not the impersonated target user', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'cust', email: 'c@x.com', isAdmin: false } as any);
    jest.spyOn(chatbotDb, 'getChatSession').mockResolvedValue({ delegateInfo: { isDelegated: true, adminUserId: 'adm', adminEmail: 'adm@agentweb.pro' } } as any);
    jest.spyOn(userDb, 'getUserByEmail').mockResolvedValue({ userId: 'u1', email: 'a@x.com', funnelStatus: 'parked' } as any);
    jest.spyOn(userDb, 'updateUser').mockResolvedValue({} as any);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await tool().execute({ mode: 'apply', rows: [{ email: 'a@x.com', funnel_status: 'follow_up' }] }, { userId: 'cust', isDelegatedAdmin: true, sessionId: 's1' });
    const audit = log.mock.calls.map(([l]) => String(l)).find((l) => l.includes('[admin-audit]'));
    expect(audit).toBeDefined();
    expect(audit).toContain('adm@agentweb.pro');
    expect(audit).not.toContain('"cust"');
  });

  it('still fails closed for a delegated non-admin with no admin identity', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'cust', email: 'c@x.com', isAdmin: false } as any);
    const update = jest.spyOn(userDb, 'updateUser').mockResolvedValue({} as any);
    await expect(tool().execute({ mode: 'apply', rows: [{ email: 'a@x.com', funnel_status: 'parked' }] }, { userId: 'cust', isDelegatedAdmin: true })).rejects.toThrow(/Administrator identity unavailable/);
    expect(update).not.toHaveBeenCalled();
  });
});
