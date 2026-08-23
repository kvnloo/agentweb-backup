jest.mock('../mcp/server/httpClient', () => ({ mcpFetch: jest.fn() }));
jest.mock('../services/skillService', () => ({ skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) } }));
jest.mock('../services/subscriptionService', () => ({ getAllowedSkills: jest.fn().mockResolvedValue(['*']) }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { getUnassociatedToolNames: jest.fn().mockReturnValue([]) } }));

import { mcpToolRegistry } from '../mcp/server/registry';
import { mcpFetch } from '../mcp/server/httpClient';
import '../mcp/server/apiTools';

const fetchMock = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const context = { userId: 'admin-1' };

describe('manage_client_allowance MCP tool', () => {
  beforeEach(() => jest.clearAllMocks());

  it('translates inspect and both mutation actions to their admin routes', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await mcpToolRegistry.execute('manage_client_allowance', { action: 'inspect', email: 'a+b@example.com' }, context);
    await mcpToolRegistry.execute('manage_client_allowance', { action: 'change_subscription', email: 'a@example.com', subscription_type: 'Pro', reason: 'support', confirmed: true }, context);
    await mcpToolRegistry.execute('manage_client_allowance', { action: 'grant_cost_credit', email: 'a@example.com', amount_usd: 0.01, idempotency_key: 'credit-20260823', reason: 'support', confirmed: true }, context);
    expect(fetchMock.mock.calls.map(([call]) => call)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        path: '/api/admin/client-allowance?email=a%2Bb%40example.com',
        context: expect.objectContaining({ userId: 'admin-1' }),
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/admin/client-allowance/subscription',
        context: expect.objectContaining({ userId: 'admin-1' }),
        body: expect.objectContaining({ email: 'a@example.com', subscriptionType: 'Pro', confirmed: true }),
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/admin/client-allowance/cost-credit',
        context: expect.objectContaining({ userId: 'admin-1' }),
        body: expect.objectContaining({ email: 'a@example.com', amountUsd: 0.01, idempotencyKey: 'credit-20260823', confirmed: true }),
      }),
    ]));
  });

  it('returns the existing unknown-action result without a request', async () => {
    const result: any = await mcpToolRegistry.execute('manage_client_allowance', { action: 'unsupported', email: 'a@example.com' }, context);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'Unknown action' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses delegated access before it can mint an admin self-call token', async () => {
    const result: any = await mcpToolRegistry.execute('manage_client_allowance', { action: 'inspect', email: 'a@example.com' }, { userId: 'contractor-1', isDelegatedAccess: true });
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'Administrator access is required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
