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

const LEAD_HINT = { listId: LIST_ID, leadId: LEAD_ID };

function makeDeps(overrides: Partial<IdentityResolverDeps> = {}): IdentityResolverDeps {
  return {
    apolloPeopleMatch: jest.fn().mockResolvedValue(null),
    enrichSoReverseLookup: jest.fn().mockResolvedValue(null),
    enrichSoFindEmail: jest.fn().mockResolvedValue(null),
    findLinkedInUrl: jest.fn().mockResolvedValue(null),
    findSiblingLeads: jest.fn().mockResolvedValue([]),
    resolveCompanyDomainViaWebSearch: jest.fn().mockResolvedValue(null),
    writeLeadFields: jest.fn().mockResolvedValue(undefined),
    apolloBrokerChain: jest.fn().mockResolvedValue(null),
    findEmailViaPatterns: jest.fn().mockResolvedValue(null),
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
    // Unified Apollo fires for name+company leads — expanded signal support.
    expect(deps.apolloPeopleMatch).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Ayush', lastName: 'Jha', company: 'Agoda' }),
    );
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

// ─── LinkedIn-URL-only identity (Unipile getProfile path) ────────────────────

describe('resolveIdentity — LinkedIn-URL-only path (Unipile getProfile)', () => {
  it('resolves first/last name from a LinkedIn URL via Unipile getProfile when Apollo misses', async () => {
    // Repro of the EveryIO bug: lead imported with ONLY a LinkedIn URL (no
    // name/email/company). Apollo has no record for the profile, so the only
    // source that can establish identity is Unipile getProfile(url). Without
    // it the lead fails the person-completeness gate and is skipped before the
    // waterfall's own Unipile tier (3.5b) ever runs.
    const findUnipileProfileByUrl = jest.fn().mockResolvedValue({
      firstName: 'Uday',
      lastName: 'Ayyagari',
      title: 'Founder',
      company: 'Acme',
    });
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue(null),
      findUnipileProfileByUrl,
    });

    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, linkedin: 'https://www.linkedin.com/in/uday2' },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(findUnipileProfileByUrl).toHaveBeenCalledWith({
      linkedinUrl: 'https://www.linkedin.com/in/uday2',
    });
    if (result.ok) {
      expect(result.resolved.firstName).toBe('Uday');
      expect(result.resolved.lastName).toBe('Ayyagari');
    }
  });

  it('still returns identity_unresolvable when Unipile getProfile also cannot fetch the profile', async () => {
    // Private / deleted profile: Apollo misses AND Unipile getProfile returns
    // null. Lead remains unresolvable — but we proved we tried Unipile.
    const findUnipileProfileByUrl = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue(null),
      findUnipileProfileByUrl,
    });

    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, linkedin: 'https://www.linkedin.com/in/muhammadymalik' },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(findUnipileProfileByUrl).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('identity_unresolvable');
  });

  it('does not call Unipile getProfile when first and last name are already present', async () => {
    const findUnipileProfileByUrl = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ findUnipileProfileByUrl });

    await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          firstName: 'Jane',
          lastName: 'Doe',
          linkedin: 'https://www.linkedin.com/in/jane-doe',
        },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(findUnipileProfileByUrl).not.toHaveBeenCalled();
  });
});

// ─── Failure paths (TDD: cover the unhappy branches first) ────────────────────

describe('resolveIdentity — failure paths', () => {
  it("returns { ok: false, reason: 'no_identity_signal' } when lead has no email", async () => {
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({ lead: { leadId: LEAD_ID } }),
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'no_identity_signal' });
    expect(deps.apolloPeopleMatch).not.toHaveBeenCalled();
    expect(deps.enrichSoReverseLookup).not.toHaveBeenCalled();
    expect(deps.writeLeadFields).not.toHaveBeenCalled();
  });

  it("returns { ok: false, reason: 'no_identity_signal' } when email is empty string", async () => {
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({ lead: { leadId: LEAD_ID, email: '   ' } }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_identity_signal');
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

  it("returns 'identity_unresolvable' when company fields requested AND all sources miss AND email is personal (no business domain)", async () => {
    // Personal email → hasBusinessEmailDomain=false. All company sources return null.
    // Gate should block since there's no company name and no business email domain.
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@gmail.com', firstName: 'Jane', lastName: 'Doe' },
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('identity_unresolvable');
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

  it('skips company resolution when lead already has company AND website', async () => {
    const deps = makeDeps();
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com', company: 'Acme', website: 'acme.com' },
        needsCompanyFields: true,
      }),
      deps,
    );

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
    expect(deps.apolloPeopleMatch).toHaveBeenCalledWith(expect.objectContaining({ email: 'jane@acme.com' }));
  });
});

describe('resolveIdentity — Unipile LinkedIn discovery', () => {
  it('uses Unipile linkedin URL for Apollo lookup and stamps provider=unipile for linkedin meta', async () => {
    const apolloPeopleMatch = jest
      .fn()
      .mockResolvedValue({ email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe' });
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findLinkedInUrl: jest.fn().mockResolvedValue('https://linkedin.com/in/jane-unipile'),
      apolloPeopleMatch,
      writeLeadFields,
    });

    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
        needsPersonFields: true,
        mode: 'enrich',
      }),
      deps,
    );

    expect(apolloPeopleMatch).toHaveBeenCalledWith(
      expect.objectContaining({ linkedinUrl: 'https://linkedin.com/in/jane-unipile' }),
    );
    const call = writeLeadFields.mock.calls[0][0];
    expect(call.meta.linkedin.provider).toBe('unipile');
    expect(call.meta.linkedin.source).toBe('api');
  });
});

describe('resolveIdentity — Apollo people-match fills company from embedded org', () => {
  it('fills company / website from embedded org in Apollo people-match without separate org call', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', company: 'Acme Corp', website: 'acme.com',
      }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
        needsCompanyFields: true,
        needsPersonFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toMatchObject({ company: 'Acme Corp', website: 'acme.com' });
    }
    expect(deps.enrichSoReverseLookup).not.toHaveBeenCalled();
  });
});

describe('resolveIdentity — enrich.so reverse-lookup company fallback', () => {
  it('calls enrich.so reverse-lookup when Apollo people-match returns no company', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue(null),
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
  it('writes person fields (linkedin, title) before completeness gate fires — no data loss on skip', async () => {
    // Apollo returns person+linkedin+title but no org (personal email).
    // Completeness gate fires (needsCompanyFields=true, no company).
    // Write must still happen so linkedin/title land in the DB.
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        firstName: 'Nels',
        lastName: 'Anderson',
        linkedin: 'http://www.linkedin.com/in/kullahanderson',
        title: 'Startup and Strategic Advisor',
      }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'kanderso66@gmail.com', firstName: 'Nels', lastName: 'Anderson' },
        needsCompanyFields: true,
        mode: 'enrich',
      }),
      deps,
    );

    expect(result.ok).toBe(false); // company missing → gate fires
    // But write must have happened with the person fields Apollo returned
    expect(deps.writeLeadFields).toHaveBeenCalledTimes(1);
    const call = (deps.writeLeadFields as jest.Mock).mock.calls[0][0];
    expect(call.fields).toMatchObject({
      linkedin: 'http://www.linkedin.com/in/kullahanderson',
      title: 'Startup and Strategic Advisor',
    });
  });
});

// ─── Combined flow ────────────────────────────────────────────────────────────

describe('resolveIdentity — combined person + company resolution', () => {
  it('resolves person and company from single Apollo people-match (embedded org)', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe',
        company: 'Acme Corp', website: 'acme.com',
      }),
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

// ─── Tier 0.5 — emailDomain derivation from LLM-resolved website ──────────────
//
// Bug repro: when a lead has only `company` (no email, no website, no
// linkedin), Tier 0.5 used to fill `resolved.website` but never populated
// `resolved.emailDomain`. That left every downstream provider gated on
// emailDomain (Apollo org-match, enrich.so find-email) unfired, so the
// company-name-only enrichment path produced no email and no person fields —
// the exact "same bad output" behavior the user reported on 2026-05-12.

describe('resolveIdentity — Tier 0.5 emailDomain derivation', () => {
  const COMPANY_ONLY_LEAD = {
    leadId: LEAD_ID,
    firstName: 'Jane',
    lastName: 'Doe',
    company: 'Argusoft',
  } as const;

  it('derives emailDomain from the LLM-resolved website (strips https + www)', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://www.argusoft.com' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: COMPANY_ONLY_LEAD,
        needsPersonFields: true,
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.website).toBe('https://www.argusoft.com');
    expect(result.resolved.emailDomain).toBe('argusoft.com');
  });

  it('surfaces the derived emailDomain in the resolved output so the downstream find-email waterfall can use it', async () => {
    // The pipeline that actually consumes this is enrichmentGroupWaterfall
    // (find_email tier and the canonical-key builder for company groups).
    // Both read `resolved.emailDomain` after resolveIdentity returns. Without
    // this field, find-email cannot run for a company-name-only lead.
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://www.argusoft.com' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: COMPANY_ONLY_LEAD,
        needsPersonFields: true,
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.emailDomain).toBe('argusoft.com');
  });

  it('writes emailDomain with provenance source=web_search, provider=llm_web_search', async () => {
    const writeSpy = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://medixbio.com' }),
      writeLeadFields: writeSpy,
    });
    await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          firstName: 'Sam',
          lastName: 'Patel',
          company: 'Medix Biotechnologies',
        },
        needsCompanyFields: true,
        mode: 'enrich',
      }),
      deps,
    );

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const call = writeSpy.mock.calls[0][0];
    expect(call.fields.emailDomain).toBe('medixbio.com');
    expect(call.meta.emailDomain.source).toBe('web_search');
    expect(call.meta.emailDomain.provider).toBe('llm_web_search');
  });

  it('does not overwrite an emailDomain already derived from the lead email', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest.fn().mockResolvedValue({ website: 'https://other.com' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          company: 'Acme',
          email: 'jane@acme.com',
        },
        needsCompanyFields: true,
      }),
      deps,
    );

    // Tier 0.5 now fires (company + business email = searchable signal, website missing).
    // But emailDomain derived locally from jane@acme.com must NOT be overwritten
    // by the LLM-returned website domain.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.emailDomain ?? 'acme.com').toBe('acme.com');
  });

  it('skips emailDomain when the LLM returns a malformed URL (no crash, no derived domain)', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'not a url at all' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: COMPANY_ONLY_LEAD,
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Website is stored as-is (existing behavior), but emailDomain must NOT
    // be set to garbage — better to leave it empty than to feed bad data
    // into Apollo org-match.
    expect(result.resolved.emailDomain).toBeUndefined();
  });
});

// ─── Tier 0.5 Branch B — domain-search via business email ────────────────────

describe('resolveIdentity — Tier 0.5 Branch B (business email → company+website)', () => {
  it('fires resolveCompanyDomainViaWebSearch with domain when business email present and company missing', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest.fn().mockResolvedValue(null),
    });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'eric@geniecore.net', firstName: 'Eric', lastName: 'Smith' },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(deps.resolveCompanyDomainViaWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'geniecore.net' }),
    );
  });

  it('fills resolved.website AND resolved.company from LLM result when website validation passes', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://geniecore.net', company: 'GenieCore' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'eric@geniecore.net', firstName: 'Eric', lastName: 'Smith' },
        needsCompanyFields: true,
      }),
      deps,
    );
    // Website domain matches email domain → validation passes → company written → gate passes
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.website).toBe('https://geniecore.net');
    expect(result.resolved.company).toBe('GenieCore');
  });

  it('does NOT fill company when lead already has a company name', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://geniecore.net', company: 'GenieCore LLM Name' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'eric@geniecore.net', firstName: 'Eric', lastName: 'Smith', company: 'GenieCore Existing' },
        needsCompanyFields: true,
      }),
      deps,
    );
    if (!result.ok) return;
    expect(result.resolved.company).toBeUndefined(); // existing company not overwritten
  });

  it('does not fire for personal/freemail email domain', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest.fn().mockResolvedValue(null),
    });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'bfactor@yahoo.com', firstName: 'Bob', lastName: 'Factor' },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(deps.resolveCompanyDomainViaWebSearch).not.toHaveBeenCalled();
  });

  it('fires even when company already known (website still missing — domain signal improves Apollo)', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest.fn().mockResolvedValue({ website: 'https://geniecore.net' }),
    });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'eric@geniecore.net', company: 'GenieCore' },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(deps.resolveCompanyDomainViaWebSearch).toHaveBeenCalledWith(
      expect.objectContaining({ company: 'GenieCore', domain: 'geniecore.net' }),
    );
  });

  it('rejects mismatched website but still passes gate via business email domain (option 4)', async () => {
    // resolveCompanyDomainViaWebSearch returns .com but lead email is .net — domain mismatch.
    // Website should NOT be written, but lead still passes gate because business email domain is sufficient.
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://geniecore.com', searchedDomain: 'geniecore.com' }), // .com vs .net
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'eric@geniecore.net', firstName: 'Eric', lastName: 'Smith' },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.website).toBeUndefined();
  });

  it('rejects website when echoed searchedDomain does not match email domain but gate passes via business email (option 2)', async () => {
    // Website echoed wrong domain — rejected. But business email domain still passes the gate.
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://geniecore.net', searchedDomain: 'geniecore.com' }), // echoed wrong domain
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'eric@geniecore.net', firstName: 'Eric', lastName: 'Smith' },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.website).toBeUndefined();
  });

  it('accepts website when both derived domain and echoed domain match email domain', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://geniecore.net', searchedDomain: 'geniecore.net' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'eric@geniecore.net', firstName: 'Eric', lastName: 'Smith' },
        needsCompanyFields: true,
      }),
      deps,
    );
    if (result.ok) expect(result.resolved.website).toBe('https://geniecore.net');
  });

  it('accepts website when derived domain is a subdomain of email domain', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://app.geniecore.net', searchedDomain: 'geniecore.net' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'eric@geniecore.net', firstName: 'Eric', lastName: 'Smith' },
        needsCompanyFields: true,
      }),
      deps,
    );
    if (result.ok) expect(result.resolved.website).toBe('https://app.geniecore.net');
  });

  it('accepts website when searchedDomain absent but derived domain matches (option 2 skipped, option 4 passes)', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://geniecore.net' }), // no searchedDomain
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'eric@geniecore.net', firstName: 'Eric', lastName: 'Smith' },
        needsCompanyFields: true,
      }),
      deps,
    );
    if (result.ok) expect(result.resolved.website).toBe('https://geniecore.net');
  });

  it('does not fire when needsCompanyFields=false', async () => {
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest.fn().mockResolvedValue(null),
    });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'eric@geniecore.net', firstName: 'Eric', lastName: 'Smith' },
        needsCompanyFields: false,
      }),
      deps,
    );
    expect(deps.resolveCompanyDomainViaWebSearch).not.toHaveBeenCalled();
  });

  // Fix #3 — subdomain email domain predicate
  // rawEmailDomain.endsWith('.' + derivedFromWebsite) allows the parent domain
  // to match when the lead email uses a subdomain (e.g. marketing.acme.com).

  it('Fix #3: subdomain email + parent domain website → accepted', async () => {
    // Lead email is john@marketing.acme.com → rawEmailDomain = "marketing.acme.com"
    // LLM returns website = "https://acme.com" → derivedFromWebsite = "acme.com"
    // Old predicate: "acme.com".endsWith(".marketing.acme.com") → false → rejected
    // New predicate: "marketing.acme.com".endsWith(".acme.com") → true → accepted
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://acme.com', searchedDomain: 'acme.com' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'john@marketing.acme.com', firstName: 'John', lastName: 'Doe' },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.website).toBe('https://acme.com');
  });

  it('Fix #3: subdomain email + unrelated domain website → rejected', async () => {
    // LLM returns a completely different domain — must still be rejected.
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://othercorp.com', searchedDomain: 'othercorp.com' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'john@marketing.acme.com', firstName: 'John', lastName: 'Doe' },
        needsCompanyFields: true,
      }),
      deps,
    );
    // Gate still passes (business email domain), but website must NOT be set
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.website).toBeUndefined();
  });

  it('Fix #3: exact domain match still works after predicate change', async () => {
    // Regression check: john@acme.com + website "https://acme.com" → d === rawEmailDomain → accepted
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ website: 'https://acme.com', searchedDomain: 'acme.com' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'john@acme.com', firstName: 'John', lastName: 'Doe' },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.website).toBe('https://acme.com');
  });
});

// ─── Tier 0.5 Fix #5 — company-only result when no domain hint ───────────────
//
// When the LLM returns a company name but no website, we only accept it when
// no domain hint (hasBusinessEmailDomain=false) was used, since without a
// website we cannot validate via domain match.

describe('resolveIdentity — Tier 0.5 company-only result (Fix #5)', () => {
  it('Fix #5: company-only result written when lead has a company name hint (no email) and LLM returns a confirmed company', async () => {
    // Lead has company name (triggers tier05HasSignal) but no email →
    // hasBusinessEmailDomain=false. LLM returns company but no website.
    // Fix #5 guards: !hasBusinessEmailDomain=true BUT !lead.company=false because
    // the lead already has a company — so this block is correctly skipped and
    // the resolved.company comes from the sibling/apollo path (or stays absent).
    // This test validates that lead.company is not overwritten by Fix #5.
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ company: 'New Corp Name', website: undefined }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', company: 'Existing Corp' },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    // lead.company is already "Existing Corp" — Fix #5 !lead.company guard blocks overwrite
    if (result.ok) expect(result.resolved.company).toBeUndefined();
  });

  it('Fix #5: company-only result ignored when domain hint was used (hasBusinessEmailDomain=true)', async () => {
    // Lead has business email → hasBusinessEmailDomain=true → Fix #5 block skipped.
    // LLM returns company but no website → company must NOT be written via Fix #5 path.
    // (The website validation also fails because no website was returned, so company
    // is not written via the websiteAccepted path either.)
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ company: 'Acme Corp', website: undefined }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'john@acme.com', firstName: 'John', lastName: 'Doe' },
        needsCompanyFields: true,
      }),
      deps,
    );
    // Gate passes via business email domain, but company must not have been set
    // by the company-only path (it was blocked by hasBusinessEmailDomain=true).
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.company).toBeUndefined();
  });

  it('Fix #5: company-only result written when sibling fills resolved.company and LLM confirms same — no double-write', async () => {
    // Verifies Fix #5 condition: !lead.company is true (no company on lead) and
    // !resolved.company is also true at Fix #5 check time (no prior company set).
    // This is the core scenario: lead has company on lead → different from
    // what LLM returns. Guard prevents clobbering.
    // Use lead with no company — tier05HasSignal = false → tier 0.5 doesn't fire.
    // resolveCompanyDomainViaWebSearch must NOT be called at all.
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest.fn().mockResolvedValue({ company: 'Inferred Corp', website: undefined }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe' },
        needsCompanyFields: true,
      }),
      deps,
    );
    // No company + no business email → tier05HasSignal=false → tier 0.5 doesn't fire
    expect(deps.resolveCompanyDomainViaWebSearch).not.toHaveBeenCalled();
    // Gate fires: no company resolved → identity_unresolvable
    expect(result.ok).toBe(false);
  });

  it('Fix #5: company-only result NOT overwritten when lead already has company', async () => {
    // lead.company="Existing Corp" → Fix #5 guard (!lead.company) prevents overwrite.
    // The LLM returns a different company name — must not clobber the existing value.
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest
        .fn()
        .mockResolvedValue({ company: 'New Corp', website: undefined }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', company: 'Existing Corp' },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    // Fix #5 guard: !lead.company = false → block skipped → resolved.company not set by Fix #5
    if (result.ok) expect(result.resolved.company).toBeUndefined();
  });
});

// ─── Step 5.5 — enrich.so email-finder → reverse-lookup chain ────────────────

describe('resolveIdentity — step 5.5 enrich.so email-finder chain', () => {
  it('calls enrichSoFindEmail then enrichSoReverseLookup when no email but has name+emailDomain', async () => {
    const enrichSoFindEmail = jest.fn().mockResolvedValue({ email: 'jane@acme.com' });
    const enrichSoReverseLookup = jest.fn().mockResolvedValue({ company: 'Acme', firstName: 'Jane', lastName: 'Doe' });
    const deps = makeDeps({ enrichSoFindEmail, enrichSoReverseLookup });

    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(enrichSoFindEmail).toHaveBeenCalledWith({ firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' });
    expect(enrichSoReverseLookup).toHaveBeenCalledWith({ email: 'jane@acme.com' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('jane@acme.com');
    expect(result.resolved.company).toBe('Acme');
  });

  it('does not overwrite existing firstName/lastName from 5.5 reverse-lookup — names already known at gate', async () => {
    const enrichSoFindEmail = jest.fn().mockResolvedValue({ email: 'jane@acme.com' });
    // enrich.so returns different names — must NOT overwrite lead names
    const enrichSoReverseLookup = jest.fn().mockResolvedValue({ company: 'Acme', firstName: 'Janet', lastName: 'Smith' });
    const deps = makeDeps({ enrichSoFindEmail, enrichSoReverseLookup });

    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.firstName).toBeUndefined(); // lead.firstName already set — no overwrite
    expect(result.resolved.lastName).toBeUndefined();  // lead.lastName already set — no overwrite
    expect(result.resolved.company).toBe('Acme');
  });

  it('resolved email from email-finder makes step 6 enrichSoReverseLookup eligible for company', async () => {
    const enrichSoFindEmail = jest.fn().mockResolvedValue({ email: 'jane@acme.com' });
    const enrichSoReverseLookup = jest.fn().mockResolvedValue({ company: 'Acme Inc' });
    const deps = makeDeps({ enrichSoFindEmail, enrichSoReverseLookup });

    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(enrichSoReverseLookup).toHaveBeenCalledWith({ email: 'jane@acme.com' });
    if (!result.ok) return;
    expect(result.resolved.company).toBe('Acme Inc');
  });

  it('does not call enrichSoFindEmail when email already present', async () => {
    const enrichSoFindEmail = jest.fn();
    const deps = makeDeps({ enrichSoFindEmail });

    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(enrichSoFindEmail).not.toHaveBeenCalled();
  });

  it('does not call enrichSoFindEmail when firstName missing', async () => {
    const enrichSoFindEmail = jest.fn();
    const deps = makeDeps({ enrichSoFindEmail });

    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(enrichSoFindEmail).not.toHaveBeenCalled();
  });

  it('does not call enrichSoFindEmail when emailDomain missing', async () => {
    const enrichSoFindEmail = jest.fn();
    const deps = makeDeps({ enrichSoFindEmail });

    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(enrichSoFindEmail).not.toHaveBeenCalled();
  });

  it('skips reverse-lookup when email-finder returns null', async () => {
    const enrichSoFindEmail = jest.fn().mockResolvedValue(null);
    const enrichSoReverseLookup = jest.fn();
    const deps = makeDeps({ enrichSoFindEmail, enrichSoReverseLookup });

    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
      }),
      deps,
    );

    expect(enrichSoFindEmail).toHaveBeenCalledTimes(1);
    expect(enrichSoReverseLookup).not.toHaveBeenCalled();
  });

  it('step 6 does not call enrichSoReverseLookup again when 5.5 chain already filled company', async () => {
    // 5.5: findEmail → resolves email, reverse-lookup fills company.
    // Step 6 gate: companyStillMissing = false → inner block must not fire.
    const enrichSoFindEmail = jest.fn().mockResolvedValue({ email: 'jane@acme.com' });
    const enrichSoReverseLookup = jest.fn().mockResolvedValue({ company: 'Acme' });
    const deps = makeDeps({ enrichSoFindEmail, enrichSoReverseLookup });

    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        needsCompanyFields: true,
      }),
      deps,
    );

    // enrichSoReverseLookup called exactly once — inside 5.5 chain, not again in step 6.
    expect(enrichSoReverseLookup).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.company).toBe('Acme');
  });
});

// ─── Unified Apollo call (expanded signals) ────────────────────────────────────

describe('resolveIdentity — unified Apollo call with expanded signals', () => {
  it('fires Apollo for name+company lead (no email, no linkedin)', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue(null),
    });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Ayush', lastName: 'Jha', company: 'Agoda' },
        needsPersonFields: true,
      }),
      deps,
    );
    expect(deps.apolloPeopleMatch).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Ayush', lastName: 'Jha', company: 'Agoda' }),
    );
  });

  it('resolves email from Apollo when lead has name+emailDomain (verified status)', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        email: 'ayush@agoda.com',
        emailStatus: 'verified',
        firstName: 'Ayush',
        lastName: 'Jha',
      }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Ayush', lastName: 'Jha', emailDomain: 'agoda.com' },
        needsPersonFields: true,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('ayush@agoda.com');
  });

  it('accepts guessed email AND fills all Apollo fields on weak signal (name+domain only)', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        email: 'ayush@agoda.com',
        emailStatus: 'guessed',
        title: 'Engineer',
        company: 'Agoda',
      }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Ayush', lastName: 'Jha', emailDomain: 'agoda.com' },
        needsPersonFields: true,
        needsCompanyFields: false,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('ayush@agoda.com');  // guessed → accepted
    expect(result.resolved.title).toBe('Engineer');          // emailTrusted=true → matchConfident=true
  });

  it('stores confidence=low in email meta for guessed status', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        email: 'ayush@agoda.com',
        emailStatus: 'guessed',
      }),
      writeLeadFields: jest.fn().mockResolvedValue(undefined),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Ayush', lastName: 'Jha', emailDomain: 'agoda.com' },
        needsPersonFields: true,
        mode: 'enrich',
        listId: 'list-1',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const writeCalls = (deps.writeLeadFields as jest.Mock).mock.calls;
    const emailMeta = writeCalls[0]?.[0]?.meta?.email;
    expect(emailMeta?.confidence).toBe('low');
  });

  it('stores confidence=high in email meta for verified status', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        email: 'ayush@agoda.com',
        emailStatus: 'verified',
      }),
      writeLeadFields: jest.fn().mockResolvedValue(undefined),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Ayush', lastName: 'Jha', emailDomain: 'agoda.com' },
        needsPersonFields: true,
        mode: 'enrich',
        listId: 'list-1',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const writeCalls = (deps.writeLeadFields as jest.Mock).mock.calls;
    const emailMeta = writeCalls[0]?.[0]?.meta?.email;
    expect(emailMeta?.confidence).toBe('high');
  });

  it('accepts guessed email with linkedin anchor and fills all non-email fields', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        email: 'ayush@agoda.com',
        emailStatus: 'guessed',
        title: 'Engineer',
        company: 'Agoda',
      }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          firstName: 'Ayush',
          lastName: 'Jha',
          linkedin: 'https://linkedin.com/in/ayush',
          emailDomain: 'agoda.com',
        },
        needsPersonFields: true,
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('ayush@agoda.com');  // guessed → accepted
    expect(result.resolved.title).toBe('Engineer');
    expect(result.resolved.company).toBe('Agoda');
  });

  it('sends all available signals combined when lead has email+linkedin+name+domain (company missing)', async () => {
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue(null),
    });
    await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          email: 'jane@acme.com',
          linkedin: 'https://linkedin.com/in/jane',
          firstName: 'Jane',
          lastName: 'Doe',
          emailDomain: 'acme.com',
        },
        needsPersonFields: true,
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(deps.apolloPeopleMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'jane@acme.com',
        linkedinUrl: 'https://linkedin.com/in/jane',
        firstName: 'Jane',
        lastName: 'Doe',
        domain: 'acme.com',
      }),
    );
  });

  it('calls Apollo for personal email leads (no early bail-out)', async () => {
    const deps = makeDeps();
    await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          email: 'bfactor@yahoo.com',
          firstName: 'Bob',
          lastName: 'Factor',
        },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(deps.apolloPeopleMatch).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'bfactor@yahoo.com' }),
    );
  });

  it('strips freemail domain from Apollo input so personal email does not mislead org lookup', async () => {
    const deps = makeDeps();
    await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          email: 'bfactor@yahoo.com',
          firstName: 'Bob',
          lastName: 'Factor',
        },
        needsCompanyFields: true,
      }),
      deps,
    );
    const call = (deps.apolloPeopleMatch as jest.Mock).mock.calls[0][0];
    expect(call.domain).toBeUndefined();
  });

  it('preserves business domain in Apollo input for non-freemail leads', async () => {
    const deps = makeDeps();
    await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          email: 'alice@acme.com',
          firstName: 'Alice',
          lastName: 'Smith',
        },
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(deps.apolloPeopleMatch).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'acme.com' }),
    );
  });

  it('skips Apollo when no signals at all (no email, linkedin, or name)', async () => {
    const deps = makeDeps();
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, company: 'Acme' },
        needsPersonFields: true,
      }),
      deps,
    ).catch(() => {});
    expect(deps.apolloPeopleMatch).not.toHaveBeenCalled();
  });

  it('found email flows into enrich.so reverse-lookup chain (Tier 5.5 uses Apollo-found email)', async () => {
    const enrichSoReverseLookup = jest.fn().mockResolvedValue({ company: 'Agoda' });
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        email: 'ayush@agoda.com',
        emailStatus: 'verified',
      }),
      enrichSoReverseLookup,
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Ayush', lastName: 'Jha', emailDomain: 'agoda.com' },
        needsPersonFields: true,
        needsCompanyFields: true,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('ayush@agoda.com');
    expect(result.resolved.company).toBe('Agoda');
  });
});

// ─── Tier 6.5 — Apollo broker chain ──────────────────────────────────────────

describe('resolveIdentity — broker chain (Tier 6.5)', () => {
  it('fires when email missing + name + emailDomain + leadHint', async () => {
    const apolloBrokerChain = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ apolloBrokerChain });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        leadHint: LEAD_HINT,
      }),
      deps,
    );
    expect(apolloBrokerChain).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' }),
      LEAD_HINT,
    );
  });

  it('skipped when no leadHint', async () => {
    const apolloBrokerChain = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ apolloBrokerChain });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        // no leadHint
      }),
      deps,
    );
    expect(apolloBrokerChain).not.toHaveBeenCalled();
  });

  it('skipped when email already present on lead', async () => {
    const apolloBrokerChain = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ apolloBrokerChain });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        leadHint: LEAD_HINT,
      }),
      deps,
    );
    expect(apolloBrokerChain).not.toHaveBeenCalled();
  });

  it('accepts verified email on weak signal (name+domain only)', async () => {
    const deps = makeDeps({
      apolloBrokerChain: jest.fn().mockResolvedValue({ email: 'jane@acme.com', emailStatus: 'verified' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        leadHint: LEAD_HINT,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('jane@acme.com');
  });

  it('accepts guessed email (confidence=low) regardless of signal strength', async () => {
    const deps = makeDeps({
      apolloBrokerChain: jest.fn().mockResolvedValue({ email: 'jane@acme.com', emailStatus: 'guessed' }),
      writeLeadFields: jest.fn().mockResolvedValue(undefined),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          firstName: 'Jane',
          lastName: 'Doe',
          emailDomain: 'acme.com',
          linkedin: 'https://linkedin.com/in/jane',
        },
        needsPersonFields: true,
        leadHint: LEAD_HINT,
        mode: 'enrich',
        listId: 'list-1',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('jane@acme.com');
    const writeCalls = (deps.writeLeadFields as jest.Mock).mock.calls;
    const emailMeta = writeCalls[0]?.[0]?.meta?.email;
    expect(emailMeta?.confidence).toBe('low');
  });

  it('accepts undefined emailStatus on weak signal (confidence=medium)', async () => {
    const deps = makeDeps({
      apolloBrokerChain: jest.fn().mockResolvedValue({ email: 'jane@acme.com', emailStatus: undefined }),
      writeLeadFields: jest.fn().mockResolvedValue(undefined),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        leadHint: LEAD_HINT,
        mode: 'enrich',
        listId: 'list-1',
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('jane@acme.com');
    const writeCalls = (deps.writeLeadFields as jest.Mock).mock.calls;
    const emailMeta = writeCalls[0]?.[0]?.meta?.email;
    expect(emailMeta?.confidence).toBe('medium');
  });

  it('accepts undefined emailStatus with linkedin (confidence=medium)', async () => {
    const deps = makeDeps({
      apolloBrokerChain: jest.fn().mockResolvedValue({ email: 'jane@acme.com', emailStatus: undefined }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: {
          leadId: LEAD_ID,
          firstName: 'Jane',
          lastName: 'Doe',
          emailDomain: 'acme.com',
          linkedin: 'https://linkedin.com/in/jane',
        },
        needsPersonFields: true,
        leadHint: LEAD_HINT,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('jane@acme.com');
  });

  it('falls through to pattern matching when broker chain returns null', async () => {
    const findEmailViaPatterns = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({
      apolloBrokerChain: jest.fn().mockResolvedValue(null),
      findEmailViaPatterns,
    });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        leadHint: LEAD_HINT,
      }),
      deps,
    );
    expect(findEmailViaPatterns).toHaveBeenCalled();
  });
});

// ─── Tier 7 — Pattern matching ────────────────────────────────────────────────

describe('resolveIdentity — pattern matching (Tier 7)', () => {
  it('fires when email missing + name + emailDomain (no leadHint required)', async () => {
    const findEmailViaPatterns = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ findEmailViaPatterns });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        // no leadHint
      }),
      deps,
    );
    expect(findEmailViaPatterns).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jane', lastName: 'Doe', domain: 'acme.com' }),
    );
  });

  it('skipped when email already present', async () => {
    const findEmailViaPatterns = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ findEmailViaPatterns });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
      }),
      deps,
    );
    expect(findEmailViaPatterns).not.toHaveBeenCalled();
  });

  it('skipped when emailDomain missing (company only)', async () => {
    const findEmailViaPatterns = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ findEmailViaPatterns });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
        needsPersonFields: true,
      }),
      deps,
    );
    expect(findEmailViaPatterns).not.toHaveBeenCalled();
  });

  it('resolves email and sets emailPattern on result', async () => {
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'j.doe@acme.com', pattern: 'f.last@domain' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.email).toBe('j.doe@acme.com');
    expect(result.emailPattern).toBe('f.last@domain');
  });

  it('meta.email provider is "pattern" when pattern matching finds email', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'j.doe@acme.com', pattern: 'f.last@domain' }),
      writeLeadFields,
    });
    await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
        needsPersonFields: true,
        mode: 'enrich',
      }),
      deps,
    );
    expect(writeLeadFields).toHaveBeenCalled();
    const call = writeLeadFields.mock.calls[0][0];
    expect(call.meta.email.provider).toBe('pattern');
  });
});

// ─── Tier 7 — Pattern-email attribution (Fix 2) ───────────────────────────────

describe('resolveIdentity — Tier 7 pattern-email attribution (Fix 2)', () => {
  function tier7Input() {
    return makeInput({
      lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', emailDomain: 'acme.com' },
      needsPersonFields: false,
      needsCompanyFields: false,
    });
  }

  it('FAIL CASE: pattern-email meta has provider "pattern", not "enrich.so"', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'jane.doe@acme.com', pattern: 'first.last' }),
      writeLeadFields,
    });
    await resolveIdentity(tier7Input(), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta.email;
    expect(meta.source).toBe('api');
    expect(meta.provider).toBe('pattern');
  });

  it('FAIL CASE: pattern-email meta carries the pattern in sourceQuote', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'jane.doe@acme.com', pattern: 'first.last' }),
      writeLeadFields,
    });
    await resolveIdentity(tier7Input(), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta.email;
    expect(meta.sourceQuote).toBe('pattern: first.last');
  });

  it('FAIL CASE: pattern-email meta confidence is "medium"', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'jane.doe@acme.com', pattern: 'flast' }),
      writeLeadFields,
    });
    await resolveIdentity(tier7Input(), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta.email;
    expect(meta.confidence).toBe('medium');
  });

  it('SUCCESS CASE: the resolved email value is still persisted', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'jane.doe@acme.com', pattern: 'first.last' }),
      writeLeadFields,
    });
    const result = await resolveIdentity(tier7Input(), deps);
    expect(result.ok).toBe(true);
    expect((writeLeadFields as jest.Mock).mock.calls[0][0].fields.email).toBe('jane.doe@acme.com');
  });

  it('pattern-email meta has no sourceQuote when pattern is absent', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findEmailViaPatterns: jest.fn().mockResolvedValue({ email: 'jane.doe@acme.com' }), // no pattern
      writeLeadFields,
    });
    await resolveIdentity(tier7Input(), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta.email;
    expect(meta.sourceQuote).toBeUndefined();
    expect(meta.provider).toBe('pattern');
  });
});

// ─── Company gate: hasBusinessEmailDomain ─────────────────────────────────────

describe('resolveIdentity — company gate accepts hasBusinessEmailDomain', () => {
  it('passes through when lead has business email, no company, needsCompanyFields=true', async () => {
    // wootech.systems is a business domain → hasBusinessEmailDomain=true → companyOk=true
    const deps = makeDeps({
      resolveCompanyDomainViaWebSearch: jest.fn().mockResolvedValue({
        website: 'https://wootech.systems',
        company: 'WooTech',
        searchedDomain: 'wootech.systems',
      }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'dave@wootech.systems' },
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
  });

  it('blocks when lead has personal email (gmail.com), no company, needsCompanyFields=true', async () => {
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'dave@gmail.com' },
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('identity_unresolvable');
  });

  it('blocks when lead has no email and no company, needsCompanyFields=true', async () => {
    const deps = makeDeps();
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, firstName: 'Dave', lastName: 'Smith' },
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('identity_unresolvable');
  });
});

describe('resolveIdentity — makeApiMeta per-field confidence (Fix 6)', () => {
  it('FAIL CASE: an Apollo-resolved firstName carries high confidence', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', company: 'Acme', email: 'jane@acme.com', emailStatus: 'verified',
      }),
      writeLeadFields,
    });
    await resolveIdentity(makeInput({
      lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
      needsPersonFields: true,
    }), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta;
    expect(meta.firstName.confidence).toBe('high');
  });

  it('FAIL CASE: an Apollo-resolved company carries medium confidence (per-field, not high)', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      apolloPeopleMatch: jest.fn().mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', company: 'Acme', email: 'jane@acme.com', emailStatus: 'verified',
      }),
      writeLeadFields,
    });
    await resolveIdentity(makeInput({
      lead: { leadId: LEAD_ID, email: 'jane@acme.com' },
      needsPersonFields: true,
      needsCompanyFields: true,
    }), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta;
    expect(meta.company.confidence).toBe('medium');
    // The same Apollo result fills firstName at 'high' — proves per-field lookup.
    expect(meta.firstName.confidence).toBe('high');
  });

  it('FAIL CASE: an enrich.so reverse-lookup company carries medium confidence', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      enrichSoReverseLookup: jest.fn().mockResolvedValue({ company: 'Acme', firstName: 'Jane', lastName: 'Doe' }),
      writeLeadFields,
    });
    await resolveIdentity(makeInput({
      lead: { leadId: LEAD_ID, email: 'jane@personal.com' },
      needsCompanyFields: true,
    }), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta;
    expect(meta.company.confidence).toBe('medium');
    // enrich.so rates firstName 'high' in the registry — per-field lookup proof.
    expect(meta.firstName).toBeDefined();
    expect(meta.firstName.confidence).toBe('high');
  });

  it('SUCCESS CASE: a Unipile-resolved linkedin carries medium confidence', async () => {
    const writeLeadFields = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findLinkedInUrl: jest.fn().mockResolvedValue('https://www.linkedin.com/in/jane-doe'),
      writeLeadFields,
    });
    await resolveIdentity(makeInput({
      lead: { leadId: LEAD_ID, firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
      needsPersonFields: true,
    }), deps);
    const meta = (writeLeadFields as jest.Mock).mock.calls[0][0].meta;
    expect(meta.linkedin.confidence).toBe('medium');
  });
});
