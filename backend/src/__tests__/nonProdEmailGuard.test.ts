/**
 * ENG-1215 — non-production must not mail real customers.
 *
 * Staging and every preview run with NODE_ENV=development against Dev- prefixed
 * tables, and Dev-AW-Users is a clone of production holding real customer
 * addresses. Before this guard the only environment check in the whole email
 * stack was on sendOncallAlert (an internal alert to our own oncall); every
 * customer-facing send went straight to the provider.
 *
 * The production no-op case is the one that must never regress: a guard that
 * accidentally suppresses real mail is a worse outage than the one it prevents.
 */

import {
  isNonProdEmailGuardActive,
  isRecipientAllowed,
  partitionRecipients,
} from '../utils/nonProdEmailGuard';

const env = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  overrides as NodeJS.ProcessEnv;

describe('ENG-1215 — non-prod email guard activation', () => {
  it('is INACTIVE in production — real mail must never be suppressed', () => {
    expect(isNonProdEmailGuardActive(env({ NODE_ENV: 'production' }))).toBe(false);
  });

  it('is active in development, which is what staging and previews actually run', () => {
    // Verified against the deployed config: Agentweb-backend-env-1 (staging)
    // sets NODE_ENV=development, not "staging".
    expect(isNonProdEmailGuardActive(env({ NODE_ENV: 'development' }))).toBe(true);
  });

  it('is active when NODE_ENV is unset', () => {
    expect(isNonProdEmailGuardActive(env({}))).toBe(true);
  });

  it('can be disabled explicitly for a deliberate staging delivery test', () => {
    expect(
      isNonProdEmailGuardActive(env({ NODE_ENV: 'development', NONPROD_EMAIL_ALLOW_ALL: 'true' })),
    ).toBe(false);
  });

  it('does not treat a non-"true" value as permission', () => {
    for (const value of ['1', 'yes', 'TRUE ', '']) {
      expect(
        isNonProdEmailGuardActive(env({ NODE_ENV: 'development', NONPROD_EMAIL_ALLOW_ALL: value })),
      ).toBe(true);
    }
  });
});

describe('ENG-1215 — allowlist matching', () => {
  it('defaults to @example.com so existing fixtures keep working', () => {
    const e = env({ NODE_ENV: 'development' });
    expect(isRecipientAllowed('test@example.com', e)).toBe(true);
    expect(isRecipientAllowed('a.real.customer@acme.io', e)).toBe(false);
  });

  it('blocks a real address that merely CONTAINS an allowlisted domain', () => {
    // The trap a naive `includes()` falls into: this address is at
    // evil.com, not example.com.
    const e = env({ NODE_ENV: 'development' });
    expect(isRecipientAllowed('example.com@evil.com', e)).toBe(false);
    expect(isRecipientAllowed('user@example.com.evil.com', e)).toBe(false);
  });

  it('matches exact addresses and domain suffixes, case-insensitively', () => {
    const e = env({
      NODE_ENV: 'development',
      NONPROD_EMAIL_ALLOWLIST: 'qa@agentweb.pro, @staging.test',
    });
    expect(isRecipientAllowed('QA@AgentWeb.pro', e)).toBe(true);
    expect(isRecipientAllowed('anyone@STAGING.test', e)).toBe(true);
    expect(isRecipientAllowed('someone.else@agentweb.pro', e)).toBe(false);
  });

  it('treats an empty allowlist as total silence, distinct from unset', () => {
    expect(isRecipientAllowed('test@example.com', env({ NONPROD_EMAIL_ALLOWLIST: '' }))).toBe(false);
    expect(isRecipientAllowed('test@example.com', env({}))).toBe(true);
  });
});

describe('ENG-1215 — recipient partitioning', () => {
  const e = env({ NODE_ENV: 'development' });

  it('suppresses entirely when every primary recipient is blocked', () => {
    const p = partitionRecipients('real@acme.io', undefined, e);
    expect(p.suppressEntirely).toBe(true);
    expect(p.blockedTo).toEqual(['real@acme.io']);
  });

  it('suppresses even when a cc IS allowlisted', () => {
    // Delivering to the cc alone would silently change who the message was
    // addressed to — a different message than the one the caller wrote.
    const p = partitionRecipients('real@acme.io', 'test@example.com', e);
    expect(p.suppressEntirely).toBe(true);
  });

  it('drops only the blocked recipients from a mixed send', () => {
    const p = partitionRecipients(
      ['test@example.com', 'real@acme.io'],
      ['cc@example.com', 'leak@acme.io'],
      e,
    );
    expect(p.suppressEntirely).toBe(false);
    expect(p.allowedTo).toEqual(['test@example.com']);
    expect(p.blockedTo).toEqual(['real@acme.io']);
    expect(p.allowedCc).toEqual(['cc@example.com']);
    expect(p.blockedCc).toEqual(['leak@acme.io']);
  });

  it('suppresses a send with no recipients rather than passing it through', () => {
    expect(partitionRecipients(undefined, undefined, e).suppressEntirely).toBe(true);
  });
});
