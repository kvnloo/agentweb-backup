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
  hasGmailCalendarWriteScope,
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
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

describe('hasGmailCalendarWriteScope', () => {
  it('returns true when calendar.events is granted', () => {
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: [GOOGLE_CALENDAR_EVENTS_SCOPE],
    };
    expect(hasGmailCalendarWriteScope(config)).toBe(true);
  });

  it('returns true when the full calendar scope is granted', () => {
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: ['https://www.googleapis.com/auth/calendar'],
    };
    expect(hasGmailCalendarWriteScope(config)).toBe(true);
  });

  it('returns true when calendar write scope is only in legacy scopes array', () => {
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: [],
      scopes: [GOOGLE_CALENDAR_EVENTS_SCOPE],
    };
    expect(hasGmailCalendarWriteScope(config)).toBe(true);
  });

  it('returns FALSE when only calendar.readonly is granted', () => {
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: [GOOGLE_CALENDAR_READONLY_SCOPE],
    };
    expect(hasGmailCalendarWriteScope(config)).toBe(false);
  });

  it('returns FALSE for calendar.events.readonly (read-only events variant)', () => {
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
    };
    expect(hasGmailCalendarWriteScope(config)).toBe(false);
  });

  it('returns FALSE for calendar.settings.readonly', () => {
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: ['https://www.googleapis.com/auth/calendar.settings.readonly'],
    };
    expect(hasGmailCalendarWriteScope(config)).toBe(false);
  });

  it('returns false when no calendar scope is present', () => {
    const config: GmailConfig = {
      ...baseConfig,
      granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    };
    expect(hasGmailCalendarWriteScope(config)).toBe(false);
  });

  it('returns false for undefined/null input', () => {
    expect(hasGmailCalendarWriteScope(undefined)).toBe(false);
    expect(hasGmailCalendarWriteScope(null)).toBe(false);
  });

  it('exports the canonical Google Calendar events scope URL', () => {
    expect(GOOGLE_CALENDAR_EVENTS_SCOPE).toBe(
      'https://www.googleapis.com/auth/calendar.events',
    );
  });
});
