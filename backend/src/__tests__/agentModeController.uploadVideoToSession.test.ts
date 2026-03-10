import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { uploadFileToS3 } from '../utils/s3Utils';

// Mock dependencies
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
  }
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
  isAllowedUploadType: jest.fn().mockReturnValue(true),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockUploadFileToS3 = uploadFileToS3 as jest.MockedFunction<typeof uploadFileToS3>;

describe('AgentModeController - uploadVideoToSession', () => {
  const mockUserId = 'test-user-123';
  const mockSessionId = 'test-session-123';
  const mockSession = {
    sessionId: mockSessionId,
    userId: mockUserId,
    title: 'Test Session',
    messages: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    portalType: 'agent' as const,
    pageIdentifier: 'agent-mode',
  };

  const mockFile = {
    buffer: Buffer.from('fake-video-data'),
    originalname: 'test-video.mp4',
    mimetype: 'video/mp4',
    size: 5 * 1024 * 1024, // 5MB
  };

  const mockUploadResult = {
    success: true,
    url: 'https://example.com/s3/test-video.mp4',
    key: 'users/test-user-123/files/1234567890-abc123/test-video.mp4',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    mockUploadFileToS3.mockResolvedValue(mockUploadResult);
    mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
  });

  it('should upload video to session successfully', async () => {
    const mockReq = {
      user: { userId: mockUserId, isAdmin: false },
      params: { sessionId: mockSessionId },
      file: mockFile,
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.uploadVideoToSession(mockReq, mockRes);

    expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
    expect(mockUploadFileToS3).toHaveBeenCalledWith(
      mockFile.buffer,
      mockFile.originalname,
      mockUserId,
      mockFile.mimetype
    );
    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalledWith(
      mockSessionId,
      expect.objectContaining({
        role: 'system',
        content: `Video uploaded: ${mockFile.originalname}`,
        metadata: expect.objectContaining({
          portalType: 'agent',
          toolCalls: [
            expect.objectContaining({
              name: 'upload_video',
              result: expect.objectContaining({
                success: true,
                videoUrl: mockUploadResult.url,
                filename: mockFile.originalname,
              }),
            }),
          ],
        }),
      })
    );
    expect(mockRes.json).toHaveBeenCalledWith({
      success: true,
      message: 'Video uploaded successfully',
      url: mockUploadResult.url,
      filename: mockFile.originalname,
      uploadedAt: expect.any(String),
    });
  });

  it('should return 400 if no file is uploaded', async () => {
    const mockReq = {
      user: { userId: mockUserId },
      params: { sessionId: mockSessionId },
      file: undefined,
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.uploadVideoToSession(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'No file uploaded' });
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
  });

  it('should return 400 if file is not a video', async () => {
    const nonVideoFile = {
      ...mockFile,
      mimetype: 'image/png',
    };

    const mockReq = {
      user: { userId: mockUserId },
      params: { sessionId: mockSessionId },
      file: nonVideoFile,
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.uploadVideoToSession(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'File must be a video' });
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
  });

  it('should return 404 if session does not exist', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(null);

    const mockReq = {
      user: { userId: mockUserId },
      params: { sessionId: mockSessionId },
      file: mockFile,
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.uploadVideoToSession(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Session not found' });
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
  });

  it('should return 403 if user does not own the session', async () => {
    const differentUserId = 'different-user-456';
    const mockReq = {
      user: { userId: differentUserId, isAdmin: false },
      params: { sessionId: mockSessionId },
      file: mockFile,
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.uploadVideoToSession(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Access denied' });
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
  });

  it('should allow admin users to upload to any session', async () => {
    const adminUserId = 'admin-user-789';
    const mockReq = {
      user: { userId: adminUserId, isAdmin: true },
      params: { sessionId: mockSessionId },
      file: mockFile,
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.uploadVideoToSession(mockReq, mockRes);

    expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith(mockSessionId);
    expect(mockUploadFileToS3).toHaveBeenCalled();
    expect(mockChatbotDb.addMessageToSession).toHaveBeenCalled();
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
      })
    );
  });

  it('should return 500 if S3 upload fails', async () => {
    mockUploadFileToS3.mockResolvedValue({
      success: false,
      error: 'S3 upload failed',
    });

    const mockReq = {
      user: { userId: mockUserId },
      params: { sessionId: mockSessionId },
      file: mockFile,
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.uploadVideoToSession(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Failed to upload file to S3' });
    expect(mockChatbotDb.addMessageToSession).not.toHaveBeenCalled();
  });

  it('should handle errors gracefully', async () => {
    mockChatbotDb.getChatSession.mockRejectedValue(new Error('Database error'));

    const mockReq = {
      user: { userId: mockUserId },
      params: { sessionId: mockSessionId },
      file: mockFile,
    } as unknown as Request;

    const mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await agentModeController.uploadVideoToSession(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Failed to upload video to session' });
  });

  it('should handle different video formats', async () => {
    const videoFormats = [
      { mimetype: 'video/mp4', originalname: 'test.mp4' },
      { mimetype: 'video/avi', originalname: 'test.avi' },
      { mimetype: 'video/mov', originalname: 'test.mov' },
      { mimetype: 'video/webm', originalname: 'test.webm' },
    ];

    for (const format of videoFormats) {
      const formatFile = {
        ...mockFile,
        mimetype: format.mimetype,
        originalname: format.originalname,
      };

      const mockReq = {
        user: { userId: mockUserId },
        params: { sessionId: mockSessionId },
        file: formatFile,
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.uploadVideoToSession(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          filename: format.originalname,
        })
      );

      jest.clearAllMocks();
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
      mockUploadFileToS3.mockResolvedValue(mockUploadResult);
    }
  });
});
