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
    mockListConnections.mockResolvedValue([{ tool: 'gmail', connection_id: connectionIdForAccount('account-1'), status: 'connected' }]);
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

  it('resolves sends with send authorization before contacting Fabriq', async () => {
    mockResolveEmailAccount.mockRejectedValue(new Error('shared mailboxes are read-only'));
    await expect(runEmailToolThroughAgenticFabriq({ account_id: 'account-1', action: 'send', to: 'x@y.test', subject: 's', body: 'b' }, 'user-1')).rejects.toThrow(/read-only/);
    expect(mockResolveEmailAccount).toHaveBeenCalledWith('user-1', 'account-1', 'send');
    expect(mockListConnections).not.toHaveBeenCalled();
  });

  it('does not select a different Gmail connection when the exact binding is absent', async () => {
    mockListConnections.mockResolvedValue([{ tool: 'gmail', connection_id: connectionIdForAccount('other-account'), status: 'connected' }]);
    const result = await runEmailToolThroughAgenticFabriq({ account_id: 'account-1', action: 'search', query: 'x' }, 'user-1');
    expect(result.outcome).toMatchObject({ error: expect.stringContaining('No connected Gmail account') });
    expect(mockListTools).not.toHaveBeenCalled();
  });

  it('passes the exact account and connection binding and guards result delivery', async () => {
    const result = await runEmailToolThroughAgenticFabriq({ account_id: 'account-1', action: 'search', query: 'x', max_results: 500 }, 'user-1');
    expect(result.outcome).toEqual({ emails: [] });
    expect(mockWithAccessGuard).toHaveBeenCalledWith('user-1', OWN, 'read', expect.any(Function));
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.any(String),
      'token',
      'google_gmail_search_messages',
      expect.objectContaining({ account_id: 'account-1', connection_id: connectionIdForAccount('account-1'), max_results: 50 }),
    );
  });
});
