import { Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { AuthenticatedRequest } from '../middleware/auth';
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(), addAssociatedSkills: jest.fn().mockResolvedValue(undefined),
    updateSessionLlmModel: jest.fn().mockResolvedValue({}), addMessageToSession: jest.fn().mockResolvedValue({}), addMessagesToSession: jest.fn().mockResolvedValue({}),
    deleteSession: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../services/skillService', () => ({ skillService: { getSkill: jest.fn() } }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat'),
    getReportsModel: jest.fn(), getCustomerSupportDefaultModel: jest.fn(), getSkillsForDisplay: jest.fn(), getAuthorizedSkill: jest.fn(),
    applyOpeningAction: jest.fn(), executeTool: jest.fn(),
  },
  AgentModeService: jest.fn(),
}));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({ generateMarketingResponseWorkerService: {} }));
const db = chatbotDb as jest.Mocked<typeof chatbotDb>;
const agent = agentModeService as jest.Mocked<typeof agentModeService> & {
  applyOpeningAction: jest.Mock; executeTool: jest.Mock;
};
const response = () => {
  const res: any = {}; res.status = jest.fn().mockReturnValue(res); res.json = jest.fn().mockReturnValue(res); return res as Response;
};
const request = (skillId: string, body: Record<string, unknown> = {}): AuthenticatedRequest => ({
  params: { skillId }, user: { userId: 'user-1', email: 'user@example.com' },
  body,
} as unknown as AuthenticatedRequest);
const PREFETCH_SKILL = {
  skillId: 'skill-prefetch', name: 'Reply guy', description: 'd', toolNames: ['search_posts'], isPublished: true,
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
  openingAction: {
    type: 'prefetch',
    calls: [{ tool: 'search_posts', args: { query: 'agent startups' } }],
    maxCalls: 3, timeoutMs: 15000, maxChars: 4000,
  },
};
describe('createSessionFromSkill opening-action prefetch (ENG-1107)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (agent.getAuthorizedSkill as jest.Mock).mockResolvedValue(PREFETCH_SKILL);
    db.createChatSession.mockResolvedValue({ sessionId: 'session-1', userId: 'user-1' } as any);
  });
  it('fails closed with 404 before writes for an unauthorized skill', async () => {
    (agent.getAuthorizedSkill as jest.Mock).mockResolvedValue(undefined);
    const res = response();
    await agentModeController.createSession(request('skill-prefetch'), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(agent.applyOpeningAction).not.toHaveBeenCalled();
    expect(db.createChatSession).not.toHaveBeenCalled();
  });
  it('renders successful prefetch results as the first assistant turn before user input', async () => {
    (agent.applyOpeningAction as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Holding 2 candidates: …', metadata: { kind: 'skill-prefetch' } }],
    });
    const res = response();
    await agentModeController.createSession(request('skill-prefetch'), res);
    expect(agent.applyOpeningAction).toHaveBeenCalledWith(PREFETCH_SKILL, 'user-1', 'session-1');
    expect(db.addMessagesToSession).toHaveBeenCalledWith('session-1', expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: 'Holding 2 candidates: …' })]));
    expect(res.status).toHaveBeenCalledWith(201);
  });
  it('degrades loudly on prefetch failure: plain failure statement, session usable, no fabrication', async () => {
    (agent.applyOpeningAction as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'I could not fetch the opening material (search_posts failed). Tell me what to work on and we will start from there.', metadata: { kind: 'skill-prefetch-failed' } }],
    });
    const res = response();
    await agentModeController.createSession(request('skill-prefetch'), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(db.addMessagesToSession).toHaveBeenCalledWith('session-1', expect.arrayContaining([expect.objectContaining({ content: expect.stringMatching(/could not fetch/i) })]));
  });
  it('rejects an unsafe persisted openingAction before any write', async () => {
    (agent.getAuthorizedSkill as jest.Mock).mockResolvedValue({
      ...PREFETCH_SKILL,
      openingAction: { type: 'prefetch', calls: [{ tool: 'admin_wipe' }] },
    });
    const res = response();
    await agentModeController.createSession(request('skill-prefetch'), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.createChatSession).not.toHaveBeenCalled();
    expect(agent.applyOpeningAction).not.toHaveBeenCalled();
  });
  it('folds welcomeMessage into the prefetch first turn instead of preceding it', async () => {
    (agent.getAuthorizedSkill as jest.Mock).mockResolvedValue({ ...PREFETCH_SKILL, welcomeMessage: 'Welcome aboard.' });
    (agent.applyOpeningAction as jest.Mock).mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Holding 2 candidates: …', metadata: { kind: 'skill-prefetch' } }],
    });
    const res = response();
    await agentModeController.createSession(request('skill-prefetch'), res);
    expect(res.status).toHaveBeenCalledWith(201);
    // No standalone welcome seed: initial state carries no messages...
    expect(db.createChatSession).toHaveBeenCalled();
    const stateArg = db.createChatSession.mock.calls[0][9] as any;
    expect(stateArg?.messages ?? []).toEqual([]);
    // ...and the first persisted turn carries welcome + prefetch together.
    expect(db.addMessagesToSession).toHaveBeenCalledWith('session-1', expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: 'Welcome aboard.\n\nHolding 2 candidates: …' }),
    ]));
  });
  it('costs nothing for containers without an openingAction: dispatcher never invoked', async () => {
    (agent.getAuthorizedSkill as jest.Mock).mockResolvedValue({ ...PREFETCH_SKILL, openingAction: undefined });
    await agentModeController.createSession(request('skill-prefetch'), response());
    expect(agent.applyOpeningAction).not.toHaveBeenCalled();
    expect(agent.executeTool).not.toHaveBeenCalled();
  });
});
