/**
 * The in-memory DynamoDB supports two forms the lead routes use (ENG-2840): `SET x = list_append(if_not_exists(x, :empty), :new)` (an
 * engagement is appended on every status change) and a comparison on the RANGE key in a query (the duplicate-email check asks the
 * email index for one (list, email) pair). Before, the first threw "unsupported SET function" and the second returned the whole partition,
 * so every add looked like a duplicate.
 */
import { InMemoryDynamo } from './helpers/inMemoryDynamo';

const clientOf = (fake: InMemoryDynamo) => new (fake.documentClient as any)();

function makeFake() {
  const fake = new InMemoryDynamo({
    'AW-Leads': { hash: 'listId', range: 'leadId', indexes: { 'email-index': { hash: 'listId', range: 'email' } } },
  });
  fake.seed('AW-Leads', { listId: 'l1', leadId: '1', email: 'a@x.test' });
  fake.seed('AW-Leads', { listId: 'l1', leadId: '2', email: 'b@x.test', engagements: [{ eventType: 'old' }] });
  fake.seed('AW-Leads', { listId: 'l2', leadId: '3', email: 'a@x.test' });
  return fake;
}

const append = (fake: InMemoryDynamo, leadId: string, entry: unknown) =>
  clientOf(fake)
    .update({
      TableName: 'AW-Leads',
      Key: { listId: 'l1', leadId },
      UpdateExpression: 'SET engagements = list_append(if_not_exists(engagements, :empty), :new)',
      ExpressionAttributeValues: { ':empty': [], ':new': [entry] },
    })
    .promise();

describe('InMemoryDynamo list_append', () => {
  it('starts the list when the attribute is absent and extends it when present', async () => {
    const fake = makeFake();
    await append(fake, '1', { eventType: 'status.changed' });
    await append(fake, '2', { eventType: 'status.changed' });
    const rows = fake.items('AW-Leads');
    expect(rows.find((r) => r.leadId === '1')!.engagements).toEqual([{ eventType: 'status.changed' }]);
    expect(rows.find((r) => r.leadId === '2')!.engagements).toEqual([{ eventType: 'old' }, { eventType: 'status.changed' }]);
  });

  it('refuses a non-list operand with the ValidationException DynamoDB raises', async () => {
    const fake = makeFake();
    fake.seed('AW-Leads', { listId: 'l1', leadId: '4', email: 'd@x.test', engagements: 'not a list' });
    await expect(append(fake, '4', { eventType: 'x' })).rejects.toMatchObject({ code: 'ValidationException' });
  });
});

describe('InMemoryDynamo plain if_not_exists', () => {
  const makeMap = (fake: InMemoryDynamo, leadId: string) =>
    clientOf(fake)
      .update({
        TableName: 'AW-Leads',
        Key: { listId: 'l1', leadId },
        UpdateExpression: 'SET #cfMap = if_not_exists(#cfMap, :emptyMap)',
        ConditionExpression: 'attribute_exists(#lid)',
        ExpressionAttributeNames: { '#cfMap': 'customFields', '#lid': 'leadId' },
        ExpressionAttributeValues: { ':emptyMap': {} },
      })
      .promise();

  it('creates the attribute when it is absent and leaves one that is there alone (how a missing custom-field map is created)', async () => {
    const fake = makeFake();
    fake.seed('AW-Leads', { listId: 'l1', leadId: '5', email: 'e@x.test', customFields: { keep: 'me' } });
    await makeMap(fake, '1');
    await makeMap(fake, '5');
    const rows = fake.items('AW-Leads');
    expect(rows.find((r) => r.leadId === '1')!.customFields).toEqual({});
    expect(rows.find((r) => r.leadId === '5')!.customFields).toEqual({ keep: 'me' });
  });

  it('refuses for a lead that does not exist (the existence condition), so no stray row is created', async () => {
    const fake = makeFake();
    await expect(makeMap(fake, 'ghost')).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    expect(fake.items('AW-Leads').find((r) => r.leadId === 'ghost')).toBeUndefined();
  });
});

describe('InMemoryDynamo range-key comparison in a query', () => {
  const byEmail = (fake: InMemoryDynamo, listId: string, email: string) =>
    clientOf(fake)
      .query({
        TableName: 'AW-Leads',
        IndexName: 'email-index',
        KeyConditionExpression: '#listId = :listId AND #email = :email',
        ExpressionAttributeNames: { '#listId': 'listId', '#email': 'email' },
        ExpressionAttributeValues: { ':listId': listId, ':email': email },
      })
      .promise();

  it('returns only the (list, email) pair asked for', async () => {
    const fake = makeFake();
    expect((await byEmail(fake, 'l1', 'a@x.test')).Items.map((i: any) => i.leadId)).toEqual(['1']);
    expect((await byEmail(fake, 'l1', 'nobody@x.test')).Items).toEqual([]);
    expect((await byEmail(fake, 'l2', 'a@x.test')).Items.map((i: any) => i.leadId)).toEqual(['3']);
  });

  it('a query with only the hash key still returns the whole partition', async () => {
    const fake = makeFake();
    const r = await clientOf(fake)
      .query({
        TableName: 'AW-Leads',
        KeyConditionExpression: 'listId = :l',
        ExpressionAttributeValues: { ':l': 'l1' },
      })
      .promise();
    expect(r.Items.map((i: any) => i.leadId)).toEqual(['1', '2']);
  });
});
