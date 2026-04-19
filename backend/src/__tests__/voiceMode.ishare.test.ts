// Unit tests for iShare voice mode conversable token validation logic
//
// These tests verify the token validation logic that the socket middleware uses
// to authenticate conversable (iShare) socket connections for voice mode.

const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocumentClientMethods),
  },
  S3: jest.fn(() => ({
    upload: jest.fn(),
    getObject: jest.fn(),
    deleteObject: jest.fn(),
  })),
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('test-secret'),
}));

// ---------------------------------------------------------------------------
// Extracted validation logic (mirrors server.ts conversable auth block)
// ---------------------------------------------------------------------------

interface InteractiveShareMetadata {
  isActive: boolean;
  token?: string;
}

interface MockSession {
  userId: string;
  interactiveShareMetadata?: InteractiveShareMetadata;
}

type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

async function validateConversableSocketAuth(
  conversableToken: string,
  conversableSessionId: string,
  getSession: (id: string) => Promise<MockSession | null>
): Promise<AuthResult> {
  const session = await getSession(conversableSessionId);
  if (!session) return { ok: false, error: 'Session not found' };

  const interactiveToken = session.interactiveShareMetadata?.token;
  if (!interactiveToken || interactiveToken !== conversableToken) {
    return { ok: false, error: 'Invalid conversable token' };
  }
  if (!session.interactiveShareMetadata?.isActive) {
    return { ok: false, error: 'Interactive share is not active' };
  }
  return { ok: true, userId: session.userId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('iShare voice mode: conversable socket auth', () => {
  const validSession: MockSession = {
    userId: 'user-abc',
    interactiveShareMetadata: {
      isActive: true,
      token: 'valid-conversable-token-xyz',
    },
  };

  // --- Invalid inputs ---

  it('rejects when session does not exist', async () => {
    const getSession = jest.fn().mockResolvedValue(null);
    const result = await validateConversableSocketAuth('any-token', 'missing-session', getSession);
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('Session not found');
  });

  it('rejects when conversable token does not match session token', async () => {
    const getSession = jest.fn().mockResolvedValue(validSession);
    const result = await validateConversableSocketAuth('wrong-token', 'session-id', getSession);
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('Invalid conversable token');
  });

  it('rejects when session has no interactiveShareMetadata', async () => {
    const sessionWithoutMeta: MockSession = { userId: 'user-abc' };
    const getSession = jest.fn().mockResolvedValue(sessionWithoutMeta);
    const result = await validateConversableSocketAuth('any-token', 'session-id', getSession);
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('Invalid conversable token');
  });

  it('rejects when interactive share is not active', async () => {
    const inactiveSession: MockSession = {
      userId: 'user-abc',
      interactiveShareMetadata: {
        isActive: false,
        token: 'valid-conversable-token-xyz',
      },
    };
    const getSession = jest.fn().mockResolvedValue(inactiveSession);
    const result = await validateConversableSocketAuth(
      'valid-conversable-token-xyz',
      'session-id',
      getSession
    );
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('Interactive share is not active');
  });

  it('rejects an empty conversable token even if session token exists', async () => {
    const getSession = jest.fn().mockResolvedValue(validSession);
    const result = await validateConversableSocketAuth('', 'session-id', getSession);
    expect(result.ok).toBe(false);
    expect((result as any).error).toBe('Invalid conversable token');
  });

  // --- Happy path ---

  it('accepts valid conversable token for active session and returns userId', async () => {
    const getSession = jest.fn().mockResolvedValue(validSession);
    const result = await validateConversableSocketAuth(
      'valid-conversable-token-xyz',
      'session-id',
      getSession
    );
    expect(result.ok).toBe(true);
    expect((result as any).userId).toBe('user-abc');
  });

  it('calls getSession with the provided sessionId', async () => {
    const getSession = jest.fn().mockResolvedValue(validSession);
    await validateConversableSocketAuth('valid-conversable-token-xyz', 'my-session-123', getSession);
    expect(getSession).toHaveBeenCalledWith('my-session-123');
  });
});

// ---------------------------------------------------------------------------
// Session ID mismatch check (mirrors the live:start handler guard)
// ---------------------------------------------------------------------------

describe('iShare voice mode: live:start sessionId guard', () => {
  function checkSessionIdMatch(
    conversableSessionId: string | undefined,
    requestedSessionId: string
  ): boolean {
    if (conversableSessionId && conversableSessionId !== requestedSessionId) {
      return false; // mismatch — reject
    }
    return true;
  }

  it('rejects when conversable sessionId does not match requested sessionId', () => {
    expect(checkSessionIdMatch('session-A', 'session-B')).toBe(false);
  });

  it('allows when conversable sessionId matches requested sessionId', () => {
    expect(checkSessionIdMatch('session-A', 'session-A')).toBe(true);
  });

  it('allows when no conversable sessionId (regular JWT auth)', () => {
    expect(checkSessionIdMatch(undefined, 'any-session')).toBe(true);
  });
});
