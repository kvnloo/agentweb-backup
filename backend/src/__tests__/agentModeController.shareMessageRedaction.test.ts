/**
 * ENG-2645: share viewers never receive the system prompt, the model's private reasoning/usage keys, or
 * (anonymous view-only) account fields the share page does not render.
 */
import { Request, Response } from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: jest.fn(), updateSessionShareMetadata: jest.fn(), updateSessionInteractiveShareMetadata: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    getSupportedModels: jest.fn().mockResolvedValue(['gpt-5-chat-2']),
    resolveGenerationModel: jest.fn((m: string) => ({ model: m, fellBack: false, requestedModel: m })),
    getSkillsForDisplay: jest.fn().mockResolvedValue([{ skillId: 'secret-skill', name: 'n', description: 'd', installed: true, toolNames: [] }]),
  },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn().mockResolvedValue({ supportNote: 'secret-support-note' }) } }));
jest.mock('../services/llmUsagePolicyResolverService', () => ({ getEffectiveLlmUsagePolicy: jest.fn() }));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({ generateMarketingResponseWorkerService: { runInWorker: jest.fn() } }));
jest.mock('../services/tokenUsageService', () => ({ checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true }), incrementUserTokenUsage: jest.fn() }));
jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn() }, getLatestProgress: jest.fn(), requestCancel: jest.fn(), clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false), emitProgress: jest.fn(), hasActiveProgress: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/agentMode/workPlanStepModelsInstance', () => ({ workPlanStepModels: { isEnabled: jest.fn(), shouldHonor: jest.fn() } }));

import { chatbotDb } from '../services/chatbotService';
import { agentModeController, redactMessagesForShareViewer } from '../controllers/agentModeController';

const messages = [
  { role: 'system', content: 'You are EMMA, secret-system-prompt' },
  { role: 'user', content: 'hi', timestamp: 't1' },
  {
    role: 'assistant', content: 'hello', timestamp: 't2', metadata: { citations: [] },
    reasoning: 'secret-reasoning', reasoning_details: [{ text: 'secret-rd' }], usage: { total_tokens: 9 }, refusal: null, llm: 'secret-llm',
  },
];
const session = {
  sessionId: 's1', userId: 'owner', title: 't', messages, createdAt: 'x', updatedAt: 'x', llmModel: 'gpt-5-chat-2',
  shareMetadata: { isShared: true }, interactiveShareMetadata: { isActive: true, token: 'tok', createdAt: new Date().toISOString() },
  slackThread: { channel: 'secret-slack' }, pendingWorkPlanInput: { secret: 'secret-pending' },
};
const res = () => { const r: any = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r as Response; };
const call = async (query: Record<string, string>) => {
  const r = res();
  await agentModeController.getSharedConversation({ params: { shareId: 's1' }, query } as unknown as Request, r);
  expect(r.status as jest.Mock).toHaveBeenCalledWith(200);
  return (r.json as jest.Mock).mock.calls[0][0].session;
};

describe('ENG-2645 share response shape', () => {
  beforeEach(() => { (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session); });

  it('anonymous view-only share: no system row, no private message keys, no account fields', async () => {
    const out = await call({});
    expect(out.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(out.messages[1]).toEqual({ role: 'assistant', content: 'hello', timestamp: 't2', metadata: { citations: [] } });
    for (const k of ['supportNote', 'skills', 'slackThread', 'pendingWorkPlanInput']) expect(out).not.toHaveProperty(k);
    expect(JSON.stringify(out)).not.toMatch(/secret-/);
  });

  it('interactive share: still no system row or private keys; keeps the agent-mode UI fields', async () => {
    const out = await call({ conversable: 'tok' });
    expect(out.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(out.messages)).not.toMatch(/secret-/);
    expect(out.supportNote).toBe('secret-support-note');
    expect(out.skills).toHaveLength(1);
  });

  it('redaction works on a copy (stored messages unchanged)', () => {
    const snapshot = JSON.parse(JSON.stringify(messages));
    redactMessagesForShareViewer(messages);
    expect(messages).toEqual(snapshot);
  });
});
