/**
 * ENG-1550 / G6 — `record_ads_recommendation`, the ledger's only agent-reachable write path.
 *
 * Why these specific tests exist. Before this tool, the outcome ledger had a store, a service and
 * REST routes but nothing any agent could call, so it accumulated nothing. Two properties of the
 * fix are integrity invariants rather than ordinary behaviour, and both are cheap to break later
 * by someone adding "the obvious missing sibling":
 *
 *   1. RECORD-ONLY. A model must never be able to score its own predictions — that would let it
 *      launder its own track record, which is exactly what `routes/outcomeLedger.ts` gates behind
 *      `requireAdmin` for. Recording a *pending* prediction is safe; resolving one is not.
 *   2. OWNERSHIP. The write is owner-scoped with no admin cross-tenant escape hatch, per the
 *      ENG-1801 warning in `agentModeService.getMetaCredentials` that client-scope must not be
 *      wired into a write path without its own fresh authorization decision.
 *
 * `createRecommendation` is deliberately NOT mocked — its validation is part of the contract being
 * asserted here (a malformed prediction must never reach the store).
 */

jest.mock('../services/agentModeService', () => ({
  agentModeService: {},
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  accountMemoryDb: {},
  orgMemoryDb: {},
  crmDb: {},
}));

jest.mock('../services/metaAccountCredentials', () => ({
  cleanAccountId: (id: string) => String(id).replace(/^act_/, ''),
  getConnectedMetaAccountsList: jest.fn(),
}));

jest.mock('../services/outcomeLedgerDb', () => ({
  putNewRecommendation: jest.fn(),
}));

import { emmaToolRegistry } from '../emma/registry';
import { userDb } from '../services/db';
import { getConnectedMetaAccountsList } from '../services/metaAccountCredentials';
import { putNewRecommendation } from '../services/outcomeLedgerDb';

import '../emma/tools';

const TOOL = 'record_ads_recommendation';
const CALLER = 'user-abc';
const OWNED_ACCOUNT = '1234567890';

function validArgs(overrides: Record<string, any> = {}) {
  return {
    platform: 'meta',
    account_id: OWNED_ACCOUNT,
    hypothesis: 'Pause the two ad sets with no leads in 14 days and move their budget to Leasing v2.1.',
    predicted_metric: 'cost_per_lead',
    predicted_direction: 'decrease',
    predicted_magnitude_pct: 15,
    evaluation_date: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ENG-1550 record_ads_recommendation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: CALLER });
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: OWNED_ACCOUNT }]);
  });

  it('is registered', () => {
    expect(emmaToolRegistry.getTool(TOOL)).toBeDefined();
  });

  // THE integrity invariant. If a future change adds a scoring tool, this fails loudly and whoever
  // adds it has to re-decide the record/score split on purpose rather than by accident.
  it('exposes NO way for an agent to score a recommendation', () => {
    const scoringNames = emmaToolRegistry
      .getToolNames()
      .filter((name: string) => /recommendation/i.test(name) && /score|resolve|verdict|adopt/i.test(name));

    expect(scoringNames).toEqual([]);
  });

  it('records a pending prediction for an account the caller owns', async () => {
    const tool = emmaToolRegistry.getTool(TOOL)!;

    const result: any = await tool.execute(validArgs(), { userId: CALLER });

    expect(result.success).toBe(true);
    expect(putNewRecommendation).toHaveBeenCalledTimes(1);

    const written = (putNewRecommendation as jest.Mock).mock.calls[0][0];
    expect(written.status).toBe('pending');
    expect(written.verdict).toBeNull();
    expect(written.scoredAt).toBeNull();
    expect(written.adopted).toBeNull();
    expect(written.accountId).toBe(OWNED_ACCOUNT);
    expect(written.createdBy).toBe(CALLER);
    // Server-minted, never caller-supplied — the caller states what it predicted, not its own
    // audit-trail key.
    expect(written.recommendationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.recommendation_id).toBe(written.recommendationId);
  });

  it('refuses an ad account the caller does not have connected, and writes nothing', async () => {
    const tool = emmaToolRegistry.getTool(TOOL)!;
    (getConnectedMetaAccountsList as jest.Mock).mockReturnValue([{ accountId: 'some-other-account' }]);

    const result: any = await tool.execute(validArgs(), { userId: CALLER });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not one of your connected accounts/i);
    expect(putNewRecommendation).not.toHaveBeenCalled();
  });

  it('normalizes an act_-prefixed account id before the ownership check', async () => {
    const tool = emmaToolRegistry.getTool(TOOL)!;

    const result: any = await tool.execute(validArgs({ account_id: `act_${OWNED_ACCOUNT}` }), { userId: CALLER });

    expect(result.success).toBe(true);
    expect((putNewRecommendation as jest.Mock).mock.calls[0][0].accountId).toBe(OWNED_ACCOUNT);
  });

  // A prediction that cannot be scored is not a prediction. Each of these is rejected by
  // createRecommendation's real validation, and none may reach the store.
  it.each([
    ['empty hypothesis', { hypothesis: '   ' }],
    ['unparseable evaluation_date', { evaluation_date: 'next quarter' }],
    ['negative magnitude', { predicted_magnitude_pct: -5 }],
    ['non-finite magnitude', { predicted_magnitude_pct: Number.POSITIVE_INFINITY }],
    ['bogus direction', { predicted_direction: 'sideways' }],
    ['empty predicted_metric', { predicted_metric: '' }],
  ])('rejects %s as a clean error without writing', async (_label, override) => {
    const tool = emmaToolRegistry.getTool(TOOL)!;

    const result: any = await tool.execute(validArgs(override), { userId: CALLER });

    expect(result.success).toBe(false);
    // Pin the rejection to createRecommendation's own validation rather than accepting any
    // failure — otherwise this test would still pass if the call died on auth or platform
    // checks and never exercised validation at all.
    expect(result.error).toMatch(/^outcomeLedger:/);
    expect(putNewRecommendation).not.toHaveBeenCalled();
  });

  it('rejects a non-meta platform without touching the store', async () => {
    const tool = emmaToolRegistry.getTool(TOOL)!;

    const result: any = await tool.execute(validArgs({ platform: 'google_ads' }), { userId: CALLER });

    expect(result.success).toBe(false);
    expect(putNewRecommendation).not.toHaveBeenCalled();
  });

  it('does not accept a client_id admin cross-tenant parameter', () => {
    const tool = emmaToolRegistry.getTool(TOOL)!;
    const properties = (tool.definition as any).inputSchema.properties;

    expect(properties.client_id).toBeUndefined();
  });
});
