import { matchFathomRecording, OrgCandidate, OrgLookupPort } from '../services/fathomOrgMatcher';

function fakePort(data: {
  contacts?: Record<string, OrgCandidate[]>;
  domains?: Record<string, OrgCandidate[]>;
  crm?: Record<string, OrgCandidate[]>;
}): OrgLookupPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findContactsByEmail: async (e) => { calls.push(`email:${e}`); return data.contacts?.[e] ?? []; },
    findOrgsByDomain: async (d) => { calls.push(`domain:${d}`); return data.domains?.[d] ?? []; },
    findCrmContactsByEmail: async (e) => { calls.push(`crm:${e}`); return data.crm?.[e] ?? []; },
  };
}

const ext = { email: 'Jane@Acme.com', name: 'Jane' };

describe('matchFathomRecording (ENG-2531)', () => {
  it('exact email beats domain and CRM', async () => {
    const port = fakePort({
      contacts: { 'jane@acme.com': [{ orgId: 'org-a', contactId: 'c-1' }] },
      domains: { 'acme.com': [{ orgId: 'org-b' }] },
      crm: { 'jane@acme.com': [{ orgId: 'org-c', contactId: 'c-9' }] },
    });
    await expect(matchFathomRecording({ participants: [ext] }, port)).resolves.toEqual({
      match: { orgId: 'org-a', contactId: 'c-1', basis: 'email' }, confidence: 'high',
    });
    expect(port.calls.some((c) => c.startsWith('domain:') || c.startsWith('crm:'))).toBe(false);
  });

  it('domain beats CRM when no email match', async () => {
    const port = fakePort({
      domains: { 'acme.com': [{ orgId: 'org-b' }] },
      crm: { 'jane@acme.com': [{ orgId: 'org-c' }] },
    });
    await expect(matchFathomRecording({ participants: [ext] }, port)).resolves.toEqual({
      match: { orgId: 'org-b', basis: 'domain' }, confidence: 'medium',
    });
  });

  it('extracted domain is normalized and used', async () => {
    const port = fakePort({ domains: { 'acme.com': [{ orgId: 'org-b' }] } });
    const r = await matchFathomRecording(
      { participants: [{ email: 'x@gmail.com' }], extractedDomain: 'https://www.ACME.com/about' }, port);
    expect(r).toEqual({ match: { orgId: 'org-b', basis: 'domain' }, confidence: 'medium' });
    expect(port.calls).not.toContain('domain:gmail.com');
  });

  it('CRM contact is the last matching tier', async () => {
    const port = fakePort({ crm: { 'jane@acme.com': [{ orgId: 'org-c', contactId: 'c-9' }] } });
    await expect(matchFathomRecording({ participants: [ext] }, port)).resolves.toEqual({
      match: { orgId: 'org-c', contactId: 'c-9', basis: 'crm' }, confidence: 'low',
    });
  });

  it('nothing found -> review', async () => {
    await expect(matchFathomRecording({ participants: [ext] }, fakePort({})))
      .resolves.toEqual({ review: 'insufficient_evidence' });
  });

  it('title/name-only evidence never matches', async () => {
    const port = fakePort({ domains: { 'acme.com': [{ orgId: 'org-a' }] } });
    const r = await matchFathomRecording(
      { participants: [{ name: 'Jane from Acme' }], title: 'Acme <> AgentWeb kickoff (acme.com)' }, port);
    expect(r).toEqual({ review: 'no_external_participants' });
    expect(port.calls).toEqual([]);
  });

  it('ignores internal @agentweb.pro participants', async () => {
    const port = fakePort({
      contacts: { 'harsha@agentweb.pro': [{ orgId: 'org-internal' }] },
      domains: { 'agentweb.pro': [{ orgId: 'org-internal' }] },
    });
    const r = await matchFathomRecording(
      { participants: [{ email: 'harsha@agentweb.pro' }, { email: 'm@sub.AgentWeb.pro' }], extractedDomain: 'agentweb.pro' },
      port);
    expect(r).toEqual({ review: 'no_external_participants' });
    expect(port.calls).toEqual([]);
  });

  it('internal participant does not affect an external match', async () => {
    const port = fakePort({ contacts: { 'jane@acme.com': [{ orgId: 'org-a', contactId: 'c-1' }] } });
    const r = await matchFathomRecording({ participants: [{ email: 'harsha@agentweb.pro' }, ext] }, port);
    expect(r).toMatchObject({ match: { orgId: 'org-a', basis: 'email' } });
    expect(port.calls).not.toContain('email:harsha@agentweb.pro');
  });

  it('conflicting email candidates -> review listing candidates (no fallthrough)', async () => {
    const port = fakePort({
      contacts: {
        'jane@acme.com': [{ orgId: 'org-a', contactId: 'c-1' }],
        'bob@beta.io': [{ orgId: 'org-b', contactId: 'c-2' }],
      },
      domains: { 'acme.com': [{ orgId: 'org-a' }] },
    });
    const r = await matchFathomRecording({ participants: [ext, { email: 'bob@beta.io' }] }, port);
    expect(r).toEqual({
      review: 'conflicting_candidates', basis: 'email',
      candidates: [{ orgId: 'org-a', contactId: 'c-1' }, { orgId: 'org-b', contactId: 'c-2' }],
    });
  });

  it('conflicting domain candidates -> review', async () => {
    const port = fakePort({ domains: { 'acme.com': [{ orgId: 'org-a' }, { orgId: 'org-z' }] } });
    const r = await matchFathomRecording({ participants: [ext] }, port);
    expect(r).toMatchObject({ review: 'conflicting_candidates', basis: 'domain' });
  });

  it('same org via two contacts matches the org without guessing a contact', async () => {
    const port = fakePort({
      contacts: {
        'jane@acme.com': [{ orgId: 'org-a', contactId: 'c-1' }],
        'joe@acme.com': [{ orgId: 'org-a', contactId: 'c-2' }],
      },
    });
    const r = await matchFathomRecording({ participants: [ext, { email: 'joe@acme.com' }] }, port);
    expect(r).toEqual({ match: { orgId: 'org-a', basis: 'email' }, confidence: 'high' });
  });
});
