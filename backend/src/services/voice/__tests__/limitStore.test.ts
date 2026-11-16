const update = jest.fn();
const get = jest.fn();
jest.mock('../../../config/aws', () => ({ dynamodb: { update: (...a: unknown[]) => ({ promise: () => update(...a) }), get: (...a: unknown[]) => ({ promise: () => get(...a) }) } }));
import { getLimitStore } from '../limitStore';

beforeEach(() => update.mockReset().mockResolvedValue({}));

describe('DynamoDB limit store: incrementBelow', () => {
  it.each([0, -1, NaN])('refuses a cap of %p without calling DynamoDB', async (cap) => {
    expect(await getLimitStore().incrementBelow('k', cap, 1)).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('writes once for a cap of 1 and treats a failed condition as "at the cap"', async () => {
    expect(await getLimitStore().incrementBelow('k', 1, 1)).toBe(true);
    update.mockRejectedValue(Object.assign(new Error('x'), { code: 'ConditionalCheckFailedException' }));
    expect(await getLimitStore().incrementBelow('k', 1, 1)).toBe(false);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('also recognises a failed condition reported by error name (the SDK shape differs between versions)', async () => {
    update.mockRejectedValue(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }));
    expect(await getLimitStore().incrementBelow('k', 1, 1)).toBe(false);
  });

  it('propagates other DynamoDB errors so the job fails closed', async () => {
    update.mockRejectedValue(Object.assign(new Error('missing table'), { code: 'ResourceNotFoundException' }));
    await expect(getLimitStore().incrementBelow('k', 1, 1)).rejects.toThrow('missing table');
  });
});

describe('DynamoDB limit store: read', () => {
  it('reads the counter consistently, 0 when absent', async () => {
    get.mockResolvedValueOnce({ Item: { calls: 7 } }).mockResolvedValueOnce({});
    expect(await getLimitStore().read('k')).toBe(7);
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ ConsistentRead: true, Key: { sessionId: 'k' } }));
    expect(await getLimitStore().read('k')).toBe(0);
  });
});
