/**
 * ENG-2108 (A2): per-call funding resolution. The connection service and flags are
 * stubbed at the module boundary; what is under test is the matching rule.
 */
const listUsableForUser = jest.fn();
jest.mock('../llmConnectionService', () => ({
  getLlmConnectionService: () => ({ listUsableForUser }),
}));
const getFundingFlags = jest.fn();
jest.mock('../fundingFlags', () => ({ getFundingFlags: (...a: unknown[]) => getFundingFlags(...a) }));

import { resolveCallFunding, isCustomerRoutableFeature } from '../callFunding';
import { registerCustomerRouteProvisioner } from '../transport/customerRouteProvisioner';
import type { RunFunding } from '../runFunding';

const run: RunFunding = {
  route: 'agentweb',
  fallback: 'stop',
  ownerUserId: 'member-1',
  billingUserId: 'member-1',
  resolvedAt: '2026-10-13T00:00:00.000Z',
};
const conn = (over: Record<string, unknown> = {}) => ({
  connectionId: 'c1',
  ownerUserId: 'owner-1',
  kind: 'api_key',
  provider: 'anthropic',
  status: 'active',
  ownedByCaller: false,
  ...over,
});
const input = { userId: 'member-1', modelLab: 'anthropic', feature: 'agent_task:interactive' };

describe('resolveCallFunding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerCustomerRouteProvisioner({ clientFor: jest.fn() });
    getFundingFlags.mockResolvedValue({ killSwitch: false, byok: { enabled: true, allowUserIds: ['*'] } });
    listUsableForUser.mockResolvedValue([conn()]);
  });
  afterAll(() => registerCustomerRouteProvisioner(null));

  it('routes a call to the customer key matching the model\'s provider, paid by the key\'s owner', async () => {
    const funding = await resolveCallFunding(run, input);
    expect(funding).toMatchObject({
      route: 'api_key',
      connectionId: 'c1',
      provider: 'anthropic',
      fundingPrincipalId: 'owner-1',
      ownerUserId: 'member-1',
      fallback: 'stop',
    });
  });

  it('lists every usable same-provider key in order, and takes the first', async () => {
    listUsableForUser.mockResolvedValue([
      conn({ connectionId: 'a' }),
      conn({ connectionId: 'b', ownerUserId: 'owner-2' }),
      conn({ connectionId: 'g', provider: 'google' }),
    ]);
    const funding = await resolveCallFunding(run, input);
    expect(funding?.connectionId).toBe('a');
    expect(funding?.candidates).toEqual([
      { connectionId: 'a', fundingPrincipalId: 'owner-1' },
      { connectionId: 'b', fundingPrincipalId: 'owner-2' },
    ]);
  });

  it('keeps the call on AgentWeb when no key matches this call\'s provider', async () => {
    listUsableForUser.mockResolvedValue([conn({ provider: 'openai' })]);
    expect(await resolveCallFunding(run, input)).toBe(run);
  });

  it.each([
    ['revoked', { status: 'revoked' }],
    ['invalid', { status: 'invalid' }],
    ['a subscription', { kind: 'claude_subscription' }],
  ])('ignores a connection that is %s', async (_label, over) => {
    listUsableForUser.mockResolvedValue([conn(over)]);
    expect(await resolveCallFunding(run, input)).toBe(run);
  });

  it.each([['xai'], ['deepseek'], ['other'], [undefined]])('keeps a %s model on AgentWeb', async (modelLab) => {
    expect(await resolveCallFunding(run, { ...input, modelLab })).toBe(run);
    expect(listUsableForUser).not.toHaveBeenCalled();
  });

  it('keeps helper calls on AgentWeb in v1', async () => {
    for (const feature of ['session_title:interactive', 'suggested_replies:interactive', 'report_classification', 'session_summary:interactive', undefined]) {
      expect(await resolveCallFunding(run, { ...input, feature })).toBe(run);
    }
    expect(listUsableForUser).not.toHaveBeenCalled();
    expect(isCustomerRoutableFeature('agent_task')).toBe(true);
    expect(isCustomerRoutableFeature('agent_task_extra')).toBe(false);
  });

  it('stays dark with no provisioner registered, however the flags are set', async () => {
    registerCustomerRouteProvisioner(null);
    expect(await resolveCallFunding(run, input)).toBe(run);
    expect(getFundingFlags).not.toHaveBeenCalled();
  });

  it.each([
    ['BYOK off', { killSwitch: false, byok: { enabled: false, allowUserIds: ['*'] } }],
    ['kill switch on', { killSwitch: true, byok: { enabled: true, allowUserIds: ['*'] } }],
  ])('stays on AgentWeb with %s, without a connection lookup', async (_label, flags) => {
    getFundingFlags.mockResolvedValue(flags);
    expect(await resolveCallFunding(run, input)).toBe(run);
    expect(listUsableForUser).not.toHaveBeenCalled();
  });

  it('leaves a run that already has a non-AgentWeb funding, or none, untouched', async () => {
    const sub: RunFunding = { ...run, route: 'claude_subscription' };
    expect(await resolveCallFunding(sub, input)).toBe(sub);
    expect(await resolveCallFunding(undefined, input)).toBeUndefined();
    expect(await resolveCallFunding(run, { ...input, userId: undefined })).toBe(run);
  });

  it('keeps the call on AgentWeb, without throwing, if the connection lookup fails', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    listUsableForUser.mockRejectedValue(Object.assign(new Error('secret detail'), { code: 'ThrottlingException' }));
    expect(await resolveCallFunding(run, input)).toBe(run);
    const logged = spy.mock.calls.flat().join(' ');
    spy.mockRestore();
    expect(logged).toContain('ThrottlingException');
    expect(logged).not.toContain('secret detail');
  });
});
