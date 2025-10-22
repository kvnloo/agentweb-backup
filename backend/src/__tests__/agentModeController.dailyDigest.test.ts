import { agentModeController } from '../controllers/agentModeController';
import { scheduleDb } from '../services/db';
import { emailService } from '../services/emailService';

// Mock dependencies
jest.mock('../services/db', () => ({
  scheduleDb: {
    getScheduleById: jest.fn(),
    getRunResults: jest.fn()
  }
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatResultEmail: jest.fn()
  }
}));

describe('Agent Mode Controller - Daily Digest', () => {
  const mockUser = {
    userId: 'user-123',
    email: 'test@example.com'
  };

  const mockSchedule = {
    scheduleId: 'schedule-123',
    userId: 'user-123',
    scheduleName: 'Test Schedule',
    frequency: 'hourly',
    dailyDigest: true
  };

  const mockTestHistory = [
    {
      runId: 'run-1',
      passed: true,
      actualResponse: 'Test response 1',
      executionTime: 5000,
      sessionId: 'session-1',
      attempt: 1,
      createdAt: '2024-01-15T10:00:00Z'
    },
    {
      runId: 'run-2',
      passed: false,
      actualResponse: 'Test response 2',
      executionTime: 3000,
      sessionId: 'session-2',
      attempt: 2,
      createdAt: '2024-01-15T11:00:00Z'
    },
    {
      runId: 'run-3',
      passed: true,
      actualResponse: 'Test response 3',
      executionTime: 4000,
      sessionId: 'session-3',
      attempt: 1,
      createdAt: '2024-01-15T12:00:00Z'
    }
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sendScheduledChatTestEmail', () => {
    const mockReq = {
      user: mockUser,
      params: { scheduleId: 'schedule-123', runId: 'run-1' },
      body: { toEmail: 'test@example.com' }
    };

    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    it('should send daily digest for hourly schedule with daily digest enabled', async () => {
      (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(mockSchedule);
      (scheduleDb.getRunResults as jest.Mock).mockResolvedValue(mockTestHistory);
      (emailService.sendDailyDigestEmail as jest.Mock).mockResolvedValue(undefined);

      await agentModeController.sendScheduledChatTestEmail(mockReq as any, mockRes as any);

      expect(scheduleDb.getScheduleById).toHaveBeenCalledWith('schedule-123');
      expect(scheduleDb.getRunResults).toHaveBeenCalledWith('schedule-123');
      expect(emailService.sendDailyDigestEmail).toHaveBeenCalledWith(
        ['test@example.com'],
        'Test Schedule',
        expect.arrayContaining([
          expect.objectContaining({ runId: 'run-1' }),
          expect.objectContaining({ runId: 'run-2' }),
          expect.objectContaining({ runId: 'run-3' })
        ]),
        'schedule-123',
        expect.any(Date)
      );
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        message: expect.stringContaining('Daily digest email sent with all results from'),
        resultCount: 3,
        date: expect.any(String)
      });
    });

    it('should send individual email for non-hourly schedule', async () => {
      const nonHourlySchedule = { ...mockSchedule, frequency: 'daily', dailyDigest: false };
      (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(nonHourlySchedule);
      (scheduleDb.getRunResults as jest.Mock).mockResolvedValue(mockTestHistory);
      (emailService.sendScheduledChatResultEmail as jest.Mock).mockResolvedValue(undefined);

      await agentModeController.sendScheduledChatTestEmail(mockReq as any, mockRes as any);

      expect(emailService.sendDailyDigestEmail).not.toHaveBeenCalled();
      expect(emailService.sendScheduledChatResultEmail).toHaveBeenCalledWith(
        ['test@example.com'],
        'Test Schedule',
        expect.objectContaining({
          passed: true,
          actualResponse: 'Test response 1',
          sessionId: 'session-1'
        }),
        'schedule-123'
      );
      expect(mockRes.json).toHaveBeenCalledWith({ success: true });
    });

    it('should send individual email for hourly schedule without daily digest', async () => {
      const hourlyWithoutDigest = { ...mockSchedule, dailyDigest: false };
      (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(hourlyWithoutDigest);
      (scheduleDb.getRunResults as jest.Mock).mockResolvedValue(mockTestHistory);
      (emailService.sendScheduledChatResultEmail as jest.Mock).mockResolvedValue(undefined);

      await agentModeController.sendScheduledChatTestEmail(mockReq as any, mockRes as any);

      expect(emailService.sendDailyDigestEmail).not.toHaveBeenCalled();
      expect(emailService.sendScheduledChatResultEmail).toHaveBeenCalled();
    });

    it('should filter results by the same date as selected test', async () => {
      const testHistoryWithDifferentDates = [
        ...mockTestHistory,
        {
          runId: 'run-4',
          passed: true,
          actualResponse: 'Test response 4',
          executionTime: 2000,
          sessionId: 'session-4',
          attempt: 1,
          createdAt: '2024-01-14T10:00:00Z' // Different date
        }
      ];

      (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(mockSchedule);
      (scheduleDb.getRunResults as jest.Mock).mockResolvedValue(testHistoryWithDifferentDates);
      (emailService.sendDailyDigestEmail as jest.Mock).mockResolvedValue(undefined);

      await agentModeController.sendScheduledChatTestEmail(mockReq as any, mockRes as any);

      expect(emailService.sendDailyDigestEmail).toHaveBeenCalledWith(
        ['test@example.com'],
        'Test Schedule',
        expect.arrayContaining([
          expect.objectContaining({ runId: 'run-1' }),
          expect.objectContaining({ runId: 'run-2' }),
          expect.objectContaining({ runId: 'run-3' })
        ]),
        'schedule-123',
        expect.any(Date)
      );

      // Should not include run-4 from different date
      const digestCall = (emailService.sendDailyDigestEmail as jest.Mock).mock.calls[0];
      const results = digestCall[2];
      expect(results).not.toContainEqual(expect.objectContaining({ runId: 'run-4' }));
    });

    it('should return 404 when schedule not found', async () => {
      (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(null);

      await agentModeController.sendScheduledChatTestEmail(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Scheduled chat not found' });
    });

    it('should return 404 when schedule belongs to different user', async () => {
      const otherUserSchedule = { ...mockSchedule, userId: 'other-user' };
      (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(otherUserSchedule);

      await agentModeController.sendScheduledChatTestEmail(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Scheduled chat not found' });
    });

    it('should return 404 when test record not found', async () => {
      (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(mockSchedule);
      (scheduleDb.getRunResults as jest.Mock).mockResolvedValue(mockTestHistory);

      const reqWithNonExistentRun = {
        ...mockReq,
        params: { scheduleId: 'schedule-123', runId: 'non-existent-run' }
      };

      await agentModeController.sendScheduledChatTestEmail(reqWithNonExistentRun as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Test record not found' });
    });

    it('should return 400 when toEmail is missing', async () => {
      const reqWithoutEmail = {
        ...mockReq,
        body: {}
      };

      await agentModeController.sendScheduledChatTestEmail(reqWithoutEmail as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'toEmail is required' });
    });

    it('should handle empty test history gracefully', async () => {
      (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(mockSchedule);
      (scheduleDb.getRunResults as jest.Mock).mockResolvedValue([]);

      await agentModeController.sendScheduledChatTestEmail(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Test record not found' });
    });

    it('should handle errors gracefully', async () => {
      (scheduleDb.getScheduleById as jest.Mock).mockRejectedValue(new Error('Database error'));

      await agentModeController.sendScheduledChatTestEmail(mockReq as any, mockRes as any);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Failed to send test email' });
    });
  });
});
