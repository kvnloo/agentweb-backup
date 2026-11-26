/**
 * In-memory fake of the AW-Waitlist DynamoDB table as the Zoma admission code uses it (capacity counter row
 * `__zoma_free_capacity__` plus one row per email): get, the conditional updates, the two-item capacity
 * transaction and scan. Shared by the ENG-2881 launch tests and the ENG-2781 cross-seam test; wire it with
 *   jest.mock('aws-sdk', () => require('./helpers/zomaWaitlistFake').awsSdkMock());
 */
export const rows = new Map<string, any>();
const conditional = () => Object.assign(new Error('condition'), { code: 'ConditionalCheckFailedException' });
export const mockGet = jest.fn((p: any) => ({ promise: async () => ({ Item: rows.get(p.Key.email) }) }));
const mockUpdate = jest.fn((p: any) => ({ promise: async () => {
  const old = rows.get(p.Key.email) ?? {};
  const v = p.ExpressionAttributeValues ?? {};
  if (p.ConditionExpression === 'attribute_not_exists(zomaStatus)') {
    if (old.zomaStatus) throw conditional();
    rows.set(p.Key.email, { email: p.Key.email, ...old, zomaStatus: v[':pending'] });
    return;
  }
  if (p.ConditionExpression === 'zomaStatus = :pending') {
    if (old.zomaStatus !== 'waitlisted') throw conditional();
    rows.set(p.Key.email, { ...old, zomaStatus: v[':rejected'], rejectedBy: v[':actor'] });
    return;
  }
  // legacy CRUD (updateDetails / updateStatus): record the SET attribute names
  const names = p.ExpressionAttributeNames ?? {};
  const next = { ...old };
  for (const [k, name] of Object.entries(names)) next[name as string] = v[(k as string).replace('#', ':')];
  rows.set(p.Key.email, next);
  return { Attributes: next };
} }));
const mockTransact = jest.fn((p: any) => ({ promise: async () => {
  const [counter, admission] = p.TransactItems.map((x: any) => x.Update);
  const count = rows.get(counter.Key.email);
  const old = rows.get(admission.Key.email) ?? {};
  if (count.approvedCount >= counter.ExpressionAttributeValues[':cap'] || (admission.ExpressionAttributeValues[':pending'] ? old.zomaStatus !== 'waitlisted' : !!old.zomaStatus)) {
    throw Object.assign(new Error('condition'), { code: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
  }
  rows.set(counter.Key.email, { email: counter.Key.email, approvedCount: count.approvedCount + 1 });
  rows.set(admission.Key.email, { ...old, email: admission.Key.email, zomaStatus: 'approved', approvedBy: admission.ExpressionAttributeValues[':actor'] });
} }));
const mockScan = jest.fn(() => ({ promise: async () => ({ Items: [...rows.values()] }) }));

export const awsSdkMock = () => ({
  __esModule: true,
  default: {
    config: { update: jest.fn() },
    DynamoDB: { DocumentClient: jest.fn(() => ({ get: mockGet, update: mockUpdate, transactWrite: mockTransact, scan: mockScan })) },
  },
});

/**
 * Same fake, for suites that load more of the app than the admission code: any other `AWS.<Client>` the import
 * graph constructs becomes an inert stub (it is never called on these paths), while DocumentClient stays the fake.
 */
export const awsSdkMockWithInertClients = () => {
  const base = awsSdkMock();
  return {
    ...base,
    default: new Proxy(base.default as Record<string | symbol, unknown>, {
      get: (target, key) => (typeof key === 'string' && /^[A-Z]/.test(key) && !(key in target) ? jest.fn(() => ({})) : Reflect.get(target, key)),
    }),
  };
};
