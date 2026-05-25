// Tests for buildIdentityDeps().writeLeadFields field routing.
//
// Verifies that `website` is treated as a top-level standard column (not a
// customField) so Tier 0.5 website writes land at item.website in DynamoDB
// rather than being buried in customFields.website.
import { buildIdentityDeps } from '../services/enrichmentV3RealDeps';
import { crmDb } from '../services/db';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('writeLeadFields — website field routing', () => {
  it('routes website to topLevel, not customFields', async () => {
    const spy = jest.spyOn(crmDb, 'setLeadFields').mockResolvedValue(undefined as any);

    const deps = buildIdentityDeps('user-1');
    await deps.writeLeadFields({
      listId: 'list-1',
      leadId: 'lead-1',
      fields: { website: 'https://acme.com' },
      meta: {},
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0];
    expect(call[2].topLevel).toEqual({ website: 'https://acme.com' });
    expect(call[2].customFields).toBeUndefined();
  });

  it('adds website to removeCustomFieldKeys to clean up stale customFields.website', async () => {
    const spy = jest.spyOn(crmDb, 'setLeadFields').mockResolvedValue(undefined as any);

    const deps = buildIdentityDeps('user-1');
    await deps.writeLeadFields({
      listId: 'list-1',
      leadId: 'lead-1',
      fields: { website: 'https://acme.com' },
      meta: {},
    });

    const call = spy.mock.calls[0];
    expect(call[2].removeCustomFieldKeys).toContain('website');
  });

  it('routes other standard fields (firstName, company, linkedin) to topLevel', async () => {
    const spy = jest.spyOn(crmDb, 'setLeadFields').mockResolvedValue(undefined as any);

    const deps = buildIdentityDeps('user-1');
    await deps.writeLeadFields({
      listId: 'list-1',
      leadId: 'lead-1',
      fields: { firstName: 'Jane', company: 'Acme', linkedin: 'https://linkedin.com/in/jane' },
      meta: {},
    });

    const call = spy.mock.calls[0];
    expect(call[2].topLevel).toMatchObject({ firstName: 'Jane', company: 'Acme', linkedin: 'https://linkedin.com/in/jane' });
    expect(call[2].customFields).toBeUndefined();
  });

  it('routes non-standard fields to customFields', async () => {
    const spy = jest.spyOn(crmDb, 'setLeadFields').mockResolvedValue(undefined as any);

    const deps = buildIdentityDeps('user-1');
    await deps.writeLeadFields({
      listId: 'list-1',
      leadId: 'lead-1',
      fields: { industry: 'SaaS', revenue_range: '$1M-$5M' },
      meta: {},
    });

    const call = spy.mock.calls[0];
    expect(call[2].customFields).toMatchObject({ industry: 'SaaS', revenue_range: '$1M-$5M' });
    expect(call[2].topLevel).toBeUndefined();
  });

  it('handles mixed standard + custom fields in one call', async () => {
    const spy = jest.spyOn(crmDb, 'setLeadFields').mockResolvedValue(undefined as any);

    const deps = buildIdentityDeps('user-1');
    await deps.writeLeadFields({
      listId: 'list-1',
      leadId: 'lead-1',
      fields: { website: 'https://acme.com', company: 'Acme', industry: 'SaaS' },
      meta: {},
    });

    const call = spy.mock.calls[0];
    expect(call[2].topLevel).toMatchObject({ website: 'https://acme.com', company: 'Acme' });
    expect(call[2].customFields).toMatchObject({ industry: 'SaaS' });
    expect(call[2].removeCustomFieldKeys).toContain('website');
    expect(call[2].removeCustomFieldKeys).toContain('company');
  });
});
