import { mintZomaSignupIntent, isZomaSignup } from '../services/zomaSignupIntent';

jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'test-signup-intent-secret' }));

describe('product scoped Zoma signup intent', () => {
  it('recognizes an explicit Zoma signup but not Emma or an unclassified signup', () => {
    expect(isZomaSignup({ signupProduct: 'zoma' })).toBe(true);
    for (const signupProduct of ['emma_web', 'emma_mcp', undefined]) expect(isZomaSignup({ signupProduct })).toBe(false);
  });
  it('carries a signed Zoma intent from setup / MCP consent registration', () => {
    const token = mintZomaSignupIntent();
    expect(isZomaSignup({ signupIntent: token })).toBe(true);
    expect(isZomaSignup({ signupIntent: `${token}tampered` })).toBe(false);
    expect(isZomaSignup({ signupIntent: 'zoma' })).toBe(false);
  });
  it('rejects expired intents', () => {
    const token = mintZomaSignupIntent();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60 * 1000);
    expect(isZomaSignup({ signupIntent: token })).toBe(false);
    jest.restoreAllMocks();
  });
});
