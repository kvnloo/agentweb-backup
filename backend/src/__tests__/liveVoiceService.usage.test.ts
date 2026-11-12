/**
 * ENG-2957: voice usage. A voice call spends the account's allowance like a typed turn: it is admitted at start and
 * after every completed turn (a call whose allowance ran out ends), and each Gemini usage report is metered per modality
 * (audio is billed far above text) under its own `live_voice` feature.
 *
 * Harness copied from liveVoiceService.test.ts: Tests for liveVoiceService.ts
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

// ENG-2957: voice now checks the account's allowance at start and after each turn; these tests are about other rules.
const mockCheckTokenUsage = jest.fn();
jest.mock('../services/tokenUsageService', () => ({
  ...jest.requireActual('../services/tokenUsageService'),
  checkTokenUsage: (...a: unknown[]) => mockCheckTokenUsage(...a),
}));
const mockMeter = jest.fn();
jest.mock('../services/usageRecorderService', () => ({
  ...jest.requireActual('../services/usageRecorderService'),
  meterUserUsage: (...a: unknown[]) => mockMeter(...a),
}));

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    live: {
      connect: mockLiveConnect,
    },
  })),
  Modality: { AUDIO: 'AUDIO', TEXT: 'TEXT' },
  MediaResolution: { MEDIA_RESOLUTION_MEDIUM: 'MEDIA_RESOLUTION_MEDIUM' },
  StartSensitivity: { START_SENSITIVITY_LOW: 'START_SENSITIVITY_LOW', START_SENSITIVITY_HIGH: 'START_SENSITIVITY_HIGH' },
  EndSensitivity: { END_SENSITIVITY_LOW: 'END_SENSITIVITY_LOW', END_SENSITIVITY_HIGH: 'END_SENSITIVITY_HIGH' },
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
const mockAddToolCostToSession = jest.fn().mockResolvedValue(undefined);
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
    addToolCostToSession: mockAddToolCostToSession,
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


import { startLiveSession, closeLiveSession, hasLiveSession, LiveSessionUsageBlockedError } from '../services/liveVoiceService';
import { computeLiveModalityCostUsd, LLM_PRICE_BOOK_PROVENANCE } from '../utils/llmPricing';

beforeAll(() => {
  process.env.GEMINI_API_KEY = 'test-key';
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetChatSessionRecord.mockImplementation(async (sessionId: string) => ({ sessionId, userId: 'test-user-id' }));
  mockCheckTokenUsage.mockResolvedValue({ allowed: true, month: '2026-11' });
});

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe('voice admission at start', () => {
  it('starts when the allowance admits the turn, checking the session owner with a turn admission', async () => {
    makeCallbacks();
    await startLiveSession('s-ok', 'sock', jest.fn(), 'test-user-id');
    expect(mockCheckTokenUsage).toHaveBeenCalledWith('test-user-id', { recordAdmission: true });
    expect(mockLiveConnect).toHaveBeenCalledTimes(1);
    closeLiveSession('s-ok');
  });

  it('refuses a paused account before any Gemini session exists, with the typed-chat message', async () => {
    makeCallbacks();
    mockCheckTokenUsage.mockResolvedValue({ allowed: false, month: '2026-11' });
    await expect(startLiveSession('s-paused', 'sock', jest.fn(), 'test-user-id')).rejects.toBeInstanceOf(LiveSessionUsageBlockedError);
    expect(mockLiveConnect).not.toHaveBeenCalled();
    expect(hasLiveSession('s-paused')).toBe(false);
  });

  it('fails closed when the usage lookup fails', async () => {
    makeCallbacks();
    mockCheckTokenUsage.mockRejectedValue(new Error('dynamo down'));
    await expect(startLiveSession('s-err', 'sock', jest.fn(), 'test-user-id')).rejects.toBeInstanceOf(LiveSessionUsageBlockedError);
    expect(mockLiveConnect).not.toHaveBeenCalled();
  });

  it('checks ownership before usage: a foreign session never reaches the usage check', async () => {
    makeCallbacks();
    mockGetChatSessionRecord.mockResolvedValue({ sessionId: 's-foreign', userId: 'someone-else' });
    await expect(startLiveSession('s-foreign', 'sock', jest.fn(), 'test-user-id')).rejects.toThrow();
    expect(mockCheckTokenUsage).not.toHaveBeenCalled();
  });
});

describe('voice admission after each turn', () => {
  it('ends the call and tells the browser when the allowance ran out during it', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('s-mid', 'sock', emitFn, 'test-user-id');
    mockCheckTokenUsage.mockResolvedValue({ allowed: false, month: '2026-11' });
    callbacks['onmessage']?.({ serverContent: { modelTurn: { parts: [{ text: 'hi' }] } } });
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });
    await flush();
    expect(emitFn).toHaveBeenCalledWith('live:error', expect.objectContaining({ sessionId: 's-mid', code: 'usage_paused' }));
    expect(hasLiveSession('s-mid')).toBe(false);
  });

  it('keeps the call going while the allowance admits, and on a transient lookup error', async () => {
    const emitFn = jest.fn();
    const callbacks = makeCallbacks();
    await startLiveSession('s-keep', 'sock', emitFn, 'test-user-id');
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });
    await flush();
    mockCheckTokenUsage.mockRejectedValue(new Error('blip'));
    callbacks['onmessage']?.({ serverContent: { turnComplete: true } });
    await flush();
    expect(emitFn).not.toHaveBeenCalledWith('live:error', expect.anything());
    expect(hasLiveSession('s-keep')).toBe(true);
    closeLiveSession('s-keep');
  });
});

describe('voice metering', () => {
  it('meters each usage report as interactive live voice, per-modality priced, and adds it to the chat cost', async () => {
    const callbacks = makeCallbacks();
    await startLiveSession('s-meter', 'sock', jest.fn(), 'test-user-id');
    const usageMetadata = {
      promptTokenCount: 1200, responseTokenCount: 600, cachedContentTokenCount: 100, toolUsePromptTokenCount: 20, thoughtsTokenCount: 10,
      promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 1000 }, { modality: 'TEXT', tokenCount: 200 }],
      responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 500 }, { modality: 'TEXT', tokenCount: 100 }],
    };
    callbacks['onmessage']?.({ usageMetadata });
    const cost = (1000 * 3 + 200 * 0.75 + 20 * 0.75 + 500 * 12 + 100 * 4.5 + 10 * 4.5) / 1e6;
    expect(mockMeter).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'test-user-id', feature: 'live_voice:interactive', model: 'gemini-3.1-flash-live-preview',
      // cached tokens are part of the prompt: counted once, as cache reads; tool-use prompt is input; thinking is output
      inputTokens: 1200 - 100 + 20, cacheReadTokens: 100, outputTokens: 600 + 10, sessionId: 's-meter',
      costProvenance: LLM_PRICE_BOOK_PROVENANCE,
    }));
    expect(mockMeter.mock.calls[0][0].costUsdOverride).toBeCloseTo(cost, 12);
    expect(mockAddToolCostToSession).toHaveBeenCalledWith('s-meter', expect.closeTo(cost, 12), 'live_voice');
    closeLiveSession('s-meter');
  });
});

describe('share-link wording', () => {
  it('a share-link visitor refused for usage is told only that the shared session is paused', async () => {
    makeCallbacks();
    mockCheckTokenUsage.mockResolvedValue({ allowed: false, month: '2026-11' });
    await expect(startLiveSession('s-share', 'sock', jest.fn(), 'test-user-id', 'default', undefined, 'share_visitor'))
      .rejects.toThrow('AI usage is paused for this shared session. Please contact the owner of this link.');
  });

  it('the owner (no restriction) gets the account wording, not the share wording', async () => {
    makeCallbacks();
    mockCheckTokenUsage.mockResolvedValue({ allowed: false, month: '2026-11' });
    const err = await startLiveSession('s-own', 'sock', jest.fn(), 'test-user-id').catch((e) => e);
    expect(err).toBeInstanceOf(LiveSessionUsageBlockedError);
    expect(err.message).not.toMatch(/shared session/);
  });
});

describe('computeLiveModalityCostUsd', () => {
  const M = 'gemini-3.1-flash-live-preview';
  it('prices audio and text at their own rates (Google pricing 2026-11-12)', () => {
    expect(computeLiveModalityCostUsd(M, {
      promptTokenCount: 1_000_000, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 1_000_000 }],
      responseTokenCount: 1_000_000, responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 1_000_000 }],
    })).toBeCloseTo(15, 9);
    expect(computeLiveModalityCostUsd(M, { promptTokenCount: 1_000_000, responseTokenCount: 1_000_000 })).toBeCloseTo(5.25, 9);
  });
  it('bills tokens the breakdown does not cover as text, an unknown modality at the highest rate, and thinking as output text', () => {
    expect(computeLiveModalityCostUsd(M, { promptTokenCount: 100, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 60 }] }))
      .toBeCloseTo((60 * 3 + 40 * 0.75) / 1e6, 12);
    expect(computeLiveModalityCostUsd(M, { promptTokenCount: 10, promptTokensDetails: [{ modality: 'HOLOGRAM', tokenCount: 10 }] }))
      .toBeCloseTo((10 * 3) / 1e6, 12);
    expect(computeLiveModalityCostUsd(M, { thoughtsTokenCount: 10 })).toBeCloseTo((10 * 4.5) / 1e6, 12);
  });
  it('accepts the models/ prefix and the candidates fields; null for a model without modality rates', () => {
    expect(computeLiveModalityCostUsd('models/' + M, { candidatesTokenCount: 10, candidatesTokensDetails: [{ modality: 'AUDIO', tokenCount: 10 }] }))
      .toBeCloseTo((10 * 12) / 1e6, 12);
    expect(computeLiveModalityCostUsd('gemini-3.8-flash', { promptTokenCount: 10 })).toBeNull();
    expect(computeLiveModalityCostUsd(M, null)).toBeNull();
  });
});
