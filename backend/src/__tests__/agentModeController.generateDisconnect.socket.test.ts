/**
 * ENG-110 FACT test (real sockets). A real http server with the real middleware order (express.json -> auth ->
 * agentModeController.generateResponse) and a client that aborts mid-run. On Node >= 16 `req.on('close')` never
 * fires after the body was parsed, so the abort must NOT cancel the run today: worker keeps running, reply is
 * persisted once, lock + cap slot are released, and /generating shows the run while it is in flight.
 * A unit test that mocks `req.on` cannot see this, which is why this file uses http.request + socket.destroy().
 */
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import {
  __resetConcurrentGenerationCapForTests,
  __activeGenerationCountForTests,
} from '../services/agentMode/concurrentGenerationCap';
import { agentModeController, activeSessionGenerations } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { requestCancel } from '../utils/sseProgress';

jest.mock('../services/durableLandingService', () => ({
  findInFlightJobForSession: jest.fn().mockResolvedValue(null),
  markAwaitingReconnect: jest.fn().mockResolvedValue(undefined),
  claimCompletion: jest.fn().mockResolvedValue(false),
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));
jest.mock('../services/emailService', () => ({ emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), cancelSession: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('System prompt'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
  },
  AgentModeService: jest.fn(),
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-10',
  }),
}));
jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn() },
  emitProgress: jest.fn(),
  hasActiveProgress: jest.fn().mockReturnValue(false),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
  registerProgressCallback: jest.fn().mockReturnValue(() => {}),
  getLatestProgress: jest.fn().mockReturnValue(null),
  markProgressComplete: jest.fn(),
}));
jest.mock('../services/workPlanService', () => ({ workPlanService: { getWorkPlan: jest.fn().mockResolvedValue(null) } }));
jest.mock('../services/skillService', () => ({ skillService: { getInstalledSkills: jest.fn().mockResolvedValue([]) } }));
jest.mock('../services/subscriptionService', () => ({ getAllowedSkills: jest.fn().mockResolvedValue([]) }));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/agentModeErrors', () => ({
  ...jest.requireActual('../utils/agentModeErrors'),
  isContextLimitError: jest.fn().mockReturnValue(false),
  isSessionLimitError: jest.fn().mockReturnValue(false),
  isTransientLLMError: jest.fn().mockReturnValue(false),
  isWorkerShutdownError: jest.fn().mockReturnValue(false),
  isProviderNoEndpointsError: jest.fn().mockReturnValue(false),
}));

const mockDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const worker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

const userId = 'user-socket';
const REPLY = 'the finished reply';
const DONE = {
  content: REPLY, toolCalls: [], knowledgeBaseQueries: [], sources: [],
  responseMessages: [{ role: 'assistant', content: REPLY, timestamp: '2026-10-12T00:00:00Z', metadata: {} }],
};
const sessionFor = (id: string) => ({
  sessionId: id, userId, title: 't', messages: [], createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z', portalType: 'agent' as const, pageIdentifier: 'agent-mode', llmModel: 'gpt-5-chat-2',
});

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req: any, _res, next) => { req.user = { userId, email: 'test@example.com' }; next(); });
  app.post('/generate', (req: any, res) => { void agentModeController.generateResponse(req, res); });
  app.get('/generating', (req: any, res) => { void agentModeController.getGeneratingSessions(req, res); });
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', ok); });
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise((ok) => server.close(ok)); });

function postGenerate(sessionId: string) {
  const body = JSON.stringify({ sessionId, userMessage: 'hello', llmModel: 'gpt-5-chat-2', attachments: [] });
  const clientReq = http.request({
    host: '127.0.0.1', port, method: 'POST', path: '/generate',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    agent: false,
  });
  clientReq.on('error', () => {});
  clientReq.end(body);
  return clientReq;
}

function getJson(path: string): Promise<any> {
  return new Promise((ok, no) => {
    http.get({ host: '127.0.0.1', port, path, agent: false }, (r) => {
      let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => ok(JSON.parse(b)));
    }).on('error', no);
  });
}

describe('ENG-110 POST /generate over a real socket: a client abort does not cancel the run', () => {
  let resolveWorker!: (v: any) => void;
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessionGenerations.clear();
    __resetConcurrentGenerationCapForTests();
    mockDb.getChatSession.mockImplementation(async (id: string) => sessionFor(id) as any);
    (mockDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockDb.addMessageToSession.mockResolvedValue({} as any);
    mockDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockDb.updateSessionTitle.mockResolvedValue(undefined as any);
    worker.runInWorker.mockReturnValueOnce(new Promise((ok) => { resolveWorker = ok; }));
  });

  it('aborting the connection keeps the worker running, then persists the reply once and releases lock + slot', async () => {
    const clientReq = postGenerate('a');
    await until(() => __activeGenerationCountForTests(userId) === 1);
    expect((await getJson('/generating')).sessionIds).toEqual(['a']);

    clientReq.destroy(); // tab closed / reloaded: the socket goes away mid-run
    await new Promise((r) => setTimeout(r, 150)); // let the server observe the close
    expect(requestCancel).not.toHaveBeenCalled();
    expect(worker.cancelSession).not.toHaveBeenCalled();
    expect(activeSessionGenerations.has('a')).toBe(true);
    expect((await getJson('/generating')).sessionIds).toEqual(['a']);

    resolveWorker(DONE);
    await until(() => __activeGenerationCountForTests(userId) === 0);
    const persisted = mockDb.addMessagesToSession.mock.calls.filter((c) => c[0] === 'a');
    expect(persisted).toHaveLength(1);
    expect(persisted[0][1]).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: REPLY })]));
    expect(activeSessionGenerations.has('a')).toBe(false);
    expect((await getJson('/generating')).sessionIds).toEqual([]);
  });

  it('explicit Stop is what cancels', async () => {
    const clientReq = postGenerate('a');
    await until(() => __activeGenerationCountForTests(userId) === 1);
    clientReq.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const stopRes: any = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await agentModeController.stopGeneration({ params: { sessionId: 'a' }, user: { userId } } as any, stopRes);
    expect(requestCancel).toHaveBeenCalledWith('a');
    expect(worker.cancelSession).toHaveBeenCalledWith('a');
    resolveWorker(DONE);
    await until(() => __activeGenerationCountForTests(userId) === 0);
  });
});
