/**
 * ENG-2816 — live voice on a share link.
 *
 * A share-link socket acts under the session OWNER's userId, so downstream checks cannot tell the owner from a visitor. This
 * drives a real Socket.IO server and client through the production handshake (`authenticateConversableSocket`), the real
 * live:start handler and the real voice service. Only Gemini, the database and the tool executor are mocked, and the
 * executor is where the restriction a tool call carries is observed. (That `executeTool` then refuses on it is proven against
 * the real service in agentModeService.restrictionProfile.test.ts.)
 */
// ENG-2957: voice now checks the account's allowance at start and after each turn; these tests are about other rules.
jest.mock('../services/tokenUsageService', () => ({
  ...jest.requireActual('../services/tokenUsageService'),
  checkTokenUsage: jest.fn(async () => ({ allowed: true, month: '2026-11' })),
}));


import http from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIoServer, Socket as ServerSocket } from 'socket.io';
import { io as createSocketClient, Socket as ClientSocket } from 'socket.io-client';

const mockLiveConnect = jest.fn();
const mockSessionClose = jest.fn();
const mockGetChatSessionRecord = jest.fn();
const mockGetChatSession = jest.fn();
const mockExecuteTool = jest.fn();

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({ live: { connect: mockLiveConnect } })),
  Modality: { AUDIO: 'AUDIO', TEXT: 'TEXT' },
  MediaResolution: { MEDIA_RESOLUTION_MEDIUM: 'MEDIA_RESOLUTION_MEDIUM' },
  StartSensitivity: { START_SENSITIVITY_LOW: 'START_SENSITIVITY_LOW' },
  EndSensitivity: { END_SENSITIVITY_LOW: 'END_SENSITIVITY_LOW' },
  ActivityHandling: { START_OF_ACTIVITY_INTERRUPTS: 'START_OF_ACTIVITY_INTERRUPTS' },
}));
jest.mock('../services/onboardingTelemetry', () => ({
  ONBOARDING_TELEMETRY_EVENTS: {
    voiceSessionStarted: 'a', voiceSessionReady: 'b', voiceFirstAudio: 'c', voiceTurnCompleted: 'd',
    voiceTurnRecovery: 'e', voiceInterrupted: 'f', voiceSessionFailed: 'g',
  },
  recordOnboardingEvent: jest.fn().mockResolvedValue(undefined),
  recordOnboardingFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSessionRecord: mockGetChatSessionRecord,
    getChatSession: mockGetChatSession,
    getMessagesFromMessagesTable: jest.fn().mockResolvedValue([]),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
    addMessageToSession: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn().mockResolvedValue('fake-gemini-api-key') }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getFilteredTools: jest.fn().mockResolvedValue([]),
    getAvailableTools: jest.fn().mockReturnValue([]),
    executeTool: mockExecuteTool,
    callLLM: jest.fn().mockResolvedValue({ choices: [{ message: { content: '{"narrative":"ok","artifacts":[]}' } }] }),
  },
}));
// Only the login check is replaced (the same getUserFromToken every route uses).
const mockGetUserFromToken = jest.fn();
jest.mock('../middleware/auth', () => ({ getUserFromToken: mockGetUserFromToken }));

import { closeLiveSession } from '../services/liveVoiceService';
import { authenticateConversableSocket, registerLiveCloseHandler, registerLiveStartHandler } from '../services/liveVoiceSocket';

const OWNER = 'owner-user';
const SESSION = 'shared-session-1';
const OTHER_SESSION = 'shared-session-2';
const SHARE_TOKEN = 'share-token-abc';

let httpServer: http.Server;
let ioServer: SocketIoServer;
let baseUrl: string;
const serverSockets = new Map<string, ServerSocket>();
const clients: ClientSocket[] = [];
let geminiCallbacks: Record<string, (...args: any[]) => void> = {};

const sessionRecord = (id: string, active = true) => ({
  sessionId: id,
  userId: OWNER,
  interactiveShareMetadata: { isActive: active, token: SHARE_TOKEN, expiresAt: '2099-01-01T00:00:00Z' },
});

function waitForEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 2_000);
    socket.once(event, (p: T) => { clearTimeout(t); resolve(p); });
  });
}
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
function connect(auth: Record<string, unknown>): Promise<ClientSocket> {
  const client = createSocketClient(baseUrl, { auth, forceNew: true, reconnection: false, transports: ['websocket'] });
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
}

beforeAll(async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});

  httpServer = http.createServer();
  ioServer = new SocketIoServer(httpServer, { cors: { origin: '*' } });
  // The same shape as the middleware in server.ts: a conversable socket goes through the production handshake function.
  ioServer.use(async (socket, next) => {
    const auth = socket.handshake.auth as Record<string, unknown>;
    if (auth.conversableToken && auth.conversableSessionId) {
      const result = await authenticateConversableSocket(auth, (id) => mockGetChatSession(id));
      if (!result.ok) return next(new Error(result.error));
      Object.assign(socket.data, result.data);
      return next();
    }
    if (auth.userId) { socket.data.user = { userId: auth.userId }; return next(); }
    return next(new Error('Authentication error'));
  });
  ioServer.on('connection', (socket) => {
    serverSockets.set(socket.id, socket);
    socket.once('disconnect', () => serverSockets.delete(socket.id));
    registerLiveStartHandler(socket);
    registerLiveCloseHandler(socket);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const c of clients) c.disconnect();
  await new Promise<void>((resolve) => ioServer.close(() => resolve()));
  (console.error as jest.Mock).mockRestore();
  (console.warn as jest.Mock).mockRestore();
  (console.log as jest.Mock).mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserFromToken.mockReset().mockResolvedValue({ user: null });
  mockGetChatSession.mockReset().mockImplementation(async (id: string) => (id === SESSION || id === OTHER_SESSION ? sessionRecord(id) : null));
  mockGetChatSessionRecord.mockReset().mockImplementation(async (id: string) => ({ sessionId: id, userId: OWNER }));
  mockExecuteTool.mockReset().mockResolvedValue({ success: true });
  mockLiveConnect.mockReset().mockImplementation(({ callbacks }: any) => {
    geminiCallbacks = callbacks;
    return Promise.resolve({ sendClientContent: jest.fn(), sendRealtimeInput: jest.fn(), sendToolResponse: jest.fn(), close: mockSessionClose });
  });
  closeLiveSession(SESSION);
  closeLiveSession(OTHER_SESSION);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => {
    if (!client.connected) return;
    const s = serverSockets.get(client.id!);
    if (!s) { client.disconnect(); return; }
    const gone = new Promise<void>((resolve) => s.once('disconnect', () => resolve()));
    client.disconnect();
    await gone;
  }));
  closeLiveSession(SESSION);
  closeLiveSession(OTHER_SESSION);
  serverSockets.clear();
});

/** Connect, start voice on `sessionId`, have Gemini call `toolName`, and return the context the executor was handed. */
async function toolContextFor(auth: Record<string, unknown>, sessionId = SESSION, toolName = 'save_memory'): Promise<Record<string, unknown>> {
  const client = await connect(auth);
  const ready = waitForEvent(client, 'live:ready');
  client.emit('live:start', { sessionId });
  await ready;
  geminiCallbacks.onmessage({ toolCall: { functionCalls: [{ id: `fc-${sessionId}`, name: toolName, args: { content: 'canary' } }] } });
  await waitFor(() => mockExecuteTool.mock.calls.length > 0);
  const call = mockExecuteTool.mock.calls[mockExecuteTool.mock.calls.length - 1];
  expect(call[1]).toBe(toolName);
  expect(call[3]).toBe(OWNER); // the socket acts as the owner either way: only the context tells the visitor apart
  return call[6];
}

const shareAuth = (extra: Record<string, unknown> = {}) => ({ conversableToken: SHARE_TOKEN, conversableSessionId: SESSION, ...extra });

describe('live voice on a share link (ENG-2816)', () => {
  it('a visitor (no login) runs every tool under the share_visitor restriction', async () => {
    const ctx = await toolContextFor(shareAuth());
    expect(ctx).toEqual({ isUnattendedRun: false, restrictionProfile: 'share_visitor' });
  });

  it('the same restriction reaches the tools voice runs through its other branch (the onboarding-safe ones, connect_account included)', async () => {
    for (const toolName of ['connect_account', 'list_connected_accounts', 'read_brand_guidelines']) {
      mockExecuteTool.mockClear();
      closeLiveSession(SESSION);
      const ctx = await toolContextFor(shareAuth(), SESSION, toolName);
      expect(ctx).toEqual({ isUnattendedRun: false, restrictionProfile: 'share_visitor' });
    }
  });

  it('a visitor sending a garbage login is still a visitor and the connection still succeeds', async () => {
    const ctx = await toolContextFor(shareAuth({ viewerToken: 'not.a.jwt' }));
    expect(ctx).toMatchObject({ restrictionProfile: 'share_visitor' });
  });

  it("a logged-in colleague (someone else's login) is a visitor", async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: 'colleague-id' }, decoded: { userId: 'colleague-id' } });
    expect(await toolContextFor(shareAuth({ viewerToken: 'colleague.jwt' }))).toMatchObject({ restrictionProfile: 'share_visitor' });
  });

  it('an admin acting as the owner through a delegate token is a visitor', async () => {
    mockGetUserFromToken.mockResolvedValue({
      user: { userId: OWNER },
      decoded: { userId: 'admin-id', delegateAccess: { adminUserId: 'admin-id', adminEmail: 'a@x.com', targetUserId: OWNER, targetEmail: 'o@x.com' } },
    });
    expect(await toolContextFor(shareAuth({ viewerToken: 'delegate.jwt' }))).toMatchObject({ restrictionProfile: 'share_visitor' });
  });

  it("the owner's own login makes it an owner call: no restriction, exactly the context voice always had", async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER }, decoded: { userId: OWNER } });
    const ctx = await toolContextFor(shareAuth({ viewerToken: 'owner.jwt' }));
    expect(ctx).toEqual({ isUnattendedRun: false });
    expect(ctx).not.toHaveProperty('restrictionProfile');
  });

  it('a regular signed-in socket (not a share link) is unrestricted, as before', async () => {
    const ctx = await toolContextFor({ userId: OWNER });
    expect(ctx).toEqual({ isUnattendedRun: false });
  });

  it('each session gets its own frozen context: a visitor session never leaks its restriction to an owner call', async () => {
    const visitorCtx = await toolContextFor(shareAuth());
    const ownerCtx = await toolContextFor({ userId: OWNER }, OTHER_SESSION);
    expect(Object.isFrozen(visitorCtx)).toBe(true);
    expect(Object.isFrozen(ownerCtx)).toBe(true);
    expect(visitorCtx).not.toBe(ownerCtx);
    expect(ownerCtx).not.toHaveProperty('restrictionProfile');
    expect(visitorCtx).toHaveProperty('restrictionProfile', 'share_visitor');
  });

  it('the handshake still refuses a wrong share token, an inactive share and an unknown session with the same errors as before', async () => {
    await expect(connect({ conversableToken: 'wrong', conversableSessionId: SESSION })).rejects.toThrow('Invalid conversable token');
    mockGetChatSession.mockResolvedValueOnce(sessionRecord(SESSION, false));
    await expect(connect(shareAuth())).rejects.toThrow('Interactive share is not active');
    await expect(connect({ conversableToken: SHARE_TOKEN, conversableSessionId: 'nope' })).rejects.toThrow('Session not found');
    mockGetChatSession.mockRejectedValueOnce(new Error('db down'));
    await expect(connect(shareAuth())).rejects.toThrow('Conversable auth error');
  });

  it('leaves a token-free trace of the owner-or-visitor decision for each share connection', async () => {
    const traces = () => (console.log as jest.Mock).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[ENG-2816] voice socket'));
    (console.log as jest.Mock).mockClear();
    await connect(shareAuth());
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER }, decoded: { userId: OWNER } });
    await connect(shareAuth({ viewerToken: 'owner.jwt' }));
    const lines = traces();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`${SESSION}: the viewer is a visitor`);
    expect(lines[1]).toContain(`${SESSION}: the viewer is the session owner`);
    for (const line of lines) {
      expect(line).not.toContain('owner.jwt');
      expect(line).not.toContain(SHARE_TOKEN);
      expect(line).not.toContain(OWNER);
    }
  });

  it('a login never replaces the share token: the owner with a wrong share token is refused', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: { userId: OWNER }, decoded: { userId: OWNER } });
    await expect(connect({ conversableToken: 'wrong', conversableSessionId: SESSION, viewerToken: 'owner.jwt' })).rejects.toThrow('Invalid conversable token');
  });
});
