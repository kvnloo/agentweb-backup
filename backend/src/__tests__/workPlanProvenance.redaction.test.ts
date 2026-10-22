/**
 * ENG-669 (#3607 follow-up 6): the work plan's model provenance bookkeeping (`planAuthor`, `launchModelSource`,
 * `planDefaultModelSource`, step `modelSource`) never reaches a non-admin, on every read of the session store, not only
 * agent mode's getSession: the legacy chatbot session endpoints and GET /api/auth/:userId/chat-sessions return the same
 * AW-ChatSessions rows. An admin (or an admin acting as a delegate) keeps them.
 */
import request from 'supertest';
import express from 'express';
import { Response } from 'express';

jest.mock('../middleware/auth');
jest.mock('../services/chatbotService', () => {
  const chatbotDb = { getUserSessions: jest.fn(), getEmmaSessions: jest.fn(), getChatSession: jest.fn() };
  return { chatbotDb, ChatbotDB: jest.fn(() => chatbotDb), generateChatResponse: jest.fn() };
});
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, taskDb: {}, subscriberDb: {}, orgDb: {} }));

import { redactWorkPlanProvenance, withoutWorkPlanProvenance } from '../utils/workPlanProvenance';
import { getChatSession, listEmmaSessions, listUserSessions } from '../controllers/chatbot';
import authRoutes from '../routes/auth';
import { authenticateToken } from '../middleware/auth';
import { chatbotDb } from '../services/chatbotService';

const mockDb = chatbotDb as unknown as Record<'getUserSessions' | 'getEmmaSessions' | 'getChatSession', jest.Mock>;

const OWNER = 'user-1';
const plan = () => ({
  title: 'P', templatePlanId: 't1', planAuthor: 'system', launchModel: 'gpt-5.5', launchModelSource: 'user',
  planDefaultModel: 'gpt-5.5', planDefaultModelSource: 'system', createdAt: 'x', updatedAt: 'x',
  steps: [{ stepCount: 1, title: 'S1', status: 'pending', model: 'gpt-5.5', modelSource: 'system' }, { stepCount: 2, title: 'S2', status: 'pending' }],
});
const session = () => ({ sessionId: 's1', userId: OWNER, llmModel: 'gpt-5.5', llmModelSource: 'system', messages: [], workPlan: plan() });
const PROVENANCE = /planAuthor|launchModelSource|planDefaultModelSource|"modelSource"/;

const expectRedacted = (wp: any) => {
  expect(JSON.stringify(wp)).not.toMatch(PROVENANCE);
  // What the portal reads stays.
  expect(wp).toMatchObject({ templatePlanId: 't1', steps: [{ stepCount: 1, model: 'gpt-5.5' }, { stepCount: 2 }] });
};
const expectKept = (wp: any) => {
  expect(wp).toMatchObject({ planAuthor: 'system', launchModelSource: 'user', planDefaultModelSource: 'system' });
  expect(wp.steps[0].modelSource).toBe('system');
};

const makeRes = () => {
  const res: any = { statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: unknown) => { res.body = body; return res; });
  return res as Response & { statusCode: number; body: any };
};
const asUser = (isAdmin: boolean, extra: Record<string, unknown> = {}) => ({ user: { userId: OWNER, isAdmin }, query: {}, params: {}, body: {}, ...extra }) as any;

beforeEach(() => jest.clearAllMocks());

describe('redactWorkPlanProvenance / withoutWorkPlanProvenance', () => {
  it('drops the four fields, keeps everything else, and never mutates the stored plan', () => {
    const stored = plan();
    const snapshot = JSON.stringify(stored);
    expectRedacted(redactWorkPlanProvenance(stored));
    expect(JSON.stringify(stored)).toBe(snapshot);
  });

  it('passes through non-plans and admin reads untouched', () => {
    expect(redactWorkPlanProvenance(null)).toBeNull();
    expect(redactWorkPlanProvenance(undefined)).toBeUndefined();
    const s = session();
    expect(withoutWorkPlanProvenance(s, true)).toBe(s);
    expect(withoutWorkPlanProvenance({ sessionId: 's2' }, false)).toEqual({ sessionId: 's2' });
    expectRedacted(withoutWorkPlanProvenance(s, false).workPlan);
    expectKept(s.workPlan);
  });
});

describe('legacy chatbot session endpoints', () => {
  it('GET /api/chatbot/sessions: the owner\'s list is redacted; an admin\'s is not', async () => {
    mockDb.getUserSessions.mockImplementation(async () => ({ sessions: [session()] }));
    const owner = makeRes();
    await listUserSessions(asUser(false), owner);
    expectRedacted(owner.body[0].workPlan);
    const admin = makeRes();
    await listUserSessions(asUser(true), admin);
    expectKept(admin.body[0].workPlan);
  });

  it('GET /api/chatbot/sessions/emma: redacted for the owner, kept for a delegated admin', async () => {
    mockDb.getEmmaSessions.mockImplementation(async () => [session()]);
    const owner = makeRes();
    await listEmmaSessions(asUser(false), owner);
    expectRedacted(owner.body[0].workPlan);
    const delegate = makeRes();
    await listEmmaSessions(asUser(false, { delegateInfo: { isDelegated: true } }), delegate);
    expectKept(delegate.body[0].workPlan);
  });

  it('GET /api/chatbot/sessions/:id: redacted for the owner', async () => {
    mockDb.getChatSession.mockImplementation(async () => session());
    const res = makeRes();
    await getChatSession(asUser(false, { params: { sessionId: 's1' } }), res);
    expect(res.statusCode).toBe(200);
    expectRedacted(res.body.workPlan);
    expect(res.body.llmModelSource).toBe('system');
  });
});

describe('GET /api/auth/:userId/chat-sessions', () => {
  const call = (isAdmin: boolean) => {
    (authenticateToken as jest.Mock).mockImplementation(async (req: any, _res: any, next: any) => {
      req.user = { userId: OWNER, isAdmin };
      next();
    });
    const app = express();
    app.use('/api/auth', authRoutes);
    return request(app).get(`/api/auth/${OWNER}/chat-sessions`);
  };

  it('the owner\'s list is redacted (pagination kept); an admin\'s is not', async () => {
    mockDb.getUserSessions.mockImplementation(async () => ({ sessions: [session()], lastEvaluatedKey: { k: 1 } }));
    const owner = await call(false).expect(200);
    expectRedacted(owner.body.sessions[0].workPlan);
    expect(owner.body.lastEvaluatedKey).toEqual({ k: 1 });
    const admin = await call(true).expect(200);
    expectKept(admin.body.sessions[0].workPlan);
  });
});
