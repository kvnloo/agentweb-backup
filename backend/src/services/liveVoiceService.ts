/**
 * liveVoiceService.ts
 *
 * Manages Gemini Live API sessions for Agent Mode voice conversations.
 * One persistent WebSocket connection to Gemini per Agent Mode chat session.
 *
 * Responsibilities:
 * - Open/close Gemini Live sessions keyed by Agent Mode sessionId
 * - Proxy incoming audio chunks and text turns from the browser to Gemini
 * - Relay Gemini's audio output and text transcript back to the browser via
 *   an emit callback (wired to Socket.IO in server.ts)
 * - On turnComplete: asynchronously save the turn transcript to DynamoDB
 *   without blocking the audio stream
 */

import { GoogleGenAI, Modality, MediaResolution, LiveServerMessage, Session } from '@google/genai';
import { chatbotDb } from './chatbotService';
import { getSecret } from '../utils/secretsManager';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';
const LIVE_VOICE_NAME = 'Zephyr';
const AUDIO_MIME_TYPE = 'audio/pcm;rate=16000';

/**
 * System prompt that instructs Gemini to use emotion tags for expressive TTS.
 * Tags like [warm], [excited], [thoughtful], [encouraging], [concerned], [pause]
 * are interpreted by Gemini 3.1 Flash's voice director layer.
 */
const LIVE_SYSTEM_PROMPT = `You are Emma, an expert marketing assistant having a voice conversation.
Respond naturally and conversationally — keep answers concise and direct.
Use emotion markers in your text to make speech expressive and engaging:
- [warm] when being friendly or reassuring
- [excited] for great news or achievements
- [thoughtful] when analyzing data or thinking through a problem
- [encouraging] when motivating the user
- [concerned] when flagging a problem or risk
- [pause] for natural conversational breaks
Embed these markers naturally before the relevant phrase — don't announce them or explain them.
Example: "[warm] Great question! [thoughtful] Your ad spend is trending up — [excited] 23% higher than last month."`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback used to push events back to the browser via Socket.IO */
type EmitFn = (event: string, data: unknown) => void;

interface LiveEntry {
  session: Session;
  socketId: string;
  emitFn: EmitFn;
  /** Accumulated assistant text for the current turn */
  currentTurnText: string;
  /** Accumulated user text for the current turn (set when sendTextTurn is called) */
  pendingUserText: string;
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, LiveEntry>();

// ---------------------------------------------------------------------------
// Gemini client (lazy-initialized, reuses same secret as agentModeService)
// ---------------------------------------------------------------------------

let genAI: GoogleGenAI | null = null;
let genAIPromise: Promise<GoogleGenAI> | null = null;

async function getGenAI(): Promise<GoogleGenAI> {
  if (genAI) return genAI;
  if (genAIPromise) return genAIPromise;

  genAIPromise = (async () => {
    let apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const environment = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
      apiKey = await getSecret(`${environment}/AgentWeb/GeminiAPIKey`);
    }
    if (!apiKey?.trim()) throw new Error('Gemini API key not found in env or Secrets Manager');
    genAI = new GoogleGenAI({ apiKey: apiKey.trim() });
    return genAI;
  })();

  return genAIPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a Gemini Live session for the given Agent Mode sessionId.
 * If a session already exists for this sessionId, it is closed first.
 *
 * @param sessionId  Agent Mode chat session ID
 * @param socketId   Socket.IO socket ID of the connected browser
 * @param emitFn     Function to emit Socket.IO events back to the browser
 */
export async function startLiveSession(
  sessionId: string,
  socketId: string,
  emitFn: EmitFn
): Promise<void> {
  // Close any existing session for this sessionId
  if (activeSessions.has(sessionId)) {
    closeLiveSession(sessionId);
  }

  // Placeholder entry — filled after session resolves
  const entry: LiveEntry = {
    session: null as unknown as Session,
    socketId,
    emitFn,
    currentTurnText: '',
    pendingUserText: '',
  };
  activeSessions.set(sessionId, entry);

  const ai = await getGenAI();

  const geminiSession = await ai.live.connect({
    model: LIVE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: LIVE_VOICE_NAME,
          },
        },
      },
      systemInstruction: {
        parts: [{ text: LIVE_SYSTEM_PROMPT }],
      },
      contextWindowCompression: {
        triggerTokens: '104857',
        slidingWindow: { targetTokens: '52428' },
      },
    },
    callbacks: {
      onopen: () => {
        // Session open — nothing to emit; browser already knows it connected
      },
      onmessage: (message: LiveServerMessage) => {
        handleIncomingMessage(sessionId, message);
      },
      onerror: (e: ErrorEvent) => {
        console.error(`[liveVoiceService] Error on session ${sessionId}:`, e.message);
        const currentEntry = activeSessions.get(sessionId);
        if (currentEntry) {
          currentEntry.emitFn('live:error', { sessionId, error: e.message });
        }
      },
      onclose: (e: CloseEvent) => {
        const currentEntry = activeSessions.get(sessionId);
        if (currentEntry) {
          currentEntry.emitFn('live:closed', { sessionId });
        }
        activeSessions.delete(sessionId);
      },
    },
  });

  entry.session = geminiSession;
}

/**
 * Send a base64-encoded audio chunk from the browser microphone to Gemini.
 */
export async function sendAudioChunk(sessionId: string, base64Chunk: string): Promise<void> {
  const entry = getEntry(sessionId);
  entry.session.sendClientContent({
    turns: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: base64Chunk,
              mimeType: AUDIO_MIME_TYPE,
            },
          },
        ],
      },
    ],
  });
}

/**
 * Send a text message from the browser to Gemini (text-input mode when live model is active).
 */
export async function sendTextTurn(sessionId: string, text: string): Promise<void> {
  const entry = getEntry(sessionId);
  entry.pendingUserText = text;
  entry.session.sendClientContent({
    turns: [
      {
        role: 'user',
        parts: [{ text }],
      },
    ],
  });
}

/**
 * Close the Gemini Live session for the given sessionId.
 */
export function closeLiveSession(sessionId: string): void {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;
  try {
    entry.session.close();
  } catch {
    // Ignore close errors
  }
  activeSessions.delete(sessionId);
}

/**
 * Whether a live session is currently open for the given sessionId.
 */
export function hasLiveSession(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}

// ---------------------------------------------------------------------------
// Internal: handle incoming Gemini messages
// ---------------------------------------------------------------------------

function handleIncomingMessage(sessionId: string, message: LiveServerMessage): void {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;

  const { emitFn } = entry;
  const parts = message.serverContent?.modelTurn?.parts;

  if (parts) {
    for (const part of parts) {
      // Relay audio chunk to browser immediately (non-blocking)
      if (part.inlineData?.data) {
        emitFn('live:audio', {
          sessionId,
          chunk: part.inlineData.data,
          mimeType: part.inlineData.mimeType ?? 'audio/pcm;rate=24000',
        });
      }

      // Accumulate text transcript for saving on turnComplete
      if (part.text) {
        entry.currentTurnText += part.text;
        emitFn('live:transcript', { sessionId, text: part.text });
      }
    }
  }

  // Turn complete: save transcript to DynamoDB asynchronously, then notify browser
  if (message.serverContent?.turnComplete) {
    const assistantText = entry.currentTurnText.trim();
    const userText = entry.pendingUserText.trim();

    // Reset for next turn before async work
    entry.currentTurnText = '';
    entry.pendingUserText = '';

    // Emit turn-complete immediately so browser can update UI
    emitFn('live:turn-complete', { sessionId, assistantText });

    // Fire-and-forget save — never blocks the audio stream
    if (assistantText) {
      const messagesToSave = [];
      if (userText) {
        messagesToSave.push({ role: 'user' as const, content: userText });
      }
      messagesToSave.push({ role: 'assistant' as const, content: assistantText });

      chatbotDb.addMessagesToSession(sessionId, messagesToSave).catch((err) => {
        console.warn(`[liveVoiceService] Failed to save transcript for session ${sessionId}:`, err?.message);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: safe entry lookup
// ---------------------------------------------------------------------------

function getEntry(sessionId: string): LiveEntry {
  const entry = activeSessions.get(sessionId);
  if (!entry) {
    throw new Error(`No active live session for sessionId: ${sessionId}`);
  }
  return entry;
}
