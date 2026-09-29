import { resolveLifecycleFilterBatch } from '../experiments/lifecycleFilterBatchResolver';

const NOW = new Date('2026-09-29T18:00:00.000Z');

describe('A11b batched live lifecycle resolver', () => {
  it('resolves live lifecycle with a constant number of dependency calls', async () => {
    const loadUsersByEmails = jest.fn().mockResolvedValue(new Map([
      ['paying@example.com', { userId: 'u1', email: 'paying@example.com', subscription_status: 'active' }],
    ]));
    const loadEventsByContactIds = jest.fn().mockResolvedValue(new Map());
    const loadDealsByIds = jest.fn().mockResolvedValue(new Map([
      ['d1', { dealId: 'd1', stage: 'Negotiation' }],
    ]));

    const result = await resolveLifecycleFilterBatch([
      { listId: 'l1', leadId: 'paying', email: 'Paying@Example.com', lifecycle: 'inbox' },
      { listId: 'l1', leadId: 'deal', email: 'deal@example.com', lifecycle: 'inbox', dealIds: ['d1'] },
      { listId: 'l1', leadId: 'prospect', email: 'prospect@example.com' },
    ], { loadUsersByEmails, loadEventsByContactIds, loadDealsByIds }, NOW);

    expect(loadUsersByEmails).toHaveBeenCalledTimes(1);
    expect(loadEventsByContactIds).toHaveBeenCalledTimes(1);
    expect(loadDealsByIds).toHaveBeenCalledTimes(1);
    expect(result.dependencyCalls).toBe(3);
    expect(result.lifecycleByLeadId.get('paying')).toBe('paying');
    expect(result.lifecycleByLeadId.get('deal')).toBe('in_deal');
    expect(result.lifecycleByLeadId.get('prospect')).toBe('inbox');
  });

  it('deduplicates shared emails and deal ids before loading', async () => {
    const loadUsersByEmails = jest.fn().mockResolvedValue(new Map());
    const loadEventsByContactIds = jest.fn().mockResolvedValue(new Map());
    const loadDealsByIds = jest.fn().mockResolvedValue(new Map());

    const result = await resolveLifecycleFilterBatch([
      { listId: 'l1', leadId: 'a', email: 'same@example.com', dealIds: ['d1'] },
      { listId: 'l1', leadId: 'b', email: ' SAME@example.com ', dealIds: ['d1'] },
    ], { loadUsersByEmails, loadEventsByContactIds, loadDealsByIds }, NOW);

    expect(result.uniqueEmails).toBe(1);
    expect(result.uniqueDealIds).toBe(1);
    expect(loadUsersByEmails).toHaveBeenCalledWith(['same@example.com']);
    expect(loadDealsByIds).toHaveBeenCalledWith(['d1']);
  });
});
