// ENG-2720: the pre-run quote prices two things off the lead record: which leads the identity resolver skips
// (they book nothing) and which emailless leads the Apollo broker can be sent for (the $0.445 line). Both rules
// are re-implemented in enrichmentQuote.ts so the quote never has to run a lead. These tests run the REAL resolver
// and the REAL broker gate (enrichmentGroupWaterfall tier 3.5a) over the same lead shapes and require them to agree
// with `hasIdentitySignal` / `canReachApolloBroker`, so a change to either gate fails here instead of silently
// skewing every customer's estimate (the first calibration counted website/domain as eligible; the real gate never did).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
import {
  createApolloFetchContext,
  createEnrichSoFetchContext,
  runWaterfall,
  type WaterfallDeps,
} from '../services/enrichmentGroupWaterfall';
import { resolveIdentity, type IdentityResolverDeps } from '../services/enrichmentIdentityResolver';
import { canReachApolloBroker, hasIdentitySignal } from '../services/enrichmentQuote';
import type { LeadRecord } from '../services/crmEnrichmentService';

type Shape = { name: string; lead: Record<string, unknown> };

const shapes: Shape[] = [
  { name: 'full name + company', lead: { firstName: 'Ada', lastName: 'Lovelace', company: 'Acme' } },
  { name: 'full name + emailDomain', lead: { firstName: 'Ada', lastName: 'Lovelace', emailDomain: 'acme.com' } },
  { name: 'full name + website only', lead: { firstName: 'Ada', lastName: 'Lovelace', website: 'https://acme.com' } },
  { name: 'full name + domain only', lead: { firstName: 'Ada', lastName: 'Lovelace', domain: 'acme.com' } },
  { name: 'full name alone', lead: { firstName: 'Ada', lastName: 'Lovelace' } },
  { name: 'first name + company', lead: { firstName: 'Ada', company: 'Acme' } },
  { name: 'last name + company', lead: { lastName: 'Lovelace', company: 'Acme' } },
  { name: 'blank first name + company', lead: { firstName: '  ', lastName: 'Lovelace', company: 'Acme' } },
  { name: 'company alone', lead: { company: 'Acme' } },
  { name: 'website alone', lead: { website: 'https://acme.com' } },
  { name: 'LinkedIn + company', lead: { linkedin: 'https://linkedin.com/in/ada', company: 'Acme' } },
  { name: 'LinkedIn alone', lead: { linkedin: 'https://linkedin.com/in/ada' } },
];

const LEAD_HINT = { listId: 'list-1', leadId: 'lead-1' };

function waterfallDeps(apolloBrokerChain: jest.Mock): WaterfallDeps {
  return {
    fetchApolloOrg: jest.fn().mockResolvedValue(null),
    fetchApolloPerson: jest.fn().mockResolvedValue(null),
    extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    fetchWebForGroup: jest.fn().mockResolvedValue(null),
    apolloBrokerChain,
  };
}

describe('canReachApolloBroker matches the real tier 3.5a gate', () => {
  it.each(shapes)('$name', async ({ lead }) => {
    const broker = jest.fn().mockResolvedValue(null);
    await runWaterfall(
      {
        listId: 'list-1',
        lead: { leadId: 'lead-1', enrichmentMetadata: {}, customFields: {}, ...lead } as unknown as LeadRecord,
        groupName: 'person_identity',
        requestedFields: ['email'],
        configFieldsByName: {},
        apolloCtx: createApolloFetchContext(),
        enrichSoCtx: createEnrichSoFetchContext(),
        refreshFields: new Set<string>(),
        leadHint: LEAD_HINT,
      },
      waterfallDeps(broker),
    );
    expect(broker.mock.calls.length > 0).toBe(canReachApolloBroker(lead));
  });

  it('does not fire for a person_identity run that does not request the email', async () => {
    const broker = jest.fn().mockResolvedValue(null);
    await runWaterfall(
      {
        listId: 'list-1',
        lead: { leadId: 'lead-1', enrichmentMetadata: {}, customFields: {}, firstName: 'Ada', lastName: 'Lovelace', company: 'Acme' } as unknown as LeadRecord,
        groupName: 'person_identity',
        requestedFields: ['title'],
        configFieldsByName: {},
        apolloCtx: createApolloFetchContext(),
        enrichSoCtx: createEnrichSoFetchContext(),
        refreshFields: new Set<string>(),
        leadHint: LEAD_HINT,
      },
      waterfallDeps(broker),
    );
    expect(broker).not.toHaveBeenCalled();
  });
});

describe('hasIdentitySignal matches the real identity resolver (no_identity_signal)', () => {
  const resolverDeps = (): IdentityResolverDeps => ({
    apolloPeopleMatch: jest.fn().mockResolvedValue(null),
    enrichSoReverseLookup: jest.fn().mockResolvedValue(null),
    enrichSoFindEmail: jest.fn().mockResolvedValue(null),
    findLinkedInUrl: jest.fn().mockResolvedValue(null),
    findSiblingLeads: jest.fn().mockResolvedValue([]),
    resolveCompanyDomainViaWebSearch: jest.fn().mockResolvedValue(null),
    writeLeadFields: jest.fn().mockResolvedValue(undefined),
    apolloBrokerChain: jest.fn().mockResolvedValue(null),
    findEmailViaPatterns: jest.fn().mockResolvedValue(null),
  });

  const withEmail: Shape[] = [
    ...shapes,
    { name: 'real email alone', lead: { email: 'jane@acme.com' } },
    { name: 'placeholder email alone', lead: { email: 'queue-verify@example.com' } },
    { name: 'blank email + company', lead: { email: '   ', company: 'Acme' } },
  ];

  it.each(withEmail)('$name', async ({ lead }) => {
    const deps = resolverDeps();
    const result = await resolveIdentity(
      { listId: 'list-1', lead: { leadId: 'lead-1', ...lead } as unknown as LeadRecord, needsPersonFields: true, needsCompanyFields: false, mode: 'enrich' },
      deps,
    );
    const skippedByResolver = !result.ok && result.reason === 'no_identity_signal';
    // The quote's own "usable email" test is the route's (blank or placeholder-domain = none); mirror it here.
    const email = typeof lead.email === 'string' ? lead.email.trim() : '';
    const usable = email.length > 0 && !email.endsWith('@example.com');
    expect(!skippedByResolver).toBe(hasIdentitySignal(lead, usable));
    if (skippedByResolver) {
      // skipped before any paid call: that is why the quote charges nothing for it
      for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled();
    }
  });
});
