/**
 * ENG-2378 round 2: share / conversable views are not the owner: they never carry step models or the engine's
 * internal bookkeeping (launchModel, planDefaultModel, engineModel).
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
    getSkillsForDisplay: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../services/llmUsagePolicyResolverService', () => ({ getEffectiveLlmUsagePolicy: jest.fn() }));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({ generateMarketingResponseWorkerService: { runInWorker: jest.fn() } }));
jest.mock('../services/tokenUsageService', () => ({ checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true }), incrementUserTokenUsage: jest.fn() }));
jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn() }, getLatestProgress: jest.fn(), requestCancel: jest.fn(), clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false), emitProgress: jest.fn(), hasActiveProgress: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/agentMode/workPlanStepModelsInstance', () => ({ workPlanStepModels: { isEnabled: jest.fn(), shouldHonor: jest.fn() } }));

import { chatbotDb } from '../services/chatbotService';
import { agentModeController } from '../controllers/agentModeController';

const plan = {
  title: 'P',
  planDefaultModel: 'secret-default', launchModel: 'secret-launch', engineModel: 'secret-engine', pickedModel: 'secret-picked',
  steps: [{ stepCount: 1, title: 'A', status: 'pending', model: 'secret-step-model', description: 'd' }],
};
const session = {
  sessionId: 's1', userId: 'owner', title: 't', messages: [], createdAt: 'x', updatedAt: 'x', llmModel: 'gpt-5-chat-2',
  shareMetadata: { isShared: true }, interactiveShareMetadata: { isActive: true, token: 'tok' }, workPlan: plan,
};
const res = () => { const r: any = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r as Response; };

describe('share / conversable views redact step models and bookkeeping', () => {
  beforeEach(() => { jest.clearAllMocks(); (chatbotDb.getChatSession as jest.Mock).mockResolvedValue(session); });
  const expectRedacted = (payload: any) => {
    expect(JSON.stringify(payload)).not.toMatch(/secret-|launchModel|planDefaultModel|engineModel|pickedModel/);
    expect(payload.workPlan.steps[0]).toMatchObject({ stepCount: 1, title: 'A', status: 'pending', description: 'd' });
  };

  it('view-only share (getSharedConversation)', async () => {
    const r = res();
    await agentModeController.getSharedConversation({ params: { shareId: 's1' }, query: {} } as unknown as Request, r);
    expect((r.status as jest.Mock)).toHaveBeenCalledWith(200);
    expectRedacted((r.json as jest.Mock).mock.calls[0][0].session);
  });

  it('conversable session (getConversableSession)', async () => {
    const r = res();
    await agentModeController.getConversableSession({ params: { sessionId: 's1' }, conversableSession: session } as unknown as Request, r);
    expectRedacted((r.json as jest.Mock).mock.calls[0][0]);
  });

  it('D6: redaction works on a copy: the stored plan deep-equals its snapshot after every redacting response', async () => {
    const snapshot = JSON.parse(JSON.stringify(session.workPlan));
    await agentModeController.getConversableSession({ params: { sessionId: 's1' }, conversableSession: session } as unknown as Request, res());
    expect(session.workPlan).toEqual(snapshot);
    await agentModeController.getSharedConversation({ params: { shareId: 's1' }, query: {} } as unknown as Request, res());
    expect(session.workPlan).toEqual(snapshot);
  });
});
