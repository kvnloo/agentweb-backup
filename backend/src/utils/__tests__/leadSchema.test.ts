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

  // ENG-1176 — denormalized click IDs.
  //
  // firstTouch.clickIds.gclid is written correctly today but is only reachable
  // by walking the blob, so "what share of this account's leads carry a click
  // ID" is not answerable by query (ENG-926 §F). These cover the denormalized
  // top-level `clickIds` map.
  describe('clickIds denormalization (ENG-1176)', () => {
    const gclidTouch: AttributionTouch = {
      timestamp: '2026-08-13T10:00:00.000Z',
      utm: { source: 'google', medium: 'cpc', campaign: 'brand' },
      clickIds: { gclid: 'Cj0KCQjw_test_gclid' },
      landingUrl: 'https://example.com/?gclid=Cj0KCQjw_test_gclid',
    };

    it('denormalizes clickIds from firstTouch', () => {
      const fields = buildLeadAttributionFields({ firstTouch: gclidTouch });
      expect(fields.clickIds).toEqual({ gclid: 'Cj0KCQjw_test_gclid' });
    });

    it('carries every captured platform, not just gclid', () => {
      const multi: AttributionTouch = {
        timestamp: '2026-08-13T10:00:00.000Z',
        clickIds: { gclid: 'g-1', fbclid: 'f-1' },
      };
      const fields = buildLeadAttributionFields({ firstTouch: multi });
      expect(fields.clickIds).toEqual({ gclid: 'g-1', fbclid: 'f-1' });
    });

    it('carries a platform the schema never named, with no code change', () => {
      // AC3: adding a third platform must not require a schema change. ttclid
      // and liFatId are already captured by normalizeAttribution; anything else
      // an upstream capture adds must survive too.
      const exotic = {
        timestamp: '2026-08-13T10:00:00.000Z',
        clickIds: { msclkid: 'm-1' },
      } as unknown as AttributionTouch;
      const fields = buildLeadAttributionFields({ firstTouch: exotic });
      expect(fields.clickIds).toEqual({ msclkid: 'm-1' });
    });

    it('omits clickIds entirely when firstTouch has no clickIds block', () => {
      // AC4: a lead written before this change, or from an untagged visit,
      // reports the field as ABSENT — never an empty object, which would count
      // as "carries a click ID" in an attribute_exists check.
      const fields = buildLeadAttributionFields({ firstTouch: fullTouch });
      expect('clickIds' in fields).toBe(false);
    });

    it('omits clickIds when every captured value is blank', () => {
      const blank = {
        timestamp: '2026-08-13T10:00:00.000Z',
        clickIds: { gclid: '   ', fbclid: '' },
      } as unknown as AttributionTouch;
      const fields = buildLeadAttributionFields({ firstTouch: blank });
      expect('clickIds' in fields).toBe(false);
    });

    it('drops blank values but keeps the populated ones', () => {
      const partial = {
        timestamp: '2026-08-13T10:00:00.000Z',
        clickIds: { gclid: 'g-1', fbclid: '  ' },
      } as unknown as AttributionTouch;
      const fields = buildLeadAttributionFields({ firstTouch: partial });
      expect(fields.clickIds).toEqual({ gclid: 'g-1' });
    });

    it('ignores non-string click-ID values rather than storing them', () => {
      const junk = {
        timestamp: '2026-08-13T10:00:00.000Z',
        clickIds: { gclid: 12345, fbclid: null, ttclid: 'ok' },
      } as unknown as AttributionTouch;
      const fields = buildLeadAttributionFields({ firstTouch: junk });
      expect(fields.clickIds).toEqual({ ttclid: 'ok' });
    });

    it('does not derive clickIds from lastTouch', () => {
      // AC2: set-once, mirroring firstTouch. A repeat visit carrying a new
      // gclid must not overwrite the click that actually acquired the lead.
      const fields = buildLeadAttributionFields({ lastTouch: gclidTouch });
      expect('clickIds' in fields).toBe(false);
    });

    it('prefers an explicit clickIds override over the derived value', () => {
      const fields = buildLeadAttributionFields({
        firstTouch: gclidTouch,
        clickIds: { gclid: 'admin-corrected' },
      });
      expect(fields.clickIds).toEqual({ gclid: 'admin-corrected' });
    });

    it('falls back to the derived value when the override is empty or malformed', () => {
      expect(
        buildLeadAttributionFields({ firstTouch: gclidTouch, clickIds: {} }).clickIds
      ).toEqual({ gclid: 'Cj0KCQjw_test_gclid' });
      expect(
        buildLeadAttributionFields({
          firstTouch: gclidTouch,
          clickIds: 'not-an-object' as unknown as Record<string, string>,
        }).clickIds
      ).toEqual({ gclid: 'Cj0KCQjw_test_gclid' });
    });

    it('does not mutate the caller\'s firstTouch', () => {
      const touch: AttributionTouch = {
        timestamp: '2026-08-13T10:00:00.000Z',
        clickIds: { gclid: 'g-1' },
      };
      const before = JSON.parse(JSON.stringify(touch));
      const fields = buildLeadAttributionFields({ firstTouch: touch });
      expect(touch).toEqual(before);
      // The denormalized copy must not alias the blob's own object.
      expect(fields.clickIds).not.toBe(touch.clickIds);
    });
  });
});
