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

describe('ENG-3124 Google OAuth state carries the Zoma intent', () => {
  const { encodeGoogleOAuthState, parseGoogleOAuthState } = require('../services/zomaSignupIntent');
  it('round-trips a signed intent only on the customer portal', () => {
    const intent = mintZomaSignupIntent();
    expect(parseGoogleOAuthState(encodeGoogleOAuthState('customer', intent))).toEqual({ portal: 'customer', zomaSignup: true });
    expect(encodeGoogleOAuthState('genius', intent)).toBe('genius');
    expect(encodeGoogleOAuthState('customer', 'forged')).toBe('customer');
  });
  it('keeps the legacy plain-portal state and rejects forged or malformed intents', () => {
    expect(parseGoogleOAuthState('customer')).toEqual({ portal: 'customer', zomaSignup: false });
    expect(parseGoogleOAuthState('genius')).toEqual({ portal: 'genius', zomaSignup: false });
    expect(parseGoogleOAuthState(undefined)).toEqual({ portal: 'partner', zomaSignup: false });
    expect(parseGoogleOAuthState('customer~9999999999.forged')).toEqual({ portal: 'customer', zomaSignup: false });
    expect(parseGoogleOAuthState(`customer~${mintZomaSignupIntent()}~x`).zomaSignup).toBe(false);
  });
});
