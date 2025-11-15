import { Request, Response } from 'express';
import { createChatSession } from '../controllers/chatbot';
import { chatbotDb } from '../services/chatbotService';
import { AuthenticatedRequest } from '../middleware/auth';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
  }
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;

describe('Chatbot - createChatSession', () => {
  const mockUserId = 'test-user-123';
  const mockSession = {
    sessionId: 'test-session-123',
    userId: mockUserId,
    title: 'New Chat Session',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    portalType: 'partner' as const,
    sessionType: 'regular' as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
  });

  it('should create session with sessionType "regular" for partner portal', async () => {
    const mockReq = {
      user: { userId: mockUserId },
      body: {
        pageContext: 'some context',
        pageIdentifier: 'some-page'
      },
      query: {
        portal: 'partner'
      }
    } as unknown as AuthenticatedRequest;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await createChatSession(mockReq, mockRes);

    expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
      mockUserId,
      'some context',
      'partner',
      'some-page',
      undefined,
      undefined,
      undefined,
      undefined,
      'regular'
    );
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(mockSession);
  });

  it('should create session with sessionType "regular" for customer portal', async () => {
    const mockSessionCustomer = {
      ...mockSession,
      portalType: 'customer' as const,
    };
    mockChatbotDb.createChatSession.mockResolvedValue(mockSessionCustomer as any);

    const mockReq = {
      user: { userId: mockUserId },
      body: {
        pageContext: 'some context',
        pageIdentifier: 'some-page'
      },
      query: {
        portal: 'customer'
      }
    } as unknown as AuthenticatedRequest;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await createChatSession(mockReq, mockRes);

    expect(mockChatbotDb.createChatSession).toHaveBeenCalledWith(
      mockUserId,
      'some context',
      'customer',
      'some-page',
      undefined,
      undefined,
      undefined,
      undefined,
      'regular'
    );
    expect(mockRes.status).toHaveBeenCalledWith(201);
    expect(mockRes.json).toHaveBeenCalledWith(mockSessionCustomer);
  });

  it('should return 401 when user is not authenticated', async () => {
    const mockReq = {
      user: undefined,
      body: {},
      query: {}
    } as unknown as AuthenticatedRequest;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await createChatSession(mockReq, mockRes);

    expect(mockChatbotDb.createChatSession).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'User not authenticated' });
  });

  it('should handle errors gracefully', async () => {
    mockChatbotDb.createChatSession.mockRejectedValue(new Error('Database error'));

    const mockReq = {
      user: { userId: mockUserId },
      body: {},
      query: {}
    } as unknown as AuthenticatedRequest;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await createChatSession(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Failed to create chat session' });
  });
});

