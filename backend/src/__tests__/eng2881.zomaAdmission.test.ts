const rows = new Map<string, any>();
const conditional = () => Object.assign(new Error('condition'), { code: 'ConditionalCheckFailedException' });
const mockGet = jest.fn((p: any) => ({ promise: async () => ({ Item: rows.get(p.Key.email) }) }));
const mockUpdate = jest.fn((p: any) => ({ promise: async () => {
  const old = rows.get(p.Key.email) ?? {};
  const v = p.ExpressionAttributeValues;
  if (p.ConditionExpression === 'attribute_not_exists(zomaStatus)' ? !!old.zomaStatus : old.zomaStatus !== 'waitlisted') throw conditional();
  rows.set(p.Key.email, { ...old, zomaStatus: v[':rejected'] ?? v[':pending'], rejectedBy: v[':actor'], rejectedAt: v[':now'] });
} }));
const mockTransact = jest.fn((p: any) => ({ promise: async () => {
  const [counter, admission] = p.TransactItems.map((x: any) => x.Update);
  const count = rows.get(counter.Key.email);
  const old = rows.get(admission.Key.email) ?? {};
  if (count.approvedCount >= counter.ExpressionAttributeValues[':cap'] || (admission.ExpressionAttributeValues[':pending'] ? old.zomaStatus !== 'waitlisted' : !!old.zomaStatus)) {
    throw Object.assign(new Error('condition'), { code: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
  }
  rows.set(counter.Key.email, { approvedCount: count.approvedCount + 1 });
  rows.set(admission.Key.email, { zomaStatus: 'approved', approvedBy: admission.ExpressionAttributeValues[':actor'], approvedAt: admission.ExpressionAttributeValues[':now'] });
} }));
const mockDelete = jest.fn((p: any) => ({ promise: async () => {
  if (rows.get(p.Key.email)?.zomaStatus) throw conditional();
  rows.delete(p.Key.email);
} }));
jest.mock('aws-sdk', () => ({ __esModule: true, default: { config: { update: jest.fn() }, DynamoDB: { DocumentClient: jest.fn(() => ({ get: mockGet, update: mockUpdate, transactWrite: mockTransact, delete: mockDelete })) } } }));
import { waitlistDb, WaitlistCapacityCounterError } from '../services/waitlistDb';
import { admitZoma, rejectZoma, zomaApprovedCount, zomaCapacity, waitlistedResponse, zomaAdmissionEnabled } from '../services/zomaAdmission';
beforeEach(() => { rows.clear(); rows.set('__zoma_free_capacity__', { approvedCount: 0 }); delete process.env.ZOMA_FREE_USER_CAP; delete process.env.ZOMA_WAITLIST_ENABLED; });
it('admits a registration under capacity and records who/when', async () => {
  expect(await admitZoma('A@company.co')).toBe('approved');
  expect(rows.get('a@company.co')).toEqual(expect.objectContaining({ approvedBy: 'system:capacity', approvedAt: expect.any(String) }));
  expect((await zomaApprovedCount()).approvedCount).toBe(1);
});
it('60th has access, 61st stays waitlisted on retries', async () => {
  rows.set('__zoma_free_capacity__', { approvedCount: 59 });
  expect(await admitZoma('60@company.co')).toBe('approved');
  expect(await admitZoma('61@company.co')).toBe('waitlisted');
  expect(await admitZoma('61@company.co')).toBe('waitlisted');
  expect((await zomaApprovedCount()).approvedCount).toBe(60);
});
it('concurrent distinct signups cannot exceed capacity', async () => {
  rows.set('__zoma_free_capacity__', { approvedCount: 59 });
  const statuses = await Promise.all(Array.from({ length: 20 }, (_, i) => admitZoma(`${i}@company.co`)));
  expect(statuses.filter(s => s === 'approved')).toHaveLength(1);
  expect((await zomaApprovedCount()).approvedCount).toBe(60);
});
it('concurrent duplicates and retries consume exactly one seat', async () => {
  expect(await Promise.all(Array.from({ length: 10 }, () => admitZoma('same@company.co')))).toEqual(Array(10).fill('approved'));
  expect((await zomaApprovedCount()).approvedCount).toBe(1);
  expect(mockTransact.mock.calls[0][0].TransactItems[0].Update.ConditionExpression).toContain('approvedCount < :cap');
});
it('manual approve records admin; reject never disables approved users', async () => {
  rows.set('a@company.co', { zomaStatus: 'waitlisted' });
  expect(await admitZoma('a@company.co', 'admin1')).toBe('approved');
  expect(rows.get('a@company.co').approvedBy).toBe('admin1');
  expect(await rejectZoma('a@company.co', 'admin1')).toBe('approved');
  expect(await admitZoma('a@company.co', 'admin1')).toBe('approved');
  expect((await zomaApprovedCount()).approvedCount).toBe(1);
});
it('manual rejection is durable and does not decrement the count', async () => {
  rows.set('a@company.co', { zomaStatus: 'waitlisted' });
  expect(await rejectZoma('a@company.co', 'admin1')).toBe('rejected');
  expect(await admitZoma('a@company.co')).toBe('rejected');
  expect(rows.get('a@company.co').rejectedBy).toBe('admin1');
  expect((await zomaApprovedCount()).approvedCount).toBe(0);
});
it('manual approval cannot bypass cap', async () => {
  rows.set('__zoma_free_capacity__', { approvedCount: 60 });
  rows.set('a@company.co', { zomaStatus: 'waitlisted' });
  expect(await admitZoma('a@company.co', 'admin1')).toBe('capacity_exhausted');
});
it('fails closed without audited bootstrap and on invalid cap', async () => {
  rows.delete('__zoma_free_capacity__');
  await expect(admitZoma('a@company.co')).rejects.toThrow('not initialized');
  process.env.ZOMA_FREE_USER_CAP = 'no';
  expect(() => zomaCapacity()).toThrow();
});
it('dark by default, explicit flag and configurable cap', () => {
  expect(zomaAdmissionEnabled()).toBe(false);
  process.env.ZOMA_WAITLIST_ENABLED = 'true'; process.env.ZOMA_FREE_USER_CAP = '2';
  expect(zomaAdmissionEnabled()).toBe(true); expect(zomaCapacity()).toBe(2);
});
it('legacy deletion cannot erase the counter or an admission idempotency marker', async () => {
  await admitZoma('a@company.co');
  expect((await waitlistDb.deleteByEmail('__zoma_free_capacity__')).success).toBe(false);
  expect((await waitlistDb.deleteByEmail('a@company.co')).success).toBe(false);
  expect(await admitZoma('a@company.co')).toBe('approved');
  expect((await zomaApprovedCount()).approvedCount).toBe(1);
  expect(mockDelete.mock.calls[0][0].ConditionExpression).toBe('attribute_not_exists(zomaStatus)');
});
it('waitlisted response contains no token or activated user', () => {
  expect(waitlistedResponse).toEqual({ code: 'waitlisted', status: 'waitlisted', message: expect.any(String) });
});
it('capacity counter is not writable through waitlist CRUD and decided rows report conflict', async () => {
  rows.set('__zoma_free_capacity__', { approvedCount: 59 });
  await expect(waitlistDb.updateDetails('__zoma_free_capacity__', { approvedCount: 0 } as any)).rejects.toThrow(WaitlistCapacityCounterError);
  await expect(waitlistDb.updateStatus('__ZOMA_FREE_CAPACITY__', 'invited')).rejects.toThrow(WaitlistCapacityCounterError);
  await expect(waitlistDb.updateSupportNote('__zoma_free_capacity__', 'x')).rejects.toThrow(WaitlistCapacityCounterError);
  expect(rows.get('__zoma_free_capacity__').approvedCount).toBe(59);
  expect((await waitlistDb.deleteByEmail('__zoma_free_capacity__')).conflict).toBe(true);
});
