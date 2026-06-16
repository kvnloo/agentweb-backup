import crypto from 'crypto';
import { generateSecurePassword } from '../utils/secureRandom';

describe('generateSecurePassword', () => {
  // FAIL cases: invalid inputs / boundary conditions
  it('throws when length is zero', () => {
    expect(() => generateSecurePassword(0)).toThrow(/positive integer/);
  });

  it('throws when length is negative', () => {
    expect(() => generateSecurePassword(-5)).toThrow(/positive integer/);
  });

  it('throws when length is not an integer', () => {
    expect(() => generateSecurePassword(3.5)).toThrow(/positive integer/);
  });

  it('throws when charset is empty', () => {
    expect(() => generateSecurePassword(8, '')).toThrow(/charset/);
  });

  // SUCCESS cases: happy path
  it('returns a string of the requested length', () => {
    expect(generateSecurePassword(16)).toHaveLength(16);
    expect(generateSecurePassword(1)).toHaveLength(1);
    expect(generateSecurePassword(64)).toHaveLength(64);
  });

  it('defaults to length 16 when no length is given', () => {
    expect(generateSecurePassword()).toHaveLength(16);
  });

  it('only uses characters from the provided charset', () => {
    const charset = 'ABC123';
    const pwd = generateSecurePassword(100, charset);
    for (const ch of pwd) {
      expect(charset).toContain(ch);
    }
  });

  it('draws randomness from the CSPRNG (crypto.randomInt), not Math.random', () => {
    const mathSpy = jest.spyOn(Math, 'random');
    const cryptoSpy = jest.spyOn(crypto, 'randomInt');

    generateSecurePassword(20);

    expect(cryptoSpy).toHaveBeenCalled();
    expect(mathSpy).not.toHaveBeenCalled();

    mathSpy.mockRestore();
    cryptoSpy.mockRestore();
  });

  it('produces different passwords across calls (extremely unlikely to collide)', () => {
    const results = new Set<string>();
    for (let i = 0; i < 50; i++) {
      results.add(generateSecurePassword(16));
    }
    expect(results.size).toBe(50);
  });
});
