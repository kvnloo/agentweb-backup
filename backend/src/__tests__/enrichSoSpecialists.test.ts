// Tests for the enrich.so specialists:
//   - enrichSoEmailFinder      (provides `email`)
//   - enrichSoReverseLookup    (provides firstName/lastName/company/title/linkedin)

import {
  enrichSoEmailFinderSpecialist,
} from '../services/specialists/enrichSoEmailFinder';
import {
  enrichSoReverseLookupSpecialists,
  __resetReverseLookupDedupForTesting,
} from '../services/specialists/enrichSoReverseLookup';
import {
  setEnrichSoServiceForTesting,
  __resetEnrichSoServiceForTesting,
  EnrichSoService,
  type EnrichSoHttpClient,
  type EnrichSoCacheStore,
} from '../services/enrichSoService';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeStore(): EnrichSoCacheStore {
  return {
    get: jest.fn().mockResolvedValue(null),
    put: jest.fn().mockResolvedValue(undefined),
  };
}

function installService(http: Partial<EnrichSoHttpClient>) {
  const svc = new EnrichSoService({
    http: {
      validateEmail: jest.fn(),
      findEmail: jest.fn(),
      reverseLookup: jest.fn(),
      ...http,
    } as any,
    store: makeStore(),
  });
  setEnrichSoServiceForTesting(svc);
  return svc;
}

beforeEach(() => {
  __resetEnrichSoServiceForTesting();
  __resetReverseLookupDedupForTesting();
});

// ─── enrichSoEmailFinder ──────────────────────────────────────────────────────

describe('enrichSoEmailFinderSpecialist', () => {
  const ctx = { userId: 'u1' };

  it('targets the email field with a stable label', () => {
    expect(enrichSoEmailFinderSpecialist.fieldName).toBe('email');
    expect(enrichSoEmailFinderSpecialist.label).toBe('enrichso-email-finder');
  });

  it('returns null when lead has no firstName + lastName', async () => {
    installService({});
    const r = await enrichSoEmailFinderSpecialist.resolve({ leadId: '1' } as any, ctx);
    expect(r).toBeNull();
  });

  it('returns null when lead has no domain or company to anchor the search', async () => {
    installService({});
    const r = await enrichSoEmailFinderSpecialist.resolve({
      leadId: '1', firstName: 'Alice', lastName: 'Smith',
    } as any, ctx);
    expect(r).toBeNull();
  });

  it('uses website domain when no work email present', async () => {
    const findEmail = jest.fn().mockResolvedValue({
      success: true,
      data: { found: true, email: 'alice@acme.com', confidence: 'high' },
    });
    installService({ findEmail });

    const r = await enrichSoEmailFinderSpecialist.resolve({
      leadId: '1', firstName: 'Alice', lastName: 'Smith', website: 'https://www.acme.com',
    } as any, ctx);

    expect(findEmail).toHaveBeenCalledWith({
      firstName: 'Alice', lastName: 'Smith', domain: 'acme.com',
    });
    expect(r).not.toBeNull();
    expect(r!.value).toBe('alice@acme.com');
    expect(r!.confidence).toBe('high');
    expect(r!.source).toBe('web_search');
  });

  it('falls back to company name when no website', async () => {
    const findEmail = jest.fn().mockResolvedValue({
      success: true,
      data: { found: true, email: 'alice@acme.com', confidence: 'medium' },
    });
    installService({ findEmail });

    const r = await enrichSoEmailFinderSpecialist.resolve({
      leadId: '1', firstName: 'Alice', lastName: 'Smith', company: 'Acme Inc',
    } as any, ctx);

    expect(r!.confidence).toBe('medium');
  });

  it('returns null when enrich.so cannot find the email (found: false)', async () => {
    const findEmail = jest.fn().mockResolvedValue({
      success: true, data: { found: false, message: 'no match' },
    });
    installService({ findEmail });

    const r = await enrichSoEmailFinderSpecialist.resolve({
      leadId: '1', firstName: 'Alice', lastName: 'Smith', website: 'https://acme.com',
    } as any, ctx);

    expect(r).toBeNull();
  });

  it('returns null (not throw) when the service throws — lets LLM fallback handle it', async () => {
    const findEmail = jest.fn().mockRejectedValue(new Error('api down'));
    installService({ findEmail });

    const r = await enrichSoEmailFinderSpecialist.resolve({
      leadId: '1', firstName: 'Alice', lastName: 'Smith', website: 'https://acme.com',
    } as any, ctx);

    expect(r).toBeNull();
  });
});

// ─── enrichSoReverseLookup ────────────────────────────────────────────────────

describe('enrichSoReverseLookupSpecialists', () => {
  // Every test below opts into all 12 fields so behavior matches the pre-config
  // baseline (standard always populated, extended populated when present).
  const allOn = {
    firstName: true, lastName: true, company: true, title: true, linkedin: true,
    summary: true, skills: true, connectionCount: true, location: true,
    headline: true, pastCompanies: true, education: true,
  };
  const ctx = { userId: 'u1', enrichmentFieldConfig: allOn };

  it('exposes specialists for all 12 enrichable fields (5 standard + 7 extended)', () => {
    const fields = enrichSoReverseLookupSpecialists.map(s => s.fieldName).sort();
    expect(fields).toEqual([
      'company', 'connectionCount', 'education', 'firstName', 'headline',
      'lastName', 'linkedin', 'location', 'pastCompanies', 'skills',
      'summary', 'title',
    ]);
  });

  it('all specialists share the same enrichso-reverse-lookup label so sourceContexts dedupe', () => {
    for (const s of enrichSoReverseLookupSpecialists) {
      expect(s.label).toBe('enrichso-reverse-lookup');
    }
  });

  it('returns null for a lead with no email (nothing to look up)', async () => {
    installService({});
    for (const s of enrichSoReverseLookupSpecialists) {
      const r = await s.resolve({ leadId: '1' } as any, ctx);
      expect(r).toBeNull();
    }
  });

  it('extracts each field correctly when reverseLookup succeeds', async () => {
    const reverseLookup = jest.fn().mockResolvedValue({
      success: true,
      data: {
        firstName: 'Emily', lastName: 'Zhang',
        companyName: 'Figma',
        headline: 'Staff Product Designer at Figma',
        profileUrl: 'https://www.linkedin.com/in/emilyzhang',
        positions: { positionsCount: 1, positionHistory: [{ title: 'Staff Product Designer' }] },
      },
    });
    installService({ reverseLookup });

    const lead = { leadId: '1', email: 'emily@figma.com' };
    const byField = Object.fromEntries(enrichSoReverseLookupSpecialists.map(s => [s.fieldName, s]));

    expect((await byField.firstName.resolve(lead as any, ctx))!.value).toBe('Emily');
    expect((await byField.lastName.resolve(lead as any, ctx))!.value).toBe('Zhang');
    expect((await byField.company.resolve(lead as any, ctx))!.value).toBe('Figma');
    expect((await byField.title.resolve(lead as any, ctx))!.value).toBe('Staff Product Designer');
    expect((await byField.linkedin.resolve(lead as any, ctx))!.value).toBe('https://www.linkedin.com/in/emilyzhang');
  });

  it('uses linkedin as the source (data is profile-derived)', async () => {
    const reverseLookup = jest.fn().mockResolvedValue({
      success: true, data: { firstName: 'A', companyName: 'X' },
    });
    installService({ reverseLookup });

    const r = await enrichSoReverseLookupSpecialists[0].resolve(
      { leadId: '1', email: 'a@b.com' } as any, ctx,
    );
    expect(r!.source).toBe('linkedin');
  });

  it('returns null for fields the response does not include', async () => {
    const reverseLookup = jest.fn().mockResolvedValue({
      success: true, data: { firstName: 'Emily' },  // only firstName
    });
    installService({ reverseLookup });

    const lead = { leadId: '1', email: 'emily@figma.com' };
    const byField = Object.fromEntries(enrichSoReverseLookupSpecialists.map(s => [s.fieldName, s]));

    expect(await byField.lastName.resolve(lead as any, ctx)).toBeNull();
    expect(await byField.company.resolve(lead as any, ctx)).toBeNull();
  });

  it('dedupes parallel calls for the same email — service hit only once', async () => {
    const reverseLookup = jest.fn().mockResolvedValue({
      success: true, data: { firstName: 'Emily', lastName: 'Zhang', companyName: 'Figma' },
    });
    installService({ reverseLookup });

    const lead = { leadId: '1', email: 'emily@figma.com' };
    // Run all 5 specialists in parallel — should result in exactly 1 underlying call
    await Promise.all(enrichSoReverseLookupSpecialists.map(s => s.resolve(lead as any, ctx)));

    expect(reverseLookup).toHaveBeenCalledTimes(1);
  });

  it('different leads (different emails) issue separate lookups', async () => {
    const reverseLookup = jest.fn().mockResolvedValue({
      success: true, data: { firstName: 'X' },
    });
    installService({ reverseLookup });

    await enrichSoReverseLookupSpecialists[0].resolve(
      { leadId: '1', email: 'a@b.com' } as any, ctx,
    );
    await enrichSoReverseLookupSpecialists[0].resolve(
      { leadId: '2', email: 'c@d.com' } as any, ctx,
    );

    expect(reverseLookup).toHaveBeenCalledTimes(2);
  });

  it('returns null (not throw) when service errors', async () => {
    const reverseLookup = jest.fn().mockRejectedValue(new Error('api down'));
    installService({ reverseLookup });

    const r = await enrichSoReverseLookupSpecialists[0].resolve(
      { leadId: '1', email: 'a@b.com' } as any, ctx,
    );
    expect(r).toBeNull();
  });

  // ─── Per-list config gating ─────────────────────────────────────────────────

  describe('config gating', () => {
    const reverseLookup = () => jest.fn().mockResolvedValue({
      success: true,
      data: {
        firstName: 'Emily', lastName: 'Zhang', companyName: 'Figma',
        headline: 'Staff Designer', summary: 'Bio.',
        skills: ['Figma', 'UX'], connectionCount: 432,
        location: 'SF',
        positions: { positionHistory: [
          { title: 'Staff Designer', companyName: 'Figma' },
          { title: 'Senior',          companyName: 'Airbnb' },
          { title: 'IC',              companyName: 'Stripe' },
        ] },
        schools: { educationHistory: [{ schoolName: 'MIT', degreeName: 'BS' }] },
      },
    });
    const lead = { leadId: '1', email: 'emily@figma.com' };
    const byField = (specs: typeof enrichSoReverseLookupSpecialists) =>
      Object.fromEntries(specs.map(s => [s.fieldName, s]));

    it('skips fields disabled in the config — even if data is available', async () => {
      installService({ reverseLookup: reverseLookup() });
      const onlyFirstName = { userId: 'u1', enrichmentFieldConfig: { ...allOn, lastName: false, company: false } };
      const m = byField(enrichSoReverseLookupSpecialists);
      expect(await m.firstName.resolve(lead as any, onlyFirstName)).not.toBeNull();
      expect(await m.lastName.resolve(lead as any, onlyFirstName)).toBeNull();
      expect(await m.company.resolve(lead as any, onlyFirstName)).toBeNull();
    });

    it('default config (no enrichmentFieldConfig in ctx) populates standard but not extended fields', async () => {
      installService({ reverseLookup: reverseLookup() });
      const defCtx = { userId: 'u1' }; // no config at all
      const m = byField(enrichSoReverseLookupSpecialists);
      // standard ON → populated
      expect((await m.firstName.resolve(lead as any, defCtx))!.value).toBe('Emily');
      expect((await m.title.resolve(lead as any, defCtx))!.value).toBe('Staff Designer');
      // extended OFF → null
      expect(await m.summary.resolve(lead as any, defCtx)).toBeNull();
      expect(await m.skills.resolve(lead as any, defCtx)).toBeNull();
      expect(await m.connectionCount.resolve(lead as any, defCtx)).toBeNull();
      expect(await m.pastCompanies.resolve(lead as any, defCtx)).toBeNull();
      expect(await m.education.resolve(lead as any, defCtx)).toBeNull();
    });

    it('formats arrays per convention: skills comma-joined (top 5), past companies "; " joined', async () => {
      installService({
        reverseLookup: jest.fn().mockResolvedValue({
          success: true,
          data: {
            firstName: 'A',
            skills: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],   // 7 → top 5 only
            positions: { positionHistory: [
              { companyName: 'Now' },
              { companyName: 'Past1' }, { companyName: 'Past2' },
            ]},
          },
        }),
      });
      const m = byField(enrichSoReverseLookupSpecialists);
      expect((await m.skills.resolve(lead as any, ctx))!.value).toBe('a, b, c, d, e');
      expect((await m.pastCompanies.resolve(lead as any, ctx))!.value).toBe('Past1; Past2');
    });

    it('connectionCount serialized as plain string', async () => {
      installService({
        reverseLookup: jest.fn().mockResolvedValue({
          success: true,
          data: { firstName: 'A', connectionCount: 432, isConnectionCountObfuscated: false },
        }),
      });
      const m = byField(enrichSoReverseLookupSpecialists);
      const r = await m.connectionCount.resolve(lead as any, ctx);
      expect(r!.value).toBe('432');
    });

    it('education formatted as "School (Degree)" joined with "; "', async () => {
      installService({
        reverseLookup: jest.fn().mockResolvedValue({
          success: true,
          data: { firstName: 'A', schools: { educationHistory: [
            { schoolName: 'MIT', degreeName: 'BS CS' },
            { schoolName: 'Stanford' },
          ]}},
        }),
      });
      const m = byField(enrichSoReverseLookupSpecialists);
      expect((await m.education.resolve(lead as any, ctx))!.value).toBe('MIT (BS CS); Stanford');
    });

    it('unknown keys in config are ignored — defaults still apply', async () => {
      installService({ reverseLookup: reverseLookup() });
      const m = byField(enrichSoReverseLookupSpecialists);
      const weirdCtx = { userId: 'u1', enrichmentFieldConfig: { banana: true } as any };
      // standard still populates
      expect((await m.firstName.resolve(lead as any, weirdCtx))!.value).toBe('Emily');
      // extended still off
      expect(await m.skills.resolve(lead as any, weirdCtx)).toBeNull();
    });
  });
});
