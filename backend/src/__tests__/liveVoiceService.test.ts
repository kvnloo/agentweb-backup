/**
 * Tests for liveVoiceService.ts
 *
 * The Live Voice Service manages Gemini Live API sessions — one persistent
 * WebSocket connection per Agent Mode chat session. It proxies audio/text
 * between the browser (via Socket.IO) and Gemini, then asynchronously saves
 * transcripts to DynamoDB when a turn completes.
 */

// ---------------------------------------------------------------------------
// Mocks
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

const mockAddMessageToSession = jest.fn();
const mockAddMessagesToSession = jest.fn();
// ENG-521: startLiveSession now resolves the session owner before starting.
// These tests all drive sessions owned by 'test-user-id'. Cross-user rejection
// is covered separately in liveVoiceService.sessionOwnership.test.ts.
const mockGetChatSessionRecord = jest.fn();
const mockGetMessagesFromMessagesTable = jest.fn().mockResolvedValue([]);

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: mockAddMessageToSession,
    addMessagesToSession: mockAddMessagesToSession,
    getChatSessionRecord: mockGetChatSessionRecord,
    getMessagesFromMessagesTable: mockGetMessagesFromMessagesTable,
  },
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('fake-gemini-api-key'),
}));

const mockExecuteTool = jest.fn();
const mockGetFilteredTools = jest.fn().mockResolvedValue([]);
const mockGetAvailableTools = jest.fn().mockReturnValue([]);
const mockCallLLM = jest.fn().mockResolvedValue({
  choices: [{ message: { content: '{"narrative":"Tool completed successfully.","artifacts":[]}' } }],
});
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getFilteredTools: mockGetFilteredTools,
    getAvailableTools: mockGetAvailableTools,
    executeTool: mockExecuteTool,
    callLLM: mockCallLLM,
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Import service under test (after mocks are set up)
// ---------------------------------------------------------------------------

import {
  startLiveSession,
  sendAudioChunk,
  sendAudioStreamEnd,
  sendTextTurn,
  closeLiveSession,
  hasLiveSession,
} from '../services/liveVoiceService';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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
  mockGetChatSessionRecord.mockImplementation(async (sessionId: string) => ({
    sessionId,
    userId: 'test-user-id',
  }));
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// startLiveSession
// ---------------------------------------------------------------------------

describe('startLiveSession', () => {
  it('opens a Gemini Live connection and marks session as active', async () => {
    const callbacks = makeCallbacks();
    const emitFn = jest.fn();

    await startLiveSession('session-1', 'socket-abc', emitFn, 'test-user-id');

    expect(mockLiveConnect).toHaveBeenCalledTimes(1);
    expect(mockLiveConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.stringContaining('gemini'),
        config: expect.objectContaining({
          responseModalities: expect.arrayContaining(['AUDIO']),
          speechConfig: expect.objectContaining({
            voiceConfig: expect.objectContaining({
              prebuiltVoiceConfig: expect.objectContaining({
                voiceName: 'Kore',
              }),
            }),
          }),
        }),
        callbacks: expect.objectContaining({
          onopen: expect.any(Function),
          onmessage: expect.any(Function),
          onerror: expect.any(Function),
          onclose: expect.any(Function),
        }),
      })
    );

    expect(hasLiveSession('session-1')).toBe(true);
  });

  it('signals the browser only after the Gemini Live session is ready', async () => {
    makeCallbacks();
    const emitFn = jest.fn();

    await startLiveSession('session-ready', 'socket-ready', emitFn, 'test-user-id');

    expect(emitFn).toHaveBeenCalledWith('live:ready', { sessionId: 'session-ready' });
  });

  it('loads only onboarding-safe tools for the onboarding profile', async () => {
    makeCallbacks();
    mockGetAvailableTools.mockReturnValueOnce([
      { type: 'function', function: { name: 'publish_blog_article', parameters: { type: 'object' } } },
    ]);
    mockGetFilteredTools.mockResolvedValueOnce([
      { type: 'function', function: { name: 'list_connected_accounts', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'connect_account', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'publish_blog_article', parameters: { type: 'object' } } },
    ]);

    await startLiveSession(
      'session-onboarding-tools',
      'socket-onboarding-tools',
      jest.fn(),
      'test-user-id',
      'onboarding',
    );

    const declarations = mockLiveConnect.mock.calls[0][0].config.tools[0].functionDeclarations;
    expect(declarations.map((tool: { name: string }) => tool.name)).toEqual([
      'list_connected_accounts',
      'connect_account',
    ]);
    expect(mockGetFilteredTools).toHaveBeenCalledWith('test-user-id');
    expect(mockGetAvailableTools).not.toHaveBeenCalled();
  });

  it('directs Emma to use a neutral accent', async () => {
    makeCallbacks();

    await startLiveSession('session-neutral-accent', 'socket-accent', jest.fn(), 'test-user-id');

    const connectionConfig = mockLiveConnect.mock.calls[0][0].config;
    expect(connectionConfig.systemInstruction.parts[0].text).toContain('neutral');
  });

  it('directs Emma to use General American English', async () => {
    makeCallbacks();

    await startLiveSession('session-american-english', 'socket-american', jest.fn(), 'test-user-id');

    const connectionConfig = mockLiveConnect.mock.calls[0][0].config;
    expect(connectionConfig.systemInstruction.parts[0].text).toContain('General American English');
  });

  it('allows a natural pause before committing the user turn', async () => {
    makeCallbacks();

    await startLiveSession('session-natural-pause', 'socket-pause', jest.fn(), 'test-user-id');

    const detection = mockLiveConnect.mock.calls[0][0].config
      .realtimeInputConfig.automaticActivityDetection;
    expect(detection).toEqual(expect.objectContaining({
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
      endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
    }));
    expect(detection.prefixPaddingMs).toBeGreaterThanOrEqual(150);
    expect(detection.silenceDurationMs).toBeGreaterThanOrEqual(1_000);
  });

  it('starting a second session for the same sessionId replaces the old one', async () => {
    const emitFn = jest.fn();
    makeCallbacks();
    await startLiveSession('session-dup', 'socket-1', emitFn, 'test-user-id');

    makeCallbacks();
    await startLiveSession('session-dup', 'socket-2', emitFn, 'test-user-id');

    // close was called on the first session
    expect(mockSessionClose).toHaveBeenCalledTimes(1);
    expect(hasLiveSession('session-dup')).toBe(true);
  });

  it('different sessionIds maintain independent sessions', async () => {
    const emitFn = jest.fn();
    makeCallbacks();
    await startLiveSession('session-A', 'socket-1', emitFn, 'test-user-id');

    makeCallbacks();
    await startLiveSession('session-B', 'socket-2', emitFn, 'test-user-id');

    expect(hasLiveSession('session-A')).toBe(true);
    expect(hasLiveSession('session-B')).toBe(true);
    expect(mockLiveConnect).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// sendAudioChunk
// ---------------------------------------------------------------------------

describe('sendAudioChunk', () => {
  it('forwards base64 audio to Gemini sendRealtimeInput', async () => {
    const emitFn = jest.fn();
    makeCallbacks();
    await startLiveSession('session-audio', 'socket-1', emitFn, 'test-user-id');

    await sendAudioChunk('session-audio', 'SGVsbG8=', 'socket-1');

    expect(mockSessionSendRealtimeInput).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({
          data: 'SGVsbG8=',
          mimeType: expect.stringContaining('audio'),
        }),
      })
    );
  });

  it('throws if session does not exist', async () => {
    await expect(sendAudioChunk('no-such-session', 'abc=', 'socket-1')).rejects.toThrow();
  });

  it('rejects audio from a socket that does not own the session', async () => {
    makeCallbacks();
    await startLiveSession('session-owned-audio', 'socket-owner', jest.fn(), 'test-user-id');

    await expect(
      sendAudioChunk('session-owned-audio', 'abc=', 'socket-attacker'),
    ).rejects.toThrow(/active live session/i);
  });
});

describe('sendAudioStreamEnd', () => {
  it('flushes a stalled automatic-VAD turn without closing the live session', async () => {
    makeCallbacks();
    await startLiveSession('session-stalled-turn', 'socket-1', jest.fn(), 'test-user-id');

    await sendAudioStreamEnd('session-stalled-turn', 'socket-1');

    expect(mockSessionSendRealtimeInput).toHaveBeenCalledWith({ audioStreamEnd: true });
    expect(hasLiveSession('session-stalled-turn')).toBe(true);
  });

  it('rejects a stream-end request from a socket that does not own the session', async () => {
    makeCallbacks();
    await startLiveSession('session-owned-turn', 'socket-owner', jest.fn(), 'test-user-id');

    await expect(
      sendAudioStreamEnd('session-owned-turn', 'socket-attacker'),
    ).rejects.toThrow(/active live session/i);
    expect(mockSessionSendRealtimeInput).not.toHaveBeenCalledWith({ audioStreamEnd: true });
  });
});

// ---------------------------------------------------------------------------
// sendTextTurn
// ---------------------------------------------------------------------------

describe('sendTextTurn', () => {
  it('forwards text input to Gemini sendClientContent', async () => {
    const emitFn = jest.fn();
    makeCallbacks();
    await startLiveSession('session-text', 'socket-1', emitFn, 'test-user-id');

    await sendTextTurn('session-text', 'What is my ad spend this month?', 'socket-1');

    expect(mockSessionSendClientContent).toHaveBeenCalledWith(
      expect.objectContaining({
        turns: expect.arrayContaining([
          expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({ text: 'What is my ad spend this month?' }),
            ]),
          }),
        ]),
      })
    );
  });

  it('throws if session does not exist', async () => {
    await expect(sendTextTurn('ghost-session', 'hello', 'socket-1')).rejects.toThrow();
  });

  it('rejects text from a socket that does not own the session', async () => {
    makeCallbacks();
    await startLiveSession('session-owned-text', 'socket-owner', jest.fn(), 'test-user-id');

    await expect(
      sendTextTurn('session-owned-text', 'hello', 'socket-attacker'),
    ).rejects.toThrow(/active live session/i);
  });
});

// ---------------------------------------------------------------------------
// Incoming audio from Gemini → emit to client
// ---------------------------------------------------------------------------

describe('incoming audio relay', () => {
  it('tells the browser to clear buffered speech when Gemini confirms an interruption', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-interrupted', 'socket-1', emitFn, 'test-user-id');

    callbacks['onmessage']?.({
      serverContent: { interrupted: true },
    });

    expect(emitFn).toHaveBeenCalledWith('live:interrupted', {
      sessionId: 'session-interrupted',
    });
  });

  it('emits live:audio event when Gemini returns inline audio data', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-relay', 'socket-1', emitFn, 'test-user-id');

    // Simulate Gemini sending back audio
    callbacks['onmessage']?.({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                data: 'YXVkaW9kYXRh',
                mimeType: 'audio/pcm;rate=24000',
              },
            },
          ],
        },
      },
    });

    expect(emitFn).toHaveBeenCalledWith('live:audio', {
      sessionId: 'session-relay',
      chunk: 'YXVkaW9kYXRh',
      mimeType: 'audio/pcm;rate=24000',
    });
  });

  it('emits live:transcript when Gemini returns inline text', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-transcript', 'socket-1', emitFn, 'test-user-id');

    callbacks['onmessage']?.({
      serverContent: {
        modelTurn: {
          parts: [{ text: 'Your ad spend is $1,200 this month.' }],
        },
      },
    });

    expect(emitFn).toHaveBeenCalledWith('live:transcript', {
      sessionId: 'session-transcript',
      text: 'Your ad spend is $1,200 this month.',
    });
  });

  it('emits live:transcript when Gemini returns outputTranscription (audio-only mode)', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-audiotranscript', 'socket-1', emitFn, 'test-user-id');

    callbacks['onmessage']?.({
      serverContent: {
        outputTranscription: { text: 'Your campaigns are performing well.' },
      },
    });

    expect(emitFn).toHaveBeenCalledWith('live:transcript', {
      sessionId: 'session-audiotranscript',
      text: 'Your campaigns are performing well.',
    });
  });
});

// ---------------------------------------------------------------------------
// turnComplete → save transcript to DynamoDB
// ---------------------------------------------------------------------------

describe('turnComplete handling', () => {
  it('saves user and assistant messages to DynamoDB on turnComplete (inline text mode)', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-save', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    // Simulate a full turn: user input was tracked, Gemini responds with text, then turnComplete
    callbacks['onmessage']?.({
      serverContent: {
        modelTurn: {
          parts: [{ text: 'Here is your report.' }],
        },
      },
    });
    callbacks['onmessage']?.({
      serverContent: { turnComplete: true },
    });

    // Allow async save to run
    await Promise.resolve();
    await Promise.resolve();

    expect(mockAddMessagesToSession).toHaveBeenCalledWith(
      'session-save',
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: expect.stringContaining('Here is your report.') }),
      ])
    );
  });

  it('saves transcript from outputTranscription field (audio-only mode)', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-save-audio', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    // Simulate audio-only turn: transcript comes via outputTranscription, not part.text
    callbacks['onmessage']?.({
      serverContent: {
        outputTranscription: { text: 'Your CTR is 3.2% this week.' },
      },
    });
    callbacks['onmessage']?.({
      serverContent: { turnComplete: true },
    });

    // Allow async save to run
    await Promise.resolve();
    await Promise.resolve();

    expect(mockAddMessagesToSession).toHaveBeenCalledWith(
      'session-save-audio',
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: expect.stringContaining('Your CTR is 3.2% this week.') }),
      ])
    );
  });

  it('saves user speech transcript from inputTranscription field', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-save-user', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    // Simulate: user speech transcribed by Gemini, then assistant responds
    callbacks['onmessage']?.({
      serverContent: {
        inputTranscription: { text: 'How is my ad spend?' },
      },
    });
    callbacks['onmessage']?.({
      serverContent: {
        outputTranscription: { text: 'Your ad spend is $500 this week.' },
      },
    });
    callbacks['onmessage']?.({
      serverContent: { turnComplete: true },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(mockAddMessagesToSession).toHaveBeenCalledWith(
      'session-save-user',
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.stringContaining('How is my ad spend?') }),
        expect.objectContaining({ role: 'assistant', content: expect.stringContaining('Your ad spend is $500 this week.') }),
      ])
    );
  });

  it('emits live:turn-complete event after turn finishes', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-complete', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: {
        modelTurn: { parts: [{ text: 'Done.' }] },
      },
    });
    callbacks['onmessage']?.({
      serverContent: { turnComplete: true },
    });

    await Promise.resolve();

    expect(emitFn).toHaveBeenCalledWith('live:turn-complete', {
      sessionId: 'session-complete',
      assistantText: 'Done.',
      userText: '',
    });
  });

  it('does not block audio playback while saving transcript', async () => {
    // The save is fire-and-forget; audio events should fire before save completes
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-nonblock', 'socket-1', emitFn, 'test-user-id');

    let saveResolve: () => void;
    mockAddMessagesToSession.mockReturnValue(
      new Promise<void>((resolve) => { saveResolve = resolve; })
    );

    callbacks['onmessage']?.({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: 'audio==', mimeType: 'audio/pcm;rate=24000' } }] },
      },
    });
    callbacks['onmessage']?.({
      serverContent: { turnComplete: true },
    });

    // Audio emit should already have happened
    expect(emitFn).toHaveBeenCalledWith('live:audio', expect.any(Object));

    // Save hasn't finished yet but we didn't block
    saveResolve!();
  });
});

// ---------------------------------------------------------------------------
// Emotion tag stripping
// ---------------------------------------------------------------------------

describe('emotion tag stripping', () => {
  it('passes inline text through unchanged to live:transcript', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-emotion-inline', 'socket-1', emitFn, 'test-user-id');

    callbacks['onmessage']?.({
      serverContent: {
        modelTurn: {
          parts: [{ text: 'Great news! Your CTR is up 12%.' }],
        },
      },
    });

    const transcriptCall = emitFn.mock.calls.find(([event]) => event === 'live:transcript');
    expect(transcriptCall).toBeDefined();
    expect(transcriptCall![1].text).toContain('Great news!');
  });

  it('passes inline text with punctuation through unchanged to live:transcript', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-emotion-punctuation', 'socket-1', emitFn, 'test-user-id');

    callbacks['onmessage']?.({
      serverContent: {
        modelTurn: {
          parts: [{ text: 'Hello there! Your results are in.' }],
        },
      },
    });

    const transcriptCall = emitFn.mock.calls.find(([event]) => event === 'live:transcript');
    expect(transcriptCall).toBeDefined();
    expect(transcriptCall![1].text).toContain('Hello there!');
    expect(transcriptCall![1].text).toContain('Your results are in.');
  });

  it('passes outputTranscription text through unchanged for emitting and saving', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-emotion-output', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: {
        outputTranscription: { text: 'Your campaigns are doing well. Let me check the numbers.' },
      },
    });
    callbacks['onmessage']?.({
      serverContent: { turnComplete: true },
    });

    await Promise.resolve();
    await Promise.resolve();

    const transcriptCall = emitFn.mock.calls.find(([event]) => event === 'live:transcript');
    expect(transcriptCall![1].text).toContain('Your campaigns are doing well.');

    const saveCall = mockAddMessagesToSession.mock.calls[0];
    const savedContent: string = saveCall[1].find((m: any) => m.role === 'assistant')?.content ?? '';
    expect(savedContent).toContain('Your campaigns are doing well.');
  });

  it('preserves inter-chunk spacing when Gemini streams words in separate chunks', async () => {
    // Gemini streams with trailing spaces like "I've got " + "them!" — stripping per-chunk
    // must not remove the trailing space or words will be concatenated without spaces.
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-spacing', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: "I've got " } },
    });
    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: 'them! Your brand is TaskFlow.' } },
    });
    callbacks['onmessage']?.({
      serverContent: { turnComplete: true },
    });

    await Promise.resolve();
    await Promise.resolve();

    const turnCompleteCall = emitFn.mock.calls.find(([event]) => event === 'live:turn-complete');
    // Words must be separated by a space, not concatenated
    expect(turnCompleteCall![1].assistantText).toContain("I've got them!");
    expect(turnCompleteCall![1].assistantText).not.toContain("I've gotthem!");
  });

  it('passes inputTranscription (user speech transcript) through unchanged', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-emotion-input', 'socket-1', emitFn, 'test-user-id');

    callbacks['onmessage']?.({
      serverContent: {
        inputTranscription: { text: 'How is my ad spend?' },
      },
    });

    const userTranscriptCall = emitFn.mock.calls.find(([event]) => event === 'live:user-transcript');
    expect(userTranscriptCall).toBeDefined();
    expect(userTranscriptCall![1].text).toContain('How is my ad spend?');
  });
});

// ---------------------------------------------------------------------------
// Tool text isolation (not shown in chat UI)
// ---------------------------------------------------------------------------

describe('tool text isolation', () => {
  it('does not include tool call output in assistantText emitted to browser', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-tool-emit', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    // Simulate: outputTranscription with spoken response (what should appear in chat)
    callbacks['onmessage']?.({
      serverContent: {
        outputTranscription: { text: 'Here is your campaign summary.' },
      },
    });
    callbacks['onmessage']?.({
      serverContent: { turnComplete: true },
    });

    await Promise.resolve();

    const turnCompleteCall = emitFn.mock.calls.find(([event]) => event === 'live:turn-complete');
    expect(turnCompleteCall).toBeDefined();
    // assistantText should only contain the spoken transcript (trimmed at turn level)
    expect(turnCompleteCall![1].assistantText).toContain('Here is your campaign summary.');
    // No tool output appended
    expect(turnCompleteCall![1].assistantText).not.toContain('[Tool:');
  });
});

// ---------------------------------------------------------------------------
// closeLiveSession
// ---------------------------------------------------------------------------

describe('closeLiveSession', () => {
  it('closes the Gemini session and removes it from active map', async () => {
    const emitFn = jest.fn();
    makeCallbacks();
    await startLiveSession('session-close', 'socket-1', emitFn, 'test-user-id');

    expect(hasLiveSession('session-close')).toBe(true);

    closeLiveSession('session-close');

    expect(mockSessionClose).toHaveBeenCalledTimes(1);
    expect(hasLiveSession('session-close')).toBe(false);
  });

  it('is a no-op for unknown sessionId', () => {
    expect(() => closeLiveSession('does-not-exist')).not.toThrow();
  });

  it('does not let stale socket cleanup close a replacement session', async () => {
    makeCallbacks();
    await startLiveSession('session-replaced', 'socket-old', jest.fn(), 'test-user-id');
    await startLiveSession('session-replaced', 'socket-new', jest.fn(), 'test-user-id');

    closeLiveSession('session-replaced', 'socket-old');
    expect(hasLiveSession('session-replaced')).toBe(true);

    closeLiveSession('session-replaced', 'socket-new');
    expect(hasLiveSession('session-replaced')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Noise turn filtering
// ---------------------------------------------------------------------------

describe('noise turn filtering', () => {
  it('does NOT save a user transcript that is purely filler noise (e.g. "uh")', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-noise-uh', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: { inputTranscription: { text: 'uh' } },
    });
    callbacks['onmessage']?.({
      serverContent: {
        outputTranscription: { text: 'I didn\'t catch that — could you repeat?' },
      },
    });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });

    await Promise.resolve();
    await Promise.resolve();

    const saveCall = mockAddMessagesToSession.mock.calls[0];
    const messages: any[] = saveCall?.[1] ?? [];
    const userMsg = messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeUndefined();
  });

  it('does NOT save a user transcript that is just background noise punctuation ("...")', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-noise-dots', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: { inputTranscription: { text: '...' } },
    });
    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: 'How can I help?' } },
    });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });

    await Promise.resolve();
    await Promise.resolve();

    const saveCall = mockAddMessagesToSession.mock.calls[0];
    const messages: any[] = saveCall?.[1] ?? [];
    const userMsg = messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeUndefined();
  });

  it('does NOT save a user transcript below the minimum word count (single isolated word noise)', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-noise-single', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: { inputTranscription: { text: 'the' } },
    });
    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: 'Pardon?' } },
    });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });

    await Promise.resolve();
    await Promise.resolve();

    const saveCall = mockAddMessagesToSession.mock.calls[0];
    const messages: any[] = saveCall?.[1] ?? [];
    const userMsg = messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeUndefined();
  });

  it('DOES save a short but meaningful user transcript ("Yes" as affirmation)', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-noise-yes', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: { inputTranscription: { text: 'Yes' } },
    });
    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: 'Great, proceeding.' } },
    });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });

    await Promise.resolve();
    await Promise.resolve();

    const saveCall = mockAddMessagesToSession.mock.calls[0];
    const messages: any[] = saveCall?.[1] ?? [];
    const userMsg = messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toContain('Yes');
  });

  it('DOES save a short but meaningful user transcript ("No" as negation)', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-noise-no', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: { inputTranscription: { text: 'No' } },
    });
    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: 'Okay, cancelling.' } },
    });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });

    await Promise.resolve();
    await Promise.resolve();

    const saveCall = mockAddMessagesToSession.mock.calls[0];
    const messages: any[] = saveCall?.[1] ?? [];
    const userMsg = messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toContain('No');
  });

  it('DOES save a multi-word user transcript despite having filler words among real words', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-noise-mixed', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: { inputTranscription: { text: 'uh how is my ad spend' } },
    });
    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: 'Your ad spend is $500.' } },
    });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });

    await Promise.resolve();
    await Promise.resolve();

    const saveCall = mockAddMessagesToSession.mock.calls[0];
    const messages: any[] = saveCall?.[1] ?? [];
    const userMsg = messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toContain('uh how is my ad spend');
  });

  it('still emits live:user-transcript for display even when the turn is noise (do not suppress UI)', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-noise-display', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: { inputTranscription: { text: 'mm' } },
    });
    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: 'Sorry, I missed that.' } },
    });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });

    await Promise.resolve();
    await Promise.resolve();

    // UI should still receive the transcript (for display), but DynamoDB should not
    const userTranscriptEmit = emitFn.mock.calls.find(([event]) => event === 'live:user-transcript');
    expect(userTranscriptEmit).toBeDefined();

    const saveCall = mockAddMessagesToSession.mock.calls[0];
    const messages: any[] = saveCall?.[1] ?? [];
    const userMsg = messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('emits live:error when Gemini fires onerror', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-err', 'socket-1', emitFn, 'test-user-id');

    callbacks['onerror']?.({ message: 'Connection lost' });

    expect(emitFn).toHaveBeenCalledWith('live:error', {
      sessionId: 'session-err',
      error: expect.stringContaining('Connection lost'),
    });
  });

  it('cleans up session when Gemini closes unexpectedly', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-drop', 'socket-1', emitFn, 'test-user-id');

    callbacks['onclose']?.({ code: 1006, reason: 'server closed' });

    expect(hasLiveSession('session-drop')).toBe(false);
    expect(emitFn).toHaveBeenCalledWith('live:closed', {
      sessionId: 'session-drop',
      code: 1006,
      reason: 'server closed',
    });
  });
});

// ---------------------------------------------------------------------------
// Tool call surfacing in live:turn-complete and DynamoDB metadata
// ---------------------------------------------------------------------------

describe('tool call surfacing', () => {
  const mockSession = {
    sendClientContent: mockSessionSendClientContent,
    sendRealtimeInput: mockSessionSendRealtimeInput,
    sendToolResponse: jest.fn(),
    close: mockSessionClose,
  };

  beforeEach(() => {
    mockLiveConnect.mockImplementation(({ callbacks: cbs }: any) => {
      Object.assign(makeCallbacks(), cbs);
      return Promise.resolve(mockSession);
    });
  });

  it('returns a bounded error to Gemini when a live tool never finishes', async () => {
    jest.useFakeTimers();
    const callbacks = makeCallbacks();
    await startLiveSession('session-tool-timeout', 'socket-1', jest.fn(), 'test-user-id');
    mockExecuteTool.mockReturnValue(new Promise(() => {}));

    callbacks['onmessage']?.({
      toolCall: {
        functionCalls: [{ id: 'fc-timeout', name: 'read_brand_guidelines', args: {} }],
      },
    });

    await jest.advanceTimersByTimeAsync(12_000);
    await Promise.resolve();

    expect(mockSessionSendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        expect.objectContaining({
          id: 'fc-timeout',
          name: 'read_brand_guidelines',
          response: expect.objectContaining({ error: expect.stringMatching(/timed out/i) }),
        }),
      ],
    });
    jest.useRealTimers();
  });

  it('does not timeout and retry a non-cancellable mutating tool', async () => {
    jest.useFakeTimers();
    const callbacks = makeCallbacks();
    await startLiveSession('session-mutating-tool', 'socket-1', jest.fn(), 'test-user-id');
    let resolveTool!: (value: { post_url: string }) => void;
    mockExecuteTool.mockReturnValue(new Promise((resolve) => {
      resolveTool = resolve;
    }));

    callbacks['onmessage']?.({
      toolCall: {
        functionCalls: [{
          id: 'fc-mutation',
          name: 'post_on_connected_account',
          args: { content: 'Hello' },
        }],
      },
    });

    await jest.advanceTimersByTimeAsync(12_000);
    expect(mockSessionSendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        expect.objectContaining({
          id: 'fc-mutation',
          name: 'post_on_connected_account',
          response: expect.objectContaining({ status: 'in_progress' }),
        }),
      ],
    });
    mockSessionSendToolResponse.mockClear();

    callbacks['onmessage']?.({
      toolCall: {
        functionCalls: [{
          id: 'fc-mutation-retry',
          name: 'post_on_connected_account',
          args: { content: 'Hello' },
        }],
      },
    });

    resolveTool({ post_url: 'https://linkedin.com/post/123' });
    await jest.runAllTimersAsync();

    expect(mockExecuteTool).toHaveBeenCalledTimes(1);

    expect(mockSessionSendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        expect.objectContaining({
          id: 'fc-mutation-retry',
          name: 'post_on_connected_account',
          response: expect.objectContaining({ result: expect.any(String) }),
        }),
      ],
    });
  });

  it('includes toolCalls in live:turn-complete payload when tools ran', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-tc-emit', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});
    mockExecuteTool.mockResolvedValue({ post_url: 'https://linkedin.com/post/123' });
    mockSession.sendToolResponse = jest.fn();

    // Simulate tool call
    callbacks['onmessage']?.({
      toolCall: {
        functionCalls: [{ id: 'fc-1', name: 'post_on_connected_account', args: { content: 'Hello' } }],
      },
    });

    // Flush async work: tool execution + summarizeToolResult LLM call
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    // Simulate Gemini responding after tool
    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: 'Your post is live!' } },
    });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });

    await new Promise(resolve => setImmediate(resolve));

    const turnCompleteCall = emitFn.mock.calls.find(([event]) => event === 'live:turn-complete');
    expect(turnCompleteCall).toBeDefined();
    expect(turnCompleteCall![1].toolCalls).toBeDefined();
    expect(turnCompleteCall![1].toolCalls).toHaveLength(1);
    expect(turnCompleteCall![1].toolCalls[0].name).toBe('post_on_connected_account');
    expect(turnCompleteCall![1].toolCalls[0].result).toEqual({ post_url: 'https://linkedin.com/post/123' });
  });

  it('saves assistant message with metadata.toolCalls to DynamoDB when tools ran', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-tc-db', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});
    mockExecuteTool.mockResolvedValue({ htmlUrl: 'https://s3.amazonaws.com/posts/abc' });
    mockSession.sendToolResponse = jest.fn();

    callbacks['onmessage']?.({
      toolCall: {
        functionCalls: [{ id: 'fc-2', name: 'create_social_media_posts', args: { text: 'AI news' } }],
      },
    });

    // Flush async work: tool execution + summarizeToolResult LLM call
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: "Here are your posts." } },
    });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });

    await new Promise(resolve => setImmediate(resolve));

    const saveCall = mockAddMessagesToSession.mock.calls.find(
      ([sid]: [string]) => sid === 'session-tc-db'
    );
    expect(saveCall).toBeDefined();
    const messages: any[] = saveCall![1];
    const assistantMsg = messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.metadata?.toolCalls).toBeDefined();
    expect(assistantMsg.metadata.toolCalls[0].name).toBe('create_social_media_posts');
  });

  it('does not include toolCalls in payload or metadata when no tools ran', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('session-tc-none', 'socket-1', emitFn, 'test-user-id');
    mockAddMessagesToSession.mockResolvedValue({});

    callbacks['onmessage']?.({
      serverContent: { outputTranscription: { text: 'Hello!' } },
    });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });

    await Promise.resolve();
    await Promise.resolve();

    const turnCompleteCall = emitFn.mock.calls.find(([event]) => event === 'live:turn-complete');
    expect(turnCompleteCall).toBeDefined();
    expect(turnCompleteCall![1].toolCalls).toBeUndefined();

    const saveCall = mockAddMessagesToSession.mock.calls[0];
    const messages: any[] = saveCall?.[1] ?? [];
    const assistantMsg = messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg?.metadata?.toolCalls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ENG-763: onboarding guardrail + anti-loop directive on the live-voice path
// ---------------------------------------------------------------------------

describe('ENG-763 onboarding install_skills tool-gate (live path)', () => {
  it('blocks install_skills during onboarding and never executes it', async () => {
    const callbacks = makeCallbacks();
    await startLiveSession(
      'session-onboarding-gate',
      'socket-gate',
      jest.fn(),
      'test-user-id',
      'onboarding',
    );

    callbacks['onmessage']?.({
      toolCall: {
        functionCalls: [{ id: 'fc-install', name: 'install_skills', args: {} }],
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    // The forbidden tool must never reach execution.
    expect(mockExecuteTool).not.toHaveBeenCalled();
    // Gemini is told the tool is unavailable during onboarding.
    expect(mockSessionSendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        expect.objectContaining({
          id: 'fc-install',
          name: 'install_skills',
          response: expect.objectContaining({ error: expect.stringMatching(/not available during onboarding/i) }),
        }),
      ],
    });
  });

  it('still executes onboarding-safe tools during onboarding', async () => {
    const callbacks = makeCallbacks();
    mockExecuteTool.mockResolvedValueOnce({ ok: true });
    await startLiveSession(
      'session-onboarding-allowed',
      'socket-allowed',
      jest.fn(),
      'test-user-id',
      'onboarding',
    );

    callbacks['onmessage']?.({
      toolCall: {
        functionCalls: [{ id: 'fc-brand', name: 'read_brand_guidelines', args: {} }],
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(mockExecuteTool).toHaveBeenCalledWith(
      expect.any(String), 'read_brand_guidelines', {}, 'test-user-id', 'session-onboarding-allowed', false,
    );
  });

  it('does not gate non-onboarding tools in the default profile', async () => {
    const callbacks = makeCallbacks();
    mockExecuteTool.mockResolvedValueOnce({ ok: true });
    await startLiveSession('session-default-gate', 'socket-default', jest.fn(), 'test-user-id');

    callbacks['onmessage']?.({
      toolCall: {
        functionCalls: [{ id: 'fc-install-default', name: 'install_skills', args: {} }],
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    // Default (non-onboarding) sessions are unaffected by the onboarding gate.
    expect(mockExecuteTool).toHaveBeenCalledWith(
      expect.any(String), 'install_skills', {}, 'test-user-id', 'session-default-gate', false,
    );
  });
});

describe('ENG-763 anti-loop directive in the live system prompt', () => {
  it('injects a non-attributable anti-loop directive after repeated identical user turns', async () => {
    makeCallbacks();
    mockGetMessagesFromMessagesTable.mockResolvedValueOnce([
      { role: 'user', content: 'qa exactly once check' },
      { role: 'assistant', content: 'I need a target first.' },
      { role: 'user', content: 'qa exactly once check' },
      { role: 'assistant', content: 'Still need a target.' },
      { role: 'user', content: 'qa exactly once check' },
    ]);

    await startLiveSession('session-loop', 'socket-loop', jest.fn(), 'test-user-id');

    const systemText = mockLiveConnect.mock.calls[0][0].config.systemInstruction.parts[0].text;
    expect(systemText).toContain('ANTI-LOOP DIRECTIVE');
    // Never re-introduce the "[SYSTEM OVERRIDE]" wording the model echoed back.
    expect(systemText).not.toMatch(/SYSTEM OVERRIDE/i);
    // Explicitly forbids attributing system-authored text to the user.
    expect(systemText.toLowerCase()).toContain('attribute');
  });

  it('does not inject the anti-loop directive for a normal, non-repetitive conversation', async () => {
    makeCallbacks();
    mockGetMessagesFromMessagesTable.mockResolvedValueOnce([
      { role: 'user', content: 'What campaigns are running?' },
      { role: 'assistant', content: 'Here are your campaigns.' },
      { role: 'user', content: 'Great, draft a follow-up email.' },
    ]);

    await startLiveSession('session-noloop', 'socket-noloop', jest.fn(), 'test-user-id');

    const systemText = mockLiveConnect.mock.calls[0][0].config.systemInstruction.parts[0].text;
    expect(systemText).not.toContain('ANTI-LOOP DIRECTIVE');
  });
});
