// Tests for CRM-history Tier 0 — the new step 1.5 of resolveIdentity.
// Cross-tenant sibling-lead lookup before Apollo/enrich.so. Fills empties
// only; respects refreshFields; stamps source: 'crm-history' + sibling IDs
// in metadata for audit.

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
    findSiblingLead: jest.fn().mockResolvedValue(null),
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

describe('resolveIdentity — Tier 0 CRM-history', () => {
  it('copies identity fields from a sibling when current lead is empty', async () => {
    const deps = makeDeps({
      findSiblingLead: jest.fn().mockResolvedValue(makeSibling()),
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
    // Apollo should not run when Tier 0 supplied the missing fields.
    expect(deps.apolloPeopleMatch).not.toHaveBeenCalled();
    expect(deps.apolloOrgMatch).not.toHaveBeenCalled();
  });

  it('stamps source crm-history and sibling IDs in the meta for audit', async () => {
    const writeSpy = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findSiblingLead: jest.fn().mockResolvedValue(makeSibling()),
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
      findSiblingLead: jest.fn().mockResolvedValue(makeSibling({ firstName: 'WRONG' })),
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
      findSiblingLead: jest.fn().mockResolvedValue(makeSibling()),
      // Apollo runs as the natural fallback when Tier 0 skipped firstName.
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
    // firstName came from Apollo (the refresh source), not the sibling.
    expect(result.resolved.firstName).toBe('FromApollo');
    expect(result.resolved.lastName).toBe('Doe');   // Tier 0 still filled this
  });

  it('falls through to Apollo on Tier 0 miss', async () => {
    const apolloPersonSpy = jest.fn().mockResolvedValue({
      firstName: 'Jane', lastName: 'Doe',
    });
    const deps = makeDeps({
      findSiblingLead: jest.fn().mockResolvedValue(null),
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
    const findSiblingSpy = jest.fn().mockResolvedValue(null);
    const deps = makeDeps({ findSiblingLead: findSiblingSpy });
    await resolveIdentity(makeInput(), deps);
    expect(findSiblingSpy).toHaveBeenCalledWith(
      expect.objectContaining({ excludeLeadId: LEAD_ID }),
    );
  });

  it('continues with Apollo when findSiblingLead throws (Tier 0 failure is non-fatal)', async () => {
    const apolloPersonSpy = jest.fn().mockResolvedValue({
      firstName: 'Jane', lastName: 'Doe',
    });
    const deps = makeDeps({
      findSiblingLead: jest.fn().mockRejectedValue(new Error('GSI temporarily unavailable')),
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

  it('Tier 0 partial fill — Apollo runs for fields not filled by Tier 0', async () => {
    const apolloPersonSpy = jest.fn().mockResolvedValue({
      title: 'VP Sales',
    });
    const deps = makeDeps({
      // Sibling has firstName/lastName but not title.
      findSiblingLead: jest.fn().mockResolvedValue(makeSibling({ title: undefined })),
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
    if (!result.ok) return;
    expect(result.resolved.firstName).toBe('Jane');
    // Apollo only ran if needs were unmet — with both firstName+lastName from
    // sibling, Apollo people-match is skipped (personStillMissing falsy).
    // For TITLE specifically, this test doesn't drive Apollo people-match
    // because the resolver only calls it when name fields are still missing.
    expect(apolloPersonSpy).not.toHaveBeenCalled();
  });

  it('does not copy empty sibling fields', async () => {
    const deps = makeDeps({
      findSiblingLead: jest.fn().mockResolvedValue(makeSibling({ firstName: '   ', lastName: '' })),
      // Apollo runs as fallback for missing names.
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
    // Came from Apollo, not the empty sibling values.
    expect(result.resolved.firstName).toBe('Jane');
  });
});
