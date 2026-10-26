/**
 * ENG-2644 - the public POST /api/agent-mode/ishare/:shareId/stop route required a conversable token without
 * ever comparing it with the session's interactive-share token or checking expiry, so anyone who knew the id
 * of an interactively shared chat could cancel its owner's run.
 *
 * Mounts the REAL routes/agentMode.ts router, the REAL agentModeController and the REAL ChatbotDB over an
 * in-memory DocumentClient (helpers/branchFakeDynamo); run cancellation is observed.
 */
import express from 'express';
import request from 'supertest';
import { BranchFakeDynamo } from './helpers/branchFakeDynamo';

const mockFake = new BranchFakeDynamo();

jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  return {
    ...actual,
    DynamoDB: Object.assign(function DynamoDB() { return {}; }, actual.DynamoDB, {
      DocumentClient: jest.fn(() => mockFake.client()),
    }),
  };
});

const mockRequestCancel = jest.fn();
jest.mock('../utils/sseProgress', () => ({
  ...jest.requireActual('../utils/sseProgress'),
  requestCancel: (...a: unknown[]) => mockRequestCancel(...a),
}));

import agentModeRoutes from '../routes/agentMode';

const app = express();
app.use(express.json());
app.use('/api/agent-mode', agentModeRoutes);

const SESSION_ID = 's-owner';
const SEEDED_SESSION = {
  sessionId: SESSION_ID, userId: 'owner', title: 'Owner chat', portalType: 'agent', sessionType: 'regular',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', messageCount: 0, messages: [],
  interactiveShareMetadata: { isActive: true, token: 'TOK', sharedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
};

beforeEach(() => {
  mockFake.tables.clear();
  mockFake.writeLog.length = 0;
  mockFake.getLog.length = 0;
  mockFake.conditionalFailures = 0;
  mockRequestCancel.mockReset();
  mockFake.seedSession(SEEDED_SESSION);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('POST /api/agent-mode/ishare/:shareId/stop (public, conversable token)', () => {
  const stop = (id: string, token?: string) =>
    request(app).post(`/api/agent-mode/ishare/${id}/stop${token === undefined ? '' : `?conversable=${token}`}`);

  it('stops the run for a holder of the share token', async () => {
    const res = await stop(SESSION_ID, 'TOK');
    expect(res.status).toBe(200);
    expect(mockRequestCancel).toHaveBeenCalledWith(SESSION_ID);
  });

  it('refuses a wrong token with 401 and cancels nothing', async () => {
    const res = await stop(SESSION_ID, 'not-the-token');
    expect(res.status).toBe(401);
    expect(mockRequestCancel).not.toHaveBeenCalled();
  });

  it('refuses a missing token and cancels nothing', async () => {
    const res = await stop(SESSION_ID);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(mockRequestCancel).not.toHaveBeenCalled();
  });

  it('refuses an expired share with 410 and cancels nothing', async () => {
    mockFake.seedSession({ ...SEEDED_SESSION, interactiveShareMetadata: { ...SEEDED_SESSION.interactiveShareMetadata, expiresAt: '2020-01-01T00:00:00.000Z' } });
    const res = await stop(SESSION_ID, 'TOK');
    expect(res.status).toBe(410);
    expect(mockRequestCancel).not.toHaveBeenCalled();
  });
});
