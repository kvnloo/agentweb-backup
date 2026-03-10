import {
  getTrialStatus,
  isTrialExpired,
  DEFAULT_TRIAL_DAYS,
  EXTENDED_TRIAL_DAYS,
  TrialStatus,
} from '../services/trialService';

describe('Free trial system', () => {
  // --- FAIL TESTS ---

  describe('isTrialExpired', () => {
    it('should return false for a trial that has not expired', () => {
      const now = new Date();
      const trialEnd = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days from now
      expect(isTrialExpired(trialEnd.toISOString())).toBe(false);
    });

    it('should return true for a trial that has expired', () => {
      const now = new Date();
      const trialEnd = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
      expect(isTrialExpired(trialEnd.toISOString())).toBe(true);
    });

    it('should return false if trial_end is not set (no trial = no expiration)', () => {
      expect(isTrialExpired(undefined)).toBe(false);
    });
  });

  describe('getTrialStatus', () => {
    it('should return active status with correct daysRemaining for active trial', () => {
      const now = new Date();
      const trialStart = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // started 1 day ago
      const trialEnd = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days from now

      const status = getTrialStatus(trialStart.toISOString(), trialEnd.toISOString());

      expect(status.isInTrial).toBe(true);
      expect(status.isExpired).toBe(false);
      expect(status.daysRemaining).toBe(2);
      expect(status.trialEnd).toBe(trialEnd.toISOString());
    });

    it('should return expired status for expired trial', () => {
      const now = new Date();
      const trialStart = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // started 5 days ago
      const trialEnd = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // ended 1 day ago

      const status = getTrialStatus(trialStart.toISOString(), trialEnd.toISOString());

      expect(status.isInTrial).toBe(false);
      expect(status.isExpired).toBe(true);
      expect(status.daysRemaining).toBe(0);
    });

    it('should return no-trial status when trial dates are not set', () => {
      const status = getTrialStatus(undefined, undefined);

      expect(status.isInTrial).toBe(false);
      expect(status.isExpired).toBe(false);
      expect(status.daysRemaining).toBe(0);
    });
  });

  describe('Constants', () => {
    it('should have 3-day default trial', () => {
      expect(DEFAULT_TRIAL_DAYS).toBe(3);
    });

    it('should have 14-day extended trial', () => {
      expect(EXTENDED_TRIAL_DAYS).toBe(14);
    });
  });

  describe('Trial date calculation', () => {
    it('should calculate trial end as trial_start + DEFAULT_TRIAL_DAYS', () => {
      const trialStart = new Date('2026-03-10T00:00:00Z');
      const expectedEnd = new Date('2026-03-13T00:00:00Z'); // 3 days later

      const trialEnd = new Date(trialStart.getTime() + DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000);
      expect(trialEnd.toISOString()).toBe(expectedEnd.toISOString());
    });
  });
});
