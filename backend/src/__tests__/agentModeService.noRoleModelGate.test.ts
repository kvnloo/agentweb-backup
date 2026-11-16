/**
 * ENG-2028: the only role gate on model selection is the registry's
 * adminOnly/internalOnly flags. No model-name (Opus) check anywhere.
 */
import { Request, Response } from 'express';
import { AgentModeService, agentModeService } from '../services/agentModeService';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
  },
}));

const mockDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const OPUS_IDS = [
  'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-5',
  'anthropic.claude-opus-4-6-v1',
];
const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response);
const patch = (llmModel: string, user: any = { userId: 'u1', isAdmin: false }) =>
  ({ params: { sessionId: 's1' }, body: { llmModel }, user } as unknown as Request);

describe('ENG-2028 isModelSelectableBy', () => {
  const svc: any = agentModeService;
  const anyInternal = Object.keys(svc.llmModels).find(m => svc.llmModels[m].internalOnly);
  const anyLive = Object.keys(svc.llmModels).find(m => svc.llmModels[m].isLive);

  it.each(OPUS_IDS)('allows %s for non-admins and admins', id => {
    expect(svc.isModelSelectableBy(id, false)).toBe(true);
    expect(svc.isModelSelectableBy(id, true)).toBe(true);
  });
  it('refuses unknown, internalOnly and live ids for everyone', () => {
    expect(svc.isModelSelectableBy('nope', true)).toBe(false);
    if (anyInternal) { expect(svc.isModelSelectableBy(anyInternal, true)).toBe(false); expect(svc.isModelSelectableBy(anyInternal, false)).toBe(false); }
    // The registry always carries a live voice model; fail loudly instead of silently skipping if that changes.
    expect(anyLive).toBeDefined();
    expect(svc.isModelSelectableBy(anyLive as string, true)).toBe(false);
    expect(svc.isModelSelectableBy(anyLive as string, false)).toBe(false);
  });
  it('honours a synthetic adminOnly flag: refused for non-admin, allowed for admin', () => {
    const s: any = new AgentModeService();
    s.llmModels['synthetic-admin-only'] = { ...s.llmModels['anthropic.claude-opus-5'], adminOnly: true };
    expect(s.isModelSelectableBy('synthetic-admin-only', false)).toBe(false);
    expect(s.isModelSelectableBy('synthetic-admin-only', true)).toBe(true);
  });
  it('getReportsModelOptions(false) includes the opus anthropic models', async () => {
    const opts = await agentModeService.getReportsModelOptions(false);
    for (const id of ['anthropic.claude-opus-4-8', 'anthropic.claude-opus-5']) expect(opts).toContain(id);
  });
});

describe('ENG-2028 PATCH llm-model for non-admins (real registry)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.getChatSession.mockResolvedValue({
      sessionId: 's1', userId: 'u1',
      interactiveShareMetadata: { isActive: true, token: 'tok', sharedAt: new Date().toISOString() },
    } as any);
    mockDb.updateSessionLlmModel.mockImplementation(async (_i: string, m: string) => ({ llmModel: m } as any));
  });

  it.each([...OPUS_IDS, 'openrouter/anthropic/claude-opus-5.5'])('authenticated PATCH %s stores canonical id', async id => {
    const res = makeRes();
    await agentModeController.updateSessionLlmModel(patch(id) as any, res);
    expect(res.status).not.toHaveBeenCalled();
    const canonical = agentModeService.resolveGenerationModel(id).model;
    expect(mockDb.updateSessionLlmModel).toHaveBeenCalledWith('s1', canonical, undefined, 'user');
  });

  it.each([...OPUS_IDS, 'openrouter/anthropic/claude-opus-5.5'])('shared PATCH %s stores canonical id', async id => {
    const res = makeRes();
    await agentModeController.updateSharedSessionLlmModel(
      { params: { shareId: 's1' }, query: { conversable: 'tok' }, body: { llmModel: id } } as unknown as Request, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(mockDb.updateSessionLlmModel).toHaveBeenCalledWith('s1', agentModeService.resolveGenerationModel(id).model, undefined, 'user');
  });

  it('unknown id keeps the existing 400 on both handlers', async () => {
    const a = makeRes();
    await agentModeController.updateSessionLlmModel(patch('claude-sonnet-4-5') as any, a);
    expect(a.status).toHaveBeenCalledWith(400);
    const b = makeRes();
    await agentModeController.updateSharedSessionLlmModel(
      { params: { shareId: 's1' }, query: { conversable: 'tok' }, body: { llmModel: 'claude-sonnet-4-5' } } as unknown as Request, b);
    expect(b.status).toHaveBeenCalledWith(400);
    expect(mockDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('a non-selectable (live) id that resolves is refused with 403 on both handlers', async () => {
    const live = Object.keys((agentModeService as any).llmModels).find(m => (agentModeService as any).llmModels[m].isLive);
    expect(live).toBeDefined(); // the registry always carries a live voice model
    expect(agentModeService.resolveGenerationModel(live as string).fellBack).toBe(false);
    const a = makeRes();
    await agentModeController.updateSessionLlmModel(patch(live as string) as any, a);
    expect(a.status).toHaveBeenCalledWith(403);
    expect(mockDb.updateSessionLlmModel).not.toHaveBeenCalled();
  });
});
