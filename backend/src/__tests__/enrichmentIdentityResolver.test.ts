// Tests for enrichmentIdentityResolver — Req B step 0 of the v3.1 waterfall.
// Resolves missing emailDomain / firstName / lastName / company / website
// BEFORE the per-group waterfall runs. Stateless logic + injected dependencies
// so the orchestrator can pass real specialists in prod and the tests can pass
// jest.fn() mocks.
//
// Design ref: tasks/crm-enrichment-v3.1-design.md §5.1.

import {
  resolveIdentity,
  type IdentityResolverDeps,
  type ResolveIdentityInput,
} from '../services/enrichmentIdentityResolver';

const LIST_ID = 'list-test';
const LEAD_ID = 'lead-001';

function makeDeps(overrides: Partial<IdentityResolverDeps> = {}): IdentityResolverDeps {
  return {
    apolloPeopleMatch: jest.fn().mockResolvedValue(null),
    apolloOrgMatch: jest.fn().mockResolvedValue(null),
    enrichSoReverseLookup: jest.fn().mockResolvedValue(null),
    writeLeadFields: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeInput(overrides: Partial<ResolveIdentityInput> = {}): ResolveIdentityInput {
  return {
    listId: LIST_ID,
    lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
    needsPersonFields: false,
    needsCompanyFields: false,
    mode: 'enrich',
    ...overrides,
  };
}

// ─── Name-based identity (Unipile tier 3.5 path) ─────────────────────────────

describe('resolveIdentity — name-based path (no email / no linkedin)', () => {
  it('allows lead with firstName+lastName through when needsPersonFields=true and email/linkedin are missing', async () => {
    // Repro of the FitSimple Waitlist bug: lead has name + company but no
    // email and no linkedin (user deleted it). User enriches linkedin_url
    // only; downstream Unipile tier 3.5 should be reachable. Identity
    // resolution must not gate the lead out.
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          firstName: 'Ayush',
          lastName: 'Jha',
          company: 'Agoda',
        },
        needsPersonFields: true,
        needsCompanyFields: false,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    // No email → no Apollo/enrich.so calls are even possible. The waterfall
    // downstream handles LinkedIn lookup via Unipile by name+company.
    expect(deps.apolloPeopleMatch).not.toHaveBeenCalled();
    expect(deps.apolloOrgMatch).not.toHaveBeenCalled();
    expect(deps.enrichSoReverseLookup).not.toHaveBeenCalled();
  });

  it("still rejects lead with only firstName (no lastName) when needsPersonFields=true and no email/linkedin", async () => {
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Ayush' },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(false);
  });
});

// ─── Failure paths (TDD: cover the unhappy branches first) ────────────────────

describe('resolveIdentity — failure paths', () => {
  it("returns { ok: false, reason: 'no_email' } when lead has no email", async () => {
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({ lead: { leadId: LEAD_ID } }),
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'no_email' });
    expect(deps.apolloPeopleMatch).not.toHaveBeenCalled();
    expect(deps.apolloOrgMatch).not.toHaveBeenCalled();
    expect(deps.enrichSoReverseLookup).not.toHaveBeenCalled();
    expect(deps.writeLeadFields).not.toHaveBeenCalled();
  });

  it("returns { ok: false, reason: 'no_email' } when email is empty string", async () => {
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({ lead: { leadId: LEAD_ID, email: '   ' } }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_email');
  });

  it("returns 'identity_unresolvable' when person fields requested AND all sources miss", async () => {
    // Lead has email but no name; all enrichment sources return null.
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue(null),
      enrichSoReverseLookup: jest.fn().mockResolvedValue(null),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'ghost@acme.com' },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('identity_unresolvable');
    expect(deps.writeLeadFields).not.toHaveBeenCalled();
  });

  it("returns 'identity_unresolvable' when company fields requested AND Apollo + enrich.so both miss", async () => {
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@unknown-domain.com' },
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('identity_unresolvable');
    expect(deps.apolloOrgMatch).toHaveBeenCalledWith({ emailDomain: 'unknown-domain.com' });
    expect(deps.enrichSoReverseLookup).toHaveBeenCalledWith({ email: 'jane@unknown-domain.com' });
  });
});

// ─── No-op paths (everything already resolved) ────────────────────────────────

describe('resolveIdentity — no work needed', () => {
  it('returns ok with no API-derived fields when nothing is requested (emailDomain still derived locally)', async () => {
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({ needsPersonFields: false, needsCompanyFields: false }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // emailDomain is derived locally from email — free, no API call.
      // No person/company fields should be in `resolved` since nothing was requested.
      expect(result.resolved).toEqual({ emailDomain: 'acme.com' });
    }
    expect(deps.apolloPeopleMatch).not.toHaveBeenCalled();
    expect(deps.apolloOrgMatch).not.toHaveBeenCalled();
    expect(deps.enrichSoReverseLookup).not.toHaveBeenCalled();
    // emailDomain is not persisted (it's derived, not an API result).
    expect(deps.writeLeadFields).not.toHaveBeenCalled();
  });

  it("derives emailDomain locally without any API call when lead has email but no emailDomain field", async () => {
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({ lead: { leadId: LEAD_ID, email: 'jane@acme.com' } }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.emailDomain).toBe('acme.com');
    expect(deps.apolloPeopleMatch).not.toHaveBeenCalled();
    expect(deps.apolloOrgMatch).not.toHaveBeenCalled();
  });

  it('skips Apollo person-match when lead already has firstName and lastName', async () => {
    const deps = makeDeps();
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe' },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(deps.apolloPeopleMatch).not.toHaveBeenCalled();
  });

  it('skips Apollo org-match when lead already has company AND website', async () => {
    const deps = makeDeps();
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com', company: 'Acme', website: 'acme.com' },
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(deps.apolloOrgMatch).not.toHaveBeenCalled();
    expect(deps.enrichSoReverseLookup).not.toHaveBeenCalled();
  });
});

// ─── Happy paths (each tier hits) ─────────────────────────────────────────────

describe('resolveIdentity — Apollo person hit', () => {
  it('fills firstName / lastName / title / linkedin from Apollo people-match', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', title: 'VP Engineering',
        linkedin: 'https://www.linkedin.com/in/janedoe',
      }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toMatchObject({
        firstName: 'Jane', lastName: 'Doe', title: 'VP Engineering',
        linkedin: 'https://www.linkedin.com/in/janedoe',
      });
    }
    expect(deps.apolloPeopleMatch).toHaveBeenCalledWith({ email: 'jane@acme.com' });
  });
});

describe('resolveIdentity — Apollo org hit', () => {
  it('fills company / website from Apollo org-match without calling enrich.so', async () => {
    const deps = makeDeps({
      apolloOrgMatch: jest.fn().mockResolvedValue({
        company: 'Acme Corp', website: 'acme.com',
      }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toMatchObject({ company: 'Acme Corp', website: 'acme.com' });
    }
    expect(deps.apolloOrgMatch).toHaveBeenCalledWith({ emailDomain: 'acme.com' });
    expect(deps.enrichSoReverseLookup).not.toHaveBeenCalled();
  });
});

describe('resolveIdentity — enrich.so fallback when Apollo org misses', () => {
  it('falls through to enrich.so reverse-lookup when Apollo org returns null', async () => {
    const deps = makeDeps({
      apolloOrgMatch: jest.fn().mockResolvedValue(null),
      enrichSoReverseLookup: jest.fn().mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', company: 'Acme Corp',
      }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.company).toBe('Acme Corp');
    expect(deps.apolloOrgMatch).toHaveBeenCalledTimes(1);
    expect(deps.enrichSoReverseLookup).toHaveBeenCalledTimes(1);
  });
});

// ─── Write semantics (mode + provenance) ──────────────────────────────────────

describe('resolveIdentity — write semantics', () => {
  it('mode=enrich: writes resolved fields with source="api", provider="apollo"', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' }),
    });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
        needsPersonFields: true,
        mode: 'enrich',
      }),
      deps,
    );

    expect(deps.writeLeadFields).toHaveBeenCalledTimes(1);
    const call = (deps.writeLeadFields as jest.Mock).mock.calls[0][0];
    expect(call.listId).toBe(LIST_ID);
    expect(call.leadId).toBe(LEAD_ID);
    expect(call.fields).toMatchObject({ firstName: 'Jane', lastName: 'Doe' });
    expect(call.meta.firstName.source).toBe('api');
    expect(call.meta.firstName.provider).toBe('apollo');
    expect(call.meta.firstName.enrichedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('mode=enrich: enrich.so-resolved fields carry provider="enrich.so"', async () => {
    const deps = makeDeps({
      apolloOrgMatch: jest.fn().mockResolvedValue(null),
      enrichSoReverseLookup: jest.fn().mockResolvedValue({ company: 'Acme Corp' }),
    });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
        needsCompanyFields: true,
        mode: 'enrich',
      }),
      deps,
    );

    const call = (deps.writeLeadFields as jest.Mock).mock.calls[0][0];
    expect(call.meta.company.source).toBe('api');
    expect(call.meta.company.provider).toBe('enrich.so');
  });

  it('mode=preview: never calls writeLeadFields even when fields are resolved', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
        needsPersonFields: true,
        mode: 'preview',
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.firstName).toBe('Jane');
    expect(deps.writeLeadFields).not.toHaveBeenCalled();
  });

  it('does not include lead fields that were already set (only newly-resolved ones)', async () => {
    // Apollo returns firstName, but lead already has lastName — only firstName
    // should appear in `resolved` and in the write payload.
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe-Old',
      }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com', lastName: 'Doe' },
        needsPersonFields: true,
        mode: 'enrich',
      }),
      deps,
    );

    if (!result.ok) throw new Error('expected ok');
    expect(result.resolved.firstName).toBe('Jane');
    expect(result.resolved.lastName).toBeUndefined();   // lead already had it
    const call = (deps.writeLeadFields as jest.Mock).mock.calls[0][0];
    expect(call.fields).toEqual({ firstName: 'Jane' });
    expect(call.fields.lastName).toBeUndefined();
  });
});

// ─── Combined flow ────────────────────────────────────────────────────────────

describe('resolveIdentity — combined person + company resolution', () => {
  it('resolves both person and company in one call when both are needed', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' }),
      apolloOrgMatch: jest.fn().mockResolvedValue({ company: 'Acme Corp', website: 'acme.com' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
        needsPersonFields: true,
        needsCompanyFields: true,
        mode: 'enrich',
      }),
      deps,
    );

    if (!result.ok) throw new Error('expected ok');
    expect(result.resolved).toMatchObject({
      emailDomain: 'acme.com',
      firstName: 'Jane',
      lastName: 'Doe',
      company: 'Acme Corp',
      website: 'acme.com',
    });
    expect(deps.writeLeadFields).toHaveBeenCalledTimes(1);
  });
});
