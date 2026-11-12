import { Request, Response } from 'express';

// Voice mode restore. The chat's voice button switches the chat to the live-voice model and back. Since 2026-10-07 the
// text picker never lists that model and both model-switch routes refused it (it is not a text pick), so the button did
// nothing. Voice mode is not a text pick: the routes must accept the live-voice model the server serves, judged on its
// own gates (internal/adminOnly for the session OWNER), while every text model keeps the picker's checks and the
// plan check exactly as before.

const LIVE = 'gemini-3.1-flash-live-preview';
const TEXT_IN_PLAN = 'gemini-3.8-flash';
const TEXT_OUTSIDE_PLAN = 'anthropic.claude-opus-5';
const REGISTRY = [LIVE, TEXT_IN_PLAN, TEXT_OUTSIDE_PLAN];

// Mutable per test: which live model the service serves to non-admins and to admins.
let voiceForUser: string | null = LIVE;
let voiceForAdmin: string | null = LIVE;

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    resolveGenerationModel: jest.fn((model: string) =>
      REGISTRY.includes(model) ? { model, fellBack: false, requestedModel: model } : { model: 'x', fellBack: true, requestedModel: model }),
    // The real gate refuses live models for the text picker.
    isModelSelectableBy: jest.fn((modelId: string) => REGISTRY.includes(modelId) && modelId !== LIVE),
    isLiveModel: jest.fn((modelId: string) => modelId === LIVE),
    getVoiceModelFor: jest.fn((isAdmin: boolean) => (isAdmin ? voiceForAdmin : voiceForUser)),
    isVoiceModelSelectableBy: jest.fn((modelId: string, isAdmin: boolean) => !!modelId && (isAdmin ? voiceForAdmin : voiceForUser) === modelId),
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

const mockIsEnabled = jest.fn();
const mockAssertInPlan = jest.fn();
jest.mock('../services/agentMode/modelAccessInstance', () => ({
  ...jest.requireActual('../services/agentMode/modelAccessInstance'),
  modelAccess: { ...jest.requireActual('../services/agentMode/modelAccessInstance').modelAccess, isEnabled: (...a: unknown[]) => mockIsEnabled(...a) },
  assertModelInOwnerPlan: (...a: unknown[]) => mockAssertInPlan(...a),
}));

import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { ModelUnavailableError } from '../services/agentMode/modelUnavailable';
import { AgentModeService } from '../services/agentModeService';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response & { json: jest.Mock; status: jest.Mock });

const ownerId = 'owner-1';
const sessionId = 'session-1';
const ownerPatch = (llmModel: string, user: any = { userId: ownerId, isAdmin: false }) =>
  ({ params: { sessionId }, body: { llmModel }, user } as unknown as Request);
const sharePatch = (llmModel: string) =>
  ({ params: { shareId: sessionId }, query: { conversable: 'token-1' }, body: { llmModel } } as unknown as Request);

beforeEach(() => {
  jest.clearAllMocks();
  voiceForUser = LIVE;
  voiceForAdmin = LIVE;
  mockChatbotDb.getChatSession.mockResolvedValue({
    sessionId, userId: ownerId, interactiveShareMetadata: { isActive: true, token: 'token-1', createdAt: new Date() },
  } as any);
  mockChatbotDb.updateSessionLlmModel.mockImplementation(async (_id: string, llmModel: string) => ({ sessionId, llmModel } as any));
  // The plan allows only TEXT_IN_PLAN; anything else is a plan refusal, as in production with the allowlist on.
  mockAssertInPlan.mockImplementation(async ({ model }: { model: string }) => {
    if (model !== TEXT_IN_PLAN) throw new ModelUnavailableError(model, 'not_in_plan' as any);
  });
});

describe('updateSessionLlmModel: voice mode switch', () => {
  it.each([true, false])('accepts the live-voice model for the owner (plan allowlist on: %s) and skips the text plan check', async (allowlistOn) => {
    mockIsEnabled.mockResolvedValue(allowlistOn);
    const res = makeRes();
    await agentModeController.updateSessionLlmModel(ownerPatch(LIVE) as any, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ llmModel: LIVE });
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith(sessionId, LIVE, undefined, expect.anything());
    expect(mockAssertInPlan).not.toHaveBeenCalled();
  });

  it('refuses the live-voice model when the server does not serve it to this owner (e.g. admin-only voice, non-admin owner)', async () => {
    mockIsEnabled.mockResolvedValue(true);
    voiceForUser = null;
    const res = makeRes();
    await agentModeController.updateSessionLlmModel(ownerPatch(LIVE) as any, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('judges the voice model for the session OWNER, not an admin caller acting on it', async () => {
    mockIsEnabled.mockResolvedValue(false);
    voiceForUser = null; // owner is not served voice
    mockChatbotDb.getChatSession.mockResolvedValue({ sessionId, userId: 'someone-else' } as any);
    const res = makeRes();
    // An admin acting on another user's session: the owner (looked up, non-admin by default) decides.
    await agentModeController.updateSessionLlmModel(ownerPatch(LIVE, { userId: 'admin-1', isAdmin: true }) as any, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('leaves text models exactly as before: a model outside the plan is still a 422 with the allowlist on', async () => {
    mockIsEnabled.mockResolvedValue(true);
    const res = makeRes();
    await agentModeController.updateSessionLlmModel(ownerPatch(TEXT_OUTSIDE_PLAN) as any, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(mockAssertInPlan).toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('leaves text models exactly as before: a model in the plan is stored', async () => {
    mockIsEnabled.mockResolvedValue(true);
    const res = makeRes();
    await agentModeController.updateSessionLlmModel(ownerPatch(TEXT_IN_PLAN) as any, res);
    expect(res.json).toHaveBeenCalledWith({ llmModel: TEXT_IN_PLAN });
  });
});

describe('updateSharedSessionLlmModel: voice mode on a share link', () => {
  it('accepts the live-voice model and skips the plan check', async () => {
    const res = makeRes();
    await agentModeController.updateSharedSessionLlmModel(sharePatch(LIVE), res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ llmModel: LIVE });
    expect(mockAssertInPlan).not.toHaveBeenCalled();
  });

  it('refuses the live-voice model when it is not served to non-admins (viewers are non-admin)', async () => {
    voiceForUser = null;
    const res = makeRes();
    await agentModeController.updateSharedSessionLlmModel(sharePatch(LIVE), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('still checks the owner plan for a text model', async () => {
    const res = makeRes();
    await agentModeController.updateSharedSessionLlmModel(sharePatch(TEXT_OUTSIDE_PLAN), res);
    expect(mockAssertInPlan).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('still needs a valid share token for the voice model', async () => {
    const res = makeRes();
    await agentModeController.updateSharedSessionLlmModel(
      { params: { shareId: sessionId }, query: { conversable: 'wrong' }, body: { llmModel: LIVE } } as unknown as Request, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });
});

describe('getPublicVoiceModel', () => {
  it('answers the served voice model for an anonymous caller', async () => {
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

describe('AgentModeService.getVoiceModelFor / isVoiceModelSelectableBy (real methods)', () => {
  const real = jest.requireActual('../services/agentModeService').AgentModeService.prototype as InstanceType<typeof AgentModeService>;
  const withRegistry = (llmModels: Record<string, any>) => ({ llmModels, getVoiceModelFor: real.getVoiceModelFor });

  it('returns the live registry model, and only a live one', () => {
    const svc = withRegistry({ 'text-a': {}, [LIVE]: { isLive: true } });
    expect(real.getVoiceModelFor.call(svc, false)).toBe(LIVE);
    expect(real.isVoiceModelSelectableBy.call(svc, LIVE, false)).toBe(true);
    expect(real.isVoiceModelSelectableBy.call(svc, 'text-a', false)).toBe(false);
    expect(real.isVoiceModelSelectableBy.call(svc, '', false)).toBe(false);
  });

  it('applies the same internal-only and admin-only gates as the picker', () => {
    expect(real.getVoiceModelFor.call(withRegistry({ [LIVE]: { isLive: true, internalOnly: true } }), true)).toBeNull();
    const adminOnly = withRegistry({ [LIVE]: { isLive: true, adminOnly: true } });
    expect(real.getVoiceModelFor.call(adminOnly, false)).toBeNull();
    expect(real.getVoiceModelFor.call(adminOnly, true)).toBe(LIVE);
  });

  it('returns null when the registry has no live model', () => {
    expect(real.getVoiceModelFor.call(withRegistry({ 'text-a': {} }), true)).toBeNull();
  });
});
