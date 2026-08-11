import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { skillService } from '../services/skillService';
import { agentModeService } from '../services/agentModeService';
import { getUserFromToken } from '../middleware/auth';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    addAssociatedSkills: jest.fn().mockResolvedValue(undefined),
    updateSessionLlmModel: jest.fn().mockResolvedValue({}),
    addMessageToSession: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getSkill: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('claude-sonnet-4-20250514'),
    applyOpeningAction: jest.fn(),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../middleware/auth', () => ({
  getUserFromToken: jest.fn(),
  authenticateToken: jest.fn((req, res, next) => next()),
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-anon-uuid-712'),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockSkillService = skillService as jest.Mocked<typeof skillService>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockGetUserFromToken = getUserFromToken as jest.MockedFunction<typeof getUserFromToken>;

describe('AgentModeController - createSessionFromSkill (ENG-712)', () => {
  const mockSession = {
    sessionId: 'session-from-skill-1',
    userId: 'user-1',
    title: 'New Chat Session',
    messages: [],
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };

  const mockRequest = (skillId: string) =>
    ({
      params: { skillId },
      headers: {},
    } as unknown as Request);

  const mockResponse = () => {
    const res: Partial<Response> = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue('claude-sonnet-4-20250514');
    mockAgentModeService.applyOpeningAction.mockResolvedValue({ applied: false });
  });

  it('FAIL: returns 404 when the skill does not exist', async () => {
    mockSkillService.getSkill.mockResolvedValue(null);
    mockGetUserFromToken.mockResolvedValue({ user: null } as any);

    const req = mockRequest('missing-skill');
    const res = mockResponse();

    await agentModeController.createSessionFromSkill(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  it('FAIL: returns 403 for a private skill when the requester is not the owner', async () => {
    mockSkillService.getSkill.mockResolvedValue({
      skillId: 'private-skill',
      name: 'Private',
      description: 'd',
      toolNames: [],
      isPublished: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      visibility: 'private',
      ownerId: 'owner-1',
    } as any);
    mockGetUserFromToken.mockResolvedValue({ user: { userId: 'someone-else' } } as any);

    const req = mockRequest('private-skill');
    const res = mockResponse();

    await agentModeController.createSessionFromSkill(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
  });

  it('FAIL: happy path creates a session, installs the skill, applies the opening action, and returns a navigable deep link (AC6)', async () => {
    const skill = {
      skillId: 'reply-guy',
      name: 'Reply Guy',
      description: 'd',
      toolNames: ['find_reply_candidates'],
      isPublished: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      openingAction: { type: 'prefetch' as const, toolCalls: [{ toolName: 'find_reply_candidates' }] },
    };
    mockSkillService.getSkill.mockResolvedValue(skill as any);
    mockGetUserFromToken.mockResolvedValue({ user: { userId: 'user-1' } } as any);
    mockAgentModeService.applyOpeningAction.mockResolvedValue({ applied: true, degraded: false });

    const req = mockRequest('reply-guy');
    const res = mockResponse();

    await agentModeController.createSessionFromSkill(req, res);

    expect(mockChatbotDb.createChatSession).toHaveBeenCalled();
    expect(mockChatbotDb.addAssociatedSkills).toHaveBeenCalledWith(mockSession.sessionId, ['reply-guy']);
    expect(mockAgentModeService.applyOpeningAction).toHaveBeenCalledWith(skill, mockSession.sessionId, 'user-1');
    expect(res.status).toHaveBeenCalledWith(201);
    const jsonArg = (res.json as jest.Mock).mock.calls[0][0];
    expect(jsonArg.sessionId).toBe(mockSession.sessionId);
    expect(jsonArg.redirectUrl).toContain(mockSession.sessionId);
    expect(jsonArg.openingActionApplied).toBe(true);
  });

  it('SUCCESS: a skill with no openingAction still creates a usable session (no regression)', async () => {
    const skill = {
      skillId: 'plain-skill',
      name: 'Plain',
      description: 'd',
      toolNames: [],
      isPublished: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    mockSkillService.getSkill.mockResolvedValue(skill as any);
    mockGetUserFromToken.mockResolvedValue({ user: null } as any);
    mockAgentModeService.applyOpeningAction.mockResolvedValue({ applied: false });

    const req = mockRequest('plain-skill');
    const res = mockResponse();

    await agentModeController.createSessionFromSkill(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const jsonArg = (res.json as jest.Mock).mock.calls[0][0];
    expect(jsonArg.openingActionApplied).toBe(false);
  });
});
