/** ENG-3132 slice B2. Ledger invariants: append-only, idempotent per invoice, refunds are negative rows. */
import {
  DynamoZomaReferralLedgerStore,
  accrualKey,
  buildAccrualEntry,
  buildReversalEntry,
  reversalKey,
} from '../services/zomaReferralLedger';

const base = { referredUserId: 'u1', referrerId: 'sandra', code: 'sandra', percentBps: 2000, invoiceId: 'in_1', paidAt: '2026-12-31T23:30:00.000Z', now: new Date('2027-01-01T00:00:00Z') };

describe('ledger entries', () => {
  it('an accrual is 20% of the base, keyed by invoice, in the UTC month the invoice was paid', () => {
    expect(buildAccrualEntry({ ...base, baseCents: 5000 })).toMatchObject({ entry: 'in_1#accrual', kind: 'accrual', commissionCents: 1000, baseCents: 5000, payoutMonth: '2026-12', currency: 'usd' });
  });
  it('a reversal is negative, keyed by credit note, and stays in the invoice month', () => {
    expect(buildReversalEntry({ ...base, creditNoteId: 'cn_1', creditedBaseCents: 2500 })).toMatchObject({ entry: 'in_1#reversal#cn_1', kind: 'reversal', commissionCents: -500, baseCents: -2500, payoutMonth: '2026-12', creditNoteId: 'cn_1' });
  });
  it('a full refund nets the accrual to exactly zero', () => {
    const a = buildAccrualEntry({ ...base, baseCents: 5005 });
    const r = buildReversalEntry({ ...base, creditNoteId: 'cn_1', creditedBaseCents: 5005 });
    expect(a.commissionCents + r.commissionCents).toBe(0);
  });
  it('keys are distinct for accrual and each credit note', () => {
    expect(new Set([accrualKey('in_1'), reversalKey('in_1', 'cn_1'), reversalKey('in_1', 'cn_2')]).size).toBe(3);
  });
});

describe('DynamoZomaReferralLedgerStore', () => {
  const dbOf = (mock: object) => mock as unknown as ConstructorParameters<typeof DynamoZomaReferralLedgerStore>[0];
  const conditionFailure = Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' });
  const req = (fn: () => unknown) => ({ promise: async () => fn() });
  const entry = buildAccrualEntry({ ...base, baseCents: 5000 });

  it('append writes once: duplicate false, any other error rethrown', async () => {
    const put = jest.fn()
      .mockReturnValueOnce(req(() => ({})))
      .mockReturnValueOnce(req(() => { throw conditionFailure; }))
      .mockReturnValueOnce(req(() => { throw new Error('throttled'); }));
    const store = new DynamoZomaReferralLedgerStore(dbOf({ put }), 'T');
    expect(await store.append(entry)).toBe(true);
    expect(await store.append(entry)).toBe(false);
    await expect(store.append(entry)).rejects.toThrow('throttled');
    expect(put.mock.calls[0][0]).toMatchObject({ TableName: 'T', Item: entry, ConditionExpression: 'attribute_not_exists(#entry)' });
  });

  it('listForReferredUser reads consistently and follows pagination', async () => {
    const query = jest.fn()
      .mockReturnValueOnce(req(() => ({ Items: [entry], LastEvaluatedKey: { referredUserId: 'u1', entry: 'k' } })))
      .mockReturnValueOnce(req(() => ({ Items: [{ ...entry, entry: 'in_2#accrual' }] })));
    const store = new DynamoZomaReferralLedgerStore(dbOf({ query }), 'T');
    expect(await store.listForReferredUser('u1')).toHaveLength(2);
    expect(query.mock.calls[0][0]).toMatchObject({ ConsistentRead: true, ExpressionAttributeValues: { ':u': 'u1' } });
    expect(query.mock.calls[1][0]).toMatchObject({ ExclusiveStartKey: { entry: 'k' } });
  });

  it('listAll follows pagination', async () => {
    const scan = jest.fn()
      .mockReturnValueOnce(req(() => ({ Items: [entry], LastEvaluatedKey: { referredUserId: 'u1', entry: 'k' } })))
      .mockReturnValueOnce(req(() => ({ Items: [entry] })));
    const store = new DynamoZomaReferralLedgerStore(dbOf({ scan }), 'T');
    expect(await store.listAll()).toHaveLength(2);
  });
});
