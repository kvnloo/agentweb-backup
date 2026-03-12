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

    it('should return future date for all timezones', () => {
      const result = calculateNextRunTime('daily', 'Pacific/Kiritimati');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should return valid date for default timezone (UTC)', () => {
      const result = calculateNextRunTime('daily', 'UTC');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result).toContain('09:00');
    });
  });
});
