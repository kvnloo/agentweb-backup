/**
 * Unit tests for hasGmailCalendarScope helper.
 *
 * Context: Historically the gmail OAuth /connect path only populated
 * `GmailConfig.granted_scopes`, leaving the generic
 * `BaseOAuthConfig.scopes` field empty. That meant any downstream caller
 * that looked at `.scopes` concluded calendar wasn't granted even when it
 * was. This helper reads BOTH fields so both old and new records work.
 */
import {
  hasGmailCalendarScope,
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GmailConfig,
} from '../services/connectedAccountsDb';

const baseConfig = {
  account_type: 'gmail' as const,
  email: 'user@example.com',
  access_token: 'access',
  refresh_token: 'refresh',
  token_expires_at: Date.now() + 3600_000,
};

describe('hasGmailCalendarScope', () => {
  it('returns true when calendar.readonly is in granted_scopes', () => {
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: [GOOGLE_CALENDAR_READONLY_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly'],
    };
    expect(hasGmailCalendarScope(config)).toBe(true);
  });

  it('returns true when calendar scope is only in the legacy scopes array (old records)', () => {
    // Simulates a record written before the scopes-persistence fix: the
    // new granted_scopes field is empty, but the legacy BaseOAuthConfig.scopes
    // field from an older code path has the calendar scope.
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: [],
      scopes: [GOOGLE_CALENDAR_READONLY_SCOPE],
    };
    expect(hasGmailCalendarScope(config)).toBe(true);
  });

  it('returns false when neither field contains a calendar scope', () => {
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
      ],
    };
    expect(hasGmailCalendarScope(config)).toBe(false);
  });

  it('returns false when both fields are empty', () => {
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: [],
      scopes: [],
    };
    expect(hasGmailCalendarScope(config)).toBe(false);
  });

  it('returns false for undefined/null input', () => {
    expect(hasGmailCalendarScope(undefined)).toBe(false);
    expect(hasGmailCalendarScope(null)).toBe(false);
  });

  it('exports the canonical Google Calendar scope URL', () => {
    expect(GOOGLE_CALENDAR_READONLY_SCOPE).toBe(
      'https://www.googleapis.com/auth/calendar.readonly',
    );
  });
});
