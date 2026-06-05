import { applyApolloMatchToLead } from '../services/applyApolloMatchToLead';
import type { MappedMatch } from '../services/apolloFieldMapper';

function match(p: any = {}, o: any = {}): MappedMatch {
  return {
    person: {
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      emailStatus: p.emailStatus,
      title: p.title,
      seniority: p.seniority,
      linkedin: p.linkedin,
      apolloPersonId: p.apolloPersonId ?? 'apollo_p1',
      employmentHistory: p.employmentHistory,
      city: p.city,
      state: p.state,
      country: p.country,
      fieldConfidence: p.fieldConfidence ?? {},
    } as any,
    organization: o ? ({
      name: o.name,
      techStack: o.techStack,
      headcountGrowth12mo: o.headcountGrowth12mo,
      totalFunding: o.totalFunding,
      latestFundingStage: o.latestFundingStage,
      latestFundingRoundDate: o.latestFundingRoundDate,
      annualRevenue: o.annualRevenue,
      linkedinUrl: o.linkedinUrl,
    } as any) : undefined,
  };
}

describe('applyApolloMatchToLead', () => {
  it('fills every missing field from a complete Apollo payload', () => {
    const lead = {};
    const m = match(
      {
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@acme.com',
        emailStatus: 'verified',
        title: 'VP Eng',
        seniority: 'vp',
        linkedin: 'https://linkedin.com/in/janedoe',
        employmentHistory: [{ organizationName: 'Acme', title: 'VP' }],
        fieldConfidence: { firstName: 'high', email: 'high' },
      },
      {
        name: 'Acme',
        techStack: ['React', 'AWS'],
        headcountGrowth12mo: 0.32,
        totalFunding: 30_000_000,
        latestFundingStage: 'Series B',
        latestFundingRoundDate: '2025-06-01',
      },
    );
    const r = applyApolloMatchToLead(lead, m, { fillEmail: true });
    expect(r.updates.email).toBe('jane@acme.com');
    expect(r.updates.firstName).toBe('Jane');
    expect(r.updates.lastName).toBe('Doe');
    expect(r.updates.title).toBe('VP Eng');
    expect(r.updates.linkedin).toBe('https://linkedin.com/in/janedoe');
    expect(r.updates.company).toBe('Acme');
    expect(r.customFields.apolloPersonId).toBe('apollo_p1');
    expect(r.customFields.apolloSeniority).toBe('vp');
    expect(r.customFields.companyTechStack).toBe('React; AWS');
    expect(r.customFields.companyHeadcountGrowth12mo).toBe('0.32');
    expect(r.customFields.companyFundingTotal).toBe('30000000');
    expect(r.customFields.companyFundingStage).toBe('Series B');
    expect(r.customFields.employmentHistory).toBe(JSON.stringify([{ organizationName: 'Acme', title: 'VP' }]));
    expect(r.enrichmentMetadata.email.provider).toBe('apollo');
    expect(r.changed.size).toBeGreaterThan(8);
  });

  it('NEVER overwrites existing fields', () => {
    const lead = {
      firstName: 'KeepMe',
      title: 'KeepMyTitle',
      company: 'KeepMyCompany',
      customFields: { companyTechStack: 'KeepMyStack', employmentHistory: '[]' },
    };
    const m = match(
      { firstName: 'NewName', title: 'NewTitle', email: 'x@y.com', employmentHistory: [{ title: 'New' }] },
      { name: 'NewCo', techStack: ['NewStack'] },
    );
    const r = applyApolloMatchToLead(lead, m, { fillEmail: true });
    expect(r.updates.firstName).toBeUndefined();
    expect(r.updates.title).toBeUndefined();
    expect(r.updates.company).toBeUndefined();
    expect(r.customFields.companyTechStack).toBeUndefined();
    expect(r.customFields.employmentHistory).toBeUndefined();
    // Email is missing on lead so it should be filled.
    expect(r.updates.email).toBe('x@y.com');
  });

  it('apolloPersonId always updates even when other fields are skipped', () => {
    const lead = { firstName: 'A', lastName: 'B', email: 'a@b.com', customFields: {} };
    const m = match({ firstName: 'X', email: 'x@y.com', apolloPersonId: 'apollo_99' });
    const r = applyApolloMatchToLead(lead, m);
    expect(r.customFields.apolloPersonId).toBe('apollo_99');
    expect(r.changed.has('apolloPersonId')).toBe(true);
  });

  it('returns empty updates when match is essentially empty', () => {
    const lead = { firstName: 'A', lastName: 'B', email: 'a@b.com', title: 'X' };
    const m: MappedMatch = {
      person: { fieldConfidence: {} } as any,
    };
    const r = applyApolloMatchToLead(lead, m);
    expect(Object.keys(r.updates).length).toBe(0);
  });

  it('fillEmail:false leaves email alone even when present in match', () => {
    const lead = {};
    const m = match({ email: 'apollo@x.com', emailStatus: 'verified' });
    const r = applyApolloMatchToLead(lead, m, { fillEmail: false });
    expect(r.updates.email).toBeUndefined();
    expect(r.changed.has('email')).toBe(false);
  });

  it('omits org-derived fields when match.organization is undefined', () => {
    const lead = {};
    const m: MappedMatch = {
      person: { firstName: 'A', fieldConfidence: {} } as any,
    };
    const r = applyApolloMatchToLead(lead, m);
    expect(r.updates.company).toBeUndefined();
    expect(r.customFields.companyTechStack).toBeUndefined();
    expect(r.updates.firstName).toBe('A');
  });

  describe('minimalFields option', () => {
    it('writes only email, firstName, lastName, title, company, linkedin, companyLinkedin, location', () => {
      const lead = {};
      const m = match(
        {
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'jane@acme.com',
          emailStatus: 'verified',
          title: 'VP Eng',
          seniority: 'vp',
          linkedin: 'https://linkedin.com/in/janedoe',
          employmentHistory: [{ organizationName: 'Acme', title: 'VP' }],
          city: 'San Francisco',
          state: 'CA',
          country: 'United States',
        },
        {
          name: 'Acme',
          techStack: ['React', 'AWS'],
          headcountGrowth12mo: 0.32,
          totalFunding: 30_000_000,
          latestFundingStage: 'Series B',
          latestFundingRoundDate: '2025-06-01',
          annualRevenue: 5_000_000,
          linkedinUrl: 'https://linkedin.com/company/acme',
        },
      );
      const r = applyApolloMatchToLead(lead, m, { fillEmail: true, minimalFields: true });

      // Kept fields
      expect(r.updates.email).toBe('jane@acme.com');
      expect(r.updates.firstName).toBe('Jane');
      expect(r.updates.lastName).toBe('Doe');
      expect(r.updates.company).toBe('Acme');
      expect(r.updates.linkedin).toBe('https://linkedin.com/in/janedoe');
      expect(r.updates.companyLinkedin).toBe('https://linkedin.com/company/acme');
      expect(r.updates.title).toBe('VP Eng');
      expect(r.customFields.location).toBe('San Francisco, CA, United States');

      // Dropped fields
      expect(r.customFields.apolloPersonId).toBeUndefined();
      expect(r.customFields.apolloTitle).toBeUndefined();
      expect(r.customFields.apolloSeniority).toBeUndefined();
      expect(r.customFields.employmentHistory).toBeUndefined();
      expect(r.customFields.companyTechStack).toBeUndefined();
      expect(r.customFields.companyHeadcountGrowth6mo).toBeUndefined();
      expect(r.customFields.companyHeadcountGrowth12mo).toBeUndefined();
      expect(r.customFields.companyHeadcountGrowth24mo).toBeUndefined();
      expect(r.customFields.companyFundingTotal).toBeUndefined();
      expect(r.customFields.companyFundingStage).toBeUndefined();
      expect(r.customFields.companyFundingLastRoundDate).toBeUndefined();
      expect(r.customFields.companyAnnualRevenue).toBeUndefined();

      // Changed set is exactly the kept fields
      expect(Array.from(r.changed).sort()).toEqual(
        ['company', 'companyLinkedin', 'email', 'firstName', 'lastName', 'linkedin', 'location', 'title'],
      );
    });

    it('joins location from whichever of city/state/country are present', () => {
      const r1 = applyApolloMatchToLead({}, match({ city: 'NYC' }), { minimalFields: true });
      expect(r1.customFields.location).toBe('NYC');

      const r2 = applyApolloMatchToLead({}, match({ state: 'CA', country: 'US' }), { minimalFields: true });
      expect(r2.customFields.location).toBe('CA, US');

      const r3 = applyApolloMatchToLead({}, match({}), { minimalFields: true });
      expect(r3.customFields.location).toBeUndefined();
      expect(r3.changed.has('location')).toBe(false);
    });

    it('never overwrites existing companyLinkedin or location', () => {
      const lead = {
        companyLinkedin: 'https://linkedin.com/company/keep-me',
        customFields: { location: 'KeepMyLocation' },
      };
      const m = match(
        { city: 'SF', state: 'CA' },
        { linkedinUrl: 'https://linkedin.com/company/new-co' },
      );
      const r = applyApolloMatchToLead(lead, m, { minimalFields: true });
      expect(r.updates.companyLinkedin).toBeUndefined();
      expect(r.customFields.location).toBeUndefined();
      expect(r.changed.has('companyLinkedin')).toBe(false);
      expect(r.changed.has('location')).toBe(false);
    });

    it('still respects fillEmail:false in minimal mode', () => {
      const r = applyApolloMatchToLead(
        {},
        match({ email: 'a@b.com', emailStatus: 'verified', firstName: 'A' }),
        { minimalFields: true, fillEmail: false },
      );
      expect(r.updates.email).toBeUndefined();
      expect(r.updates.firstName).toBe('A');
    });
  });

  describe('LinkedIn URL validation', () => {
    it('does NOT write a malformed company LinkedIn URL (search URL)', () => {
      const m = match({}, { name: 'Acme', linkedinUrl: 'https://www.linkedin.com/search/results/companies/?keywords=x' });
      const r = applyApolloMatchToLead({}, m);
      expect(r.updates.companyLinkedin).toBeUndefined();
      expect(r.changed.has('companyLinkedin')).toBe(false);
    });

    it('writes a valid /company/ URL', () => {
      const m = match({}, { name: 'Acme', linkedinUrl: 'https://www.linkedin.com/company/acme' });
      const r = applyApolloMatchToLead({}, m);
      expect(r.updates.companyLinkedin).toBe('https://www.linkedin.com/company/acme');
      expect(r.changed.has('companyLinkedin')).toBe(true);
    });

    it('does NOT write a malformed personal LinkedIn URL', () => {
      const m = match({ firstName: 'A', linkedin: 'https://www.linkedin.com/pub/dir/foo' });
      const r = applyApolloMatchToLead({}, m);
      expect(r.updates.linkedin).toBeUndefined();
      expect(r.changed.has('linkedin')).toBe(false);
    });

    it('writes a valid /in/ personal URL', () => {
      const m = match({ firstName: 'A', linkedin: 'https://www.linkedin.com/in/janedoe' });
      const r = applyApolloMatchToLead({}, m);
      expect(r.updates.linkedin).toBe('https://www.linkedin.com/in/janedoe');
      expect(r.changed.has('linkedin')).toBe(true);
    });
  });
});
