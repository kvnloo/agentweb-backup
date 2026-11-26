import { mintZomaSignupIntent, isZomaSignup, isDatabricksSignupIntent, hasValidZomaSignupIntent } from '../services/zomaSignupIntent';

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

describe('ENG-2781 Databricks-origin signup intent', () => {
  const { encodeGoogleOAuthState, parseGoogleOAuthState } = require('../services/zomaSignupIntent');

  it('a Databricks intent is still a valid Zoma intent, and only it is Databricks-origin', () => {
    const db = mintZomaSignupIntent({ databricks: true });
    expect(isZomaSignup({ signupIntent: db })).toBe(true);
    expect(hasValidZomaSignupIntent(db)).toBe(true);
    expect(isDatabricksSignupIntent(db)).toBe(true);
    expect(isDatabricksSignupIntent(mintZomaSignupIntent())).toBe(false);
    expect(isDatabricksSignupIntent(mintZomaSignupIntent({ databricks: false }))).toBe(false);
  });

  it('an ordinary intent keeps its original two-part shape', () => {
    // Pinned clock: two mints either side of a second boundary would otherwise differ.
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      expect(mintZomaSignupIntent().split('.')).toHaveLength(2);
      expect(mintZomaSignupIntent({})).toBe(mintZomaSignupIntent());
      expect(mintZomaSignupIntent({ databricks: false })).toBe(mintZomaSignupIntent());
      expect(mintZomaSignupIntent({ databricks: true }).split('.')[1]).toBe('db');
    } finally {
      now.mockRestore();
    }
  });

  it('the Databricks marker cannot be added to an ordinary intent', () => {
    const [expiry, mac] = mintZomaSignupIntent().split('.');
    const forged = `${expiry}.db.${mac}`;
    expect(isDatabricksSignupIntent(forged)).toBe(false);
    expect(hasValidZomaSignupIntent(forged)).toBe(false);
    expect(isZomaSignup({ signupIntent: forged })).toBe(false);
  });

  it('the Databricks marker cannot be stripped into a different valid intent or swapped for another', () => {
    const [expiry, , mac] = mintZomaSignupIntent({ databricks: true }).split('.');
    expect(hasValidZomaSignupIntent(`${expiry}.${mac}`)).toBe(false);
    expect(hasValidZomaSignupIntent(`${expiry}.other.${mac}`)).toBe(false);
    expect(isDatabricksSignupIntent(`${expiry}.other.${mac}`)).toBe(false);
  });

  it.each([null, undefined, 42, {}, '', 'db', '1.db', '1.db.', 'a.db.b', '9999999999.db.forged', `${'9'.repeat(10)}.db.${'x'.repeat(100)}`])(
    'rejects a malformed or forged Databricks intent %p', (bad) => {
      expect(isDatabricksSignupIntent(bad)).toBe(false);
      expect(hasValidZomaSignupIntent(bad)).toBe(false);
    },
  );

  it('an expired Databricks intent is neither valid nor Databricks-origin', () => {
    const token = mintZomaSignupIntent({ databricks: true });
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60 * 1000);
    expect(isDatabricksSignupIntent(token)).toBe(false);
    expect(hasValidZomaSignupIntent(token)).toBe(false);
    jest.restoreAllMocks();
  });

  it('Google state round-trips the marker, and never reports it for an ordinary or forged state', () => {
    const state = encodeGoogleOAuthState('customer', mintZomaSignupIntent({ databricks: true }));
    expect(parseGoogleOAuthState(state)).toEqual({ portal: 'customer', zomaSignup: true, databricksSignup: true });
    expect(parseGoogleOAuthState(encodeGoogleOAuthState('customer', mintZomaSignupIntent()))).toEqual({ portal: 'customer', zomaSignup: true });
    expect(parseGoogleOAuthState(encodeGoogleOAuthState('customer', mintZomaSignupIntent())).databricksSignup).toBeUndefined();
    expect(parseGoogleOAuthState('customer~9999999999.db.forged').databricksSignup).toBeUndefined();
    expect(parseGoogleOAuthState(`${state}~x`).databricksSignup).toBeUndefined();
    expect(encodeGoogleOAuthState('genius', mintZomaSignupIntent({ databricks: true }))).toBe('genius');
  });
});
