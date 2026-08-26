/**
 * Tests for mcp/server/adminClientScope.ts (ENG-1596).
 *
 * resolveClientScopedContext is the single gate every admin MCP tool's
 * client_id param routes through: no client_id → unchanged self-scoped
 * context (100% backward compatible); client_id present → caller must be a
 * server-verified admin (DB lookup, never trusted from the caller-supplied
 * context) and the target must be a real customer account, or it throws
 * loudly rather than silently falling back to the caller's own data.
 */

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
  },
}));

jest.mock('../services/delegateAccessToken', () => ({
  mintDelegateToken: jest.fn().mockReturnValue('minted-delegate-token'),
}));

import { resolveClientScopedContext } from '../mcp/server/adminClientScope';
import { userDb } from '../services/db';
import { mintDelegateToken } from '../services/delegateAccessToken';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockMintDelegateToken = mintDelegateToken as jest.Mock;

describe('resolveClientScopedContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMintDelegateToken.mockReturnValue('minted-delegate-token');
  });

  it('passes through unchanged when client_id is absent', async () => {
    const context = { userId: 'admin-1', sessionId: 'sess-1' };
    const result = await resolveClientScopedContext(context, undefined);

    expect(result).toEqual({ userId: 'admin-1', agentUserId: undefined, isDelegatedAccess: undefined, sessionId: 'sess-1' });
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
    expect(mockMintDelegateToken).not.toHaveBeenCalled();
  });

  it('passes through unchanged for an empty-string client_id', async () => {
    const context = { userId: 'admin-1' };
    const result = await resolveClientScopedContext(context, '   ');

    expect(result.overrideToken).toBeUndefined();
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller before ever resolving the target', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'caller-1', isAdmin: false } as any);

    await expect(
      resolveClientScopedContext({ userId: 'caller-1' }, 'client@example.com')
    ).rejects.toThrow('client_id is admin-only');

    expect(mockUserDb.getUserByEmail).not.toHaveBeenCalled();
    expect(mockMintDelegateToken).not.toHaveBeenCalled();
  });

  it('rejects when there is no authenticated caller at all', async () => {
    await expect(
      resolveClientScopedContext({}, 'client@example.com')
    ).rejects.toThrow('client_id requires an authenticated caller');

    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
  });

  it('rejects an unknown client_id (email) with a specific error, not a silent fallback', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'admin-1', isAdmin: true } as any);
    mockUserDb.getUserByEmail.mockResolvedValue(undefined as any);

    await expect(
      resolveClientScopedContext({ userId: 'admin-1' }, 'ghost@example.com')
    ).rejects.toThrow('No client account found for "ghost@example.com"');

    expect(mockMintDelegateToken).not.toHaveBeenCalled();
  });

  it('rejects an unknown client_id (userId form, no @) via getUserById', async () => {
    mockUserDb.getUserById
      .mockResolvedValueOnce({ userId: 'admin-1', isAdmin: true } as any) // caller lookup
      .mockResolvedValueOnce(undefined as any); // target lookup

    await expect(
      resolveClientScopedContext({ userId: 'admin-1' }, 'ghost-user-id')
    ).rejects.toThrow('No client account found for "ghost-user-id"');

    expect(mockUserDb.getUserByEmail).not.toHaveBeenCalled();
  });

  it('rejects a resolved target with no customer-portal access', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'admin-1', isAdmin: true } as any);
    mockUserDb.getUserByEmail.mockResolvedValue({ userId: 'partner-1', roles: ['partner'] } as any);

    await expect(
      resolveClientScopedContext({ userId: 'admin-1' }, 'partner@example.com')
    ).rejects.toThrow('does not have customer portal access');

    expect(mockMintDelegateToken).not.toHaveBeenCalled();
  });

  it('mints a delegate token and returns it as overrideToken for a real admin + valid customer target', async () => {
    const caller = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
    const target = { userId: 'target-1', email: 'customer@example.com', roles: ['customer'] };
    mockUserDb.getUserById.mockResolvedValue(caller as any);
    mockUserDb.getUserByEmail.mockResolvedValue(target as any);

    const result = await resolveClientScopedContext({ userId: 'admin-1' }, 'customer@example.com');

    expect(mockMintDelegateToken).toHaveBeenCalledWith(
      { userId: 'admin-1', email: 'admin@example.com' },
      target,
      300,
    );
    expect(result.overrideToken).toBe('minted-delegate-token');
  });

  it('resolves a client_id without "@" via getUserById, not getUserByEmail', async () => {
    mockUserDb.getUserById
      .mockResolvedValueOnce({ userId: 'admin-1', email: 'admin@example.com', isAdmin: true } as any)
      .mockResolvedValueOnce({ userId: 'target-1', email: 'customer@example.com', roles: ['customer'] } as any);

    const result = await resolveClientScopedContext({ userId: 'admin-1' }, 'target-1');

    expect(mockUserDb.getUserByEmail).not.toHaveBeenCalled();
    expect(result.overrideToken).toBe('minted-delegate-token');
  });

  it('falls back to userId when agentUserId is absent', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'admin-1', isAdmin: false } as any);

    await expect(
      resolveClientScopedContext({ userId: 'admin-1' }, 'client@example.com')
    ).rejects.toThrow('client_id is admin-only');

    expect(mockUserDb.getUserById).toHaveBeenCalledWith('admin-1');
  });

  // CodeRabbit (PR #2651) + dev.md's stated convention: "External clients (API
  // keys, OAuth) always use the authenticated agentUserId." When both fields
  // are present, agentUserId must win — never the (potentially less trustworthy)
  // userId.
  it('prefers agentUserId over userId as the caller identity when both are present', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'agent-1', isAdmin: false } as any);

    await expect(
      resolveClientScopedContext({ userId: 'someone-else', agentUserId: 'agent-1' }, 'client@example.com')
    ).rejects.toThrow('client_id is admin-only');

    expect(mockUserDb.getUserById).toHaveBeenCalledWith('agent-1');
    expect(mockUserDb.getUserById).not.toHaveBeenCalledWith('someone-else');
  });
});
