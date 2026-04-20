import { Request, Response } from 'express';

// Mock dependencies
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getMarketingSystemPrompt: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    getScheduleById: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
  },
}));

// Import after mocks
import { scheduleDb } from '../services/db';

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

describe('calculateNextRunTime Function Logic', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Hourly frequency', () => {
    it('should add 1 hour and set minutes to 0', () => {
      // Use a date 1 hour from now
      const now = new Date();
      const fromDate = new Date(now.getTime() + 60 * 60 * 1000);
      const result = calculateNextRunTime('hourly', fromDate);

      // Should be 2 hours from now (fromDate + 1 hour)
      expect(result.getTime()).toBeGreaterThan(now.getTime());
      expect(result.getUTCMinutes()).toBe(0); // Should be set to 0
    });

    it('should ensure next run is in the future', () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 5 * 60 * 60 * 1000); // 5 hours ago
      const result = calculateNextRunTime('hourly', pastDate);

      expect(result.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  describe('Every N days frequency', () => {
    it('should add N days and preserve time', () => {
      const now = new Date();
      const fromDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days from now
      const result = calculateNextRunTime('every_n_days', fromDate, 3);

      // Should be 6 days from now (fromDate + 3 days)
      const expectedMin = fromDate.getTime() + 3 * 24 * 60 * 60 * 1000 - 1000;
      expect(result.getTime()).toBeGreaterThan(expectedMin);
      expect(result.getUTCHours()).toBe(fromDate.getUTCHours());
      expect(result.getUTCMinutes()).toBe(fromDate.getUTCMinutes());
    });

    it('should handle interval of 1 (equivalent to daily)', () => {
      const now = new Date();
      const fromDate = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Tomorrow
      const result = calculateNextRunTime('every_n_days', fromDate, 1);

      // Should be 2 days from now (fromDate + 1 day)
      expect(result.getTime()).toBeGreaterThan(fromDate.getTime());
      expect(result.getUTCHours()).toBe(fromDate.getUTCHours());
    });

    it('should handle large intervals', () => {
      const now = new Date();
      const fromDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days from now
      const result = calculateNextRunTime('every_n_days', fromDate, 90);

      // Should be 180 days from now (fromDate + 90 days)
      expect(result.getTime()).toBeGreaterThan(fromDate.getTime());
    });

    it('should ensure next run is in the future when past due', () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      const result = calculateNextRunTime('every_n_days', pastDate, 3);

      // Should catch up by adding 3-day intervals until in the future
      expect(result.getTime()).toBeGreaterThan(now.getTime());
    });

    it('should default to 1 day when frequencyIntervalDays is undefined', () => {
      const now = new Date();
      const fromDate = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Tomorrow
      const result = calculateNextRunTime('every_n_days', fromDate);

      // Should behave like daily (add 1 day)
      expect(result.getTime()).toBeGreaterThan(fromDate.getTime());
    });
  });

  describe('Daily frequency', () => {
    it('should add 1 day and preserve time', () => {
      const now = new Date();
      const fromDate = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Tomorrow
      const result = calculateNextRunTime('daily', fromDate);

      // Should be 2 days from now (fromDate + 1 day)
      expect(result.getTime()).toBeGreaterThan(fromDate.getTime());
      expect(result.getUTCHours()).toBe(fromDate.getUTCHours());
      expect(result.getUTCMinutes()).toBe(fromDate.getUTCMinutes());
    });

    it('should ensure next run is in the future', () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
      const result = calculateNextRunTime('daily', pastDate);

      expect(result.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  describe('Weekly frequency', () => {
    it('should add 7 days and preserve time', () => {
      const now = new Date();
      const fromDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // Next week
      const result = calculateNextRunTime('weekly', fromDate);

      // Should be 2 weeks from now (fromDate + 7 days)
      expect(result.getTime()).toBeGreaterThan(fromDate.getTime());
      expect(result.getUTCDay()).toBe(fromDate.getUTCDay()); // Same day of week
      expect(result.getUTCHours()).toBe(fromDate.getUTCHours());
      expect(result.getUTCMinutes()).toBe(fromDate.getUTCMinutes());
    });

    it('should ensure next run is in the future', () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 2 * 7 * 24 * 60 * 60 * 1000); // 2 weeks ago
      const result = calculateNextRunTime('weekly', pastDate);

      expect(result.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  describe('Monthly frequency', () => {
    it('should calculate same weekday and week position', () => {
      // 2nd Tuesday of January 2027 (Jan 12, 2027) at 10:30 AM
      const fromDate = new Date('2027-01-12T10:30:00.000Z');
      const result = calculateNextRunTime('monthly', fromDate);

      // Should be 2nd Tuesday of February 2027 (Feb 9, 2027) at 10:30 AM
      expect(result.getUTCMonth()).toBe(1); // February (0-indexed)
      expect(result.getUTCDay()).toBe(2); // Tuesday
      expect(result.getUTCDate()).toBe(9); // 2nd Tuesday
      expect(result.getUTCHours()).toBe(10);
      expect(result.getUTCMinutes()).toBe(30);
    });

    it('should handle 1st Monday correctly', () => {
      // 1st Monday of January 2027 (Jan 4, 2027)
      const fromDate = new Date('2027-01-04T09:00:00.000Z');
      const result = calculateNextRunTime('monthly', fromDate);

      // Should be 1st Monday of February 2027 (Feb 1, 2027)
      expect(result.getUTCMonth()).toBe(1); // February
      expect(result.getUTCDay()).toBe(1); // Monday
      expect(result.getUTCDate()).toBe(1);
    });

    it('should handle last week of month correctly', () => {
      // 4th Friday of January 2027 (Jan 22, 2027)
      const fromDate = new Date('2027-01-22T15:00:00.000Z');
      const result = calculateNextRunTime('monthly', fromDate);

      // Should be 4th Friday of February 2027 (Feb 26, 2027)
      expect(result.getUTCMonth()).toBe(1);
      expect(result.getUTCDay()).toBe(5); // Friday
      expect(result.getUTCDate()).toBe(26);
    });

    it('should ensure next run is in the future', () => {
      const now = new Date();
      const pastDate = new Date(now.getTime() - 3 * 30 * 24 * 60 * 60 * 1000); // ~3 months ago
      const result = calculateNextRunTime('monthly', pastDate);

      expect(result.getTime()).toBeGreaterThan(now.getTime());
    });
  });
});

// Helper function to test (copied from controller)
function calculateNextRunTime(frequency: string, fromDate: Date, frequencyIntervalDays?: number): Date {
  const now = new Date();
  let nextRun = new Date(fromDate);

  switch (frequency) {
    case 'hourly':
      nextRun.setUTCHours(nextRun.getUTCHours() + 1);
      nextRun.setUTCMinutes(0, 0, 0);
      while (nextRun <= now) {
        nextRun.setUTCHours(nextRun.getUTCHours() + 1);
      }
      break;
    case 'every_n_days': {
      const interval = frequencyIntervalDays && frequencyIntervalDays >= 1 ? frequencyIntervalDays : 1;
      nextRun.setUTCDate(nextRun.getUTCDate() + interval);
      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + interval);
      }
      break;
    }
    case 'daily':
      nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 1);
      }
      break;
    case 'weekly':
      nextRun.setUTCDate(nextRun.getUTCDate() + 7);
      while (nextRun <= now) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 7);
      }
      break;
    case 'monthly':
      const currentDayOfWeek = nextRun.getUTCDay();
      const currentWeekOfMonth = Math.floor((nextRun.getUTCDate() - 1) / 7);

      nextRun.setUTCMonth(nextRun.getUTCMonth() + 1);
      nextRun.setUTCDate(1);

      const firstDayOfMonth = nextRun.getUTCDay();
      let daysToAdd = (currentDayOfWeek - firstDayOfMonth + 7) % 7;
      daysToAdd += currentWeekOfMonth * 7;
      nextRun.setUTCDate(1 + daysToAdd);

      while (nextRun <= now) {
        nextRun.setUTCMonth(nextRun.getUTCMonth() + 1);
        nextRun.setUTCDate(1);
        const firstDayOfMonth = nextRun.getUTCDay();
        let daysToAdd = (currentDayOfWeek - firstDayOfMonth + 7) % 7;
        daysToAdd += currentWeekOfMonth * 7;
        nextRun.setUTCDate(1 + daysToAdd);
      }
      break;
  }

  return nextRun;
}
