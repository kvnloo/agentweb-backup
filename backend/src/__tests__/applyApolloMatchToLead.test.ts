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
});
