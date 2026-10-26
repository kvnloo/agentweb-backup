import { ClaudeRouteStopError } from '../claudeRouteErrors';
import { resolveTurnFunding, type TurnFundingInput } from '../claudeFunding';
import type { LlmConnectionRecord } from '../llmConnectionDb';
import type { SubscriptionRouteDeps } from '../subscriptionRoute';

const NOW = 1_800_000_000_000;
const SONNET = 'openrouter/anthropic/claude-sonnet-5.5';
const conn = (over: Partial<LlmConnectionRecord> = {}): LlmConnectionRecord =>
  ({
    connectionId: 'conn-1', ownerUserId: 'u1', kind: 'claude_subscription', provider: 'anthropic', status: 'active', keyLast4: '',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', subHosted: true, subHostEpoch: 2,
    subRefreshExpiresAtMs: NOW + 86_400_000, ...over,
  }) as LlmConnectionRecord;

function deps(over: { enabled?: boolean; records?: LlmConnectionRecord[] } = {}) {
  const calls = { flag: 0, list: 0 };
  const d: SubscriptionRouteDeps = {
    isEnabledFor: async () => (calls.flag++, over.enabled ?? true),
    listConnections: async () => (calls.list++, over.records ?? [conn()]),
    now: () => NOW,
  };
  return { d, calls };
}

const input = (over: Partial<TurnFundingInput> = {}): TurnFundingInput => ({
  rawFundingChoice: 'claude_subscription',
  initiatorUserId: 'u1',
  sessionOwnerUserId: 'u1',
  requestIsDelegated: false,
  sessionIsDelegated: false,
  explicitModelId: SONNET,
  ...over,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no-throw';
  } catch (e) {
    return e instanceof ClaudeRouteStopError ? e.code : `other:${String(e)}`;
  }
};

describe('resolveTurnFunding', () => {
  it('no funding choice is AgentWeb with no lookups at all', async () => {
    for (const raw of [undefined, null]) {
      const { d, calls } = deps();
      await expect(resolveTurnFunding(input({ rawFundingChoice: raw }), d)).resolves.toEqual({ route: 'agentweb' });
      expect(calls).toEqual({ flag: 0, list: 0 });
    }
  });

  it('any other value is a 400, never silently AgentWeb', async () => {
    for (const raw of ['', 'claude', 'agentweb', 'CLAUDE_SUBSCRIPTION', true, 1, {}, [], ['claude_subscription']]) {
      const { d, calls } = deps();
      expect(await code(resolveTurnFunding(input({ rawFundingChoice: raw as unknown }), d))).toBe('invalid_funding_choice');
      expect(calls).toEqual({ flag: 0, list: 0 });
    }
  });

  it('an allow-listed owner with a usable connection and a plan model gets the plan route', async () => {
    const r = await resolveTurnFunding(input(), deps().d);
    expect(r).toMatchObject({ route: 'claude_subscription', connectionId: 'conn-1', epoch: 2, alias: 'sonnet', modelId: SONNET, ownerUserId: 'u1' });
  });

  it('a stop is typed and carries its reason', async () => {
    expect(await code(resolveTurnFunding(input(), deps({ enabled: false }).d))).toBe('not_enabled');
    expect(await code(resolveTurnFunding(input(), deps({ records: [] }).d))).toBe('no_connection');
    expect(await code(resolveTurnFunding(input(), deps({ records: [conn({ subNeedsReconnect: true })] }).d))).toBe('needs_reconnect');
  });

  it('delegation, in the request OR the session, is denied', async () => {
    expect(await code(resolveTurnFunding(input({ requestIsDelegated: true }), deps().d))).toBe('not_allowed_here');
    expect(await code(resolveTurnFunding(input({ sessionIsDelegated: true }), deps().d))).toBe('not_allowed_here');
  });

  it('an admin or anyone else acting in the owner\'s session is denied', async () => {
    expect(await code(resolveTurnFunding(input({ initiatorUserId: 'admin-1' }), deps().d))).toBe('not_allowed_here');
  });

  it('the allow-list answers before the model: a non-allow-listed user learns nothing about the pick', async () => {
    expect(await code(resolveTurnFunding(input({ explicitModelId: undefined }), deps({ enabled: false }).d))).toBe('not_enabled');
  });

  it('a missing or unresolvable pick, or a model with no plan alias, is model_not_on_plan', async () => {
    expect(await code(resolveTurnFunding(input({ explicitModelId: undefined }), deps().d))).toBe('model_not_on_plan');
    expect(await code(resolveTurnFunding(input({ explicitModelId: 'openrouter/openai/gpt-5.5' }), deps().d))).toBe('model_not_on_plan');
  });

  it('never returns an AgentWeb route once the plan was asked for', async () => {
    for (const d of [deps({ enabled: false }).d, deps({ records: [] }).d]) {
      await expect(resolveTurnFunding(input(), d)).rejects.toBeInstanceOf(ClaudeRouteStopError);
    }
  });
});
