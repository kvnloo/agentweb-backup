/**
 * Unit tests for the central JWT secret accessor.
 * Guards the fail-fast contract that replaced the `|| 'your-secret-key'` fallbacks.
 */

describe('config/jwt getJwtSecret', () => {
  const ORIGINAL_SECRET = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_SECRET;
    jest.resetModules();
  });

  it('returns the configured secret when JWT_SECRET is set', () => {
    process.env.JWT_SECRET = 'a-real-secret';
    const { getJwtSecret } = require('../config/jwt');
    expect(getJwtSecret()).toBe('a-real-secret');
  });

  it('throws when JWT_SECRET is missing', () => {
    delete process.env.JWT_SECRET;
    const { getJwtSecret } = require('../config/jwt');
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET is not set/);
  });

  it('throws when JWT_SECRET is an empty string (no silent fallback)', () => {
    process.env.JWT_SECRET = '';
    const { getJwtSecret } = require('../config/jwt');
    expect(() => getJwtSecret()).toThrow(/JWT_SECRET is not set/);
  });

  it('never returns the historical public fallback value', () => {
    delete process.env.JWT_SECRET;
    const { getJwtSecret } = require('../config/jwt');
    expect(() => getJwtSecret()).toThrow();
    // If it had returned 'your-secret-key' the throw above would not happen.
  });
});

describe('config/jwt assertJwtSecretAtBoot', () => {
  const ORIGINAL_SECRET = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.JWT_SECRET = ORIGINAL_SECRET;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('does not exit when JWT_SECRET is set', () => {
    process.env.JWT_SECRET = 'a-real-secret';
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called');
    }) as never);
    const { assertJwtSecretAtBoot } = require('../config/jwt');
    expect(() => assertJwtSecretAtBoot()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits non-zero with a clear message when JWT_SECRET is missing', () => {
    delete process.env.JWT_SECRET;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit called');
    }) as never);
    const { assertJwtSecretAtBoot } = require('../config/jwt');
    expect(() => assertJwtSecretAtBoot()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('JWT_SECRET is not set'));
  });
});
