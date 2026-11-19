/**
 * The in-memory DynamoDB reads AND writes nested paths the way DynamoDB does (ENG-2840), so a guard such as
 * `attribute_not_exists(#products.#p)` after `SET #products.#p = :entry` behaves in tests as it does in production. Before, a dotted
 * SET target was stored as one flat attribute literally named "products.p": the guarded write could succeed twice and left a junk attribute.
 */
import { InMemoryDynamo } from './helpers/inMemoryDynamo';

function makeFake() {
  const fake = new InMemoryDynamo({ 'AW-Users': { hash: 'email' } });
  fake.seed('AW-Users', { email: 'a@x.test', products: { emma: { firstAt: 't0', lastAt: 't0', visits: 5 } } });
  fake.seed('AW-Users', { email: 'b@x.test' });
  return fake;
}

/** The fake exposes a DocumentClient CLASS (what jest.mock('aws-sdk') swaps in), so a client is built with `new`. */
const clientOf = (fake: InMemoryDynamo) => new (fake.documentClient as any)();

const guardedCreate = (fake: InMemoryDynamo, email: string, product: string, entry: unknown) =>
  clientOf(fake)
    .update({
      TableName: 'AW-Users',
      Key: { email },
      UpdateExpression: 'SET #products.#p = :entry',
      ConditionExpression: 'attribute_exists(#email) AND attribute_not_exists(#products.#p)',
      ExpressionAttributeNames: { '#email': 'email', '#products': 'products', '#p': product },
      ExpressionAttributeValues: { ':entry': entry },
    })
    .promise();

describe('InMemoryDynamo nested paths', () => {
  it('SET a.b stores inside the map a, and the guard on a.b then refuses a second write', async () => {
    const fake = makeFake();
    await guardedCreate(fake, 'a@x.test', 'smartlead', { firstAt: 't1' });

    const row = fake.items('AW-Users').find((r) => r.email === 'a@x.test')!;
    expect(row.products.smartlead).toEqual({ firstAt: 't1' });
    expect(Object.keys(row).filter((k) => k.includes('.'))).toEqual([]);

    await expect(guardedCreate(fake, 'a@x.test', 'smartlead', { firstAt: 't2' })).rejects.toMatchObject({
      code: 'ConditionalCheckFailedException',
    });
    expect(row.products.smartlead).toEqual({ firstAt: 't1' });
  });

  it('SET a.b on a row with no map a fails with the document-path ValidationException (what touchProduct catches)', async () => {
    const fake = makeFake();
    await expect(guardedCreate(fake, 'b@x.test', 'emma', { firstAt: 't1' })).rejects.toMatchObject({
      code: 'ValidationException',
      message: expect.stringMatching(/document path/i),
    });
    const row = fake.items('AW-Users').find((r) => r.email === 'b@x.test')!;
    expect(row.products).toBeUndefined();
    expect(Object.keys(row).filter((k) => k.includes('.'))).toEqual([]);
  });

  it('a dotted < and > condition reads the nested number', async () => {
    const fake = makeFake();
    const bump = (cond: string, value: number) =>
      clientOf(fake)
        .update({
          TableName: 'AW-Users',
          Key: { email: 'a@x.test' },
          UpdateExpression: 'SET #products.#p.#v = :next',
          ConditionExpression: cond,
          ExpressionAttributeNames: { '#products': 'products', '#p': 'emma', '#v': 'visits' },
          ExpressionAttributeValues: { ':limit': value, ':next': 6 },
        })
        .promise();

    await expect(bump('#products.#p.#v < :limit', 5)).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    await expect(bump('#products.#p.#v > :limit', 5)).rejects.toMatchObject({ code: 'ConditionalCheckFailedException' });
    await bump('#products.#p.#v < :limit', 9);
    expect(fake.items('AW-Users').find((r) => r.email === 'a@x.test')!.products.emma.visits).toBe(6);
  });

  it('a path with no dot is read and written exactly as before', async () => {
    const fake = makeFake();
    await clientOf(fake)
      .update({
        TableName: 'AW-Users',
        Key: { email: 'b@x.test' },
        UpdateExpression: 'SET #n = :v',
        ConditionExpression: 'attribute_not_exists(#n)',
        ExpressionAttributeNames: { '#n': 'nickname' },
        ExpressionAttributeValues: { ':v': 'bee' },
      })
      .promise();
    expect(fake.items('AW-Users').find((r) => r.email === 'b@x.test')!.nickname).toBe('bee');
  });
});
