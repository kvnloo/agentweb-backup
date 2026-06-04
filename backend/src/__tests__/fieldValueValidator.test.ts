import { isValidFieldValue, linkedinUrlOrUndef } from '../services/fieldValueValidator';

describe('isValidFieldValue', () => {
  // ─── FAIL cases ──────────────────────────────────────────────────────────
  describe('rejects invalid values', () => {
    it('rejects a LinkedIn search URL for a company linkedin field (the real bug)', () => {
      expect(
        isValidFieldValue(
          'company_linkedin_url',
          'https://www.linkedin.com/search/results/companies/?keywords=Sol Altos Partners',
        ),
      ).toBe(false);
      expect(isValidFieldValue('companyLinkedin', 'https://www.linkedin.com/search/results/companies/?keywords=foo')).toBe(false);
    });

    it('rejects a personal /in/ URL placed in a company linkedin field', () => {
      expect(isValidFieldValue('company_linkedin_url', 'https://www.linkedin.com/in/janedoe')).toBe(false);
    });

    it('rejects lookalike domains (host anchor)', () => {
      expect(isValidFieldValue('company_linkedin_url', 'https://notlinkedin.com/company/acme')).toBe(false);
      expect(isValidFieldValue('linkedin_url', 'https://notlinkedin.com/in/janedoe')).toBe(false);
    });

    it('rejects subdomain spoofing', () => {
      expect(isValidFieldValue('company_linkedin_url', 'https://evil.linkedin.com/company/acme')).toBe(false);
      expect(isValidFieldValue('linkedin_url', 'https://evil.linkedin.com/in/janedoe')).toBe(false);
    });

    it('rejects open-redirect embedding', () => {
      expect(isValidFieldValue('company_linkedin_url', 'https://attacker.com/?url=linkedin.com/company/acme')).toBe(false);
      expect(isValidFieldValue('linkedin_url', 'https://attacker.com/?url=linkedin.com/in/janedoe')).toBe(false);
    });

    it('rejects a company /company/ URL placed in a personal linkedin field', () => {
      expect(isValidFieldValue('linkedin', 'https://www.linkedin.com/company/acme')).toBe(false);
      expect(isValidFieldValue('linkedin_url', 'https://www.linkedin.com/search/results/people/?keywords=cto')).toBe(false);
    });

    it('rejects /pub/dir/ legacy profile URLs', () => {
      expect(isValidFieldValue('linkedin_url', 'https://www.linkedin.com/pub/dir/jane/doe')).toBe(false);
      expect(isValidFieldValue('company_linkedin_url', 'https://www.linkedin.com/pub/dir/acme/corp')).toBe(false);
    });

    it('rejects malformed / non-URL strings', () => {
      expect(isValidFieldValue('linkedin_url', 'linkedin.com/in/janedoe')).toBe(false);
      expect(isValidFieldValue('company_linkedin_url', 'not-a-url')).toBe(false);
    });

    it('rejects empty / non-string values for the linkedin URL fields only', () => {
      expect(isValidFieldValue('linkedin', '')).toBe(false);
      expect(isValidFieldValue('companyLinkedin', '')).toBe(false);
      // @ts-expect-error — exercising the runtime guard against non-string input
      expect(isValidFieldValue('linkedin', null)).toBe(false);
      // @ts-expect-error — exercising the runtime guard against non-string input
      expect(isValidFieldValue('companyLinkedin', undefined)).toBe(false);
    });
  });

  // ─── SUCCESS cases ───────────────────────────────────────────────────────
  describe('accepts valid values', () => {
    it('accepts a real /company/ URL for company linkedin fields', () => {
      expect(isValidFieldValue('company_linkedin_url', 'https://www.linkedin.com/company/acme-inc')).toBe(true);
      expect(isValidFieldValue('companyLinkedin', 'https://www.linkedin.com/company/acme-inc/')).toBe(true);
    });

    it('accepts /school/ and /showcase/ org pages for company linkedin fields', () => {
      // Real value found in the DB — educational institutions use /school/.
      expect(isValidFieldValue('companyLinkedin', 'http://www.linkedin.com/school/alexander-dawson-school')).toBe(true);
      expect(isValidFieldValue('company_linkedin_url', 'https://www.linkedin.com/showcase/acme-cloud/')).toBe(true);
    });

    it('accepts a real /in/ URL for personal linkedin fields', () => {
      expect(isValidFieldValue('linkedin', 'https://www.linkedin.com/in/maitalsrasmussen')).toBe(true);
      expect(isValidFieldValue('linkedin_url', 'https://www.linkedin.com/in/janedoe/')).toBe(true);
    });

    it('leaves non-linkedin fields untouched', () => {
      expect(isValidFieldValue('company', 'Sol Altos Partners')).toBe(true);
      expect(isValidFieldValue('title', 'Health-Tech Executive')).toBe(true);
      expect(isValidFieldValue('emailDomain', 'r-comms.com')).toBe(true);
      expect(isValidFieldValue('stage', 'Prospect')).toBe(true);
    });

    it('never gates non-linkedin fields — even empty / non-string values pass through', () => {
      expect(isValidFieldValue('company', '')).toBe(true);
      expect(isValidFieldValue('phone', '')).toBe(true);
      // @ts-expect-error — non-string still passes through for non-linkedin fields
      expect(isValidFieldValue('notes', null)).toBe(true);
    });

    it('does NOT shape-validate non-URL linkedin-named fields (regression guard)', () => {
      // linkedin_followers is a canonical enrichable field holding a count, not a URL.
      // The allowlist must NOT treat it as a URL field, or legit values get dropped.
      expect(isValidFieldValue('linkedin_followers', '5400')).toBe(true);
      expect(isValidFieldValue('linkedinFollowers', '5400')).toBe(true);
      expect(isValidFieldValue('linkedin_headline', 'CEO at Acme')).toBe(true);
    });
  });
});

describe('linkedinUrlOrUndef', () => {
  it('returns the URL for a valid http /in/ profile', () => {
    expect(linkedinUrlOrUndef('linkedin', 'https://www.linkedin.com/in/janedoe')).toBe('https://www.linkedin.com/in/janedoe');
  });

  it('returns undefined for a /search/ URL (the enrich.so garbage case)', () => {
    expect(linkedinUrlOrUndef('linkedin', 'https://www.linkedin.com/search/results/people/?keywords=cto')).toBeUndefined();
  });

  it('returns undefined for a non-http value even if it looks like a profile', () => {
    expect(linkedinUrlOrUndef('linkedin', 'linkedin.com/in/janedoe')).toBeUndefined();
  });

  it('returns undefined for empty / null / undefined', () => {
    expect(linkedinUrlOrUndef('linkedin', '')).toBeUndefined();
    expect(linkedinUrlOrUndef('linkedin', null)).toBeUndefined();
    expect(linkedinUrlOrUndef('linkedin', undefined)).toBeUndefined();
  });

  it('applies the company rule when field is a company linkedin field', () => {
    expect(linkedinUrlOrUndef('companyLinkedin', 'https://www.linkedin.com/company/acme')).toBe('https://www.linkedin.com/company/acme');
    expect(linkedinUrlOrUndef('companyLinkedin', 'https://www.linkedin.com/in/janedoe')).toBeUndefined();
  });
});
