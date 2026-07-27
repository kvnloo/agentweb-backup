/**
 * ENG-521 — cross-tenant `live:start` session-ownership regression tests.
 *
 * Before the fix, `startLiveSession` accepted ANY sessionId from any
 * authenticated socket. An attacker who learned another tenant's chat
 * sessionId got:
 *   - DISCLOSURE: the victim's prior messages were loaded and injected into the
 *     Gemini Live system prompt (`loadHistoryForSystemPrompt`), then read aloud.
 *   - WRITES: every completed voice turn was persisted onto the victim's
 *     session via `chatbotDb.addMessagesToSession`.
 *   - HIJACK: `startLiveSession` closes any pre-existing live session for that
 *     sessionId first, so the attacker also killed and took over the victim's
 *     in-flight voice call.
 *
 * These tests assert BOTH halves of the failure explicitly — that no history is
 * read AND no message is written — not merely that the call was rejected.
 */

// ---------------------------------------------------------------------------
// Mocks (mirror liveVoiceService.test.ts so the service loads identically)
// ---------------------------------------------------------------------------

const mockLiveConnect = jest.fn();
const mockSessionSendClientContent = jest.fn();
const mockSessionSendRealtimeInput = jest.fn();
const mockSessionSendToolResponse = jest.fn();
const mockSessionClose = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    live: {
      connect: mockLiveConnect,
    },
  })),
  Modality: { AUDIO: 'AUDIO', TEXT: 'TEXT' },
  MediaResolution: { MEDIA_RESOLUTION_MEDIUM: 'MEDIA_RESOLUTION_MEDIUM' },
  StartSensitivity: { START_SENSITIVITY_LOW: 'START_SENSITIVITY_LOW' },
  EndSensitivity: { END_SENSITIVITY_LOW: 'END_SENSITIVITY_LOW' },
  ActivityHandling: { START_OF_ACTIVITY_INTERRUPTS: 'START_OF_ACTIVITY_INTERRUPTS' },
}));

jest.mock('../services/onboardingTelemetry', () => ({
  ONBOARDING_TELEMETRY_EVENTS: {
    voiceSessionStarted: 'voice_session_started',
    voiceSessionReady: 'voice_session_ready',
    voiceFirstAudio: 'voice_first_audio',
    voiceTurnCompleted: 'voice_turn_completed',
    voiceTurnRecovery: 'voice_turn_recovery',
    voiceInterrupted: 'voice_interrupted',
    voiceSessionFailed: 'voice_session_failed',
  },
  recordOnboardingEvent: jest.fn().mockResolvedValue(undefined),
  recordOnboardingFailure: jest.fn().mockResolvedValue(undefined),
}));

const mockGetChatSessionRecord = jest.fn();
const mockGetMessagesFromMessagesTable = jest.fn();
const mockAddMessagesToSession = jest.fn();
const mockAddMessageToSession = jest.fn();

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSessionRecord: mockGetChatSessionRecord,
    getMessagesFromMessagesTable: mockGetMessagesFromMessagesTable,
    addMessagesToSession: mockAddMessagesToSession,
    addMessageToSession: mockAddMessageToSession,
  },
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('fake-gemini-api-key'),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getFilteredTools: jest.fn().mockResolvedValue([]),
    getAvailableTools: jest.fn().mockReturnValue([]),
    executeTool: jest.fn(),
    callLLM: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import service under test (after mocks are set up)
// ---------------------------------------------------------------------------

import {
  startLiveSession,
  sendTextTurn,
  closeLiveSession,
  hasLiveSession,
} from '../services/liveVoiceService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VICTIM_USER = 'user-victim-tenant-a';
const ATTACKER_USER = 'user-attacker-tenant-b';
const VICTIM_SESSION = 'session-owned-by-victim';

/** The victim's private conversation — must never reach the attacker. */
const VICTIM_HISTORY = [
  { role: 'user', content: 'Our Q3 acquisition target is Northwind Labs.' },
  { role: 'assistant', content: 'Noted — Northwind Labs, Q3 acquisition target.' },
];

function makeMockSession() {
  return {
    sendClientContent: mockSessionSendClientContent,
    sendRealtimeInput: mockSessionSendRealtimeInput,
    sendToolResponse: mockSessionSendToolResponse,
    close: mockSessionClose,
  };
}

function makeCallbacks() {
  const captured: Record<string, Function> = {};
  mockLiveConnect.mockImplementation(({ callbacks }: { callbacks: Record<string, Function> }) => {
    Object.assign(captured, callbacks);
    return Promise.resolve(makeMockSession());
  });
  return captured;
}

beforeAll(() => {
  process.env.GEMINI_API_KEY = 'test-key';
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  (console.error as jest.Mock).mockRestore();
  (console.warn as jest.Mock).mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  closeLiveSession(VICTIM_SESSION);
  mockGetChatSessionRecord.mockResolvedValue({
    sessionId: VICTIM_SESSION,
    userId: VICTIM_USER,
  });
  mockGetMessagesFromMessagesTable.mockResolvedValue(VICTIM_HISTORY);
  mockAddMessagesToSession.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// NEGATIVE — the cross-user proof (contract item 3)
// ---------------------------------------------------------------------------

describe('startLiveSession — cross-user session ownership (ENG-521)', () => {
  it('rejects when an authenticated user supplies another user\'s sessionId', async () => {
    makeCallbacks();

    await expect(
      startLiveSession(VICTIM_SESSION, 'socket-attacker', jest.fn(), ATTACKER_USER),
    ).rejects.toThrow(/not authorized/i);
  });

  it('loads NO history when a cross-user sessionId is supplied', async () => {
    makeCallbacks();

    await expect(
      startLiveSession(VICTIM_SESSION, 'socket-attacker', jest.fn(), ATTACKER_USER),
    ).rejects.toThrow();

    // The disclosure half: the victim's message table is never read, so nothing
    // can be formatted into the Gemini system prompt.
    expect(mockGetMessagesFromMessagesTable).not.toHaveBeenCalled();
    // And no Gemini session is opened at all, so no prompt is transmitted.
    expect(mockLiveConnect).not.toHaveBeenCalled();
  });

  it('writes NO message when a cross-user sessionId is supplied', async () => {
    makeCallbacks();

    await expect(
      startLiveSession(VICTIM_SESSION, 'socket-attacker', jest.fn(), ATTACKER_USER),
    ).rejects.toThrow();

    // The write half: nothing is persisted onto the victim's session.
    expect(mockAddMessagesToSession).not.toHaveBeenCalled();
    expect(mockAddMessageToSession).not.toHaveBeenCalled();
  });

  it('registers no live session for a cross-user sessionId', async () => {
    makeCallbacks();

    await expect(
      startLiveSession(VICTIM_SESSION, 'socket-attacker', jest.fn(), ATTACKER_USER),
    ).rejects.toThrow();

    expect(hasLiveSession(VICTIM_SESSION)).toBe(false);
  });

  it('never emits live:ready to the unauthorized caller', async () => {
    makeCallbacks();
    const attackerEmit = jest.fn();

    await expect(
      startLiveSession(VICTIM_SESSION, 'socket-attacker', attackerEmit, ATTACKER_USER),
    ).rejects.toThrow();

    expect(attackerEmit).not.toHaveBeenCalled();
  });

  it('does not close or hijack the victim\'s in-flight live session', async () => {
    makeCallbacks();

    // Victim legitimately starts their own voice session.
    await startLiveSession(VICTIM_SESSION, 'socket-victim', jest.fn(), VICTIM_USER);
    expect(hasLiveSession(VICTIM_SESSION)).toBe(true);
    jest.clearAllMocks();

    // Attacker attempts to take it over.
    await expect(
      startLiveSession(VICTIM_SESSION, 'socket-attacker', jest.fn(), ATTACKER_USER),
    ).rejects.toThrow(/not authorized/i);

    // The victim's Gemini session was never closed...
    expect(mockSessionClose).not.toHaveBeenCalled();
    expect(hasLiveSession(VICTIM_SESSION)).toBe(true);
    // ...and the entry is still bound to the victim's socket, not the attacker's.
    await expect(
      sendTextTurn(VICTIM_SESSION, 'still mine', 'socket-victim'),
    ).resolves.toBeUndefined();
    await expect(
      sendTextTurn(VICTIM_SESSION, 'stolen', 'socket-attacker'),
    ).rejects.toThrow();
  });

  it('rejects a sessionId that does not exist, reading and writing nothing', async () => {
    makeCallbacks();
    mockGetChatSessionRecord.mockResolvedValue(null);

    await expect(
      startLiveSession('session-does-not-exist', 'socket-attacker', jest.fn(), ATTACKER_USER),
    ).rejects.toThrow(/not authorized/i);

    expect(mockGetMessagesFromMessagesTable).not.toHaveBeenCalled();
    expect(mockAddMessagesToSession).not.toHaveBeenCalled();
    expect(mockLiveConnect).not.toHaveBeenCalled();
    expect(hasLiveSession('session-does-not-exist')).toBe(false);
  });

  it('rejects a session record with no owner rather than defaulting to allow', async () => {
    makeCallbacks();
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: VICTIM_SESSION });

    await expect(
      startLiveSession(VICTIM_SESSION, 'socket-attacker', jest.fn(), ATTACKER_USER),
    ).rejects.toThrow(/not authorized/i);

    expect(mockGetMessagesFromMessagesTable).not.toHaveBeenCalled();
    expect(mockLiveConnect).not.toHaveBeenCalled();
  });

  it('gives the same error for not-found and not-owned so IDs cannot be enumerated', async () => {
    makeCallbacks();

    const notOwned = await startLiveSession(
      VICTIM_SESSION, 'socket-attacker', jest.fn(), ATTACKER_USER,
    ).catch((e: Error) => e.message);

    mockGetChatSessionRecord.mockResolvedValue(null);
    const notFound = await startLiveSession(
      'session-does-not-exist', 'socket-attacker', jest.fn(), ATTACKER_USER,
    ).catch((e: Error) => e.message);

    expect(notOwned).toMatch(/not authorized/i);
    expect(notFound).toMatch(/not authorized/i);
    expect(notOwned).toBe(notFound);
  });

  it('checks ownership without hydrating the victim\'s messages', async () => {
    makeCallbacks();

    await expect(
      startLiveSession(VICTIM_SESSION, 'socket-attacker', jest.fn(), ATTACKER_USER),
    ).rejects.toThrow();

    // Ownership is resolved from the raw session record, so an unauthorized
    // caller never triggers the message-table read (or its legacy migration
    // write) that full session hydration performs.
    expect(mockGetChatSessionRecord).toHaveBeenCalledWith(VICTIM_SESSION);
    expect(mockGetMessagesFromMessagesTable).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POSITIVE — legitimate flows keep working (contract items 1 and 2)
// ---------------------------------------------------------------------------

describe('startLiveSession — authorized callers are unaffected (ENG-521)', () => {
  it('starts normally for the session owner and loads their own history', async () => {
    makeCallbacks();
    const emitFn = jest.fn();

    await startLiveSession(VICTIM_SESSION, 'socket-victim', emitFn, VICTIM_USER);

    expect(hasLiveSession(VICTIM_SESSION)).toBe(true);
    expect(mockGetMessagesFromMessagesTable).toHaveBeenCalledWith(VICTIM_SESSION);
    expect(emitFn).toHaveBeenCalledWith('live:ready', { sessionId: VICTIM_SESSION });

    const systemPrompt = mockLiveConnect.mock.calls[0][0].config.systemInstruction;
    expect(systemPrompt.parts[0].text).toContain('Northwind Labs');
  });

  it('starts for a delegated admin whose effective user is the target customer', async () => {
    makeCallbacks();

    // server.ts resolves delegateAccess.targetUserId as the effective user, so
    // the delegated admin arrives here already scoped to the customer.
    await startLiveSession(VICTIM_SESSION, 'socket-admin-delegate', jest.fn(), VICTIM_USER);

    expect(hasLiveSession(VICTIM_SESSION)).toBe(true);
    expect(mockLiveConnect).toHaveBeenCalledTimes(1);
  });

  it('starts for an iShare (conversable) socket resolved to the session owner', async () => {
    makeCallbacks();

    // The socket middleware sets conversableUserId = session.userId and the
    // live:start handler pins conversableSessionId === sessionId, so the
    // effective user always equals the owner for this boundary.
    await startLiveSession(VICTIM_SESSION, 'socket-ishare', jest.fn(), VICTIM_USER);

    expect(hasLiveSession(VICTIM_SESSION)).toBe(true);
  });

  it('checks ownership before opening the Gemini connection', async () => {
    makeCallbacks();

    await startLiveSession(VICTIM_SESSION, 'socket-victim', jest.fn(), VICTIM_USER);

    const ownershipCallOrder = mockGetChatSessionRecord.mock.invocationCallOrder[0];
    const geminiCallOrder = mockLiveConnect.mock.invocationCallOrder[0];
    expect(ownershipCallOrder).toBeLessThan(geminiCallOrder);
  });

  it('surfaces a session-record lookup failure instead of starting anyway', async () => {
    makeCallbacks();
    mockGetChatSessionRecord.mockRejectedValue(new Error('DynamoDB unavailable'));

    await expect(
      startLiveSession(VICTIM_SESSION, 'socket-victim', jest.fn(), VICTIM_USER),
    ).rejects.toThrow('DynamoDB unavailable');

    expect(mockLiveConnect).not.toHaveBeenCalled();
    expect(hasLiveSession(VICTIM_SESSION)).toBe(false);
  });
});
