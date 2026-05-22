/**
 * Tests for the centralized field-confidence registry.
 *
 * The registry consolidates per-field confidence assignments that were
 * previously scattered across:
 *   - apolloOrgEnrichment.ts (per-field table for org fields)
 *   - enrichSoReverseLookup.ts (hardcoded 'high' for every field)
 *   - applyApolloMatchToLead.ts (hardcoded 'medium' for employmentHistory,
 *     companyTechStack)
 *
 * Centralizing means each provider × field combination has a single source of
 * truth, and unknown combinations fall back to a safe 'medium' default.
 */

import { getFieldConfidence } from '../services/fieldConfidenceRegistry';

describe('fieldConfidenceRegistry — getFieldConfidence', () => {
  describe('apollo provider — person fields', () => {
    it('employmentHistory: medium', () => {
      expect(getFieldConfidence('apollo', 'employmentHistory')).toBe('medium');
    });
  });

  describe('apollo provider — org fields', () => {
    it('companyTechStack: medium', () => {
      expect(getFieldConfidence('apollo', 'companyTechStack')).toBe('medium');
    });

    it('companyHeadcountGrowth6mo: medium', () => {
      expect(getFieldConfidence('apollo', 'companyHeadcountGrowth6mo')).toBe('medium');
    });

    it('companyHeadcountGrowth12mo: medium', () => {
      expect(getFieldConfidence('apollo', 'companyHeadcountGrowth12mo')).toBe('medium');
    });

    it('companyHeadcountGrowth24mo: medium', () => {
      expect(getFieldConfidence('apollo', 'companyHeadcountGrowth24mo')).toBe('medium');
    });

    it('companyFundingTotal: high (factual public-record)', () => {
      expect(getFieldConfidence('apollo', 'companyFundingTotal')).toBe('high');
    });

    it('companyFundingStage: high (factual public-record)', () => {
      expect(getFieldConfidence('apollo', 'companyFundingStage')).toBe('high');
    });

    it('companyFundingLastRoundDate: high (factual public-record)', () => {
      expect(getFieldConfidence('apollo', 'companyFundingLastRoundDate')).toBe('high');
    });

    it('companyAnnualRevenue: low (Apollo estimate)', () => {
      expect(getFieldConfidence('apollo', 'companyAnnualRevenue')).toBe('low');
    });

    it('companyDepartmentHeadcount: low (Apollo estimate)', () => {
      expect(getFieldConfidence('apollo', 'companyDepartmentHeadcount')).toBe('low');
    });
  });

  describe('enrich.so provider — reverse-lookup fields', () => {
    it('firstName: high', () => {
      expect(getFieldConfidence('enrich.so', 'firstName')).toBe('high');
    });

    it('lastName: high', () => {
      expect(getFieldConfidence('enrich.so', 'lastName')).toBe('high');
    });

    it('email: high', () => {
      expect(getFieldConfidence('enrich.so', 'email')).toBe('high');
    });

    it('headline: high', () => {
      expect(getFieldConfidence('enrich.so', 'headline')).toBe('high');
    });

    it('connectionCount: high', () => {
      expect(getFieldConfidence('enrich.so', 'connectionCount')).toBe('high');
    });

    it('linkedin (profileUrl): high', () => {
      expect(getFieldConfidence('enrich.so', 'linkedin')).toBe('high');
    });

    it('title: medium (job-changers — drift risk)', () => {
      expect(getFieldConfidence('enrich.so', 'title')).toBe('medium');
    });

    it('company: medium (job-changers — drift risk)', () => {
      expect(getFieldConfidence('enrich.so', 'company')).toBe('medium');
    });

    it('pastCompanies: medium (lower-fidelity historical data)', () => {
      expect(getFieldConfidence('enrich.so', 'pastCompanies')).toBe('medium');
    });

    it('skills: medium (lower-fidelity historical data)', () => {
      expect(getFieldConfidence('enrich.so', 'skills')).toBe('medium');
    });

    it('education: medium (lower-fidelity historical data)', () => {
      expect(getFieldConfidence('enrich.so', 'education')).toBe('medium');
    });

    it('summary: medium', () => {
      expect(getFieldConfidence('enrich.so', 'summary')).toBe('medium');
    });

    it('location: high', () => {
      expect(getFieldConfidence('enrich.so', 'location')).toBe('high');
    });
  });

  describe('unknown field → medium default', () => {
    it('apollo + unknown field → medium', () => {
      expect(getFieldConfidence('apollo', 'someFieldThatDoesNotExist')).toBe('medium');
    });

    it('enrich.so + unknown field → medium', () => {
      expect(getFieldConfidence('enrich.so', 'someFieldThatDoesNotExist')).toBe('medium');
    });
  });

  describe('referential stability', () => {
    it('same input returns same output', () => {
      const a = getFieldConfidence('apollo', 'companyFundingTotal');
      const b = getFieldConfidence('apollo', 'companyFundingTotal');
      expect(a).toBe(b);
    });

    it('cross-provider isolation: enrich.so company is medium even though apollo treats it differently', () => {
      // Different providers can have different confidences for nominally-
      // similar fields. Verify they don't collide.
      expect(getFieldConfidence('enrich.so', 'company')).toBe('medium');
      // (apollo company-fields are all org-prefixed; no direct collision today.)
    });
  });

  describe('signal-aware lookup (optional 3rd argument)', () => {
    // The registry takes an optional `signal` hint so future callers can
    // upgrade confidence when the match was made by a strong identifier
    // (linkedin URL) vs a weaker one (name+org). Default lookup ignores
    // signal — same input → same output.
    it('apollo + companyTechStack + linkedin signal still returns medium (signal-aware not required for current fields)', () => {
      expect(getFieldConfidence('apollo', 'companyTechStack', 'linkedin')).toBe('medium');
    });

    it('enrich.so + firstName + email signal still returns high', () => {
      expect(getFieldConfidence('enrich.so', 'firstName', 'email')).toBe('high');
    });
  });
});

describe('APOLLO_FIELD_CONFIDENCE — identity fields (Fix 6)', () => {
  it('FAIL CASE: rates apollo firstName as high', () => {
    expect(getFieldConfidence('apollo', 'firstName')).toBe('high');
  });
  it('FAIL CASE: rates apollo email as high', () => {
    expect(getFieldConfidence('apollo', 'email')).toBe('high');
  });
  it('FAIL CASE: rates apollo company as medium', () => {
    expect(getFieldConfidence('apollo', 'company')).toBe('medium');
  });
  it('FAIL CASE: rates apollo title as medium', () => {
    expect(getFieldConfidence('apollo', 'title')).toBe('medium');
  });
  it('SUCCESS CASE: rates apollo lastName and linkedin high, phone medium', () => {
    expect(getFieldConfidence('apollo', 'lastName')).toBe('high');
    expect(getFieldConfidence('apollo', 'linkedin')).toBe('high');
    expect(getFieldConfidence('apollo', 'phone')).toBe('medium');
  });
});
