import { Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { AuthenticatedRequest, authenticateToken } from '../middleware/auth';
import agentModeRouter from '../routes/agentMode';
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(), addAssociatedSkills: jest.fn().mockResolvedValue(undefined),
    updateSessionLlmModel: jest.fn().mockResolvedValue({}), addMessageToSession: jest.fn().mockResolvedValue({}),
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
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res); res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};
const request = (skillId: string, body: Record<string, unknown> = {}): AuthenticatedRequest => ({
  params: { skillId }, user: { userId: 'user-1', email: 'user@example.com' },
  body,
} as unknown as AuthenticatedRequest);
const skill = {
  skillId: 'skill-1', name: 'Static brief', description: 'd', toolNames: [], isPublished: true,
  createdAt: '2026-01-01', updatedAt: '2026-01-01', welcomeMessage: 'Bring the artifact and the context.',
};
describe('createSessionFromSkill authenticated static brief', () => {
  it('exposes no public skill-session route and mounts the replacement behind authentication', () => {
    const layers = (agentModeRouter as any).stack as any[];
    const authIndex = layers.findIndex(layer => layer.handle === authenticateToken);
    const routeIndex = layers.findIndex(layer => layer.route?.path === '/skill/:skillId/session');
    expect(layers.some(layer => layer.route?.path === '/public/skill/:skillId/session')).toBe(false);
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(routeIndex).toBeGreaterThan(authIndex);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    (agent.getAuthorizedSkill as jest.Mock).mockResolvedValue(skill);
    db.createChatSession.mockResolvedValue({ sessionId: 'session-1', userId: 'user-1' } as any);
  });
  it.each([
    'cross-org private skill',
    'same-org private skill with sharing disabled',
  ])('fails closed with 404 before writes for an inaccessible %s', async () => {
    (agent.getAuthorizedSkill as jest.Mock).mockResolvedValue(undefined);
    const res = response();
    await agentModeController.createSession(request('skill-1'), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(agent.getAuthorizedSkill).toHaveBeenCalledWith('skill-1', 'user-1');
    expect(db.createChatSession).not.toHaveBeenCalled();
    expect(db.addMessageToSession).not.toHaveBeenCalled();
  });
  it('persists the full authorized snapshot in one session Put', async () => {
    const res = response(); await agentModeController.createSession(request('skill-1'), res);
    expect(db.createChatSession).toHaveBeenCalledWith(
      'user-1', undefined, 'agent', 'skill-skill-1', undefined, undefined, undefined, undefined, 'regular', undefined,
      expect.objectContaining({ llmModel: 'gpt-5-chat', associatedSkills: ['skill-1'], messages: [expect.objectContaining({ role: 'assistant', content: skill.welcomeMessage })] })
    );
    expect(agent.getSkillsForDisplay).not.toHaveBeenCalled(); expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(db.addAssociatedSkills).not.toHaveBeenCalled(); expect(db.addMessageToSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });
  it('returns 500 without rollback when the all-or-nothing session Put fails', async () => {
    db.createChatSession.mockRejectedValueOnce(new Error('write failed'));
    const res = response(); await agentModeController.createSession(request('skill-1'), res);
    expect(db.deleteSession).not.toHaveBeenCalled(); expect(db.addMessageToSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
  it.each([
    '<script>alert(1)</script>',
    '<iframe src="https://evil.test"></iframe>',
    '<form action="https://evil.test"><input></form>',
    '<img src=x onerror="alert(1)">',
    'hello\u0000world',
    null,
  ])('rejects unsafe persisted welcomeMessage before any write: %s', async (welcomeMessage) => {
    (agent.getAuthorizedSkill as jest.Mock).mockResolvedValue({ ...skill, welcomeMessage });
    const res = response();
    await agentModeController.createSession(request('skill-1'), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.createChatSession).not.toHaveBeenCalled();
    expect(db.addMessageToSession).not.toHaveBeenCalled();
  });
  it('never executes a tool, opening-action dispatcher, or LLM for the static slice', async () => {
    await agentModeController.createSession(request('skill-1'), response());
    expect(agent.applyOpeningAction).not.toHaveBeenCalled();
    expect(agent.executeTool).not.toHaveBeenCalled();
  });
  it.each([
    { portalType: 'emma-sidebar' },
    { sessionType: 'scheduled' },
    { sessionType: 'report_generation', portalType: 'emma-sidebar' },
  ])('ignores hostile session classification overrides: %j', async (body) => {
    await agentModeController.createSession(request('skill-1', body), response());
    expect(db.createChatSession).toHaveBeenCalledWith(
      'user-1', undefined, 'agent', 'skill-skill-1', undefined, undefined, undefined, undefined, 'regular', undefined, expect.any(Object)
    );
    expect(agent.getReportsModel).not.toHaveBeenCalled();
    expect(agent.getCustomerSupportDefaultModel).not.toHaveBeenCalled();
    expect(agent.getDefaultModel).toHaveBeenCalled();
  });
  it('keeps an authorized skill without a welcome message usable', async () => {
    (agent.getAuthorizedSkill as jest.Mock).mockResolvedValue({ ...skill, welcomeMessage: undefined });
    const res = response();
    await agentModeController.createSession(request('skill-1'), res);
    expect(db.createChatSession.mock.calls[0][10]).toEqual(expect.objectContaining({ messages: [] }));
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
