const mockResolveEmailAccount = jest.fn();
const mockWithAccessGuard = jest.fn(async (_userId: string, _resolved: unknown, _operation: string, run: () => Promise<unknown>) => run());
const mockListConnections = jest.fn();
const mockGetFreshToken = jest.fn();
const mockListTools = jest.fn();
const mockCallTool = jest.fn();

jest.mock('../../../services/emailProviderService', () => ({
  bootstrapEmailProviders: jest.fn(async () => undefined),
  resolveEmailAccount: (...args: unknown[]) => mockResolveEmailAccount(...args),
  withAccessGuard: (...args: unknown[]) => (mockWithAccessGuard as any)(...args),
}));
jest.mock('../config', () => ({
  getAgenticFabriqAppCredentials: jest.fn(async () => ({ appId: 'app' })),
  getAgenticFabriqApiBaseUrl: jest.fn(() => 'https://api.example.com'),
}));
jest.mock('../client', () => ({
  agenticFabriqClient: { listConnections: (...args: unknown[]) => mockListConnections(...args) },
}));
jest.mock('../tokenCache', () => ({
  agenticFabriqTokenCache: { getFreshToken: (...args: unknown[]) => mockGetFreshToken(...args) },
}));
jest.mock('../mcpBridge', () => ({
  resolveMcpExternalUrl: jest.fn(() => 'https://api.example.com/mcp/external'),
  agenticFabriqMcpBridge: {
    listTools: (...args: unknown[]) => mockListTools(...args),
    callTool: (...args: unknown[]) => mockCallTool(...args),
  },
}));

import { runEmailToolThroughAgenticFabriq } from '../emailBridge';
import { connectionIdForAccount } from '../pendingConnectStore';

const OWN = { platform: 'gmail', ownerUserId: 'user-1', accountId: 'account-1', provider: {} };

describe('Agentic Fabriq mailbox authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveEmailAccount.mockResolvedValue(OWN);
    mockGetFreshToken.mockResolvedValue({ accessToken: 'token', mcpUrl: '', expiresAtMs: 1, mintedAtMs: 0 });
    mockListTools.mockResolvedValue([{ name: 'google_gmail_search_messages' }]);
    mockCallTool.mockResolvedValue({ emails: [] });
    mockListConnections.mockResolvedValue([{ tool: 'gmail', connection_id: connectionIdForAccount('account-1', 'user-1'), status: 'connected' }]);
  });

  it('requires account_id before any provider lookup', async () => {
    await expect(runEmailToolThroughAgenticFabriq({ action: 'search', query: 'x' }, 'user-1')).rejects.toMatchObject({ name: 'AgenticFabriqUnsupportedMailboxError' });
    expect(mockListConnections).not.toHaveBeenCalled();
  });

  it('fails closed for a shared mailbox even for reads', async () => {
    mockResolveEmailAccount.mockResolvedValue({ ...OWN, ownerUserId: 'teammate' });
    await expect(runEmailToolThroughAgenticFabriq({ account_id: 'account-1', action: 'search', query: 'x' }, 'user-1')).rejects.toMatchObject({ name: 'AgenticFabriqUnsupportedMailboxError' });
    expect(mockListConnections).not.toHaveBeenCalled();
  });

  it.each(['send', 'reply', 'delete', 'search_and_delete'])('rejects %s before any vendor or token call', async (action) => {
    await expect(runEmailToolThroughAgenticFabriq({ account_id: 'account-1', action } as any, 'user-1')).rejects.toThrow(/read-only/);
    expect(mockResolveEmailAccount).not.toHaveBeenCalled();
    expect(mockListConnections).not.toHaveBeenCalled();
    expect(mockGetFreshToken).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('does not select a different Gmail connection when the exact binding is absent', async () => {
    mockListConnections.mockResolvedValue([{ tool: 'gmail', connection_id: connectionIdForAccount('other-account', 'user-1'), status: 'connected' }]);
    const result = await runEmailToolThroughAgenticFabriq({ account_id: 'account-1', action: 'search', query: 'x' }, 'user-1');
    expect(result.outcome).toMatchObject({ error: expect.stringContaining('No connected Gmail account') });
    expect(mockListTools).not.toHaveBeenCalled();
  });

  it('fails closed for an unreviewed discovered tool without a tool call', async () => {
    const result = await runEmailToolThroughAgenticFabriq({ account_id: 'account-1', action: 'search', query: 'x' }, 'user-1');
    expect(result.outcome).toMatchObject({ error: expect.stringContaining('reviewed') });
    expect(mockCallTool).not.toHaveBeenCalled();
  });
  it.each(['account', 'connections', 'token', 'discovery'])('redacts hostile %s failures at the exported bridge boundary', async (stage) => {
    const mocks = { account: mockResolveEmailAccount, connections: mockListConnections, token: mockGetFreshToken, discovery: mockListTools };
    mocks[stage as keyof typeof mocks].mockRejectedValueOnce(new Error('user-1 account-1 /api/private/user-1 bearer-secret'));
    await expect(runEmailToolThroughAgenticFabriq({ account_id: 'account-1', action: 'search', query: 'x' }, 'user-1'))
      .rejects.toThrow('Agentic Fabriq canary request failed.');
  });

});
