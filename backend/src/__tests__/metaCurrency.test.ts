import {
  describeMetaMoney, majorToMinor, metaCurrencyOffset, minorToMajor, resolveMetaCurrency,
} from '../utils/metaCurrency';

describe('metaCurrency (ENG-2046 A1)', () => {
  it('TWD 300/day is 300 minor, never 30000', () => {
    expect(majorToMinor(300, 'TWD')).toBe(300);
    expect(majorToMinor(300, 'TWD')).not.toBe(30000);
    expect(describeMetaMoney(300, 'TWD')).toBe('300 (= NT$300.00 TWD)');
  });

  it('USD $3,000 cap is 300000 minor and never renders as $30', () => {
    expect(majorToMinor(3000, 'USD')).toBe(300000);
    expect(describeMetaMoney(300000, 'USD')).toBe('300000 (= $3,000.00 USD)');
    expect(describeMetaMoney(300000, 'USD')).not.toContain('$30.00');
  });

  it('round-trips for both offsets', () => {
    expect(minorToMajor(majorToMinor(12.34, 'EUR'), 'EUR')).toBe(12.34);
    expect(minorToMajor(majorToMinor(5000, 'JPY'), 'JPY')).toBe(5000);
  });

  it('normalizes lowercase codes and flags unknown codes', () => {
    expect(metaCurrencyOffset('twd')).toBe(1);
    expect(resolveMetaCurrency(' krw ')).toEqual({ code: 'KRW', offset: 1, assumed: false });
    expect(resolveMetaCurrency(undefined)).toEqual({ code: 'UNKNOWN', offset: 100, assumed: true });
    expect(resolveMetaCurrency('dollars').assumed).toBe(true);
    expect(describeMetaMoney(3000, null)).toContain('assuming 2 decimals');
  });

  it('rejects non-finite amounts', () => {
    expect(() => majorToMinor(Number.NaN, 'USD')).toThrow();
    expect(() => minorToMajor(Infinity, 'USD')).toThrow();
  });
});
