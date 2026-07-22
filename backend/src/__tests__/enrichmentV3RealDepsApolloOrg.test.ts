/**
 * Tests for the fetchApolloOrg adapter in enrichmentV3RealDeps.
 *
 * Bug (ENG-433): leads with a university / free-mail email (e.g. alum.mit.edu,
 * berkeley.edu, yahoo.com) had their `company` set to the institution because
 * fetchApolloOrg called matchOrg() on the raw email domain with no guard —
 * matchOrg("alum.mit.edu") → "Massachusetts Institute of Technology".
 *
 * Fix: fetchApolloOrg now skips matchOrg for personal / institutional domains,
 * mirroring the guard fetchApolloPerson already has. A real company website
 * domain is still matched (and preferred over the email domain).
 */

const mockYouSearchWeb = jest.fn().mockResolvedValue({ success: true, results: [] });
jest.mock('../services/agentModeService', () => ({
  agentModeService: { youSearchWeb: (...args: any[]) => mockYouSearchWeb(...args) },
}));

import { buildOrchestratorDeps } from '../services/enrichmentV3RealDeps';
import * as apolloServiceModule from '../services/apolloService';
import type { ApolloService } from '../services/apolloService';
import { createApolloFetchContext, createEnrichSoFetchContext } from '../services/enrichmentGroupWaterfall';
import type { LeadRecord } from '../services/crmEnrichmentService';

function mockApolloService(matchOrg: jest.Mock): void {
  const svc = { matchOrg, matchPerson: jest.fn(), findEmail: jest.fn() } as unknown as ApolloService;
  jest.spyOn(apolloServiceModule, 'isApolloServiceReady').mockReturnValue(true);
  jest.spyOn(apolloServiceModule, 'getApolloService').mockReturnValue(svc);
}

function makeLead(overrides: Partial<LeadRecord> = {}): LeadRecord {
  return {
    leadId: 'lead-1',
    enrichmentMetadata: {},
    customFields: {},
    ...overrides,
  } as LeadRecord;
}

async function runOrgWaterfall(lead: LeadRecord): Promise<void> {
  const deps = buildOrchestratorDeps('user-1');
  await deps.runWaterfall({
    listId: 'list-1',
    lead,
    groupName: 'company_firmographic',
    requestedFields: ['industry'],
    configFieldsByName: {},
    apolloCtx: createApolloFetchContext(),
    enrichSoCtx: createEnrichSoFetchContext(),
    refreshFields: new Set(),
  } as any);
}

afterEach(() => {
  jest.restoreAllMocks();
  mockYouSearchWeb.mockReset();
  mockYouSearchWeb.mockResolvedValue({ success: true, results: [] });
});

describe('fetchApolloOrg — personal/institutional domain guard (ENG-433)', () => {
  it('does NOT call matchOrg for a university .edu email domain', async () => {
    const matchOrg = jest.fn();
    mockApolloService(matchOrg);

    await runOrgWaterfall(makeLead({ email: 'sofronie@alum.mit.edu' }));

    expect(matchOrg).not.toHaveBeenCalled();
  });

  it('does NOT call matchOrg for a plain .edu email domain', async () => {
    const matchOrg = jest.fn();
    mockApolloService(matchOrg);

    await runOrgWaterfall(makeLead({ email: 'kaushik@berkeley.edu' }));

    expect(matchOrg).not.toHaveBeenCalled();
  });

  it('does NOT call matchOrg for a free-mail email domain (yahoo.com)', async () => {
    const matchOrg = jest.fn();
    mockApolloService(matchOrg);

    await runOrgWaterfall(makeLead({ email: 'ajay@yahoo.com' }));

    expect(matchOrg).not.toHaveBeenCalled();
  });

  it('DOES call matchOrg with the domain for a real business email domain', async () => {
    const matchOrg = jest.fn().mockResolvedValue({ organization: { name: 'Acme Corp' }, fromCache: false });
    mockApolloService(matchOrg);

    await runOrgWaterfall(makeLead({ email: 'jane@acme.com' }));

    expect(matchOrg).toHaveBeenCalledWith('acme.com');
  });

  it('prefers the website domain over an institutional email domain', async () => {
    const matchOrg = jest.fn().mockResolvedValue({ organization: { name: 'Acme Corp' }, fromCache: false });
    mockApolloService(matchOrg);

    await runOrgWaterfall(makeLead({ email: 'sofronie@alum.mit.edu', website: 'https://www.acme.com' }));

    expect(matchOrg).toHaveBeenCalledWith('acme.com');
  });

  it('prefers a business email domain over a stale/personal website URL', async () => {
    const matchOrg = jest.fn().mockResolvedValue({ organization: { name: 'Acme Corp' }, fromCache: false });
    mockApolloService(matchOrg);

    // Business email (acme.com) must win over a stale/personal website (oldsite.io).
    await runOrgWaterfall(makeLead({ email: 'jane@acme.com', website: 'https://www.oldsite.io' }));

    expect(matchOrg).toHaveBeenCalledWith('acme.com');
  });

  it('uses the CURRENT email domain over a stale stored emailDomain (Greptile P1)', async () => {
    const matchOrg = jest.fn().mockResolvedValue({ organization: { name: 'NewCorp' }, fromCache: false });
    mockApolloService(matchOrg);

    // Lead moved employers: email is newcorp.com but a stale emailDomain
    // (oldcorp.com) lingers — the current email must win, not the former employer.
    await runOrgWaterfall(makeLead({ email: 'person@newcorp.com', emailDomain: 'oldcorp.com' }));

    expect(matchOrg).toHaveBeenCalledWith('newcorp.com');
  });

  it('uses a business stored emailDomain when the current email is free-mail', async () => {
    const matchOrg = jest.fn().mockResolvedValue({ organization: { name: 'Acme Corp' }, fromCache: false });
    mockApolloService(matchOrg);

    // Personal email but an enrichment-resolved company domain in emailDomain —
    // the resolved business domain is a stronger signal than the free-mail address.
    await runOrgWaterfall(makeLead({ email: 'john@gmail.com', emailDomain: 'acme.com' }));

    expect(matchOrg).toHaveBeenCalledWith('acme.com');
  });
});
