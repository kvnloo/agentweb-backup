/**
 * Session access on /api/emma routes that act on a chat session named by `session_id`.
 *
 * These routes delegate to agentModeService implementations that load the session by id and read
 * or write it with no notion of who is asking. The route must apply the same rule agent mode uses
 * for opening/running a chat (owner or admin; a delegate token acts as its target account) before
 * the service is called. A foreign or missing session answers 404 and the service is never called.
 *
 * Real middleware/auth.ts verifies real JWTs here: delegate tokens come from the real
 * mintDelegateToken (services/delegateAccessToken.ts) and the self-call path goes through the real
 * mcpFetch (mcp/server/httpClient.ts) against a listening server. Only the DynamoDB-backed
 * user/session reads and the service implementations are stubbed.
 */

import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import request from 'supertest';

interface TestUser { userId: string; email: string; isAdmin: boolean; roles: string[] }
const USERS: Record<string, TestUser> = {
  'owner-1': { userId: 'owner-1', email: 'owner@example.com', isAdmin: false, roles: ['customer'] },
  'other-1': { userId: 'other-1', email: 'other@example.com', isAdmin: false, roles: ['customer'] },
  'third-1': { userId: 'third-1', email: 'third@example.com', isAdmin: false, roles: ['customer'] },
  'admin-1': { userId: 'admin-1', email: 'admin@example.com', isAdmin: true, roles: ['partner'] },
  'support-1': { userId: 'support-1', email: 'support@example.com', isAdmin: true, roles: ['partner'] },
};

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(async (id: string) => USERS[id] ?? null) },
}));

// The router's ENG-973 token-quota gate is not under test here.
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null, bonus: 0,
    effectiveAllowance: null, percentUsed: 0, month: '2026-10',
  }),
}));

const SESSIONS: Record<string, { sessionId: string; userId: string }> = {
  'sess-owner': { sessionId: 'sess-owner', userId: 'owner-1' },
};
const mockChatbotDb = {
  getChatSessionRecord: jest.fn(async (id: string) => SESSIONS[id] ?? null),
  getChatSession: jest.fn(async (id: string) => SESSIONS[id] ?? null),
};
jest.mock('../services/chatbotService', () => ({ chatbotDb: mockChatbotDb }));

const ok = { success: true };
const mockService = {
  createWorkPlan: jest.fn().mockResolvedValue(ok),
  modifyWorkPlan: jest.fn().mockResolvedValue(ok),
  setWorkPlanStatus: jest.fn().mockResolvedValue(ok),
  sendForReview: jest.fn().mockResolvedValue(ok),
  generateImage: jest.fn().mockResolvedValue(ok),
  generateVideo: jest.fn().mockResolvedValue(ok),
  createHtmlFile: jest.fn().mockResolvedValue(ok),
  createHtmlTemplate: jest.fn().mockResolvedValue(ok),
  createTaskFromTemplate: jest.fn().mockResolvedValue(ok),
  createTaskFromPrompt: jest.fn().mockResolvedValue(ok),
  createImageTaskFromPrompt: jest.fn().mockResolvedValue(ok),
};
jest.mock('../services/agentModeService', () => ({ agentModeService: mockService }));

import emmaApiRoutes from '../routes/emmaApi';
import { mintDelegateToken } from '../services/delegateAccessToken';
import { mcpFetch, clearUserCache } from '../mcp/server/httpClient';

const SECRET = 'emma-session-access-test-secret';

type Method = 'post' | 'put' | 'patch';
interface RouteCase {
  name: string;
  method: Method;
  path: string;
  body: Record<string, unknown>;
  service: jest.Mock;
  /** session_id is mandatory for this route (the service cannot act without one). */
  required: boolean;
}

const ROUTES: RouteCase[] = [
  { name: 'create work plan', method: 'post', path: '/api/emma/work-plans', body: { title: 'Plan', steps: [{ stepCount: 1, title: 'A' }] }, service: mockService.createWorkPlan, required: true },
  { name: 'modify work plan', method: 'put', path: '/api/emma/work-plans', body: { steps: [{ stepCount: 1, title: 'A' }] }, service: mockService.modifyWorkPlan, required: true },
  { name: 'set work plan status', method: 'patch', path: '/api/emma/work-plans/status', body: { updates: [{ stepCount: 1, status: 'completed' }] }, service: mockService.setWorkPlanStatus, required: true },
  { name: 'send for review', method: 'post', path: '/api/emma/send-for-review', body: { subject: 'S', content_url: 'https://example.com/x' }, service: mockService.sendForReview, required: true },
  { name: 'generate image', method: 'post', path: '/api/emma/generate-image', body: { prompt: 'p', filename: 'f.png', category: 'ad' }, service: mockService.generateImage, required: false },
  { name: 'generate video', method: 'post', path: '/api/emma/generate-video', body: { prompt: 'p', filename: 'f.mp4' }, service: mockService.generateVideo, required: false },
  { name: 'create html', method: 'post', path: '/api/emma/create-html', body: { title: 't', content_draft: 'c' }, service: mockService.createHtmlFile, required: false },
  { name: 'create html template', method: 'post', path: '/api/emma/create-html-template', body: { html_source: '<p/>', template_name: 'n' }, service: mockService.createHtmlTemplate, required: false },
  { name: 'task from template', method: 'post', path: '/api/emma/task-from-template', body: { template_id: 't', parameters_json: {} }, service: mockService.createTaskFromTemplate, required: false },
  { name: 'task from prompt', method: 'post', path: '/api/emma/task-from-prompt', body: { task_name: 't', prompt: 'p', category: 'c' }, service: mockService.createTaskFromPrompt, required: false },
  { name: 'image task from prompt', method: 'post', path: '/api/emma/image-task-from-prompt', body: { task_name: 't', prompt: 'p', category: 'c' }, service: mockService.createImageTaskFromPrompt, required: false },
];

function userToken(id: string): string {
  const u = USERS[id];
  return jwt.sign({ userId: u.userId, email: u.email, isAdmin: u.isAdmin }, SECRET, { expiresIn: 300 });
}

/** Support/delegate session: the real minting helper used by the admin delegate-access flow. */
function delegateToken(adminId: string, targetId: string): string {
  return mintDelegateToken(USERS[adminId], USERS[targetId], 300);
}

let app: express.Application;

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  app = express();
  app.use(express.json());
  app.use('/api/emma', emmaApiRoutes);
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  clearUserCache();
});

function send(route: RouteCase, token: string, body: Record<string, unknown>) {
  return request(app)[route.method](route.path).set('Authorization', `Bearer ${token}`).send(body);
}

describe.each(ROUTES)('$method $path ($name)', (route) => {
  it('allows the session owner and calls the service', async () => {
    const res = await send(route, userToken('owner-1'), { ...route.body, session_id: 'sess-owner' });
    expect(res.status).toBe(200);
    expect(route.service).toHaveBeenCalledTimes(1);
  });

  it("refuses another signed-in user with 404 and never calls the service", async () => {
    const res = await send(route, userToken('other-1'), { ...route.body, session_id: 'sess-owner' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Session not found' });
    expect(route.service).not.toHaveBeenCalled();
    // Only the session record was read to decide; the transcript was never loaded.
    expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
  });

  it('allows an admin, as agent mode does for the same session (getSession/generate)', async () => {
    const res = await send(route, userToken('admin-1'), { ...route.body, session_id: 'sess-owner' });
    expect(res.status).toBe(200);
    expect(route.service).toHaveBeenCalledTimes(1);
  });

  it("allows a delegate session acting as the session owner's account", async () => {
    const res = await send(route, delegateToken('support-1', 'owner-1'), { ...route.body, session_id: 'sess-owner' });
    expect(res.status).toBe(200);
    expect(route.service).toHaveBeenCalledTimes(1);
  });

  it('refuses a delegate session acting as a different account', async () => {
    const res = await send(route, delegateToken('support-1', 'third-1'), { ...route.body, session_id: 'sess-owner' });
    expect(res.status).toBe(404);
    expect(route.service).not.toHaveBeenCalled();
  });

  it('answers 404 for a session that does not exist, without calling the service', async () => {
    const res = await send(route, userToken('owner-1'), { ...route.body, session_id: 'sess-missing' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Session not found' });
    expect(route.service).not.toHaveBeenCalled();
  });

  it('rejects a non-string session_id with 400', async () => {
    const res = await send(route, userToken('owner-1'), { ...route.body, session_id: { $ne: '' } });
    expect(res.status).toBe(400);
    expect(route.service).not.toHaveBeenCalled();
  });

  if (route.required) {
    it('answers 400 when session_id is missing', async () => {
      const res = await send(route, userToken('owner-1'), route.body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: 'session_id is required' });
      expect(route.service).not.toHaveBeenCalled();
    });
  } else {
    it('keeps working without a session_id (no session is touched)', async () => {
      const res = await send(route, userToken('owner-1'), route.body);
      expect(res.status).toBe(200);
      expect(route.service).toHaveBeenCalledTimes(1);
      expect(mockChatbotDb.getChatSessionRecord).not.toHaveBeenCalled();
    });
  }
});

describe('MCP self-calls (real mcpFetch -> real authenticateToken -> route)', () => {
  let server: http.Server;
  const previousPort = process.env.PORT;

  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.PORT = String((server.address() as AddressInfo).port);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
  });

  it("a self-call carrying the session owner's identity can create the work plan", async () => {
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/work-plans', context: { userId: 'owner-1', sessionId: 'sess-owner' },
      body: { title: 'Plan', steps: [{ stepCount: 1, title: 'A' }], session_id: 'sess-owner' },
    });
    expect(data).toEqual(ok);
    expect(mockService.createWorkPlan).toHaveBeenCalledWith('Plan', [{ stepCount: 1, title: 'A' }], 'sess-owner');
  });

  it("a self-call made during a delegate's run of the owner's chat can set work plan status", async () => {
    const data = await mcpFetch({
      method: 'PATCH', path: '/api/emma/work-plans/status',
      context: { userId: 'owner-1', isDelegatedAccess: true, sessionId: 'sess-owner' },
      body: { updates: [{ stepCount: 1, status: 'completed' }], session_id: 'sess-owner' },
    });
    expect(data).toEqual(ok);
    expect(mockService.setWorkPlanStatus).toHaveBeenCalledTimes(1);
  });

  it('a self-call carrying the existing MCP tool body (no session_id) is unaffected', async () => {
    // generate_image's MCP tool (mcp/server/apiTools.ts) sends no session_id.
    const data = await mcpFetch({
      method: 'POST', path: '/api/emma/generate-image', context: { userId: 'owner-1' },
      body: { prompt: 'p', filename: 'f.png', category: 'ad' },
    });
    expect(data).toEqual(ok);
    expect(mockService.generateImage).toHaveBeenCalledTimes(1);
  });

  it("a self-call for another account's session is refused and writes nothing", async () => {
    await expect(mcpFetch({
      method: 'PUT', path: '/api/emma/work-plans', context: { userId: 'other-1' },
      body: { steps: [{ stepCount: 1, title: 'A' }], session_id: 'sess-owner' },
    })).rejects.toThrow('API error (404): Session not found');
    expect(mockService.modifyWorkPlan).not.toHaveBeenCalled();
  });
});
