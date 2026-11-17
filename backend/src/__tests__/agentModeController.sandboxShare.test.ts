/**
 * ENG-1907 AC3: a sandbox account cannot create a public share link, and a
 * public share/ishare generate request cannot drive Emma on a sandbox-owned
 * session. Both are refused before any session mutation or LLM spend.
 */
import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionShareMetadata: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
    createOrReuseInteractiveShare: jest.fn(),
  },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: { default_model: 'gpt-5-chat-2', getDefaultModel: jest.fn(), getMarketingSystemPrompt: jest.fn(), generateSessionTitle: jest.fn() },
}));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn(), cancelSession: jest.fn() },
}));
jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn().mockReturnValue(true), has: jest.fn().mockReturnValue(false), add: jest.fn() },
  getLatestProgress: jest.fn().mockReturnValue(undefined), requestCancel: jest.fn(), clearCancel: jest.fn(), isCancelled: jest.fn().mockReturnValue(false), emitProgress: jest.fn(),
}));
jest.mock('../services/tokenUsageService', () => ({ checkTokenUsage: jest.fn() }));

import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { checkTokenUsage } from '../services/tokenUsageService';
import { agentModeController } from '../controllers/agentModeController';

const refusal = { error: 'Sharing is not available in this sandbox workspace' };
function makeRes() { return { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response; }
const sharedSession = (userId: string) => ({
  sessionId: 'share-1', userId, title: 't', messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), llmModel: 'gpt-5-chat-2',
  interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00Z' },
});

beforeEach(() => {
  jest.clearAllMocks();
  (checkTokenUsage as jest.Mock).mockResolvedValue({ allowed: true, percentUsed: 1 });
});

describe('createShareLink', () => {
  it('refuses a sandbox principal before touching the session', async () => {
    const res = makeRes();
    await agentModeController.createShareLink({ user: { userId: 'eval_test' }, body: { sessionId: 'share-1' } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(refusal);
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
    expect(chatbotDb.updateSessionShareMetadata).not.toHaveBeenCalled();
  });
  it('still shares for an ordinary owner', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId: 'share-1', userId: 'customer' });
    const res = makeRes();
    await agentModeController.createShareLink({ user: { userId: 'customer' }, body: { sessionId: 'share-1' } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(chatbotDb.updateSessionShareMetadata).toHaveBeenCalledWith('share-1', expect.objectContaining({ isShared: true }));
  });
});

describe('createConversableShare', () => {
  it('refuses a sandbox principal before touching the session', async () => {
    const res = makeRes();
    await agentModeController.createConversableShare({ user: { userId: 'eval_test' }, body: { sessionId: 'share-1' } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(refusal);
    expect(chatbotDb.getChatSession).not.toHaveBeenCalled();
    expect(chatbotDb.createOrReuseInteractiveShare).not.toHaveBeenCalled();
  });
});

describe('public readers refuse a sandbox-owned session', () => {
  it.each([['getSharedConversation', { conversable: 'tok' }], ['getShareOgMetadata', {}]] as const)('%s', async (handler, query) => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sharedSession('eval_test'));
    const res = makeRes();
    await (agentModeController as any)[handler]({ params: { shareId: 'share-1' }, query } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(refusal);
    expect(chatbotDb.getMessagesFromMessagesTable).not.toHaveBeenCalled();
  });
});

describe('generateSharedResponse', () => {
  const req = () => ({ params: { shareId: 'share-1' }, query: { conversable: 'tok' }, body: { userMessage: 'hi', attachments: [] }, ip: '203.0.113.1', headers: {} } as unknown as Request);
  it('refuses a sandbox-owned session before any usage check or worker call', async () => {
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(sharedSession('eval_test'));
    const res = makeRes();
    await agentModeController.generateSharedResponse(req(), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(refusal);
    expect(checkTokenUsage).not.toHaveBeenCalled();
    expect(generateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
    expect(chatbotDb.addMessageToSession).not.toHaveBeenCalled();
  });
});
