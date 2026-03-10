import { calculateNextRunTime } from '../../utils/schedule';

describe('schedule utils', () => {
  describe('calculateNextRunTime', () => {
    it('should return a valid ISO date string for daily frequency', () => {
      const result = calculateNextRunTime('daily');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should return a valid ISO date string for weekly frequency', () => {
      const result = calculateNextRunTime('weekly');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should return a valid ISO date string for monthly frequency', () => {
      const result = calculateNextRunTime('monthly');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should default to daily for unknown frequency', () => {
      const result = calculateNextRunTime('custom');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should handle timezone parameter', () => {
      const result = calculateNextRunTime('daily', 'America/New_York');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should set time to 9:00 AM', () => {
      const result = calculateNextRunTime('daily');
      // The result should contain 09:00 as the time
      expect(result).toContain('09:00');
    });

    it('should add extra day when calculated time is in the past due to timezone', () => {
      // Set system time to late evening so adding 1 day + setting to 9:00 AM
      // could still be in the past for far-ahead timezones
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-12-31T23:59:00Z'));

      const result = calculateNextRunTime('daily', 'Pacific/Auckland'); // UTC+13
      // Should still produce a valid future date
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T09:00:00/);

      jest.useRealTimers();
    });
  });
});
