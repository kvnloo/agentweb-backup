/**
 * ENG-3155 — per-user/org/domain rollout of measurement reports (ZOMA_MEASUREMENT_REPORTS_ALLOWLIST).
 * One helper gates the manifest listing, gateway dispatch, enrollment-on-ship, the scheduled runner and the
 * weekly-email skip. Flag off + empty allowlist must stay exactly the old flag-only behavior (no user read).
 * Mock-only: no Meta, DynamoDB or mail.
 */
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn(), updateUser: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn(async () => []), createAccount: jest.fn() }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn(), getClient: jest.fn() } }));
jest.mock('../services/mcpUsageEventsService', () => ({
  recordMcpToolUse: jest.fn().mockResolvedValue(undefined),
  recordMcpWriteExecuted: jest.fn().mockResolvedValue(undefined),
  recordMcpToolFailed: jest.fn().mockResolvedValue(undefined),
  getMcpUserUsage: jest.fn(),
  getMcpUsageByUser: jest.fn(),
  hasZomaFunnelRow: jest.fn(),
  recordZomaBillingFunnel: jest.fn(),
  EMMA_MCP_LOOP_ID: 'emma-mcp',
  EVT_MCP_WRITE_EXECUTED: 'mcp_write_executed',
}));
jest.mock('../services/journeyMilestones', () => ({ noteProductUse: jest.fn(), noteSignup: jest.fn(), zomaMilestone: jest.fn() }));

import { userDb } from '../services/db';
import {
  measurementReportsEnabledFor,
  measurementReportsEnabledForUserId,
  measurementReportsMaybeEnabled,
  ZOMA_MEASUREMENT_REPORTS_ALLOWLIST,
  ZOMA_MEASUREMENT_REPORTS_FLAG,
} from '../mcp/zomaMeasurementReport';
import {
  defaultMeasurementRunnerDeps,
  enrollReportSchedule,
  hasActiveReportSchedule,
  runZomaMeasurementReports,
  runZomaReportScheduleTool,
  type MeasurementRunnerDeps,
  type ZomaReportSchedule,
  type ZomaReportScheduleStore,
} from '../mcp/zomaReportSchedule';
import { assertMetaToolkitV1Call, getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';

const NOW = Date.parse('2026-11-18T15:00:00Z');
const env = (flag?: string, allowlist?: string) =>
  ({ ...(flag !== undefined ? { [ZOMA_MEASUREMENT_REPORTS_FLAG]: flag } : {}), ...(allowlist !== undefined ? { [ZOMA_MEASUREMENT_REPORTS_ALLOWLIST]: allowlist } : {}) }) as NodeJS.ProcessEnv;
const getUserByIdConsistent = userDb.getUserByIdConsistent as jest.Mock;

afterEach(() => {
  delete process.env[ZOMA_MEASUREMENT_REPORTS_FLAG];
  delete process.env[ZOMA_MEASUREMENT_REPORTS_ALLOWLIST];
  jest.clearAllMocks();
});

describe('measurementReportsEnabledFor', () => {
  const alice = { userId: 'u-alice', email: 'Alice@Slashy.com', orgId: 'org-slashy' };

  it('matches an email domain (case-insensitive, exact domain only)', () => {
    expect(measurementReportsEnabledFor(alice, env(undefined, '@slashy.com'))).toBe(true);
    expect(measurementReportsEnabledFor(alice, env(undefined, ' @SLASHY.COM , u-other'))).toBe(true);
    expect(measurementReportsEnabledFor({ ...alice, email: 'a@mail.slashy.com' }, env(undefined, '@slashy.com'))).toBe(false);
    expect(measurementReportsEnabledFor({ ...alice, email: 'a@notslashy.com' }, env(undefined, '@slashy.com'))).toBe(false);
  });

  it('matches an orgId or a userId', () => {
    expect(measurementReportsEnabledFor(alice, env(undefined, 'org-slashy'))).toBe(true);
    expect(measurementReportsEnabledFor(alice, env(undefined, 'u-alice'))).toBe(true);
  });

  it('does not match anyone not on the list', () => {
    const allow = env(undefined, 'u-bob,org-acme,@acme.com');
    expect(measurementReportsEnabledFor(alice, allow)).toBe(false);
    expect(measurementReportsEnabledFor({ userId: 'u-x' }, allow)).toBe(false);
    expect(measurementReportsEnabledFor(undefined, allow)).toBe(false);
    // A bare '@' or empty entries match nothing.
    expect(measurementReportsEnabledFor({ userId: 'u', email: 'x@' }, env(undefined, '@, ,'))).toBe(false);
  });

  it('the flag wins: on enables everyone, off defers to the allowlist', () => {
    expect(measurementReportsEnabledFor(alice, env('true', 'u-bob'))).toBe(true);
    expect(measurementReportsEnabledFor(undefined, env('true'))).toBe(true);
    expect(measurementReportsEnabledFor(alice, env('false', '@slashy.com'))).toBe(true);
    expect(measurementReportsEnabledFor(alice, env('false'))).toBe(false);
    expect(measurementReportsEnabledFor(alice, env())).toBe(false);
  });

  it('measurementReportsMaybeEnabled: flag on or any allowlist entry', () => {
    expect(measurementReportsMaybeEnabled(env())).toBe(false);
    expect(measurementReportsMaybeEnabled(env(undefined, ' , '))).toBe(false);
    expect(measurementReportsMaybeEnabled(env(undefined, '@slashy.com'))).toBe(true);
    expect(measurementReportsMaybeEnabled(env('true'))).toBe(true);
  });
});

describe('measurementReportsEnabledForUserId', () => {
  it('flag off + empty allowlist: false without reading the user (today’s behavior)', async () => {
    const load = jest.fn();
    expect(await measurementReportsEnabledForUserId('u1', env(), load)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('flag on: true without reading the user', async () => {
    const load = jest.fn();
    expect(await measurementReportsEnabledForUserId('u1', env('true'), load)).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it('reads email/orgId only when the userId alone does not decide', async () => {
    const load = jest.fn(async () => ({ email: 'ops@slashy.com', orgId: 'org-1' }));
    expect(await measurementReportsEnabledForUserId('u1', env(undefined, 'u1'), load)).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(await measurementReportsEnabledForUserId('u2', env(undefined, '@slashy.com'), load)).toBe(true);
    expect(await measurementReportsEnabledForUserId('u2', env(undefined, 'org-1'), load)).toBe(true);
    expect(await measurementReportsEnabledForUserId('u2', env(undefined, 'org-2,@acme.com'), load)).toBe(false);
  });

  it('fails closed when the user cannot be read', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await measurementReportsEnabledForUserId('u1', env(undefined, '@slashy.com'), async () => { throw new Error('ddb down'); })).toBe(false);
    expect(await measurementReportsEnabledForUserId('u1', env(undefined, '@slashy.com'), async () => undefined)).toBe(false);
    spy.mockRestore();
  });

  it('defaults to the user record', async () => {
    getUserByIdConsistent.mockResolvedValue({ email: 'a@slashy.com' });
    expect(await measurementReportsEnabledForUserId('u1', env(undefined, '@slashy.com'))).toBe(true);
    expect(getUserByIdConsistent).toHaveBeenCalledWith('u1');
  });
});

// ---------------------------------------------------------------------------------------------
// Every gate uses the helper
// ---------------------------------------------------------------------------------------------

function storeWith(rows: ZomaReportSchedule[] = []): ZomaReportScheduleStore & Record<string, jest.Mock> {
  return {
    get: jest.fn(async () => null),
    listForUser: jest.fn(async (u: string) => rows.filter((r) => r.userId === u)),
    listDue: jest.fn(async () => rows.map((r) => ({ ...r }))),
    create: jest.fn(async () => true),
    resumeDormant: jest.fn(async () => false),
    update: jest.fn(async () => true),
    claimSlot: jest.fn(async () => true),
    setIndustry: jest.fn(async () => true),
  } as any;
}
const row = (userId: string): ZomaReportSchedule => ({
  userId, adAccountId: '111', status: 'active', cadence: 'weekly', nextReportAt: '2026-11-18T00:00:00.000Z', launchedAt: 'x', createdAt: 'x', updatedAt: 'x',
});
const slashyUser = async () => ({ email: 'ops@slashy.com' });

describe('gates', () => {
  it('manifest: report tools listed only when the caller is enabled; default = flag only', () => {
    const names = (opts?: { measurementReports?: boolean }) => getMetaToolkitManifest(undefined, opts).map((d: any) => d.name);
    expect(names()).not.toContain('zoma_measurement_report');
    expect(names({ measurementReports: true })).toEqual(expect.arrayContaining(['zoma_measurement_report', 'zoma_report_schedule']));
    expect(names({ measurementReports: false })).not.toContain('zoma_report_schedule');
    process.env[ZOMA_MEASUREMENT_REPORTS_FLAG] = 'true';
    expect(names()).toContain('zoma_measurement_report');
  });

  it('enrollment-on-ship: allowlisted user enrolls, others do not (and nothing is written)', async () => {
    const allowed = storeWith();
    expect(await enrollReportSchedule('u1', '111', { store: allowed, now: () => NOW, env: env(undefined, '@slashy.com'), loadUser: slashyUser })).not.toBeNull();
    expect(allowed.create).toHaveBeenCalled();
    const other = storeWith();
    expect(await enrollReportSchedule('u1', '111', { store: other, now: () => NOW, env: env(undefined, '@acme.com'), loadUser: slashyUser })).toBeNull();
    expect(other.create).not.toHaveBeenCalled();
  });

  it('schedule tool: allowlisted user may use it, others are refused', async () => {
    const store = storeWith([row('u1')]);
    await expect(runZomaReportScheduleTool('u1', {}, { store, now: () => NOW, env: env(undefined, '@slashy.com'), loadUser: slashyUser })).resolves.toBeDefined();
    await expect(runZomaReportScheduleTool('u1', {}, { store, now: () => NOW, env: env(undefined, 'u-other'), loadUser: slashyUser })).rejects.toThrow(/not available/);
  });

  it('weekly-email skip: only for an enabled user with an active schedule', async () => {
    const store = storeWith([row('u1')]);
    expect(await hasActiveReportSchedule('u1', store, env(undefined, '@slashy.com'), slashyUser)).toBe(true);
    expect(await hasActiveReportSchedule('u1', store, env(undefined, '@acme.com'), slashyUser)).toBe(false);
    expect(await hasActiveReportSchedule('u1', store, env())).toBe(false);
    expect(store.listForUser).toHaveBeenCalledTimes(1);
  });

  it('runner: sends only for allowlisted users; flag off + empty allowlist runs nothing', async () => {
    process.env[ZOMA_MEASUREMENT_REPORTS_ALLOWLIST] = 'org-slashy';
    const store = storeWith([row('u-in'), row('u-out')]);
    const sendEmail = jest.fn(async () => 'sent' as const);
    const deps: MeasurementRunnerDeps = {
      ...defaultMeasurementRunnerDeps,
      store: () => store,
      getUser: async (userId: string) => ({ userId, email: `${userId}@shop.com`, isAdmin: false, orgId: userId === 'u-in' ? 'org-slashy' : 'org-acme' }),
      recentSpend: async () => 10,
      buildReport: jest.fn(async () => ({ summary: 's', date_range: { since: 'a', until: 'b' }, report_url: 'https://r' }) as any),
      sendEmail,
      backendUrl: () => 'https://api.example',
      secret: () => 's',
      now: () => NOW,
    };
    expect(deps.enabled()).toBe(true);
    const r = await runZomaMeasurementReports(deps);
    expect(r.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail.mock.calls[0] as any[])[0]).toBe('u-in@shop.com');

    delete process.env[ZOMA_MEASUREMENT_REPORTS_ALLOWLIST];
    const idle = storeWith([row('u-in')]);
    expect(await runZomaMeasurementReports({ ...deps, store: () => idle })).toEqual({ due: 0, sent: 0, failed: 0, dormant: 0 });
    expect(idle.listDue).not.toHaveBeenCalled();
  });

  describe('gateway dispatch', () => {
    const metaAccount: any = {
      platform: 'meta', account_id: 'act_111', account_name: 'Phoenix Shop',
      config: { account_type: 'ad_account', access_token: 'EAAG-secret', ad_account_id: '111', currency: 'USD', granted_scopes: ['ads_management'] },
    };
    const deps = (over: Partial<MetaToolkitGatewayDeps> = {}): MetaToolkitGatewayDeps => ({
      validateApiKey: async () => null,
      validateOAuthToken: async () => ({ userId: 'u1', clientId: 'claude-code' }),
      getOAuthClientRedirectUris: async () => ['http://localhost:1/callback'],
      listAccounts: async () => [metaAccount],
      execute: jest.fn() as any,
      recordUsage: jest.fn().mockResolvedValue(undefined) as any,
      recordWrite: jest.fn().mockResolvedValue(undefined) as any,
      recordFailure: jest.fn().mockResolvedValue(undefined) as any,
      reportBillableCall: async () => undefined,
      assertPublishAllowed: async () => undefined,
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) } as any,
      now: () => NOW,
      ...over,
    });
    const call = (toolName: string, over: Partial<MetaToolkitGatewayDeps>) =>
      handleMetaToolkitCall({ authorization: 'Bearer oauth-good', toolName, args: {} }, deps(over));

    it('routes the schedule tool and the report for an allowlisted caller', async () => {
      process.env[ZOMA_MEASUREMENT_REPORTS_ALLOWLIST] = 'u1';
      const runReportScheduleTool = jest.fn(async () => ({ schedules: [] }));
      await call('zoma_report_schedule', { runReportScheduleTool });
      expect(runReportScheduleTool).toHaveBeenCalledWith('u1', {});
      const runMeasurementReport = jest.fn(async () => ({ summary: 'ok' }));
      await call('zoma_measurement_report', { runMeasurementReport, getStoredIndustry: async () => null });
      expect(runMeasurementReport).toHaveBeenCalled();
    });

    it('refuses both for a caller not on the allowlist (flag off)', async () => {
      process.env[ZOMA_MEASUREMENT_REPORTS_ALLOWLIST] = '@slashy.com';
      getUserByIdConsistent.mockResolvedValue({ email: 'u1@acme.com' });
      const runReportScheduleTool = jest.fn();
      const runMeasurementReport = jest.fn();
      // Not routed: falls through to the v1 executor, which refuses a tool outside the surface.
      const execute = jest.fn(async (name: string, args: any) => assertMetaToolkitV1Call(name, args)) as any;
      await expect(call('zoma_report_schedule', { runReportScheduleTool, execute })).rejects.toThrow(/not part of the Meta Toolkit/);
      await expect(call('zoma_measurement_report', { runMeasurementReport, execute })).rejects.toThrow(/not part of the Meta Toolkit/);
      expect(runReportScheduleTool).not.toHaveBeenCalled();
      expect(runMeasurementReport).not.toHaveBeenCalled();
    });
  });
});
