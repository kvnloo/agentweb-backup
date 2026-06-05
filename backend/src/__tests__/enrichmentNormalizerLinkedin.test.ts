/**
 * Tests for normalizeFills() — LinkedIn URL validation branch.
 *
 * Verifies malformed LinkedIn URLs are dropped (not persisted), real ones pass,
 * the check is keyed on the CANONICAL name (so aliased custom field names are
 * covered), and non-linkedin fields are never affected.
 */

import { normalizeFills } from '../services/enrichmentNormalizer';
import type { FieldFill } from '../services/enrichmentGroupWaterfall';

function fill(field: string, value: string): FieldFill {
  return { field, value, meta: { source: 'api', enrichedAt: '2026-01-01T00:00:00Z' } };
}

describe('normalizeFills — LinkedIn fields', () => {
  it('drops a company LinkedIn search URL (the real bug) instead of persisting it', () => {
    const result = normalizeFills([
      fill('company_linkedin_url', 'https://www.linkedin.com/search/results/companies/?keywords=Sol Altos Partners'),
    ]);
    expect(result).toHaveLength(0);
  });

  it('keeps a valid /company/ URL', () => {
    const result = normalizeFills([fill('company_linkedin_url', 'https://www.linkedin.com/company/acme-inc')]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('https://www.linkedin.com/company/acme-inc');
  });

  it('keeps a real /school/ org page', () => {
    const result = normalizeFills([fill('company_linkedin_url', 'http://www.linkedin.com/school/alexander-dawson-school')]);
    expect(result).toHaveLength(1);
  });

  it('drops a personal /in/ URL placed in a company linkedin field', () => {
    const result = normalizeFills([fill('company_linkedin_url', 'https://www.linkedin.com/in/janedoe')]);
    expect(result).toHaveLength(0);
  });

  it('keeps a valid personal /in/ URL and drops a person /search/ URL', () => {
    expect(normalizeFills([fill('linkedin_url', 'https://www.linkedin.com/in/maitalsrasmussen')])).toHaveLength(1);
    expect(normalizeFills([fill('linkedin_url', 'https://www.linkedin.com/search/results/people/?keywords=cto')])).toHaveLength(0);
  });

  it('is alias-proof — validates a custom-named field by its canonical alias', () => {
    // User named the field `orgLinkedIn`, aliased to company_linkedin_url.
    const aliases = { orgLinkedIn: 'company_linkedin_url' };
    const bad = normalizeFills([fill('orgLinkedIn', 'https://www.linkedin.com/search/results/companies/?keywords=x')], aliases);
    expect(bad).toHaveLength(0);
    const good = normalizeFills([fill('orgLinkedIn', 'https://www.linkedin.com/company/acme')], aliases);
    expect(good).toHaveLength(1);
  });

  it('never touches non-linkedin fields', () => {
    const result = normalizeFills([
      fill('company', 'Sol Altos Partners'),
      fill('title', 'Health-Tech Executive'),
    ]);
    expect(result).toHaveLength(2);
  });
});
