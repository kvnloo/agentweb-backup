import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';
import { chatbotDb } from '../services/chatbotService';
import { ChatSession } from '../services/chatbotService';

// Mock the dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getAllSessions: jest.fn(),
    getChatSession: jest.fn(),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-admin', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (req: any, res: any, next: any) => {
    next();
  },
}));

// Mock other dependencies that might be imported
jest.mock('../services/db', () => ({}));
jest.mock('../services/waitlistDb', () => ({}));
jest.mock('../services/emailService', () => ({}));
jest.mock('../services/workflowDb', () => ({}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('Admin Agent Mode Analytics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockGetChatSession = (sessions: ChatSession[]) => {
    mockChatbotDb.getChatSession.mockImplementation(async (sessionId: string) => {
      return sessions.find((session) => session.sessionId === sessionId);
    });
  };

  const createMockSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
    sessionId: 'session-1',
    userId: 'user-1',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    portalType: 'agent',
    archived: false,
    sessionType: 'regular',
    ...overrides,
  });

  it('should return Agent Mode analytics with all metrics', async () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const mockSessions: ChatSession[] = [
      createMockSession({
        sessionId: 'session-1',
        userId: 'user-1',
        createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        sessionType: 'regular',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
        calledFunctions: { generate_image: 2 },
      }),
      createMockSession({
        sessionId: 'session-2',
        userId: 'user-2',
        createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        sessionType: 'scheduled',
        messages: [
          { role: 'user', content: 'Test' },
        ],
        calledFunctions: { search_web: 1 },
      }),
      createMockSession({
        sessionId: 'session-3',
        userId: 'anon_123',
        createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        sessionType: 'video-generation',
        messages: [
          { role: 'user', content: 'Generate video' },
          { role: 'assistant', content: 'Video generated' },
        ],
        workPlan: {
          title: 'Test Plan',
          steps: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        shareMetadata: { isShared: true },
        calledFunctions: { generate_video: 1 },
      }),
      createMockSession({
        sessionId: 'session-4',
        userId: 'user-1',
        createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        sessionType: 'image-generation',
        messages: [
          { role: 'user', content: 'Generate image' },
        ],
      }),
    ];

    mockChatbotDb.getAllSessions.mockResolvedValue(mockSessions);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .query({ startDate, endDate })
      .expect(200);

    expect(response.body).toHaveProperty('totalSessions', 4);
    expect(response.body).toHaveProperty('newSessions');
    expect(response.body).toHaveProperty('totalScheduledSessions', 1);
    expect(response.body).toHaveProperty('totalNonScheduledSessions', 3);
    expect(response.body).toHaveProperty('activeUsers');
    expect(response.body).toHaveProperty('totalAnonymousUsers', 1);
    expect(response.body).toHaveProperty('sessionTypes');
    expect(response.body.sessionTypes).toHaveProperty('regular', 1);
    expect(response.body.sessionTypes).toHaveProperty('scheduled', 1);
    expect(response.body.sessionTypes).toHaveProperty('video-generation', 1);
    expect(response.body.sessionTypes).toHaveProperty('image-generation', 1);
    expect(response.body).toHaveProperty('totalMessages');
    expect(response.body).toHaveProperty('messagesByRole');
    expect(response.body).toHaveProperty('totalToolCalls');
    expect(response.body).toHaveProperty('toolCallsByFunction');
    expect(response.body).toHaveProperty('dailyGrowth');
  });

  it('should separate scheduled and non-scheduled sessions correctly', async () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const mockSessions: ChatSession[] = [
      createMockSession({ sessionId: 'session-1', sessionType: 'scheduled' }),
      createMockSession({ sessionId: 'session-2', sessionType: 'regular' }),
      createMockSession({ sessionId: 'session-3', sessionType: 'predefined-work-plan' }),
      createMockSession({ sessionId: 'session-4', sessionType: 'video-generation' }),
    ];

    mockChatbotDb.getAllSessions.mockResolvedValue(mockSessions);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .query({ startDate, endDate })
      .expect(200);

    expect(response.body.totalScheduledSessions).toBe(1);
    expect(response.body.totalNonScheduledSessions).toBe(3);
  });

  it('should differentiate actual users from anonymous users', async () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const mockSessions: ChatSession[] = [
      createMockSession({ userId: 'user-1' }),
      createMockSession({ userId: 'user-2' }),
      createMockSession({ userId: 'anon_123' }),
      createMockSession({ userId: 'anon_456' }),
    ];

    mockChatbotDb.getAllSessions.mockResolvedValue(mockSessions);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .query({ startDate, endDate })
      .expect(200);

    expect(response.body.totalUsers).toBe(2); // Only actual users
    expect(response.body.totalAnonymousUsers).toBe(2); // Anonymous users
  });

  it('should calculate message metrics correctly', async () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const mockSessions: ChatSession[] = [
      createMockSession({
        sessionId: 'session-1',
        messages: [],
      }),
      createMockSession({
        sessionId: 'session-2',
        messages: [],
      }),
    ];

    const sessionsWithMessages: ChatSession[] = [
      {
        ...mockSessions[0],
        messages: [
          { role: 'user', content: 'Message 1', metadata: { timestamp: new Date().toISOString(), attachments: [{ url: 'test.jpg', filename: 'test.jpg', size: 100, mimetype: 'image/jpeg', uploadedAt: new Date().toISOString() }] } },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Message 2' },
        ],
      },
      {
        ...mockSessions[1],
        messages: [
          { role: 'user', content: 'Message 3' },
          { role: 'assistant', content: 'Response 2', tool_calls: [{ id: '1', function: { name: 'search_web' } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, estimated_cost: 0.001 } },
        ],
      },
    ];

    mockChatbotDb.getAllSessions.mockResolvedValue(mockSessions);
    mockGetChatSession(sessionsWithMessages);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .query({ startDate, endDate })
      .expect(200);

    expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith('session-1');
    expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith('session-2');
    expect(response.body.totalMessages).toBe(5);
    expect(response.body.messagesByRole.user).toBe(3); // 2 from session 1, 1 from session 2
    expect(response.body.messagesByRole.assistant).toBe(2); // 1 from session 1, 1 from session 2
    expect(response.body.messagesWithAttachments).toBe(1); // 1 message with attachment
    expect(response.body.messagesWithToolCalls).toBe(1); // 1 message with tool calls
    expect(response.body.totalTokens).toBe(150); // From the assistant message with usage
  });

  it('should calculate tool calls metrics correctly', async () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const mockSessions: ChatSession[] = [
      createMockSession({
        calledFunctions: { generate_image: 3, search_web: 2 },
      }),
      createMockSession({
        calledFunctions: { generate_video: 1, search_web: 1 },
      }),
      createMockSession({
        calledFunctions: {},
      }),
    ];

    mockChatbotDb.getAllSessions.mockResolvedValue(mockSessions);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .query({ startDate, endDate })
      .expect(200);

    expect(response.body.totalToolCalls).toBe(7);
    expect(response.body.toolCallsByFunction.generate_image).toBe(3);
    expect(response.body.toolCallsByFunction.search_web).toBe(3);
    expect(response.body.toolCallsByFunction.generate_video).toBe(1);
    expect(response.body.sessionsWithToolCalls).toBe(2);
  });

  it('should handle date range filtering correctly', async () => {
    const now = new Date();
    // Set endDate to end of today to include sessions created today
    const endDateObj = new Date(now);
    endDateObj.setHours(23, 59, 59, 999);
    const endDate = endDateObj.toISOString().split('T')[0];
    const startDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const mockSessions: ChatSession[] = [
      createMockSession({
        sessionId: 'session-1',
        createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(), // Within range (3 days ago)
      }),
      createMockSession({
        sessionId: 'session-2',
        createdAt: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString(), // Within range (4 days ago)
      }),
      createMockSession({
        sessionId: 'session-3',
        createdAt: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString(), // Outside range (6 days ago, before startDate)
      }),
      createMockSession({
        sessionId: 'session-4',
        createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(), // Within range (1 day ago)
      }),
    ];

    mockChatbotDb.getAllSessions.mockResolvedValue(mockSessions);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .query({ startDate, endDate })
      .expect(200);

    expect(response.body.totalSessions).toBe(4); // All sessions counted
    expect(response.body.newSessions).toBe(3); // Only sessions in date range (session-1, session-2, session-4)
  });

  it('should handle empty sessions array', async () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    mockChatbotDb.getAllSessions.mockResolvedValue([]);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .query({ startDate, endDate })
      .expect(200);

    expect(response.body.totalSessions).toBe(0);
    expect(response.body.newSessions).toBe(0);
    expect(response.body.totalUsers).toBe(0);
    expect(response.body.totalMessages).toBe(0);
    expect(response.body.totalToolCalls).toBe(0);
  });

  it('should filter out archived sessions', async () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const mockSessions: ChatSession[] = [
      createMockSession({ sessionId: 'session-1', archived: false }),
      createMockSession({ sessionId: 'session-2', archived: true }),
      createMockSession({ sessionId: 'session-3', archived: false }),
    ];

    mockChatbotDb.getAllSessions.mockResolvedValue(mockSessions);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .query({ startDate, endDate })
      .expect(200);

    expect(response.body.totalSessions).toBe(2); // Only non-archived
  });

  it('should only include agent portal type sessions', async () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const mockSessions: ChatSession[] = [
      createMockSession({ sessionId: 'session-1', portalType: 'agent' }),
      createMockSession({ sessionId: 'session-2', portalType: 'customer' }),
      createMockSession({ sessionId: 'session-3', portalType: 'partner' }),
      createMockSession({ sessionId: 'session-4', portalType: 'agent' }),
    ];

    mockChatbotDb.getAllSessions.mockResolvedValue(mockSessions);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .query({ startDate, endDate })
      .expect(200);

    expect(response.body.totalSessions).toBe(2); // Only agent portal type
  });

  it('should calculate daily growth for scheduled and non-scheduled separately', async () => {
    const now = new Date();
    const startDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const date1 = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const date2 = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const mockSessions: ChatSession[] = [
      createMockSession({
        sessionId: 'session-1',
        sessionType: 'scheduled',
        createdAt: `${date1}T10:00:00Z`,
      }),
      createMockSession({
        sessionId: 'session-2',
        sessionType: 'regular',
        createdAt: `${date1}T11:00:00Z`,
      }),
      createMockSession({
        sessionId: 'session-3',
        sessionType: 'scheduled',
        createdAt: `${date2}T10:00:00Z`,
      }),
      createMockSession({
        sessionId: 'session-4',
        sessionType: 'regular',
        createdAt: `${date2}T11:00:00Z`,
      }),
    ];

    mockChatbotDb.getAllSessions.mockResolvedValue(mockSessions);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .query({ startDate, endDate })
      .expect(200);

    expect(response.body.dailyGrowth).toBeDefined();
    expect(Array.isArray(response.body.dailyGrowth)).toBe(true);
    
    // Check that daily growth has scheduled and nonScheduled fields
    const dailyGrowth = response.body.dailyGrowth;
    if (dailyGrowth.length > 0) {
      expect(dailyGrowth[0]).toHaveProperty('date');
      expect(dailyGrowth[0]).toHaveProperty('scheduled');
      expect(dailyGrowth[0]).toHaveProperty('nonScheduled');
    }
  });

  it('should handle sessions without date range parameters', async () => {
    const mockSessions: ChatSession[] = [
      createMockSession({ sessionId: 'session-1' }),
      createMockSession({ sessionId: 'session-2' }),
    ];

    mockChatbotDb.getAllSessions.mockResolvedValue(mockSessions);

    const response = await request(app)
      .get('/api/admin/analytics/agent-mode')
      .expect(200);

    expect(response.body.totalSessions).toBe(2);
    expect(response.body.newSessions).toBe(2); // All sessions if no date range
  });
});
