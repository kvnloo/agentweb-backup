// Tests for buildOrchestratorDeps().loadLeads — whole-list pagination.
import { buildOrchestratorDeps } from '../services/enrichmentV3RealDeps';
import { crmDb } from '../services/db';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('buildOrchestratorDeps().loadLeads — whole-list pagination', () => {
  it('follows lastEvaluatedKey across pages and returns every lead', async () => {
    const page1 = {
      items: [{ leadId: 'l1' }, { leadId: 'l2' }],
      lastEvaluatedKey: { listId: 'list-1', leadId: 'l2' },
      hasMore: true,
    };
    const page2 = {
      items: [{ leadId: 'l3' }],
      lastEvaluatedKey: null,
      hasMore: false,
    };
    const spy = jest.spyOn(crmDb, 'getLeadsByListId')
      .mockResolvedValueOnce(page1 as any)
      .mockResolvedValueOnce(page2 as any);

    const deps = buildOrchestratorDeps('user-1');
    const leads = await deps.loadLeads({ listId: 'list-1', userId: 'user-1' });

    expect(leads.map((l: any) => l.leadId)).toEqual(['l1', 'l2', 'l3']);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(2, 'list-1', undefined, { listId: 'list-1', leadId: 'l2' });
  });

  it('returns a single page when there is no lastEvaluatedKey', async () => {
    jest.spyOn(crmDb, 'getLeadsByListId').mockResolvedValue({
      items: [{ leadId: 'l1' }],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    const deps = buildOrchestratorDeps('user-1');
    const leads = await deps.loadLeads({ listId: 'list-1', userId: 'user-1' });

    expect(leads.map((l: any) => l.leadId)).toEqual(['l1']);
  });
});
