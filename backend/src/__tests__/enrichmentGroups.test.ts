// Tests for enrichmentGroups.ts — canonical key builders, normalizers, group config

import {
  buildCompanyCanonicalKey,
  buildPersonCanonicalKey,
  toCanonicalId,
  toFieldGroupSk,
  FIELD_GROUPS,
  type LeadInfo,
} from '../services/enrichmentGroups';

// ─── buildCompanyCanonicalKey ─────────────────────────────────────────────────

describe('buildCompanyCanonicalKey', () => {
  // FAIL: invalid / boundary inputs
  it('returns null when lead has no email, website, or company', () => {
    const lead: LeadInfo = {};
    expect(buildCompanyCanonicalKey(lead)).toBeNull();
  });

  it('returns null when email is a free-domain (gmail) with no company or website', () => {
    const lead: LeadInfo = { email: 'john@gmail.com' };
    expect(buildCompanyCanonicalKey(lead)).toBeNull();
  });

  it('returns null when company normalizes to empty string (only legal suffixes)', () => {
    const lead: LeadInfo = { company: 'Inc. LLC Ltd.' };
    expect(buildCompanyCanonicalKey(lead)).toBeNull();
  });

  it('returns null when website URL is malformed', () => {
    const lead: LeadInfo = { website: 'not-a-url!!!' };
    // Malformed URL falls through to company name, which is also absent
    expect(buildCompanyCanonicalKey(lead)).toBeNull();
  });

  // SUCCESS: valid inputs
  it('uses work email domain as first priority', () => {
    const lead: LeadInfo = { email: 'john@acme.com', company: 'Something Else', website: 'https://other.com' };
    expect(buildCompanyCanonicalKey(lead)).toBe('company:acme.com');
  });

  it('falls back to website domain when email is free-domain', () => {
    const lead: LeadInfo = { email: 'john@gmail.com', website: 'https://www.acme.com' };
    expect(buildCompanyCanonicalKey(lead)).toBe('company:acme.com');
  });

  it('strips www from website domain', () => {
    const lead: LeadInfo = { website: 'https://www.acme.com' };
    expect(buildCompanyCanonicalKey(lead)).toBe('company:acme.com');
  });

  it('falls back to normalized company name as last resort', () => {
    // 'Corp' is a legal suffix so it is stripped: 'Acme Corp' → 'acme'
    const lead: LeadInfo = { email: 'john@gmail.com', company: 'Acme Corp' };
    expect(buildCompanyCanonicalKey(lead)).toBe('company:acme');
  });

  it('strips legal suffixes from company name', () => {
    const lead: LeadInfo = { company: 'Acme Inc' };
    expect(buildCompanyCanonicalKey(lead)).toBe('company:acme');
  });

  it('strips LLC from company name', () => {
    const lead: LeadInfo = { company: 'Widgets LLC' };
    expect(buildCompanyCanonicalKey(lead)).toBe('company:widgets');
  });

  it('normalizes company name to lowercase with hyphens', () => {
    const lead: LeadInfo = { company: 'Big Blue Ocean Ltd' };
    expect(buildCompanyCanonicalKey(lead)).toBe('company:big-blue-ocean');
  });
});

// ─── buildPersonCanonicalKey ──────────────────────────────────────────────────

describe('buildPersonCanonicalKey', () => {
  // FAIL: invalid / boundary inputs
  it('returns null when lead has no email, company, or name', () => {
    const lead: LeadInfo = {};
    expect(buildPersonCanonicalKey(lead)).toBeNull();
  });

  it('returns null when only free email with no company or name', () => {
    const lead: LeadInfo = { email: 'john@gmail.com' };
    expect(buildPersonCanonicalKey(lead)).toBeNull();
  });

  it('returns null when name is whitespace only with no company/email', () => {
    const lead: LeadInfo = { firstName: '  ', lastName: '   ' };
    expect(buildPersonCanonicalKey(lead)).toBeNull();
  });

  // SUCCESS: valid inputs
  it('uses work email as first priority', () => {
    const lead: LeadInfo = { email: 'john@acme.com', firstName: 'John', lastName: 'Doe', company: 'Acme' };
    expect(buildPersonCanonicalKey(lead)).toBe('person:john@acme.com');
  });

  it('lowercases the work email in the key', () => {
    const lead: LeadInfo = { email: 'John.Doe@Acme.COM' };
    expect(buildPersonCanonicalKey(lead)).toBe('person:john.doe@acme.com');
  });

  it('falls back to domain + name when free email + company', () => {
    // 'Corp' is a legal suffix so normalizeCompanyName('Acme Corp') → 'acme'
    const lead: LeadInfo = { email: 'john@gmail.com', company: 'Acme Corp', firstName: 'John', lastName: 'Doe' };
    expect(buildPersonCanonicalKey(lead)).toBe('person:acme:john-doe');
  });

  it('falls back to website domain + name when no work email', () => {
    const lead: LeadInfo = { website: 'https://acme.com', firstName: 'Jane', lastName: 'Smith' };
    expect(buildPersonCanonicalKey(lead)).toBe('person:acme.com:jane-smith');
  });
});

// ─── toCanonicalId ────────────────────────────────────────────────────────────

describe('toCanonicalId', () => {
  it('returns a 64-character hex string (SHA256)', () => {
    const id = toCanonicalId('company:acme.com');
    expect(id).toHaveLength(64);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic — same input always gives same output', () => {
    expect(toCanonicalId('company:acme.com')).toBe(toCanonicalId('company:acme.com'));
  });

  it('is different for different inputs', () => {
    expect(toCanonicalId('company:acme.com')).not.toBe(toCanonicalId('company:other.com'));
  });
});

// ─── toFieldGroupSk ───────────────────────────────────────────────────────────

describe('toFieldGroupSk', () => {
  it('formats as groupName#v{version}', () => {
    expect(toFieldGroupSk('company_firmographic', 1)).toBe('company_firmographic#v1');
  });

  it('includes version number correctly for higher versions', () => {
    expect(toFieldGroupSk('person_identity', 3)).toBe('person_identity#v3');
  });
});

// ─── FIELD_GROUPS config ─────────────────────────────────────────────────────

describe('FIELD_GROUPS', () => {
  const groupNames = Object.keys(FIELD_GROUPS);

  it('defines at least 6 Phase 1 groups', () => {
    expect(groupNames.length).toBeGreaterThanOrEqual(6);
  });

  it('every group has required properties', () => {
    for (const [name, config] of Object.entries(FIELD_GROUPS)) {
      expect(config.entityType).toMatch(/^(company|person)$/);
      expect(config.version).toBeGreaterThan(0);
      expect(Array.isArray(config.fields)).toBe(true);
      expect(config.fields.length).toBeGreaterThan(0);
      expect(Array.isArray(config.sources)).toBe(true);
      expect(config.ttlDays).toBeGreaterThan(0);
      // fail-fast: surface the group name in assertion errors
      if (!config.entityType || !config.version || !config.fields.length || !config.ttlDays) {
        throw new Error(`Group "${name}" is missing required properties`);
      }
    }
  });

  it('company groups use company entityType', () => {
    const companyGroups = ['company_firmographic', 'company_financial', 'company_technographic', 'company_social', 'intent_signals'];
    for (const name of companyGroups) {
      expect(FIELD_GROUPS[name]?.entityType).toBe('company');
    }
  });

  it('person_identity uses person entityType', () => {
    expect(FIELD_GROUPS.person_identity?.entityType).toBe('person');
  });

  it('company_firmographic includes company_linkedin_url', () => {
    expect(FIELD_GROUPS.company_firmographic.fields).toContain('company_linkedin_url');
  });

  it('person_identity includes linkedin as a source', () => {
    expect(FIELD_GROUPS.person_identity.sources).toContain('linkedin');
  });

  it('intent_signals has shorter TTL than company_firmographic', () => {
    expect(FIELD_GROUPS.intent_signals.ttlDays).toBeLessThan(FIELD_GROUPS.company_firmographic.ttlDays);
  });
});
