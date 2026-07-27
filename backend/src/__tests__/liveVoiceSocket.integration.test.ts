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
import {
  registerLiveCloseHandler,
  registerLiveStartHandler,
} from '../services/liveVoiceSocket';

const OWNER = 'owner-user';
const ATTACKER = 'attacker-user';
const ADMIN = 'admin-user';
const OWNED_SESSION = 'session-owned-by-owner';

let httpServer: http.Server;
let ioServer: SocketIoServer;
let baseUrl: string;
let connectedServerSocket: ServerSocket | undefined;
const serverSockets = new Map<string, ServerSocket>();
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

async function waitForCall(mock: { mock: { calls: unknown[][] } }): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (mock.mock.calls.length === 0) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for mock call');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out at ${label}`)), 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
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
    serverSockets.set(socket.id, socket);
    socket.once('disconnect', () => serverSockets.delete(socket.id));
    registerLiveStartHandler(socket);
    registerLiveCloseHandler(socket);
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
  mockLiveConnect.mockReset();
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

afterEach(async () => {
  const disconnects = clients.splice(0).map(async (client) => {
    if (!client.connected) return;
    const serverSocket = serverSockets.get(client.id!);
    if (!serverSocket) {
      client.disconnect();
      return;
    }
    const disconnected = new Promise<void>((resolve) => {
      serverSocket.once('disconnect', () => resolve());
    });
    client.disconnect();
    await disconnected;
  });
  await Promise.all(disconnects);
  closeLiveSession(OWNED_SESSION);
  connectedServerSocket = undefined;
  serverSockets.clear();
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

it('cancels a live session before Gemini opens when its socket disconnects', async () => {
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

  await flushSocketTasks();
  expect(mockLiveConnect).not.toHaveBeenCalled();
  expect(mockSessionClose).not.toHaveBeenCalled();
  expect(hasLiveSession(OWNED_SESSION)).toBe(false);
});

function configureBlockedFirstGeminiConnect() {
  const firstSession = {
    sendClientContent: jest.fn(),
    sendRealtimeInput: jest.fn(),
    sendToolResponse: jest.fn(),
    close: jest.fn(),
  };
  const replacementSession = {
    sendClientContent: jest.fn(),
    sendRealtimeInput: jest.fn(),
    sendToolResponse: jest.fn(),
    close: jest.fn(),
  };
  let releaseFirstConnect: (() => void) | undefined;
  let markFirstConnectStarted: (() => void) | undefined;
  const firstConnectStarted = new Promise<void>((resolve) => {
    markFirstConnectStarted = resolve;
  });
  mockLiveConnect
    .mockImplementationOnce(() => {
      markFirstConnectStarted?.();
      return new Promise((resolve) => {
        releaseFirstConnect = () => resolve(firstSession);
      });
    })
    .mockResolvedValueOnce(replacementSession);

  return {
    firstSession,
    firstConnectStarted,
    releaseFirstConnect: () => releaseFirstConnect?.(),
  };
}

async function flushSocketTasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

it('does not run a queued replacement after its socket disconnects', async () => {
  const blocked = configureBlockedFirstGeminiConnect();
  const owner = await connect({ kind: 'normal', userId: OWNER });
  const ownerReady = waitForEvent<{ sessionId: string }>(owner, 'live:ready');
  owner.emit('live:start', { sessionId: OWNED_SESSION });
  await within(blocked.firstConnectStarted, 'first Gemini connect');

  const abandoned = await connect({ kind: 'normal', userId: OWNER });
  const abandonedServerSocket = serverSockets.get(abandoned.id!);
  abandoned.emit('live:start', { sessionId: OWNED_SESSION });
  await waitForCondition(
    () => abandonedServerSocket?.data.pendingLiveStarts?.has(OWNED_SESSION) === true,
  );

  const serverDisconnected = new Promise<void>((resolve) => {
    abandonedServerSocket?.once('disconnect', () => resolve());
  });
  abandoned.disconnect();
  await serverDisconnected;
  blocked.releaseFirstConnect();

  await expect(ownerReady).resolves.toEqual({ sessionId: OWNED_SESSION });
  await waitForCondition(
    () => abandonedServerSocket?.data.pendingLiveStarts?.has(OWNED_SESSION) !== true,
  );
  expect(mockLiveConnect).toHaveBeenCalledTimes(1);
  expect(blocked.firstSession.close).not.toHaveBeenCalled();
  expect(hasLiveSession(OWNED_SESSION)).toBe(true);
});

it('does not run a queued replacement after live:close cancels it', async () => {
  const blocked = configureBlockedFirstGeminiConnect();
  const owner = await connect({ kind: 'normal', userId: OWNER });
  const ownerReady = waitForEvent<{ sessionId: string }>(owner, 'live:ready');
  owner.emit('live:start', { sessionId: OWNED_SESSION });
  await within(blocked.firstConnectStarted, 'first Gemini connect');

  const abandoned = await connect({ kind: 'normal', userId: OWNER });
  const abandonedServerSocket = serverSockets.get(abandoned.id!);
  abandoned.emit('live:start', { sessionId: OWNED_SESSION });
  await within(
    waitForCondition(
      () => abandonedServerSocket?.data.pendingLiveStarts?.has(OWNED_SESSION) === true,
    ),
    'queued start registration',
  );

  const abortSpy = jest.spyOn(AbortController.prototype, 'abort');
  abandoned.emit('live:close', { sessionId: OWNED_SESSION });
  await within(waitForCall(abortSpy), 'live:close cancellation');
  blocked.releaseFirstConnect();

  await expect(within(ownerReady, 'owner ready')).resolves.toEqual({
    sessionId: OWNED_SESSION,
  });
  await within(
    waitForCondition(
      () => abandonedServerSocket?.data.pendingLiveStarts?.has(OWNED_SESSION) !== true,
    ),
    'queued start cleanup',
  );
  expect(mockLiveConnect).toHaveBeenCalledTimes(1);
  expect(blocked.firstSession.close).not.toHaveBeenCalled();
  expect(hasLiveSession(OWNED_SESSION)).toBe(true);
  abortSpy.mockRestore();
});
