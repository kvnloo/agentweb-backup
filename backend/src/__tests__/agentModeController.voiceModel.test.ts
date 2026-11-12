import { Request, Response } from 'express';

// ENG-2957: the chat's voice button. Voice mode is a CLIENT-SIDE mode: the portal enters it without changing the chat's
// stored model, because a stored live-voice model breaks text paths later (share-link plan checks, Slack and email
// replies, work plans). So:
//  - GET /public/voice-model tells the portal which live-voice model is served (null = no voice button);
//  - both model-switch routes keep refusing the live-voice model, exactly as they have since 2026-10-07.

const LIVE = 'gemini-3.1-flash-live-preview';
const TEXT = 'gemini-3.8-flash';
const REGISTRY = [LIVE, TEXT];

let voiceForUser: string | null = LIVE;
let voiceForAdmin: string | null = LIVE;

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    resolveGenerationModel: jest.fn((model: string) =>
      REGISTRY.includes(model) ? { model, fellBack: false, requestedModel: model } : { model: 'x', fellBack: true, requestedModel: model }),
    // The real gate refuses live models as a text pick.
    isModelSelectableBy: jest.fn((modelId: string) => REGISTRY.includes(modelId) && modelId !== LIVE),
    isLiveModel: jest.fn((modelId: string) => modelId === LIVE),
    getVoiceModelFor: jest.fn((isAdmin: boolean) => (isAdmin ? voiceForAdmin : voiceForUser)),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
  },
}));

jest.mock('../services/agentMode/modelAccessInstance', () => ({
  ...jest.requireActual('../services/agentMode/modelAccessInstance'),
  modelAccess: { ...jest.requireActual('../services/agentMode/modelAccessInstance').modelAccess, isEnabled: jest.fn(async () => false) },
}));

import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { AgentModeService } from '../services/agentModeService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response & { json: jest.Mock; status: jest.Mock });

beforeEach(() => {
  jest.clearAllMocks();
  voiceForUser = LIVE;
  voiceForAdmin = LIVE;
  mockChatbotDb.getChatSession.mockResolvedValue({
    sessionId: 's1', userId: 'owner-1', interactiveShareMetadata: { isActive: true, token: 'token-1', createdAt: new Date() },
  } as any);
  mockChatbotDb.updateSessionLlmModel.mockImplementation(async (_id: string, llmModel: string) => ({ sessionId: 's1', llmModel } as any));
});

describe('GET /public/voice-model', () => {
  it('answers the served voice model for an anonymous caller (share pages)', async () => {
    const res = makeRes();
    await agentModeController.getPublicVoiceModel({ headers: {} } as unknown as Request, res);
    expect(res.json).toHaveBeenCalledWith({ voiceModel: LIVE });
  });

  it('answers null when no voice model is served', async () => {
    voiceForUser = null;
    const res = makeRes();
    await agentModeController.getPublicVoiceModel({ headers: {} } as unknown as Request, res);
    expect(res.json).toHaveBeenCalledWith({ voiceModel: null });
  });
});

describe('voice mode never changes the stored model: the switch routes still refuse the live-voice model', () => {
  it('owner route', async () => {
    const res = makeRes();
    await agentModeController.updateSessionLlmModel(
      { params: { sessionId: 's1' }, body: { llmModel: LIVE }, user: { userId: 'owner-1', isAdmin: false } } as any, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('share route', async () => {
    const res = makeRes();
    await agentModeController.updateSharedSessionLlmModel(
      { params: { shareId: 's1' }, query: { conversable: 'token-1' }, body: { llmModel: LIVE } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('a text model is still stored (unchanged)', async () => {
    const res = makeRes();
    await agentModeController.updateSessionLlmModel(
      { params: { sessionId: 's1' }, body: { llmModel: TEXT }, user: { userId: 'owner-1', isAdmin: false } } as any, res);
    expect(res.json).toHaveBeenCalledWith({ llmModel: TEXT });
  });
});

describe('AgentModeService.getVoiceModelFor (real method)', () => {
  const real = jest.requireActual('../services/agentModeService').AgentModeService.prototype as InstanceType<typeof AgentModeService>;
  const svc = (llmModels: Record<string, any>) => ({ llmModels });

  it('returns the live registry model, and only a live one', () => {
    expect(real.getVoiceModelFor.call(svc({ 'text-a': {}, [LIVE]: { isLive: true } }), false)).toBe(LIVE);
    expect(real.getVoiceModelFor.call(svc({ 'text-a': {} }), true)).toBeNull();
  });

  it('applies the same internal-only and admin-only gates as the picker', () => {
    expect(real.getVoiceModelFor.call(svc({ [LIVE]: { isLive: true, internalOnly: true } }), true)).toBeNull();
    const adminOnly = svc({ [LIVE]: { isLive: true, adminOnly: true } });
    expect(real.getVoiceModelFor.call(adminOnly, false)).toBeNull();
    expect(real.getVoiceModelFor.call(adminOnly, true)).toBe(LIVE);
  });
});
