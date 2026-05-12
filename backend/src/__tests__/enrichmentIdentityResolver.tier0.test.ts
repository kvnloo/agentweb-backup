// Tests for CRM-history Tier 0 — the new step 1.5 of resolveIdentity.
// Cross-tenant sibling-lead lookup before Apollo/enrich.so. Per-field
// best-of-N merge across all candidates returned by findSiblingLeads.
// Fills empties only; respects refreshFields; per-field audit IDs.

import {
  resolveIdentity,
  type IdentityResolverDeps,
  type ResolveIdentityInput,
  type SiblingLeadResult,
} from '../services/enrichmentIdentityResolver';
import type { LeadRecord } from '../services/crmEnrichmentService';

const LIST_ID = 'list-test';
const LEAD_ID = 'lead-001';

function makeDeps(overrides: Partial<IdentityResolverDeps> = {}): IdentityResolverDeps {
  return {
    apolloPeopleMatch: jest.fn().mockResolvedValue(null),
    apolloOrgMatch: jest.fn().mockResolvedValue(null),
    enrichSoReverseLookup: jest.fn().mockResolvedValue(null),
    findSiblingLeads: jest.fn().mockResolvedValue([]),
    writeLeadFields: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeInput(overrides: Partial<ResolveIdentityInput> = {}): ResolveIdentityInput {
  return {
    listId: LIST_ID,
    lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord,
    needsPersonFields: true,
    needsCompanyFields: true,
    mode: 'preview',
    ...overrides,
  };
}

function makeSibling(overrides: Partial<SiblingLeadResult> = {}): SiblingLeadResult {
  return {
    leadId: 'sib-1',
    listId: 'sib-list',
    userId: 'sib-user',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@acme.com',
    company: 'Acme',
    website: 'https://acme.com',
    ...overrides,
  };
}

describe('resolveIdentity — Tier 0 CRM-history (single sibling)', () => {
  it('copies identity fields from a sibling when current lead is empty', async () => {
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([makeSibling()]),
    });
    const result = await resolveIdentity(
      makeInput({ lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.firstName).toBe('Jane');
    expect(result.resolved.lastName).toBe('Doe');
    expect(result.resolved.company).toBe('Acme');
    expect(deps.apolloPeopleMatch).not.toHaveBeenCalled();
    expect(deps.apolloOrgMatch).not.toHaveBeenCalled();
  });

  it('stamps source crm-history and sibling IDs in the meta for audit', async () => {
    const writeSpy = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([makeSibling()]),
      writeLeadFields: writeSpy,
    });
    await resolveIdentity(
      makeInput({
        mode: 'enrich',
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord,
      }),
      deps,
    );

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const writeCall = writeSpy.mock.calls[0][0];
    expect(writeCall.meta.firstName.source).toBe('crm-history');
    expect(writeCall.meta.firstName.provider).toBe('agentweb');
    expect(writeCall.meta.firstName.siblingLeadId).toBe('sib-1');
    expect(writeCall.meta.firstName.siblingListId).toBe('sib-list');
    expect(writeCall.meta.firstName.siblingUserId).toBe('sib-user');
  });

  it('does not overwrite a non-empty current value (fill-empties rule)', async () => {
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([makeSibling({ firstName: 'WRONG' })]),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com', firstName: 'Existing' } as LeadRecord,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.firstName).toBeUndefined();
  });

  it('respects refreshFields — skips Tier 0 fill for fields the user marked for refresh', async () => {
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([makeSibling()]),
      apolloPeopleMatch: jest.fn().mockResolvedValue({ firstName: 'FromApollo' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord,
        refreshFields: new Set([`${LEAD_ID}:firstName`]),
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.firstName).toBe('FromApollo');
    expect(result.resolved.lastName).toBe('Doe');
  });

  it('falls through to Apollo on Tier 0 miss', async () => {
    const apolloPersonSpy = jest.fn().mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' });
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([]),
      apolloPeopleMatch: apolloPersonSpy,
    });
    const result = await resolveIdentity(
      makeInput({
        needsCompanyFields: false,
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord,
      }),
      deps,
    );

    expect(result.ok).toBe(true);
    expect(apolloPersonSpy).toHaveBeenCalled();
  });

  it('passes the current leadId as excludeLeadId so self-match is impossible', async () => {
    const findSpy = jest.fn().mockResolvedValue([]);
    const deps = makeDeps({ findSiblingLeads: findSpy });
    await resolveIdentity(makeInput(), deps);
    expect(findSpy).toHaveBeenCalledWith(
      expect.objectContaining({ excludeLeadId: LEAD_ID }),
    );
  });

  it('continues with Apollo when findSiblingLeads throws (Tier 0 failure is non-fatal)', async () => {
    const apolloPersonSpy = jest.fn().mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' });
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockRejectedValue(new Error('GSI temporarily unavailable')),
      apolloPeopleMatch: apolloPersonSpy,
    });
    const result = await resolveIdentity(
      makeInput({
        needsCompanyFields: false,
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    expect(apolloPersonSpy).toHaveBeenCalled();
  });

  it('does not copy empty sibling fields', async () => {
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([
        makeSibling({ firstName: '   ', lastName: '' }),
      ]),
      apolloPeopleMatch: jest.fn().mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' }),
    });
    const result = await resolveIdentity(
      makeInput({
        needsCompanyFields: false,
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord,
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.firstName).toBe('Jane');
  });
});

describe('resolveIdentity — Tier 0 per-field best-of-N merge', () => {
  it('combines complementary fields from multiple siblings (freshest non-empty wins per field)', async () => {
    // Sibling A is freshest: has firstName, no company.
    // Sibling B is older: has company, no firstName.
    // Sibling C is oldest: has both — but A wins firstName, B wins company.
    const sibA = makeSibling({ leadId: 'sib-A', firstName: 'Jane', lastName: 'Doe', company: undefined, linkedin: undefined, website: undefined });
    const sibB = makeSibling({ leadId: 'sib-B', listId: 'list-B', userId: 'user-B', firstName: undefined, lastName: undefined, company: 'Acme Inc', linkedin: 'https://linkedin.com/in/jane' });
    const sibC = makeSibling({ leadId: 'sib-C', firstName: 'ShouldNotWin', company: 'ShouldNotWin' });

    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([sibA, sibB, sibC]),
    });

    const result = await resolveIdentity(
      makeInput({ lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.firstName).toBe('Jane');         // from sibA
    expect(result.resolved.company).toBe('Acme Inc');       // from sibB
    expect(result.resolved.linkedin).toBe('https://linkedin.com/in/jane'); // from sibB
  });

  it('records per-field sibling provenance — different fields may come from different siblings', async () => {
    const sibA = makeSibling({ leadId: 'sib-A', listId: 'list-A', userId: 'user-A', firstName: 'Jane', lastName: 'Doe', company: undefined, linkedin: undefined, website: undefined });
    const sibB = makeSibling({ leadId: 'sib-B', listId: 'list-B', userId: 'user-B', firstName: undefined, lastName: undefined, company: 'Acme', linkedin: undefined, website: undefined });

    const writeSpy = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([sibA, sibB]),
      writeLeadFields: writeSpy,
    });
    await resolveIdentity(
      makeInput({
        mode: 'enrich',
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord,
        needsPersonFields: true,
        needsCompanyFields: true,
      }),
      deps,
    );

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const meta = writeSpy.mock.calls[0][0].meta;
    expect(meta.firstName.siblingLeadId).toBe('sib-A');
    expect(meta.firstName.siblingUserId).toBe('user-A');
    expect(meta.company.siblingLeadId).toBe('sib-B');
    expect(meta.company.siblingUserId).toBe('user-B');
  });

  it('only the first non-empty value per field is taken (later siblings ignored for that field)', async () => {
    const sibA = makeSibling({ leadId: 'sib-A', firstName: 'WinnerJane' });
    const sibB = makeSibling({ leadId: 'sib-B', firstName: 'LoserJanet' });
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([sibA, sibB]),
    });
    const result = await resolveIdentity(
      makeInput({ lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.firstName).toBe('WinnerJane');
  });

  it('falls through to Apollo for fields no sibling could fill (partial Tier 0)', async () => {
    const sibA = makeSibling({ leadId: 'sib-A', firstName: 'Jane', lastName: 'Doe', company: undefined, website: undefined });
    const apolloOrgSpy = jest.fn().mockResolvedValue({ company: 'FromApollo', website: 'https://apollo.example.com' });
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([sibA]),
      apolloOrgMatch: apolloOrgSpy,
    });
    const result = await resolveIdentity(
      makeInput({ lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.firstName).toBe('Jane');         // Tier 0
    expect(result.resolved.company).toBe('FromApollo');     // Apollo filled what Tier 0 didn't
  });

  it('refreshFields skips per-field even when many siblings have the value', async () => {
    const sibA = makeSibling({ leadId: 'sib-A', firstName: 'A' });
    const sibB = makeSibling({ leadId: 'sib-B', firstName: 'B' });
    const sibC = makeSibling({ leadId: 'sib-C', firstName: 'C' });
    const deps = makeDeps({
      findSiblingLeads: jest.fn().mockResolvedValue([sibA, sibB, sibC]),
      apolloPeopleMatch: jest.fn().mockResolvedValue({ firstName: 'FromApollo' }),
    });
    const result = await resolveIdentity(
      makeInput({
        lead: { leadId: LEAD_ID, email: 'jane@acme.com' } as LeadRecord,
        refreshFields: new Set([`${LEAD_ID}:firstName`]),
      }),
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.firstName).toBe('FromApollo');
    // Other fields still came from siblings (sibA had lastName='Doe', company='Acme', etc.)
    expect(result.resolved.lastName).toBe('Doe');
  });
});
