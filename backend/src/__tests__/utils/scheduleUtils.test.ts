import { calculateNextRunTime, isValidFrequency, isValidTimezone, Frequency } from '../../utils/scheduleUtils';

describe('scheduleUtils', () => {
  describe('calculateNextRunTime', () => {
    it('should return ISO string for daily frequency', () => {
      const result = calculateNextRunTime('daily');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      const date = new Date(result);
      expect(date.getHours()).toBe(9);
      expect(date.getMinutes()).toBe(0);
    });

    it('should return ISO string for weekly frequency', () => {
      const result = calculateNextRunTime('weekly');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      const date = new Date(result);
      expect(date.getHours()).toBe(9);
    });

    it('should return ISO string for monthly frequency', () => {
      const result = calculateNextRunTime('monthly');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      const date = new Date(result);
      expect(date.getHours()).toBe(9);
    });

    it('should throw error for invalid frequency', () => {
      expect(() => calculateNextRunTime('invalid' as Frequency)).toThrow('Invalid frequency');
    });

    it('should return a future date', () => {
      const result = calculateNextRunTime('daily');
      const date = new Date(result);
      expect(date.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('isValidFrequency', () => {
    it('should return true for valid frequencies', () => {
      expect(isValidFrequency('daily')).toBe(true);
      expect(isValidFrequency('weekly')).toBe(true);
      expect(isValidFrequency('monthly')).toBe(true);
    });

    it('should return false for invalid frequencies', () => {
      expect(isValidFrequency('hourly')).toBe(false);
      expect(isValidFrequency('yearly')).toBe(false);
      expect(isValidFrequency('')).toBe(false);
      expect(isValidFrequency('DAILY')).toBe(false);
    });
  });

  describe('isValidTimezone', () => {
    it('should return true for valid timezones', () => {
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('Europe/London')).toBe(true);
      expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    });

    it('should return false for invalid timezones', () => {
      expect(isValidTimezone('Invalid/Timezone')).toBe(false);
      expect(isValidTimezone('NotATimezone')).toBe(false);
      expect(isValidTimezone('')).toBe(false);
    });
  });
});
