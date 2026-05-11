import {
  mapApolloPerson,
  mapApolloOrganization,
  mapApolloMatchResponse,
} from '../services/apolloFieldMapper';

describe('apolloFieldMapper', () => {
  describe('mapApolloPerson', () => {
    it('projects all common person fields', () => {
      const person = {
        id: 'p_1',
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'jane@acme.com',
        email_status: 'verified',
        title: 'VP Engineering',
        seniority: 'vp',
        headline: 'Engineering leader',
        linkedin_url: 'https://www.linkedin.com/in/janedoe/',
        twitter_url: 'https://twitter.com/jane',
        city: 'San Francisco',
        state: 'CA',
        country: 'USA',
        time_zone: 'America/Los_Angeles',
        departments: ['engineering', 'product'],
        functions: ['leadership'],
        phone_numbers: [{ sanitized_number: '+14155551234', type: 'work' }],
        employment_history: [
          { organization_name: 'Acme', title: 'VP Eng', current: true, start_date: '2024-01-01' },
          { organization_name: 'Globex', title: 'Director', current: false, start_date: '2020-01-01', end_date: '2023-12-31' },
        ],
      };
      const m = mapApolloPerson(person, { hadLinkedinUrl: true, hadEmail: true });
      expect(m.firstName).toBe('Jane');
      expect(m.email).toBe('jane@acme.com');
      expect(m.phone).toBe('+14155551234');
      expect(m.employmentHistory).toHaveLength(2);
      expect(m.employmentHistory![0].current).toBe(true);
      expect(m.fieldConfidence.email).toBe('high');         // verified status
      expect(m.fieldConfidence.firstName).toBe('high');     // 2 strong identifiers
    });

    it('marks email confidence low when guessed', () => {
      const m = mapApolloPerson(
        { id: 'p', email: 'x@y.com', email_status: 'guessed' },
        { hadLinkedinUrl: false, hadEmail: false, hadNameAndOrg: true },
      );
      expect(m.fieldConfidence.email).toBe('low');
    });

    it('drops empty employment_history entries with neither org nor title', () => {
      const m = mapApolloPerson(
        { id: 'p', employment_history: [{ description: 'unknown' }, { organization_name: 'X' }] },
      );
      expect(m.employmentHistory).toHaveLength(1);
      expect(m.employmentHistory![0].organizationName).toBe('X');
    });

    it('returns no fieldConfidence entry for fields not present', () => {
      const m = mapApolloPerson({ id: 'p' });
      expect(m.fieldConfidence.firstName).toBeUndefined();
    });

    it('falls back to raw_number when sanitized_number missing', () => {
      const m = mapApolloPerson({ id: 'p', phone_numbers: [{ raw_number: '4155551234' }] });
      expect(m.phone).toBe('4155551234');
    });
  });

  describe('mapApolloOrganization', () => {
    it('projects firmographic fields', () => {
      const org = {
        id: 'o_1',
        name: 'Acme',
        primary_domain: 'acme.com',
        industry: 'software',
        estimated_num_employees: 500,
        founded_year: 2010,
        annual_revenue: 50_000_000,
        annual_revenue_printed: '$50M',
        total_funding: 30_000_000,
        latest_funding_stage: 'Series B',
        latest_funding_round_date: '2025-06-01',
        technology_names: ['React', 'AWS', 'PostgreSQL'],
        organization_headcount_six_month_growth: 0.15,
        organization_headcount_twelve_month_growth: 0.32,
        organization_headcount_twenty_four_month_growth: 0.61,
        departmental_head_count: { engineering: 120, sales: 80 },
        city: 'San Francisco',
        country: 'USA',
        website_url: 'https://acme.com',
        linkedin_url: 'https://linkedin.com/company/acme',
      };
      const m = mapApolloOrganization(org);
      expect(m.name).toBe('Acme');
      expect(m.techStack).toEqual(['React', 'AWS', 'PostgreSQL']);
      expect(m.headcountGrowth12mo).toBe(0.32);
      expect(m.departmentHeadcount).toEqual({ engineering: 120, sales: 80 });
      expect(m.totalFunding).toBe(30_000_000);
    });

    it('handles missing org gracefully', () => {
      const m = mapApolloOrganization({});
      expect(m.name).toBeUndefined();
      expect(m.techStack).toBeUndefined();
    });
  });

  describe('mapApolloMatchResponse', () => {
    it('returns null when person missing', () => {
      expect(mapApolloMatchResponse({ person: null })).toBeNull();
      expect(mapApolloMatchResponse(null)).toBeNull();
      expect(mapApolloMatchResponse({})).toBeNull();
    });

    it('returns null when person.id missing (Apollo signal for not-matched)', () => {
      expect(mapApolloMatchResponse({ person: { first_name: 'X' } })).toBeNull();
    });

    it('maps both person and nested organization', () => {
      const r = mapApolloMatchResponse(
        {
          request_id: 'req_xyz',
          person: {
            id: 'p',
            first_name: 'A',
            organization: { id: 'o', name: 'Acme', primary_domain: 'acme.com' },
          },
        },
        { hadLinkedinUrl: true },
      );
      expect(r!.person.firstName).toBe('A');
      expect(r!.organization!.name).toBe('Acme');
      expect(r!.requestId).toBe('req_xyz');
    });
  });
});
