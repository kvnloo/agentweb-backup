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

import { handleSocketChatMessage } from '../services/chatSocketHandler';

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
