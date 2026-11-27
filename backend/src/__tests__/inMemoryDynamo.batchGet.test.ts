/**
 * The in-memory DynamoDB serves BatchGetItem (ENG-2840 W2-5a): every requested key that exists comes back under `Responses[table]`, a key that
 * does not exist is simply absent, and nothing is left in `UnprocessedKeys`. It models only what the code under test uses: not the 100-key
 * cap, the duplicate-key error, key-schema validation or unprocessed keys. The stale-list recovery of `get_lead_details`
 * (`crmDb.getLeadByIdAcrossLists`) depends on it; before, the fake had no batchGet and the recovery's failure was swallowed as "not found",
 * so a test of it could pass without the recovery ever running.
 */
import { InMemoryDynamo } from './helpers/inMemoryDynamo';

const clientOf = (fake: InMemoryDynamo) => new (fake.documentClient as any)();

function makeFake() {
  const fake = new InMemoryDynamo({
    'AW-Leads': { hash: 'listId', range: 'leadId' },
    'AW-LeadLists': { hash: 'listId' },
  });
  fake.seed('AW-Leads', { listId: 'l1', leadId: 'a', email: 'a@x.test' });
  fake.seed('AW-Leads', { listId: 'l2', leadId: 'a', email: 'a2@x.test' });
  fake.seed('AW-Leads', { listId: 'l2', leadId: 'b', email: 'b@x.test' });
  fake.seed('AW-LeadLists', { listId: 'l1', name: 'One' });
  return fake;
}

describe('batchGet', () => {
  it('returns the keys that exist and leaves out the ones that do not (DynamoDB promises no order, so none is asserted)', async () => {
    const result = await clientOf(makeFake())
      .batchGet({ RequestItems: { 'AW-Leads': { Keys: [{ listId: 'l1', leadId: 'a' }, { listId: 'l3', leadId: 'a' }, { listId: 'l2', leadId: 'a' }] } } })
      .promise();
    expect(result.Responses['AW-Leads'].map((i: any) => i.email).sort()).toEqual(['a2@x.test', 'a@x.test']);
    expect(result.UnprocessedKeys).toEqual({});
  });

  it('matches the whole key: the same lead id in another list is another item', async () => {
    const result = await clientOf(makeFake()).batchGet({ RequestItems: { 'AW-Leads': { Keys: [{ listId: 'l1', leadId: 'b' }] } } }).promise();
    expect(result.Responses['AW-Leads']).toEqual([]);
  });

  it('answers each requested table, and an empty request answers nothing', async () => {
    const fake = makeFake();
    const result = await clientOf(fake)
      .batchGet({ RequestItems: { 'AW-Leads': { Keys: [{ listId: 'l2', leadId: 'b' }] }, 'AW-LeadLists': { Keys: [{ listId: 'l1' }, { listId: 'l9' }] } } })
      .promise();
    expect(result.Responses['AW-Leads']).toHaveLength(1);
    expect(result.Responses['AW-LeadLists']).toEqual([{ listId: 'l1', name: 'One' }]);
    expect((await clientOf(fake).batchGet({ RequestItems: {} }).promise()).Responses).toEqual({});
  });

  it('reading changes nothing', async () => {
    const fake = makeFake();
    const before = JSON.stringify(fake.items('AW-Leads'));
    await clientOf(fake).batchGet({ RequestItems: { 'AW-Leads': { Keys: [{ listId: 'l1', leadId: 'a' }] } } }).promise();
    expect(JSON.stringify(fake.items('AW-Leads'))).toBe(before);
  });
});
