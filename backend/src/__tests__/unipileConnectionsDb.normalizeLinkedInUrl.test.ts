/**
 * Tests for normalizeLinkedInUrl in unipileConnectionsDb.
 *
 * This normalizer produces the GSI key used to match a lead's stored LinkedIn URL
 * against the AW-UnipileConnections cache (which the sync cron populates from
 * Unipile's canonical `https://www.linkedin.com/in/<slug>/` URLs).
 *
 * ENG-377: leads whose stored URL uses a different scheme (`http://`) or omits
 * `www.` never matched their cached connection, so get_lead_details reported
 * `isConnected: false` for people who ARE 1st-degree connections. The normalizer
 * must canonicalize scheme + www + query/fragment so read keys match the stored
 * `https://www.linkedin.com/in/<slug>/` keys, while preserving the trailing slash
 * (the form already persisted in the cache).
 */

import { normalizeLinkedInUrl } from '../services/unipileConnectionsDb';

describe('unipileConnectionsDb.normalizeLinkedInUrl', () => {
  // The canonical stored key form the sync cron writes (Unipile https + www + slash).
  const CANONICAL = 'https://www.linkedin.com/in/jinbaik/';

  it('canonicalizes an http:// lead URL to the stored https form (ENG-377 Jin Baik)', () => {
    expect(normalizeLinkedInUrl('http://www.linkedin.com/in/jinbaik')).toBe(CANONICAL);
  });

  it('canonicalizes an http:// lead URL without trailing slash (ENG-377 Sri)', () => {
    expect(normalizeLinkedInUrl('http://www.linkedin.com/in/srisunda')).toBe(
      'https://www.linkedin.com/in/srisunda/',
    );
  });

  it('adds a missing www. so no-www URLs match the stored key', () => {
    expect(normalizeLinkedInUrl('https://linkedin.com/in/jinbaik')).toBe(CANONICAL);
  });

  it('strips query strings and fragments before keying', () => {
    expect(normalizeLinkedInUrl('https://www.linkedin.com/in/jinbaik?originalSubdomain=ca')).toBe(CANONICAL);
    expect(normalizeLinkedInUrl('https://www.linkedin.com/in/jinbaik/#about')).toBe(CANONICAL);
  });

  it('is idempotent on the already-canonical stored form', () => {
    expect(normalizeLinkedInUrl(CANONICAL)).toBe(CANONICAL);
  });

  it('lowercases mixed-case URLs', () => {
    expect(normalizeLinkedInUrl('HTTPS://WWW.LinkedIn.com/in/JinBaik')).toBe(CANONICAL);
  });

  it('returns empty string for empty/whitespace input', () => {
    expect(normalizeLinkedInUrl('')).toBe('');
    expect(normalizeLinkedInUrl('   ')).toBe('');
  });
});
