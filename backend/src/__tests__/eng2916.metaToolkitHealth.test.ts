/**
 * ENG-2916 slice 1 acceptance: Zoma surfaces Meta ad-account health and per-ad-set
 * learning phase (the "beyond Meta" reads), read-only, on the caller's resolved account.
 */
import {
  runMetaHealthTool,
  summarizeAccountHealth,
  summarizeLearningPhase,
  META_HEALTH_TOOL_NAMES,
} from '../mcp/metaToolkitHealth';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';

describe('ENG-2916 account health', () => {
  it('labels a healthy USD account and converts cents to major units', () => {
    const r = summarizeAccountHealth({ id: 'act_1', currency: 'USD', account_status: 1, disable_reason: 0, spend_cap: '500000', amount_spent: '120050' });
    expect(r).toMatchObject({ can_deliver: true, account_status: 'ACTIVE', disable_reason: 'NONE', spend_cap: 5000, amount_spent: 1200.5, remaining: 3799.5, warnings: [] });
  });

  it('flags a disabled account with its reason', () => {
    const r = summarizeAccountHealth({ currency: 'USD', account_status: 2, disable_reason: 3 });
    expect(r.can_deliver).toBe(false);
    expect(r.disable_reason).toBe('RISK_PAYMENT');
    expect(r.warnings[0]).toMatch(/DISABLED.*RISK_PAYMENT.*will not deliver/);
  });

  it('treats spend_cap 0 as no cap and warns near / at the cap', () => {
    expect(summarizeAccountHealth({ currency: 'USD', account_status: 1, spend_cap: '0', amount_spent: '999' }).spend_cap).toBeNull();
    expect(summarizeAccountHealth({ currency: 'USD', account_status: 1, spend_cap: '10000', amount_spent: '9500' }).warnings[0]).toMatch(/95% used/);
    expect(summarizeAccountHealth({ currency: 'USD', account_status: 1, spend_cap: '10000', amount_spent: '10000' }).warnings[0]).toMatch(/reached/);
  });

  it('does not divide zero-decimal currencies', () => {
    expect(summarizeAccountHealth({ currency: 'JPY', account_status: 1, spend_cap: '50000', amount_spent: '100' })).toMatchObject({ spend_cap: 50000, amount_spent: 100 });
  });
});

describe('ENG-2916 learning phase', () => {
  it('classifies LEARNING / SUCCESS / FAIL / missing', () => {
    const r = summarizeLearningPhase([
      { id: '1', learning_stage_info: { status: 'LEARNING', conversions: 12, last_sig_edit_ts: 1762800000 } },
      { id: '2', learning_stage_info: { status: 'SUCCESS' } },
      { id: '3', learning_stage_info: { status: 'FAIL' } },
      { id: '4' },
    ]);
    expect(r.summary).toEqual({ total: 4, learning: 1, success: 1, learning_limited: 1, unknown: 1 });
    expect(r.ad_sets[0]).toMatchObject({ learning_status: 'LEARNING', conversions_in_window: 12, last_significant_edit: '2025-11-10T18:40:00.000Z' });
    expect(r.ad_sets[0].note).toMatch(/avoid significant edits/);
  });
});

describe('ENG-2916 runMetaHealthTool', () => {
  it('reads only the resolved account node / adsets edge with filters', async () => {
    const readAccountGraph = jest.fn()
      .mockResolvedValueOnce({ id: 'act_9', currency: 'USD', account_status: 1 })
      .mockResolvedValueOnce({ data: [{ id: 'a', learning_stage_info: { status: 'LEARNING' } }], paging: { next: 'x' } });
    await runMetaHealthTool('meta_account_health', 'u', '9', {}, { readAccountGraph });
    expect(readAccountGraph).toHaveBeenLastCalledWith('u', '9', '', expect.objectContaining({ fields: expect.stringContaining('disable_reason') }));
    const lp: any = await runMetaHealthTool('meta_learning_phase', 'u', '9', { campaign_id: '123' }, { readAccountGraph });
    const params = readAccountGraph.mock.calls[1][3];
    expect(readAccountGraph.mock.calls[1][2]).toBe('adsets');
    expect(JSON.parse(params.filtering)).toEqual([
      { field: 'campaign.id', operator: 'IN', value: ['123'] },
      { field: 'effective_status', operator: 'IN', value: ['ACTIVE'] },
    ]);
    expect(lp).toMatchObject({ account_id: '9', truncated: true, summary: { learning: 1 } });
  });

  it('IN_GRACE_PERIOD still delivers, with a payment warning (ENG-2916 review)', () => {
    const h = summarizeAccountHealth({ id: 'act_9', currency: 'USD', account_status: 9 });
    expect(h.can_deliver).toBe(true);
    expect(h.account_status).toBe('IN_GRACE_PERIOD');
    expect(h.warnings.join(' ')).toMatch(/payment failed/);
  });

  it('a Graph error becomes a refusal with Meta\'s message only, never the token', async () => {
    const err: any = Object.assign(new Error('Request failed with status code 400'), {
      config: { params: { access_token: 'SECRET' } }, metaError: { code: 190, message: 'Invalid OAuth access token.' },
    });
    const readAccountGraph = jest.fn().mockRejectedValue(err);
    const p = runMetaHealthTool('meta_account_health', 'u', '9', {}, { readAccountGraph });
    await expect(p).rejects.toBeInstanceOf(MetaToolkitRefusal);
    await expect(runMetaHealthTool('meta_learning_phase', 'u', '9', {}, { readAccountGraph })).rejects.toThrow(/Invalid OAuth access token/);
    await expect(runMetaHealthTool('meta_learning_phase', 'u', '9', {}, { readAccountGraph })).rejects.not.toThrow(/SECRET/);
  });

  it('rejects a non-numeric campaign_id before any read', async () => {
    const readAccountGraph = jest.fn();
    await expect(runMetaHealthTool('meta_learning_phase', 'u', '9', { campaign_id: '1&access_token=x' }, { readAccountGraph })).rejects.toThrow(MetaToolkitRefusal);
    expect(readAccountGraph).not.toHaveBeenCalled();
  });
});

describe('ENG-2916 gateway wiring', () => {
  it('advertises the tools in the manifest and allows them past the v1 guard', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getMetaToolkitManifest, assertMetaToolkitV1Call } = require('../mcp/metaToolkitManifest');
    const fakeRegistry = { getTool: (name: string) => ({ definition: { name, inputSchema: { type: 'object', properties: {} } } }) };
    const names = getMetaToolkitManifest(fakeRegistry).map((d: any) => d.name);
    for (const n of META_HEALTH_TOOL_NAMES) {
      expect(names).toContain(n);
      expect(() => assertMetaToolkitV1Call(n, {})).not.toThrow();
    }
  });

  it('runs on the resolved account, meters once, and refuses a foreign account', async () => {
    const { handleMetaToolkitCall } = require('../mcp/metaToolkitGateway');
    const NOW = Date.parse('2026-11-10T00:00:00Z');
    const acct = (id: string) => ({ platform: 'meta', account_id: id, config: { account_type: 'ad_account', ad_account_id: id, access_token: 'tok', token_expires_at: NOW + 86_400_000 } });
    const runHealthTool = jest.fn().mockResolvedValue({ ok: true, access_token: 'leak' });
    const deps: any = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'user-1', keyId: 'k' }),
      validateOAuthToken: jest.fn().mockResolvedValue(null),
      listAccounts: jest.fn().mockResolvedValue([acct('111')]),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(true),
      now: () => NOW,
      rateLimiter: { check: () => ({ allowed: true, resetInMs: 0 }) },
      runHealthTool,
    };
    const res = await handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: 'meta_account_health', args: {} }, deps);
    expect(res).toEqual({ ok: true });
    expect(runHealthTool).toHaveBeenCalledWith('meta_account_health', 'user-1', '111', expect.any(Object));
    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
    expect(deps.execute).not.toHaveBeenCalled();

    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: 'meta_learning_phase', args: { account_id: '999' } }, deps)).rejects.toMatchObject({ status: 403 });
    expect(runHealthTool).toHaveBeenCalledTimes(1);
  });
});
