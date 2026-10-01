/**
 * ENG-1222: the socket.on('message') handler (extracted here as
 * handleSocketChatMessage) accepted a client-supplied sessionId with no
 * ownership check, unlike the HTTP chatbot routes (controllers/chatbot.ts),
 * which 403 when session.userId !== userId. Once tool binding started firing
 * for any session with installed skills regardless of portalType, a missing
 * check here would let any authenticated caller execute another user's skill
 * tools (scoped to their own account) just by knowing/guessing that user's
 * sessionId.
 */

const mockJwtVerify = jest.fn();
jest.mock('jsonwebtoken', () => ({ verify: (...args: any[]) => mockJwtVerify(...args) }));

jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'test-secret' }));

const mockGetChatSessionRecord = jest.fn();
const mockGenerateChatResponse = jest.fn();
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSessionRecord: (...args: any[]) => mockGetChatSessionRecord(...args) },
  generateChatResponse: (...args: any[]) => mockGenerateChatResponse(...args),
}));

const mockCheckTokenUsage = jest.fn();
// Spread the real module: replacing it wholesale dropped `toCustomerTokenUsage`,
// so the projection silently returned undefined the moment this path started
// using it. Only `checkTokenUsage` needs to be a stub.
jest.mock('../services/tokenUsageService', () => ({
  ...jest.requireActual('../services/tokenUsageService'),
  checkTokenUsage: (...args: any[]) => mockCheckTokenUsage(...args),
}));

const mockGetUserById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getUserById: (...args: any[]) => mockGetUserById(...args) },
}));

jest.mock('../services/funding/runFunding', () => {
  const actual = jest.requireActual('../services/funding/runFunding');
  return { ...actual, resolveRunFunding: jest.fn() };
});

import { handleSocketChatMessage } from '../services/chatSocketHandler';
import { currentRunFunding, resolveRunFunding, type RunFunding } from '../services/funding/runFunding';

const mockResolveRunFunding = resolveRunFunding as jest.MockedFunction<typeof resolveRunFunding>;

function makeSocket() {
  return {
    id: 'socket-1',
    handshake: { auth: { token: 'valid-jwt' } },
    emit: jest.fn(),
  };
}

describe('handleSocketChatMessage — session ownership (ENG-1222)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckTokenUsage.mockResolvedValue({ allowed: true });
    mockJwtVerify.mockReturnValue({ userId: 'owner-user' });
    mockGenerateChatResponse.mockResolvedValue('a real response');
  });

  it('processes the message when the caller owns the session', async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'sess-1', userId: 'owner-user' });
    const socket = makeSocket();

    await handleSocketChatMessage(socket, { sessionId: 'sess-1', message: 'hi' });

    expect(mockGenerateChatResponse).toHaveBeenCalledWith(
      'sess-1',
      'hi',
      expect.objectContaining({ userId: 'owner-user' }),
    );
    expect(socket.emit).toHaveBeenCalledWith('message', { sessionId: 'sess-1', content: 'a real response' });
  });

  it('rejects a caller who does not own the target session, without invoking generateChatResponse', async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'sess-1', userId: 'other-user' });
    const socket = makeSocket();

    await handleSocketChatMessage(socket, { sessionId: 'sess-1', message: 'call list_connected_accounts' });

    expect(mockGenerateChatResponse).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Unauthorized access to chat session' });
  });

  it('rejects a nonexistent sessionId, without invoking generateChatResponse', async () => {
    mockGetChatSessionRecord.mockResolvedValue(null);
    const socket = makeSocket();

    await handleSocketChatMessage(socket, { sessionId: 'does-not-exist', message: 'hi' });

    expect(mockGenerateChatResponse).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'Chat session not found' });
  });

  it('still blocks on token limit before ever checking session ownership (existing behavior preserved)', async () => {
    mockCheckTokenUsage.mockResolvedValue({ allowed: false });
    const socket = makeSocket();

    await handleSocketChatMessage(socket, { sessionId: 'sess-1', message: 'hi' });

    expect(mockGetChatSessionRecord).not.toHaveBeenCalled();
    expect(mockGenerateChatResponse).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'TOKEN_LIMIT_EXCEEDED' }));
  });

  it('resolves delegated-admin access against the delegated target user, not the admin', async () => {
    mockJwtVerify.mockReturnValue({
      userId: 'admin-user',
      delegateAccess: { adminUserId: 'admin-user', adminEmail: 'a@x.com', targetUserId: 'customer-user', targetEmail: 'c@x.com' },
    });
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'sess-1', userId: 'customer-user' });
    const socket = makeSocket();

    await handleSocketChatMessage(socket, { sessionId: 'sess-1', message: 'hi' });

    expect(mockGenerateChatResponse).toHaveBeenCalledWith(
      'sess-1',
      'hi',
      expect.objectContaining({ userId: 'customer-user', isDelegatedAdmin: true }),
    );
  });
});

/**
 * ENG-1816 F1 — without this wrapping, chatbotService's attribution fixes
 * (embeddings metering, etc.) are silent no-ops on this entry point:
 * currentRunFunding() would read undefined for every real sidebar turn that
 * goes through the socket. Found unwrapped by a round-1 PR review; the fix
 * has since been re-traced by code review 3 more times (rounds 2, 5) but
 * never actually executed by anything until this test.
 */
describe('ENG-1816 F1 — handleSocketChatMessage resolves and enters a RunFunding scope', () => {
  function makeFunding(ownerUserId: string): RunFunding {
    return {
      route: 'agentweb',
      fallback: 'agentweb',
      ownerUserId,
      billingUserId: ownerUserId,
      resolvedAt: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckTokenUsage.mockResolvedValue({ allowed: true });
    mockJwtVerify.mockReturnValue({ userId: 'owner-user' });
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'sess-1', userId: 'owner-user' });
  });

  it('resolves RunFunding for the real caller and generateChatResponse executes inside that scope', async () => {
    const funding = makeFunding('owner-user');
    mockResolveRunFunding.mockResolvedValue(funding);
    const seen: (RunFunding | undefined)[] = [];
    mockGenerateChatResponse.mockImplementation(async () => {
      seen.push(currentRunFunding());
      return 'a real response';
    });
    const socket = makeSocket();

    await handleSocketChatMessage(socket, { sessionId: 'sess-1', message: 'hi' });

    expect(mockResolveRunFunding).toHaveBeenCalledWith({ userId: 'owner-user' });
    expect(seen).toEqual([funding]);
    // No leakage past the handler.
    expect(currentRunFunding()).toBeUndefined();
  });

  it('never invokes generateChatResponse outside any RunFunding scope, even when unauthorized', async () => {
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 'sess-1', userId: 'someone-else' });
    const socket = makeSocket();

    await handleSocketChatMessage(socket, { sessionId: 'sess-1', message: 'hi' });

    expect(mockResolveRunFunding).not.toHaveBeenCalled();
    expect(mockGenerateChatResponse).not.toHaveBeenCalled();
  });
});
