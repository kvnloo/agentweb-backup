/**
 * Tests for leadSchema (A1 — CRM Unification v1).
 */

import {
  extractDomainFromEmail,
  validateLeadCrmExtensions,
  buildLeadCrmFields,
  buildLeadCrmUpdateFragments,
  buildLeadAttributionFields,
  LEAD_LIFECYCLES,
  LEAD_ROLES,
} from '../leadSchema';
import type { AttributionTouch } from '../../types/attribution';

describe('extractDomainFromEmail', () => {
  it('pulls the domain from a plain business email', () => {
    expect(extractDomainFromEmail('jane@acme.com')).toBe('acme.com');
  });

  it('lowercases mixed-case domains', () => {
    expect(extractDomainFromEmail('Jane@ACME.Com')).toBe('acme.com');
  });

  it('trims whitespace and trailing dots', () => {
    expect(extractDomainFromEmail('  jane@acme.com.  ')).toBe('acme.com');
  });

  it('returns undefined for free-email providers (gmail, yahoo, etc.)', () => {
    expect(extractDomainFromEmail('x@gmail.com')).toBeUndefined();
    expect(extractDomainFromEmail('x@yahoo.com')).toBeUndefined();
    expect(extractDomainFromEmail('x@outlook.com')).toBeUndefined();
    expect(extractDomainFromEmail('x@icloud.com')).toBeUndefined();
    expect(extractDomainFromEmail('x@protonmail.com')).toBeUndefined();
  });

  it('returns undefined for malformed input', () => {
    expect(extractDomainFromEmail('')).toBeUndefined();
    expect(extractDomainFromEmail('not-an-email')).toBeUndefined();
    expect(extractDomainFromEmail('@no-local.com')).toBeUndefined();
    expect(extractDomainFromEmail('no-domain@')).toBeUndefined();
    expect(extractDomainFromEmail('no-tld@acme')).toBeUndefined();
    expect(extractDomainFromEmail(null)).toBeUndefined();
    expect(extractDomainFromEmail(undefined)).toBeUndefined();
  });

  it('handles plus-addressing without affecting the domain', () => {
    expect(extractDomainFromEmail('jane+crm@acme.com')).toBe('acme.com');
  });
});

describe('validateLeadCrmExtensions', () => {
  it('accepts all valid enum values', () => {
    expect(() =>
      validateLeadCrmExtensions({
        priority: 'High',
        lifecycle: 'paying',
        role: 'KDM',
        heatScore: 75,
        healthScore: 40,
      })
    ).not.toThrow();
  });

  it('rejects invalid priority', () => {
    expect(() => validateLeadCrmExtensions({ priority: 'Urgent' as any })).toThrow(/priority/);
  });

  it('rejects invalid lifecycle', () => {
    expect(() => validateLeadCrmExtensions({ lifecycle: 'zombie' as any })).toThrow(/lifecycle/);
  });

  it('rejects invalid role', () => {
    expect(() => validateLeadCrmExtensions({ role: 'Boss' as any })).toThrow(/role/);
  });

  it('rejects heatScore outside 0-100', () => {
    expect(() => validateLeadCrmExtensions({ heatScore: 150 })).toThrow(/heatScore/);
    expect(() => validateLeadCrmExtensions({ heatScore: -5 })).toThrow(/heatScore/);
  });

  it('rejects non-numeric heatScore', () => {
    expect(() => validateLeadCrmExtensions({ heatScore: '80' as any })).toThrow(/heatScore/);
    expect(() => validateLeadCrmExtensions({ heatScore: NaN })).toThrow(/heatScore/);
  });

  it('rejects healthScore outside 0-100', () => {
    expect(() => validateLeadCrmExtensions({ healthScore: 101 })).toThrow(/healthScore/);
  });

  it('rejects healthScore NaN', () => {
    expect(() => validateLeadCrmExtensions({ healthScore: NaN })).toThrow(/healthScore/);
  });

  it('rejects non-array dealIds', () => {
    expect(() => validateLeadCrmExtensions({ dealIds: 'deal_1' as any })).toThrow(/dealIds/);
  });

  it('is a no-op for fully-undefined extensions', () => {
    expect(() => validateLeadCrmExtensions({})).not.toThrow();
  });

  it('exports stable lifecycle and role lists', () => {
    expect(LEAD_LIFECYCLES).toEqual([
      'unknown',
      'inbox',
      'signed_up',
      'in_deal',
      'trialing',
      'paying',
      'at_risk',
      'churned',
    ]);
    expect(LEAD_ROLES).toEqual(['KDM', 'Champion', 'Blocker', 'Influencer', 'Other']);
  });
});

describe('buildLeadCrmFields', () => {
  it('derives domain from email when not explicitly provided', () => {
    const fields = buildLeadCrmFields('jane@acme.com');
    expect(fields.domain).toBe('acme.com');
  });

  it('prefers an explicit domain over the email-derived one', () => {
    const fields = buildLeadCrmFields('jane@acme.com', { domain: 'override.io' });
    expect(fields.domain).toBe('override.io');
  });

  it('defaults lifecycle to "inbox" when an email exists and no lifecycle is supplied', () => {
    const fields = buildLeadCrmFields('jane@acme.com');
    expect(fields.lifecycle).toBe('inbox');
  });

  it('keeps an explicit lifecycle unchanged', () => {
    const fields = buildLeadCrmFields('jane@acme.com', { lifecycle: 'paying' });
    expect(fields.lifecycle).toBe('paying');
  });

  it('omits lifecycle when email is missing and none is supplied (domain-only contacts)', () => {
    const fields = buildLeadCrmFields(null);
    expect(fields.lifecycle).toBeUndefined();
    expect(fields.domain).toBeUndefined();
  });

  it('persists heatScore, healthScore, dealIds, role, isPrimary, priority', () => {
    const fields = buildLeadCrmFields('jane@acme.com', {
      heatScore: 80,
      healthScore: 65,
      dealIds: ['deal_1', 'deal_2'],
      role: 'KDM',
      isPrimary: true,
      priority: 'High',
      accountOwnerUserId: 'user_abc',
      expectedClose: '2026-05-01',
      closedDate: '2026-05-15',
    });
    expect(fields).toMatchObject({
      heatScore: 80,
      healthScore: 65,
      dealIds: ['deal_1', 'deal_2'],
      role: 'KDM',
      isPrimary: true,
      priority: 'High',
      accountOwnerUserId: 'user_abc',
      expectedClose: '2026-05-01',
      closedDate: '2026-05-15',
    });
  });

  it('does not write empty dealIds arrays', () => {
    const fields = buildLeadCrmFields('jane@acme.com', { dealIds: [] });
    expect('dealIds' in fields).toBe(false);
  });

  it('persists pocEmails when provided', () => {
    const fields = buildLeadCrmFields('jane@acme.com', { pocEmails: ['a@b.com', 'c@d.com'] });
    expect(fields.pocEmails).toEqual(['a@b.com', 'c@d.com']);
  });

  it('does not write empty pocEmails arrays', () => {
    const fields = buildLeadCrmFields('jane@acme.com', { pocEmails: [] });
    expect('pocEmails' in fields).toBe(false);
  });

  it('throws on invalid extension values', () => {
    expect(() => buildLeadCrmFields('jane@acme.com', { lifecycle: 'zombie' as any })).toThrow();
  });

  it('does not default lifecycle for free-email addresses without a domain', () => {
    // Free-email: no company domain derived, but we still know who the person is,
    // so lifecycle='inbox' is still appropriate — the spec says default when email exists.
    const fields = buildLeadCrmFields('jane@gmail.com');
    expect(fields.domain).toBeUndefined();
    expect(fields.lifecycle).toBe('inbox');
  });
});

describe('buildLeadCrmUpdateFragments', () => {
  it('emits SET fragments for provided scalar fields', () => {
    const { setFields, removeFields } = buildLeadCrmUpdateFragments({
      heatScore: 90,
      lifecycle: 'paying',
      priority: 'High',
    });
    const attrs = setFields.map(f => f.attr);
    expect(attrs).toContain('heatScore');
    expect(attrs).toContain('lifecycle');
    expect(attrs).toContain('priority');
    expect(removeFields).toEqual([]);
  });

  it('emits REMOVE fragments for explicit null values on scalar fields', () => {
    const { setFields, removeFields } = buildLeadCrmUpdateFragments({
      priority: null as any,
      accountOwnerUserId: null as any,
    });
    expect(removeFields).toContain('priority');
    expect(removeFields).toContain('accountOwnerUserId');
    expect(setFields.map(f => f.attr)).not.toContain('priority');
  });

  it('removes dealIds when an empty array is supplied', () => {
    const { setFields, removeFields } = buildLeadCrmUpdateFragments({ dealIds: [] });
    expect(removeFields).toContain('dealIds');
    expect(setFields).toEqual([]);
  });

  it('sets dealIds when a non-empty array is supplied', () => {
    const { setFields, removeFields } = buildLeadCrmUpdateFragments({ dealIds: ['deal_1'] });
    expect(setFields.find(f => f.attr === 'dealIds')?.value).toEqual(['deal_1']);
    expect(removeFields).not.toContain('dealIds');
  });

  it('sets pocEmails when a non-empty array is supplied', () => {
    const { setFields, removeFields } = buildLeadCrmUpdateFragments({ pocEmails: ['a@b.com'] });
    expect(setFields.find(f => f.attr === 'pocEmails')?.value).toEqual(['a@b.com']);
    expect(removeFields).not.toContain('pocEmails');
  });

  it('removes pocEmails when an empty array is supplied', () => {
    const { setFields, removeFields } = buildLeadCrmUpdateFragments({ pocEmails: [] });
    expect(removeFields).toContain('pocEmails');
    expect(setFields.find(f => f.attr === 'pocEmails')).toBeUndefined();
  });

  it('sets isPrimary=false correctly (boolean, not treated as empty)', () => {
    const { setFields, removeFields } = buildLeadCrmUpdateFragments({ isPrimary: false });
    expect(setFields.find(f => f.attr === 'isPrimary')?.value).toBe(false);
    expect(removeFields).not.toContain('isPrimary');
  });

  it('returns empty fragments when nothing is provided', () => {
    const { setFields, removeFields } = buildLeadCrmUpdateFragments({});
    expect(setFields).toEqual([]);
    expect(removeFields).toEqual([]);
  });

  it('validates before building fragments', () => {
    expect(() => buildLeadCrmUpdateFragments({ heatScore: 200 })).toThrow(/heatScore/);
  });
});

describe('buildLeadAttributionFields', () => {
  const fullTouch: AttributionTouch = {
    timestamp: '2026-04-19T10:00:00.000Z',
    utm: { source: 'linkedin', medium: 'social', campaign: 'launch' },
    referrer: 'https://linkedin.com/feed',
    landingUrl: 'https://agentweb.pro/?utm_source=linkedin',
  };

  it('writes firstTouch and lastTouch when both provided', () => {
    const fields = buildLeadAttributionFields({ firstTouch: fullTouch, lastTouch: fullTouch });
    expect(fields.firstTouch).toEqual(fullTouch);
    expect(fields.lastTouch).toEqual(fullTouch);
  });

  it('denormalizes utmSource and utmMedium from firstTouch', () => {
    const fields = buildLeadAttributionFields({ firstTouch: fullTouch });
    expect(fields.utmSource).toBe('linkedin');
    expect(fields.utmMedium).toBe('social');
  });

  it('prefers explicit utmSource/utmMedium over derived values', () => {
    const fields = buildLeadAttributionFields({
      firstTouch: fullTouch,
      utmSource: 'meta',
      utmMedium: 'cpc',
    });
    expect(fields.utmSource).toBe('meta');
    expect(fields.utmMedium).toBe('cpc');
  });

  it('returns empty object when no attribution provided', () => {
    expect(buildLeadAttributionFields({})).toEqual({});
    expect(buildLeadAttributionFields({ firstTouch: undefined })).toEqual({});
  });

  it('omits utmSource/utmMedium when firstTouch has no utm block', () => {
    const noUtm: AttributionTouch = {
      timestamp: '2026-04-19T10:00:00.000Z',
      referrer: 'https://example.com',
    };
    const fields = buildLeadAttributionFields({ firstTouch: noUtm });
    expect(fields.firstTouch).toEqual(noUtm);
    expect('utmSource' in fields).toBe(false);
    expect('utmMedium' in fields).toBe(false);
  });

  it('accepts lastTouch without firstTouch', () => {
    const fields = buildLeadAttributionFields({ lastTouch: fullTouch });
    expect(fields.lastTouch).toEqual(fullTouch);
    expect('firstTouch' in fields).toBe(false);
    // No firstTouch -> no denormalized utmSource/utmMedium
    expect('utmSource' in fields).toBe(false);
  });

  it('ignores empty-string utmSource/utmMedium', () => {
    const fields = buildLeadAttributionFields({
      firstTouch: fullTouch,
      utmSource: '   ',
      utmMedium: '',
    });
    // Falls back to derived values from firstTouch
    expect(fields.utmSource).toBe('linkedin');
    expect(fields.utmMedium).toBe('social');
  });
});
