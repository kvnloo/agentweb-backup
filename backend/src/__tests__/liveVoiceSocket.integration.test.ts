/**
 * ENG-521 — real Socket.IO coverage for the live:start authorization boundary.
 *
 * This suite drives an actual socket.io-client through an in-process
 * Socket.IO server. DynamoDB and Gemini remain mocked, but the production
 * live:start handler, effective-user resolution, ownership guard, event
 * delivery, and socket-local ownership state are real.
 */

import http from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIoServer, Socket as ServerSocket } from 'socket.io';
import { io as createSocketClient, Socket as ClientSocket } from 'socket.io-client';

const mockLiveConnect = jest.fn();
const mockSessionClose = jest.fn();
const mockGetChatSessionRecord = jest.fn();
const mockGetMessagesFromMessagesTable = jest.fn();
const mockAddMessagesToSession = jest.fn();
const mockAddMessageToSession = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    live: { connect: mockLiveConnect },
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

import {
  closeLiveSession,
  hasLiveSession,
} from '../services/liveVoiceService';
import { registerLiveStartHandler } from '../services/liveVoiceSocket';

const OWNER = 'owner-user';
const ATTACKER = 'attacker-user';
const ADMIN = 'admin-user';
const OWNED_SESSION = 'session-owned-by-owner';

let httpServer: http.Server;
let ioServer: SocketIoServer;
let baseUrl: string;
let connectedServerSocket: ServerSocket | undefined;
const clients: ClientSocket[] = [];

function waitForEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}`)),
      2_000,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

async function waitForCall(mock: jest.Mock): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (mock.mock.calls.length === 0) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for mock call');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connect(auth: Record<string, unknown>): Promise<ClientSocket> {
  const client = createSocketClient(baseUrl, {
    auth,
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('connect_error', reject);
  });
  return client;
}

beforeAll(async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});

  httpServer = http.createServer();
  ioServer = new SocketIoServer(httpServer, {
    cors: { origin: '*' },
  });
  ioServer.use((socket, next) => {
    const auth = socket.handshake.auth as Record<string, string>;
    if (auth.kind === 'ishare') {
      socket.data.conversableSessionId = auth.sessionId;
      socket.data.conversableUserId = auth.ownerId;
    } else if (auth.kind === 'delegate') {
      socket.data.user = {
        userId: auth.adminId,
        delegateAccess: { targetUserId: auth.targetUserId },
      };
    } else {
      socket.data.user = { userId: auth.userId };
    }
    next();
  });
  ioServer.on('connection', (socket) => {
    connectedServerSocket = socket;
    registerLiveStartHandler(socket);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const client of clients) client.disconnect();
  await new Promise<void>((resolve) => ioServer.close(() => resolve()));
  (console.error as jest.Mock).mockRestore();
  (console.warn as jest.Mock).mockRestore();
  (console.log as jest.Mock).mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  closeLiveSession(OWNED_SESSION);
  mockGetChatSessionRecord.mockResolvedValue({
    sessionId: OWNED_SESSION,
    userId: OWNER,
  });
  mockGetMessagesFromMessagesTable.mockResolvedValue([
    { role: 'user', content: 'private owner history' },
  ]);
  mockAddMessagesToSession.mockResolvedValue(undefined);
  mockLiveConnect.mockResolvedValue({
    sendClientContent: jest.fn(),
    sendRealtimeInput: jest.fn(),
    sendToolResponse: jest.fn(),
    close: mockSessionClose,
  });
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  closeLiveSession(OWNED_SESSION);
  connectedServerSocket = undefined;
});

it('rejects a normal JWT principal at the real live:start boundary without reading or writing', async () => {
  const client = await connect({ kind: 'normal', userId: ATTACKER });
  const error = waitForEvent<{ sessionId: string; error: string }>(client, 'live:error');

  client.emit('live:start', { sessionId: OWNED_SESSION });

  await expect(error).resolves.toEqual({
    sessionId: OWNED_SESSION,
    error: 'Not authorized for this chat session',
  });
  expect(mockGetMessagesFromMessagesTable).not.toHaveBeenCalled();
  expect(mockAddMessagesToSession).not.toHaveBeenCalled();
  expect(mockAddMessageToSession).not.toHaveBeenCalled();
  expect(mockLiveConnect).not.toHaveBeenCalled();
  expect(hasLiveSession(OWNED_SESSION)).toBe(false);
});

it('starts through the real boundary for the session owner', async () => {
  const client = await connect({ kind: 'normal', userId: OWNER });
  const ready = waitForEvent<{ sessionId: string }>(client, 'live:ready');

  client.emit('live:start', { sessionId: OWNED_SESSION });

  await expect(ready).resolves.toEqual({ sessionId: OWNED_SESSION });
  expect(mockGetMessagesFromMessagesTable).toHaveBeenCalledWith(OWNED_SESSION);
  expect(mockLiveConnect).toHaveBeenCalledTimes(1);
});

it('uses the delegated target as the effective owner', async () => {
  const client = await connect({
    kind: 'delegate',
    adminId: ADMIN,
    targetUserId: OWNER,
  });
  const ready = waitForEvent<{ sessionId: string }>(client, 'live:ready');

  client.emit('live:start', { sessionId: OWNED_SESSION });

  await expect(ready).resolves.toEqual({ sessionId: OWNED_SESSION });
  expect(mockLiveConnect).toHaveBeenCalledTimes(1);
});

it('preserves iShare owner access and rejects a different sessionId', async () => {
  const client = await connect({
    kind: 'ishare',
    sessionId: OWNED_SESSION,
    ownerId: OWNER,
  });
  const ready = waitForEvent<{ sessionId: string }>(client, 'live:ready');
  client.emit('live:start', { sessionId: OWNED_SESSION });
  await expect(ready).resolves.toEqual({ sessionId: OWNED_SESSION });

  jest.clearAllMocks();
  const error = waitForEvent<{ sessionId: string; error: string }>(client, 'live:error');
  client.emit('live:start', { sessionId: 'different-session' });

  await expect(error).resolves.toEqual({
    sessionId: 'different-session',
    error: 'Session ID mismatch for conversable socket',
  });
  expect(mockGetChatSessionRecord).not.toHaveBeenCalled();
});

it('does not grant socket-local ownership while the ownership check is pending', async () => {
  let releaseLookup: ((record: { sessionId: string; userId: string }) => void) | undefined;
  mockGetChatSessionRecord.mockReturnValue(new Promise((resolve) => {
    releaseLookup = resolve;
  }));
  const client = await connect({ kind: 'normal', userId: OWNER });
  const ready = waitForEvent<{ sessionId: string }>(client, 'live:ready');

  client.emit('live:start', { sessionId: OWNED_SESSION });
  await waitForCall(mockGetChatSessionRecord);
  const ownsWhilePending = connectedServerSocket?.data.liveSessions?.has(OWNED_SESSION) === true;

  releaseLookup?.({ sessionId: OWNED_SESSION, userId: OWNER });
  await expect(ready).resolves.toEqual({ sessionId: OWNED_SESSION });
  expect(ownsWhilePending).toBe(false);
});

it('closes a live session that finishes starting after its socket disconnects', async () => {
  let releaseLookup: ((record: { sessionId: string; userId: string }) => void) | undefined;
  mockGetChatSessionRecord.mockReturnValue(new Promise((resolve) => {
    releaseLookup = resolve;
  }));
  const client = await connect({ kind: 'normal', userId: OWNER });

  client.emit('live:start', { sessionId: OWNED_SESSION });
  await waitForCall(mockGetChatSessionRecord);
  const serverDisconnected = new Promise<void>((resolve) => {
    connectedServerSocket?.once('disconnect', () => resolve());
  });
  client.disconnect();
  await serverDisconnected;
  releaseLookup?.({ sessionId: OWNED_SESSION, userId: OWNER });

  await waitForCall(mockSessionClose);
  expect(hasLiveSession(OWNED_SESSION)).toBe(false);
});
