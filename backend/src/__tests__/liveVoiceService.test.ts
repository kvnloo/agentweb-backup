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
const mockSessionClose = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    live: {
      connect: mockLiveConnect,
    },
  })),
  Modality: { AUDIO: 'AUDIO', TEXT: 'TEXT' },
  MediaResolution: { MEDIA_RESOLUTION_MEDIUM: 'MEDIA_RESOLUTION_MEDIUM' },
}));

const mockAddMessageToSession = jest.fn();
const mockAddMessagesToSession = jest.fn();

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: mockAddMessageToSession,
    addMessagesToSession: mockAddMessagesToSession,
  },
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('fake-gemini-api-key'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSession() {
  return {
    sendClientContent: mockSessionSendClientContent,
    sendRealtimeInput: mockSessionSendRealtimeInput,
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
                voiceName: expect.any(String),
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

    await sendAudioChunk('session-audio', 'SGVsbG8=');

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
    await expect(sendAudioChunk('no-such-session', 'abc=')).rejects.toThrow();
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

    await sendTextTurn('session-text', 'What is my ad spend this month?');

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
    await expect(sendTextTurn('ghost-session', 'hello')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Incoming audio from Gemini → emit to client
// ---------------------------------------------------------------------------

describe('incoming audio relay', () => {
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

    callbacks['onclose']?.({ reason: 'server closed' });

    expect(hasLiveSession('session-drop')).toBe(false);
    expect(emitFn).toHaveBeenCalledWith('live:closed', {
      sessionId: 'session-drop',
    });
  });
});
