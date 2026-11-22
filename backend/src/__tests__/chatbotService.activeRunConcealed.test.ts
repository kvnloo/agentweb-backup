/**
 * ENG-110: AW-ChatSessions.activeRun is read by the generating checks but must never reach a serializer.
 * The REAL ChatbotDB reads over an in-memory DocumentClient: every session read hides the attribute
 * (non-enumerable), so no JSON response, spread, export or list can leak runId/instanceId.
 */
import { BranchFakeDynamo } from './helpers/branchFakeDynamo';

const mockFake = new BranchFakeDynamo();

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockFake.client()) },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));
jest.mock('../services/db', () => ({
  userDb: { updateUser: jest.fn().mockResolvedValue(undefined), getUserById: jest.fn().mockResolvedValue(null) },
  taskDb: {},
}));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn().mockResolvedValue('k') }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));

import { chatbotDb } from '../services/chatbotService';

const RUN = { runId: 'secret-run', instanceId: 'secret-instance', startedAt: 1, heartbeatAt: 2 };
const LEAK = /activeRun|secret-run|secret-instance|heartbeatAt/;

beforeEach(() => {
  mockFake.tables.clear();
  mockFake.seedSession({ sessionId: 's1', userId: 'u1', title: 't', updatedAt: '2026-10-13T00:00:00.000Z', createdAt: '2026-10-13T00:00:00.000Z', portalType: 'agent', activeRun: RUN });
  mockFake.seedSession({ sessionId: 's2', userId: 'u1', title: 't2', updatedAt: '2026-10-12T00:00:00.000Z', createdAt: '2026-10-12T00:00:00.000Z', portalType: 'agent' });
});

describe('ChatbotDB reads hide activeRun', () => {
  it('getChatSessionRecord: readable in-process, invisible to JSON / spread / keys', async () => {
    const rec = (await chatbotDb.getChatSessionRecord('s1'))!;
    expect(rec.activeRun).toEqual(RUN);
    expect(JSON.stringify(rec)).not.toMatch(LEAK);
    expect(JSON.stringify({ ...rec })).not.toMatch(LEAK);
    expect(Object.keys(rec)).not.toContain('activeRun');
  });

  it('getChatSession (which rebuilds the object) keeps it readable but hidden', async () => {
    const session = (await chatbotDb.getChatSession('s1'))!;
    expect(session.activeRun).toEqual(RUN);
    expect(JSON.stringify(session)).not.toMatch(LEAK);
    expect(JSON.stringify({ ...session, extra: 1 })).not.toMatch(LEAK);
  });

  it('a session without the attribute is returned exactly as before (no property added)', async () => {
    const rec = (await chatbotDb.getChatSessionRecord('s2'))!;
    expect(Object.getOwnPropertyDescriptor(rec, 'activeRun')).toBeUndefined();
    const session = (await chatbotDb.getChatSession('s2'))!;
    expect(Object.getOwnPropertyDescriptor(session, 'activeRun')).toBeUndefined();
  });

  it('the user session list never carries it', async () => {
    const { sessions } = await chatbotDb.getUserSessions('u1');
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
    expect(JSON.stringify(sessions)).not.toMatch(LEAK);
  });

  it('the stored item itself still holds it (the guard owns the write)', () => {
    expect(mockFake.session('s1')!.activeRun).toEqual(RUN);
  });
});
