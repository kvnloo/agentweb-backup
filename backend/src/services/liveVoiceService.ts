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

import { GoogleGenAI, Modality, LiveServerMessage, Session, Transcription } from '@google/genai';
import { chatbotDb, ChatMessage } from './chatbotService';
import { getSecret } from '../utils/secretsManager';
import { agentModeService } from './agentModeService';
import { meterUserUsage } from './usageRecorderService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';
const LIVE_VOICE_NAME = 'Kore';

/**
 * System prompt that instructs Gemini to use emotion tags for expressive TTS.
 * Tags like [warm], [excited], [thoughtful], [encouraging], [concerned], [pause]
 * are interpreted by Gemini 3.1 Flash's voice director layer.
 */
const LIVE_SYSTEM_PROMPT = `You are Emma, an expert marketing assistant having a voice conversation.
Speak with a neutral General American English accent.
Respond naturally and conversationally — keep answers concise and direct.
Be warm and friendly, enthusiastic about good news, thoughtful when analyzing data, encouraging when motivating the user, and concerned when flagging problems.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback used to push events back to the browser via Socket.IO */
type EmitFn = (event: string, data: unknown) => void;

/** A structured artifact surfaced from a tool result (URL, image, or file) */
export interface LiveArtifact {
  type: 'url' | 'image' | 'file';
  label: string;
  url: string;
}

interface LiveEntry {
  session: Session;
  socketId: string;
  emitFn: EmitFn;
  userId: string;
  /** Accumulated assistant transcript text for the current turn (display-safe) */
  currentTurnText: string;
  /** Accumulated user text for the current turn (set when sendTextTurn is called) */
  pendingUserText: string;
  /** Tool call results for the current turn — saved to DynamoDB but NOT shown in chat UI */
  toolContextText: string;
  /** Structured artifacts extracted from tool results this turn */
  pendingArtifacts: LiveArtifact[];
  /** Tool call records for the current turn — surfaced in chat UI as collapsible "Used N tools" block */
  pendingToolCalls: Array<{ id: string; name: string; arguments: any; result?: any; error?: string; narrative?: string }>;
  /** Latest resumption handle from Gemini — used to reconnect transparently after code 1000 close */
  resumptionHandle?: string;
  /** Cached function declarations so reconnects reuse the same tool config without reloading */
  functionDeclarations: any[];
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
// Tool schema conversion
// ---------------------------------------------------------------------------

/**
 * Gemini Live requires function declarations in a flat format with strict naming.
 * This converts OpenAI-format tool definitions to Gemini-compatible declarations.
 *
 * Rules:
 * - Name must match ^[a-zA-Z][a-zA-Z0-9_]{0,63}$
 * - Parameters must be valid JSON Schema (no $schema, additionalProperties unsupported for arrays)
 * - No nested $ref or complex combinators (anyOf/oneOf at top level)
 */
function toGeminiFunctionDeclaration(openAiTool: any): any | null {
  try {
    const fn = openAiTool?.function;
    if (!fn?.name) return null;

    // Sanitize name: must start with letter, only alphanumeric + underscore, max 64 chars
    const rawName: string = fn.name;
    const sanitized = rawName
      .replace(/^[^a-zA-Z]+/, '')          // strip leading non-letters
      .replace(/[^a-zA-Z0-9_]/g, '_')      // replace invalid chars with _
      .slice(0, 64);
    if (!sanitized) return null;

    const declaration: any = {
      name: sanitized,
      description: (fn.description || fn.name).slice(0, 1000),
    };

    if (fn.parameters) {
      declaration.parameters = sanitizeSchema(fn.parameters);
    }

    return declaration;
  } catch {
    return null;
  }
}

/**
 * Recursively clean a JSON Schema object to be Gemini-compatible.
 * Removes unsupported fields and normalizes types.
 */
function sanitizeSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;

  const cleaned: any = {};

  // anyOf/oneOf (and snake_case variants from MCP): Gemini Live doesn't support these.
  // Must be checked FIRST before anything else so we return early.
  // Flatten to a single type: prefer 'array' > 'string' > first entry.
  const combinator = schema.anyOf || schema.oneOf || schema.any_of || schema.one_of;
  if (Array.isArray(combinator) && combinator.length > 0) {
    if (combinator.length === 1) return sanitizeSchema(combinator[0]);
    // Filter out null type entries (these mean nullable, handled via nullable field)
    const nonNull = combinator.filter((s: any) => s?.type !== 'null' && s !== 'null');
    if (nonNull.length === 1) return sanitizeSchema(nonNull[0]);
    const arrayVariant = nonNull.find((s: any) => s?.type === 'array');
    if (arrayVariant) return sanitizeSchema(arrayVariant);
    const stringVariant = nonNull.find((s: any) => s?.type === 'string');
    if (stringVariant) return sanitizeSchema(stringVariant);
    return sanitizeSchema(nonNull[0] || combinator[0]);
  }

  // type field: if it's an array of types (JSON Schema draft 2019+), flatten to one type.
  // The Google GenAI SDK converts array types into anyOf which Gemini Live rejects.
  let schemaType = schema.type;
  if (Array.isArray(schemaType)) {
    const nonNullTypes = schemaType.filter((t: string) => t !== 'null');
    schemaType = nonNullTypes.includes('array') ? 'array'
      : nonNullTypes.includes('string') ? 'string'
      : nonNullTypes[0];
  }

  // Copy supported fields only
  if (schemaType) cleaned.type = schemaType;
  if (schema.description) cleaned.description = String(schema.description).slice(0, 500);
  if (schema.enum) cleaned.enum = schema.enum;

  if (schema.properties && typeof schema.properties === 'object') {
    cleaned.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      cleaned.properties[key] = sanitizeSchema(val);
    }
  }

  if (Array.isArray(schema.required)) {
    cleaned.required = schema.required;
  }

  // items is required by Gemini when type === 'array'
  if (schemaType === 'array') {
    cleaned.items = schema.items ? sanitizeSchema(schema.items) : { type: 'string' };
  }

  return cleaned;
}

/**
 * Load and convert agent mode tools for this user into Gemini Live format.
 * Returns an empty array on error (voice still works without tools).
 */
async function loadGeminiFunctionDeclarations(userId: string): Promise<any[]> {
  try {
    const rawTools = await agentModeService.getFilteredTools(userId);
    const declarations = rawTools
      .map(toGeminiFunctionDeclaration)
      .filter((d): d is any => d !== null);
    console.log(`[liveVoiceService] Loaded ${declarations.length}/${rawTools.length} tools for Gemini Live`);
    return declarations;
  } catch (err: any) {
    console.warn('[liveVoiceService] Failed to load tools for Gemini Live:', err?.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open (or re-open) a Gemini Live WebSocket for the given Agent Mode sessionId.
 * Internal — callers should use startLiveSession (public) or reconnectLiveSession.
 *
 * @param historyContext  Optional history block appended to the system prompt on fresh starts.
 *                        Not passed on code-1000 resumptions (Gemini already has context).
 */
async function openGeminiSession(
  sessionId: string,
  entry: LiveEntry,
  resumptionHandle?: string,
  historyContext?: string
): Promise<void> {
  const ai = await getGenAI();

  const geminiSession = await ai.live.connect({
    model: LIVE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: LIVE_VOICE_NAME,
          },
        },
      },
      systemInstruction: {
        parts: [{ text: LIVE_SYSTEM_PROMPT + (historyContext ?? '') }],
      },
      // Enable automatic transcription so transcripts are available in audio-only mode
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Wire in agent mode tools (sanitized for Gemini Live schema requirements)
      ...(entry.functionDeclarations.length > 0 ? { tools: [{ functionDeclarations: entry.functionDeclarations }] } : {}),
      // Request session resumption tokens so we can reconnect transparently after code 1000 closes
      sessionResumption: resumptionHandle ? { handle: resumptionHandle } : {},
    },
    callbacks: {
      onopen: () => {
        console.log(`[liveVoiceService] Gemini session OPEN for ${sessionId}${resumptionHandle ? ' (resumed)' : ''}`);
      },
      onmessage: (message: LiveServerMessage) => {
        console.log(`[liveVoiceService] Gemini message for ${sessionId}:`, JSON.stringify(message).slice(0, 200));
        handleIncomingMessage(sessionId, message).catch((err) => {
          console.error(`[liveVoiceService] handleIncomingMessage error for ${sessionId}:`, err?.message, err?.stack?.split('\n').slice(0, 5).join(' | '));
        });
      },
      onerror: (e: ErrorEvent) => {
        console.error(`[liveVoiceService] Gemini ERROR on session ${sessionId}:`, e.message, e);
        const currentEntry = activeSessions.get(sessionId);
        if (currentEntry) {
          currentEntry.emitFn('live:error', { sessionId, error: e.message });
        }
      },
      onclose: (e: CloseEvent) => {
        console.log(`[liveVoiceService] Gemini CLOSED session ${sessionId}, code=${e.code}, reason=${e.reason}`);
        const currentEntry = activeSessions.get(sessionId);
        if (!currentEntry) return;

        // Code 1000 = normal closure by Gemini after a turn. Reconnect transparently
        // using the latest resumption handle so the conversation continues.
        if (e.code === 1000 && currentEntry.resumptionHandle) {
          console.log(`[liveVoiceService] Auto-reconnecting session ${sessionId} with handle ${currentEntry.resumptionHandle.slice(0, 8)}...`);
          openGeminiSession(sessionId, currentEntry, currentEntry.resumptionHandle)
            .then(() => { currentEntry.session = activeSessions.get(sessionId)!.session; })
            .catch((err) => {
              console.error(`[liveVoiceService] Reconnect failed for ${sessionId}:`, err?.message);
              activeSessions.delete(sessionId);
              currentEntry.emitFn('live:closed', { sessionId });
            });
          return;
        }

        // Abnormal close or no handle — surface to client with reason
        activeSessions.delete(sessionId);
        currentEntry.emitFn('live:closed', { sessionId, code: e.code, reason: e.reason });
      },
    },
  });

  entry.session = geminiSession;
}

/**
 * Load prior chat messages from DynamoDB and format them as a conversation
 * history block to embed in the system prompt. Uses the same filtering rules
 * as agentModeService:
 * - Slice to the 10th-most-recent user message (same context window)
 * - Skip empty assistant messages and error messages
 *
 * Returns an empty string if there is no prior history.
 */
async function loadHistoryForSystemPrompt(sessionId: string): Promise<string> {
  try {
    const allMessages = await chatbotDb.getMessagesFromMessagesTable(sessionId);
    if (!allMessages || allMessages.length === 0) return '';

    // Slice to the 10th-most-recent user message (same window as agentModeService:2280-2292)
    let userCount = 0;
    let startIdx = 0;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].role === 'user') {
        userCount++;
        if (userCount === 10) { startIdx = i; break; }
      }
    }
    const sliced = allMessages.slice(startIdx);

    const lines: string[] = [];
    for (const msg of sliced) {
      if (msg.role === 'system') continue;
      // Skip empty assistant messages (same as agentModeService:2297-2300)
      if (msg.role === 'assistant' && !msg.content && !(msg as any).tool_calls) continue;
      // Skip error messages (same as agentModeService:2302-2306)
      if (msg.role === 'assistant' && (msg as any).metadata?.isErrorMessage) continue;

      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as any[]).map((c: any) => c?.text || '').filter(Boolean).join(' ')
          : String(msg.content || '');

      const trimmed = text.trim();
      if (trimmed) {
        const label = msg.role === 'user' ? 'User' : 'Emma';
        // Truncate very long messages to avoid bloating the system prompt
        const snippet = trimmed.length > 500 ? trimmed.slice(0, 500) + '…' : trimmed;
        lines.push(`${label}: ${snippet}`);
      }
    }

    if (lines.length === 0) return '';

    return `\n\n--- Prior conversation history (for context) ---\n${lines.join('\n')}\n--- End of prior history ---`;
  } catch (err: any) {
    console.warn('[liveVoiceService] Failed to load history for system prompt:', err?.message);
    return '';
  }
}

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
  emitFn: EmitFn,
  userId: string
): Promise<void> {
  // Close any existing session for this sessionId
  if (activeSessions.has(sessionId)) {
    closeLiveSession(sessionId);
  }

  // Load tools and prior history in parallel
  const [functionDeclarations, historyContext] = await Promise.all([
    loadGeminiFunctionDeclarations(userId),
    loadHistoryForSystemPrompt(sessionId),
  ]);

  if (historyContext) {
    console.log(`[liveVoiceService] Injecting history into system prompt for ${sessionId}`);
  }

  // Placeholder entry — filled after session resolves
  const entry: LiveEntry = {
    session: null as unknown as Session,
    socketId,
    emitFn,
    userId,
    currentTurnText: '',
    pendingUserText: '',
    toolContextText: '',
    pendingArtifacts: [],
    pendingToolCalls: [],
    functionDeclarations,
  };
  activeSessions.set(sessionId, entry);

  // Pass history via system prompt on fresh starts. Code-1000 resumptions already
  // carry Gemini's own in-memory context, so historyContext is not passed there.
  await openGeminiSession(sessionId, entry, undefined, historyContext || undefined);
}

/**
 * Send a base64-encoded audio chunk from the browser microphone to Gemini.
 * Uses sendRealtimeInput (streaming audio API) with the actual browser format (webm/opus).
 */
export async function sendAudioChunk(sessionId: string, base64Chunk: string): Promise<void> {
  const entry = getEntry(sessionId);
  if (!entry.session) return; // Gemini session still opening — drop chunk
  entry.session.sendRealtimeInput({
    audio: {
      data: base64Chunk,
      mimeType: 'audio/pcm;rate=16000',
    },
  });
}

/**
 * Send a text message from the browser to Gemini (text-input mode when live model is active).
 */
export async function sendTextTurn(sessionId: string, text: string): Promise<void> {
  const entry = getEntry(sessionId);
  if (!entry.session) return; // Gemini session still opening
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

const ARTIFACT_EXTRACT_MODEL = 'gemini-3.1-flash-lite';

/**
 * Use a fast LLM to both summarize a tool result in natural language and extract
 * meaningful URLs. Both happen in one call to minimize latency.
 *
 * Returns a natural-language narrative (1-2 sentences describing what the tool did)
 * and appends any content-quality URLs to `out`.
 */
async function summarizeToolResult(
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolResult: Record<string, unknown>,
  seen: Set<string>,
  out: LiveArtifact[],
): Promise<string | undefined> {
  const resultJson = JSON.stringify(toolResult).slice(0, 3000);
  const argsJson = JSON.stringify(toolArgs).slice(0, 500);

  const prompt = `You are a concise result interpreter for an AI assistant. Given a tool call and its result, produce two things:

1. "narrative": A 1-2 sentence natural-language summary of what was accomplished. Be specific and human-readable. Use past tense. Examples:
   - "Found 12 leads matching the criteria. The top result is Acme Corp with 250 employees."
   - "Published the blog post 'Q1 Marketing Trends' to the website."
   - "Retrieved the last 30 days of ad spend: $4,230 total across 3 campaigns."
   - "No results found for the search query."

2. "artifacts": A JSON array of meaningful URLs to surface to the user. Include only content pages, articles, posts, profiles, reports, downloads, or generated images. SKIP icons, favicons, tracking pixels, CDN assets, nav/UI links, and internal API paths.
   Each artifact: {"type": "url"|"image"|"file", "label": "<short label>", "url": "<full url>"}

Return ONLY valid JSON in this exact shape:
{"narrative": "...", "artifacts": [...]}

Tool name: ${toolName}
Tool arguments: ${argsJson}
Tool result: ${resultJson}`;

  try {
    const response = await agentModeService.callLLM(
      ARTIFACT_EXTRACT_MODEL,
      [{ role: 'user', content: prompt }],
      { max_completion_tokens: 600, temperature: 0 },
    );
    const text = (response as any)?.choices?.[0]?.message?.content?.trim() ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    const parsed: { narrative?: string; artifacts?: Array<{ type: string; label: string; url: string }> } = JSON.parse(match[0]);

    // Extract artifacts
    for (const item of parsed.artifacts ?? []) {
      if (typeof item.url === 'string' && item.url.startsWith('http') && !seen.has(item.url)) {
        seen.add(item.url);
        out.push({
          type: (item.type === 'image' || item.type === 'file') ? item.type : 'url',
          label: item.label || 'View link',
          url: item.url,
        });
      }
    }

    return parsed.narrative || undefined;
  } catch (err: any) {
    console.warn('[liveVoiceService] LLM tool summarization failed, skipping:', err?.message);
    return undefined;
  }
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

// Single-word affirmations/negations that are short but meaningful — always persist.
const MEANINGFUL_SINGLE_WORDS = new Set([
  'yes', 'no', 'ok', 'okay', 'sure', 'nope', 'yep', 'yeah', 'nah',
  'stop', 'go', 'done', 'next', 'back', 'help',
]);

// Pure filler/noise tokens that Gemini STT emits for background sounds or
// stray microphone pickup. These are never meaningful when they appear alone.
const NOISE_TOKENS = new Set([
  // Vocal fillers
  'uh', 'um', 'mm', 'hmm', 'hm', 'ah', 'oh', 'er',
  // Articles / conjunctions that Gemini often emits as isolated noise fragments
  'the', 'a', 'an', 'and', 'but', 'or', 'so', 'i',
]);

/**
 * Returns true if the user transcript looks like STT noise from background
 * audio and should NOT be persisted to DynamoDB.
 *
 * Rules (all must hold to classify as noise):
 *  1. After stripping punctuation and whitespace the text is ≤1 word, AND
 *  2. That word is either a known noise token or the text is purely punctuation.
 *
 * Multi-word transcripts are always treated as real input even if they start
 * with filler words ("uh how is my ad spend" is meaningful).
 * Short meaningful words like "Yes" / "No" are explicitly allowed through.
 */
function isNoiseTurn(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Strip punctuation-only strings (e.g. "...", "???")
  const stripped = trimmed.replace(/[.,!?;:\-\u2026"'()]+/g, '').trim();
  if (!stripped) return true;

  // Multi-word — always a real turn
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length > 1) return false;

  const word = words[0].toLowerCase();

  // Allow through short but meaningful words
  if (MEANINGFUL_SINGLE_WORDS.has(word)) return false;

  // Single known noise token
  return NOISE_TOKENS.has(word);
}

// ---------------------------------------------------------------------------
// Internal: handle incoming Gemini messages
// ---------------------------------------------------------------------------

async function handleIncomingMessage(sessionId: string, message: LiveServerMessage): Promise<void> {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;

  // Shadow usage metering (Ship 1): Gemini Live runs over a WebSocket that the
  // llmClients factory does not wrap, so usage is recorded here directly from
  // the per-message usageMetadata. The Live API reports output tokens as
  // `responseTokenCount` (not `candidatesTokenCount`). Fire-and-forget — a
  // metering failure must never affect the audio stream.
  if (message.usageMetadata) {
    try {
      const um: any = message.usageMetadata;
      void meterUserUsage({
        userId: entry.userId,
        model: LIVE_MODEL.replace(/^models\//, ''),
        provider: 'gemini',
        feature: 'agent_task',
        inputTokens: um.promptTokenCount || 0,
        outputTokens: um.responseTokenCount || um.candidatesTokenCount || 0,
        cacheReadTokens: um.cachedContentTokenCount || 0,
        sessionId,
      });
    } catch {
      /* metering must never break the live stream */
    }
  }

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

      // Accumulate inline text (present in text-mode; empty in audio-only mode)
      if (part.text) {
        entry.currentTurnText += part.text;
        emitFn('live:transcript', { sessionId, text: part.text });
      }
    }
  }

  // Output transcription: Gemini sends text transcripts of its own audio speech
  // (requires outputAudioTranscription: {} in session config)
  const outputTranscript = message.serverContent?.outputTranscription;
  if (outputTranscript?.text) {
    console.log(`[liveVoiceService] outputTranscription for ${sessionId}: "${outputTranscript.text}"`);
    entry.currentTurnText += outputTranscript.text;
    emitFn('live:transcript', { sessionId, text: outputTranscript.text });
  }

  // Input transcription: Gemini's speech-to-text of what the user said
  // (requires inputAudioTranscription: {} in session config)
  const inputTranscript = message.serverContent?.inputTranscription;
  if (inputTranscript?.text) {
    console.log(`[liveVoiceService] inputTranscription for ${sessionId}: "${inputTranscript.text}"`);
    entry.pendingUserText += inputTranscript.text;
    emitFn('live:user-transcript', { sessionId, text: inputTranscript.text });
  }

  // Capture resumption handle so onclose can reconnect transparently
  if (message.sessionResumptionUpdate?.newHandle && message.sessionResumptionUpdate.resumable) {
    entry.resumptionHandle = message.sessionResumptionUpdate.newHandle;
  }

  // Tool call: execute the requested tool(s) and send results back to Gemini
  if (message.toolCall?.functionCalls?.length) {
    const functionCalls = message.toolCall.functionCalls;
    console.log(`[liveVoiceService] Tool calls for ${sessionId}:`, functionCalls.map(fc => fc.name));

    // Notify frontend so InlineToolExecutions cards appear while tools run
    emitFn('live:tool-progress', {
      sessionId,
      status: 'executing',
      toolNames: functionCalls.map(fc => fc.name!),
    });

    // Execute all function calls in parallel
    const responses: any[] = await Promise.all(
      functionCalls.map(async (fc) => {
        let responseContent: Record<string, unknown>;
        try {
          const result = await agentModeService.executeTool(
            LIVE_MODEL,
            fc.name!,
            fc.args ?? {},
            entry.userId,
            sessionId,
            false,
          );
          const text = typeof result === 'string' ? result : JSON.stringify(result);
          responseContent = { result: text };
          // Append tool result to separate context (saved to DynamoDB for LLM context,
          // but NOT included in the assistant chat bubble shown to the user)
          entry.toolContextText += `\n[Tool: ${fc.name}]\n${text}`;
          // Summarize result in natural language and extract artifacts in one LLM call
          if (!entry.pendingArtifacts) entry.pendingArtifacts = [];
          const seenUrls = new Set(entry.pendingArtifacts.map(a => a.url));
          const resultObj = typeof result === 'object' && result !== null
            ? result as Record<string, unknown>
            : { result: text };
          const narrative = await summarizeToolResult(fc.name!, fc.args ?? {}, resultObj, seenUrls, entry.pendingArtifacts);
          // Record for UI display (collapsible "Used N tools" block, like other models)
          if (!entry.pendingToolCalls) entry.pendingToolCalls = [];
          entry.pendingToolCalls.push({ id: fc.id || fc.name!, name: fc.name!, arguments: fc.args ?? {}, result, narrative });
        } catch (err: any) {
          console.error(`[liveVoiceService] Tool "${fc.name}" failed:`, err?.message);
          responseContent = { error: err?.message ?? 'Tool execution failed' };
          if (!entry.pendingToolCalls) entry.pendingToolCalls = [];
          entry.pendingToolCalls.push({ id: fc.id || fc.name!, name: fc.name!, arguments: fc.args ?? {}, error: err?.message ?? 'Tool execution failed' });
        }
        return { id: fc.id, name: fc.name!, response: responseContent } as any;
      })
    );

    entry.session.sendToolResponse({ functionResponses: responses });
    return;
  }

  // Turn complete: save transcript to DynamoDB asynchronously, then notify browser
  if (message.serverContent?.turnComplete) {
    // assistantText = clean transcript shown in chat UI (no tool output, no emotion tags)
    const assistantText = entry.currentTurnText.trim();
    const userText = entry.pendingUserText.trim();

    console.log(`[liveVoiceService] turnComplete for ${sessionId}: assistantText="${assistantText.slice(0, 100)}", userText="${userText.slice(0, 100)}"`);

    // Capture artifacts and tool calls before reset (guard against undefined)
    const rawArtifacts: LiveArtifact[] = entry.pendingArtifacts ?? [];
    const artifacts = rawArtifacts.length > 0 ? [...rawArtifacts] : undefined;
    const toolCalls = (entry.pendingToolCalls ?? []).length > 0 ? [...entry.pendingToolCalls] : undefined;

    // Reset for next turn before async work
    entry.currentTurnText = '';
    entry.pendingUserText = '';
    entry.toolContextText = '';
    entry.pendingArtifacts = [];
    entry.pendingToolCalls = [];

    // Append artifact markdown to the assistant message so it persists in DynamoDB
    // and survives any subsequent session reload — no client-side re-apply needed.
    const artifactSuffix = artifacts && artifacts.length > 0
      ? '\n\n' + artifacts.map(a => a.type === 'image' ? `![${a.label}](${a.url})` : `[${a.label}](${a.url})`).join('\n')
      : '';
    const assistantContent = assistantText + artifactSuffix;

    // Emit turn-complete with full content, artifacts, and tool calls for rich UI rendering
    emitFn('live:turn-complete', { sessionId, assistantText: assistantContent, userText, artifacts, toolCalls });

    // Fire-and-forget save — never blocks the audio stream
    if (assistantContent) {
      const messagesToSave: Array<ChatMessage> = [];
      // Skip saving user turns that are STT noise from background audio — persisting
      // them corrupts the context window and causes repetitive/fragmented responses.
      if (userText && !isNoiseTurn(userText)) {
        messagesToSave.push({ role: 'user', content: userText });
      }
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: assistantContent,
        ...(toolCalls && toolCalls.length > 0 ? {
          metadata: {
            timestamp: new Date().toISOString(),
            toolCalls,
          },
        } : {}),
      };
      messagesToSave.push(assistantMessage);

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
