import { leadPhoneMacOf } from '../leadPhoneMac';
import { phoneMarkerKey } from '../hotLeadCallLimits';

describe('leadPhoneMacOf', () => {
  beforeEach(() => { process.env.JWT_SECRET = 'test-secret'; });
  afterEach(() => { delete process.env.JWT_SECRET; });

  it('is a stable hex digest that contains no part of the number', () => {
    const mac = leadPhoneMacOf('org-a', '+15555550123');
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(mac).toBe(leadPhoneMacOf('org-a', '+15555550123'));
    expect(mac).not.toContain('5555550123');
  });

  it('differs per number and per org', () => {
    const base = leadPhoneMacOf('org-a', '+15555550123');
    expect(leadPhoneMacOf('org-a', '+15555550124')).not.toBe(base);
    expect(leadPhoneMacOf('org-b', '+15555550123')).not.toBe(base);
  });

  it('depends on the server secret', () => {
    const before = leadPhoneMacOf('org-a', '+15555550123');
    process.env.JWT_SECRET = 'rotated';
    expect(leadPhoneMacOf('org-a', '+15555550123')).not.toBe(before);
  });

  it('is unrelated to the per-phone dedupe key (own domain label)', () => {
    const marker = phoneMarkerKey('org-a', '+15555550123').replace('hlc#phone#', '');
    expect(leadPhoneMacOf('org-a', '+15555550123')).not.toBe(marker);
  });

  it('refuses to run without a server secret instead of using a fallback', () => {
    delete process.env.JWT_SECRET;
    expect(() => leadPhoneMacOf('org-a', '+15555550123')).toThrow('JWT_SECRET');
  });
});
