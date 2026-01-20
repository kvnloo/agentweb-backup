import { getTokenStatus, formatExpiryMessage, TokenStatus } from '../../utils/tokenUtils';

describe('tokenUtils', () => {
  describe('getTokenStatus', () => {
    it('should return "expired" for past timestamps', () => {
      const pastTime = Date.now() - 1000; // 1 second ago
      expect(getTokenStatus(pastTime)).toBe('expired');
    });

    it('should return "expiring_soon" for timestamps within 7 days', () => {
      const threeDaysFromNow = Date.now() + 3 * 24 * 60 * 60 * 1000;
      expect(getTokenStatus(threeDaysFromNow)).toBe('expiring_soon');
    });

    it('should return "expiring_soon" for timestamps exactly at 7 days boundary', () => {
      const almostSevenDays = Date.now() + 6 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000;
      expect(getTokenStatus(almostSevenDays)).toBe('expiring_soon');
    });

    it('should return "active" for timestamps more than 7 days away', () => {
      const tenDaysFromNow = Date.now() + 10 * 24 * 60 * 60 * 1000;
      expect(getTokenStatus(tenDaysFromNow)).toBe('active');
    });

    it('should return "active" for far future timestamps', () => {
      const oneYearFromNow = Date.now() + 365 * 24 * 60 * 60 * 1000;
      expect(getTokenStatus(oneYearFromNow)).toBe('active');
    });
  });

  describe('formatExpiryMessage', () => {
    it('should return "Expired" for past timestamps', () => {
      const pastTime = Date.now() - 1000;
      expect(formatExpiryMessage(pastTime)).toBe('Expired');
    });

    it('should return days format for timestamps days away', () => {
      const fiveDaysFromNow = Date.now() + 5 * 24 * 60 * 60 * 1000;
      expect(formatExpiryMessage(fiveDaysFromNow)).toBe('Expires in 5 days');
    });

    it('should return singular day format for 1 day', () => {
      const oneDayFromNow = Date.now() + 1 * 24 * 60 * 60 * 1000;
      expect(formatExpiryMessage(oneDayFromNow)).toBe('Expires in 1 day');
    });

    it('should return hours format for timestamps hours away', () => {
      const fiveHoursFromNow = Date.now() + 5 * 60 * 60 * 1000;
      expect(formatExpiryMessage(fiveHoursFromNow)).toBe('Expires in 5 hours');
    });

    it('should return singular hour format for 1 hour', () => {
      const oneHourFromNow = Date.now() + 1 * 60 * 60 * 1000;
      expect(formatExpiryMessage(oneHourFromNow)).toBe('Expires in 1 hour');
    });

    it('should return minutes format for timestamps minutes away', () => {
      const thirtyMinutesFromNow = Date.now() + 30 * 60 * 1000;
      expect(formatExpiryMessage(thirtyMinutesFromNow)).toBe('Expires in 30 minutes');
    });

    it('should return singular minute format for 1 minute', () => {
      const oneMinuteFromNow = Date.now() + 1 * 60 * 1000;
      expect(formatExpiryMessage(oneMinuteFromNow)).toBe('Expires in 1 minute');
    });

    it('should return 0 minutes for very near future timestamps', () => {
      const tenSecondsFromNow = Date.now() + 10 * 1000;
      // 0 is not > 1, so it returns singular "minute"
      expect(formatExpiryMessage(tenSecondsFromNow)).toBe('Expires in 0 minute');
    });
  });
});
