/**
 * The in-memory DynamoDB answers a delete with `ReturnValues: 'ALL_OLD'` the way DynamoDB does (ENG-2840 W2-2): the item that was
 * deleted, and nothing when there was none. A caller learns whether a delete found a row from that, so a fake that always answered `{}`
 * made every such delete look like "not found" (the memory tools' delete does exactly this).
 */
import { InMemoryDynamo } from './helpers/inMemoryDynamo';

const clientOf = (fake: InMemoryDynamo) => new (fake.documentClient as any)();

function makeFake() {
  const fake = new InMemoryDynamo({ 'AW-AccountMemory': { hash: 'userId', range: 'memoryId' } });
  fake.seed('AW-AccountMemory', { userId: 'u1', memoryId: 'm1', content: 'a fact' });
  return fake;
}

describe('delete with ReturnValues ALL_OLD', () => {
  it('returns the deleted item, and removes it', async () => {
    const fake = makeFake();
    const result = await clientOf(fake).delete({ TableName: 'AW-AccountMemory', Key: { userId: 'u1', memoryId: 'm1' }, ReturnValues: 'ALL_OLD' }).promise();
    expect(result.Attributes).toEqual({ userId: 'u1', memoryId: 'm1', content: 'a fact' });
    expect(fake.items('AW-AccountMemory')).toEqual([]);
  });

  it('returns no Attributes when there was no such item', async () => {
    const fake = makeFake();
    const result = await clientOf(fake).delete({ TableName: 'AW-AccountMemory', Key: { userId: 'u1', memoryId: 'nope' }, ReturnValues: 'ALL_OLD' }).promise();
    expect(result.Attributes).toBeUndefined();
    expect(fake.items('AW-AccountMemory')).toHaveLength(1);
  });

  it('without ReturnValues the answer is empty, as before, and the item is still removed', async () => {
    const fake = makeFake();
    const result = await clientOf(fake).delete({ TableName: 'AW-AccountMemory', Key: { userId: 'u1', memoryId: 'm1' } }).promise();
    expect(result).toEqual({});
    expect(fake.items('AW-AccountMemory')).toEqual([]);
  });

  it('the returned item is a copy: changing it does not touch the store', async () => {
    const fake = makeFake();
    const result = await clientOf(fake).delete({ TableName: 'AW-AccountMemory', Key: { userId: 'u1', memoryId: 'm1' }, ReturnValues: 'ALL_OLD' }).promise();
    result.Attributes.content = 'changed';
    expect(fake.items('AW-AccountMemory')).toEqual([]);
  });
});
