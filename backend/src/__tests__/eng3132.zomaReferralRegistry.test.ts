/**
 * ENG-3132 slice A. Invariants only: a referral code earns money iff it is registered and active, and
 * a code can never collide with a marketing-channel `ref`.
 */
import {
  DEFAULT_REFERRAL_MONTHS,
  DEFAULT_REFERRAL_PERCENT_BPS,
  DynamoZomaReferralStore,
  createReferralCode,
  effectivePercentBps,
  getZomaReferralConfig,
  parsePercentToBps,
  resolveReferrer,
  revokeReferralCode,
  validateReferralCode,
  type ZomaReferralCode,
  type ZomaReferralStore,
} from '../services/zomaReferralRegistry';

class MemoryStore implements ZomaReferralStore {
  rows = new Map<string, ZomaReferralCode>();
  async create(r: ZomaReferralCode) {
    if (this.rows.has(r.code)) return false;
    this.rows.set(r.code, r);
    return true;
  }
  async get(code: string) {
    return this.rows.get(code) ?? null;
  }
  async revoke(code: string, nowIso: string) {
    const r = this.rows.get(code);
    if (!r) return false;
    this.rows.set(code, { ...r, status: 'revoked', revokedAt: r.revokedAt ?? nowIso });
    return true;
  }
  async list() {
    return [...this.rows.values()];
  }
}

const input = (over: Record<string, unknown> = {}) => ({ code: 'sandra', referrerId: 'sandra', payeeName: 'Sandra Example', createdBy: 'admin', ...over });

describe('validateReferralCode', () => {
  it.each(['sandra', 'sandra-2026', 'dan_k1'])('accepts %s', (code) => {
    expect(validateReferralCode(code)).toEqual({ ok: true, code });
  });
  it.each([
    ['Sandra', 'invalid'], // ENG-2906 drops uppercase refs, so an uppercase code could never be matched
    ['has space', 'invalid'],
    ['a'.repeat(65), 'invalid'],
    [undefined, 'invalid'],
    ['abc', 'too_short'],
  ])('rejects %s as %s', (code, reason) => {
    expect(validateReferralCode(code)).toEqual({ ok: false, reason });
  });
  it.each(['linkedin', 'producthunt', 'founder', 'referral', 'partner', 'slack', 'newsletter', 'direct', 'admin'])(
    'refuses %s: it is a channel alias or reserved word',
    (code) => {
      expect(validateReferralCode(code)).toEqual({ ok: false, reason: 'reserved' });
    },
  );
});

describe('createReferralCode', () => {
  it('creates an active code, never overwrites one, and refuses bad fields', async () => {
    const store = new MemoryStore();
    const created = await createReferralCode(input(), store, () => new Date('2026-11-18T00:00:00Z'));
    expect(created).toMatchObject({ status: 'created', record: { code: 'sandra', status: 'active', createdAt: '2026-11-18T00:00:00.000Z' } });
    expect(await createReferralCode(input({ referrerId: 'someone-else' }), store)).toEqual({ status: 'exists' });
    expect(store.rows.get('sandra')?.referrerId).toBe('sandra');
    expect(await createReferralCode(input({ code: 'x1' }), store)).toMatchObject({ status: 'invalid', field: 'code' });
    expect(await createReferralCode(input({ code: 'dan-k', referrerId: 'Bad Id' }), store)).toMatchObject({ status: 'invalid', field: 'referrerId' });
    expect(await createReferralCode(input({ code: 'dan-k', payeeName: '   ' }), store)).toMatchObject({ status: 'invalid', field: 'payeeName' });
    for (const percentBps of [0, 10001, 12.5]) {
      expect(await createReferralCode(input({ code: 'dan-k', percentBps }), store)).toMatchObject({ status: 'invalid', field: 'percentBps' });
    }
  });
});

describe('resolveReferrer: only a registered active code earns commission', () => {
  it('maps active, revoked, unregistered and malformed refs', async () => {
    const store = new MemoryStore();
    await createReferralCode(input(), store);
    await createReferralCode(input({ code: 'dan-k', referrerId: 'dan', payeeName: 'Dan' }), store);
    await revokeReferralCode('dan-k', store);
    expect(await resolveReferrer('sandra', store)).toMatchObject({ kind: 'active', record: { referrerId: 'sandra' } });
    expect(await resolveReferrer('dan-k', store)).toMatchObject({ kind: 'revoked' });
    expect(await resolveReferrer('hn', store)).toEqual({ kind: 'none' }); // a channel label, not a referral
    expect(await resolveReferrer('Sandra', store)).toEqual({ kind: 'none' });
    expect(await resolveReferrer(undefined, store)).toEqual({ kind: 'none' });
  });

  it('lets a store outage surface instead of reading as "not a referral"', async () => {
    const store = new MemoryStore();
    store.get = async () => {
      throw new Error('dynamo down');
    };
    await expect(resolveReferrer('sandra', store)).rejects.toThrow('dynamo down');
  });

  it('revoking twice keeps the first revocation time and an unknown code reports false', async () => {
    const store = new MemoryStore();
    await createReferralCode(input(), store);
    await revokeReferralCode('sandra', store, () => new Date('2026-11-20T00:00:00Z'));
    await revokeReferralCode('sandra', store, () => new Date('2026-12-01T00:00:00Z'));
    expect(store.rows.get('sandra')?.revokedAt).toBe('2026-11-20T00:00:00.000Z');
    expect(await revokeReferralCode('nobody', store)).toBe(false);
  });
});

describe('configuration', () => {
  it('defaults to 20% and 3 months, dark', () => {
    expect(getZomaReferralConfig({})).toEqual({ enabled: false, percentBps: DEFAULT_REFERRAL_PERCENT_BPS, months: DEFAULT_REFERRAL_MONTHS });
    expect(DEFAULT_REFERRAL_PERCENT_BPS).toBe(2000);
  });
  it('is enabled only by the exact string true', () => {
    expect(getZomaReferralConfig({ ZOMA_REFERRAL_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(getZomaReferralConfig({ ZOMA_REFERRAL_ENABLED: 'true' }).enabled).toBe(true);
  });
  it('reads a configured percent and months, and falls back to defaults for junk', () => {
    expect(getZomaReferralConfig({ ZOMA_REFERRAL_PERCENT: '12.5', ZOMA_REFERRAL_MONTHS: '6' })).toMatchObject({ percentBps: 1250, months: 6 });
    for (const bad of ['0', '-5', '101', 'abc', '', '1.234']) {
      expect(getZomaReferralConfig({ ZOMA_REFERRAL_PERCENT: bad }).percentBps).toBe(DEFAULT_REFERRAL_PERCENT_BPS);
    }
    for (const bad of ['0', '13', '2.5', 'x']) {
      expect(getZomaReferralConfig({ ZOMA_REFERRAL_MONTHS: bad }).months).toBe(DEFAULT_REFERRAL_MONTHS);
    }
    expect(parsePercentToBps(20)).toBe(2000);
  });
  it('a code override wins over the default percent', () => {
    expect(effectivePercentBps({ percentBps: 1500 }, { percentBps: 2000 })).toBe(1500);
    expect(effectivePercentBps({}, { percentBps: 2000 })).toBe(2000);
  });
});

describe('DynamoZomaReferralStore', () => {
  const dbOf = (mock: object) => mock as unknown as ConstructorParameters<typeof DynamoZomaReferralStore>[0];
  const conditionFailure = Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' });
  const req = (fn: () => unknown) => ({ promise: async () => fn() });

  it('create returns false only for a conditional failure and rethrows anything else', async () => {
    const put = jest.fn()
      .mockReturnValueOnce(req(() => ({})))
      .mockReturnValueOnce(req(() => { throw conditionFailure; }))
      .mockReturnValueOnce(req(() => { throw new Error('throttled'); }));
    const store = new DynamoZomaReferralStore(dbOf({ put }), 'T');
    const rec: ZomaReferralCode = { code: 'sandra', referrerId: 's', payeeName: 'S', status: 'active', createdAt: 'x', createdBy: 'a' };
    expect(await store.create(rec)).toBe(true);
    expect(await store.create(rec)).toBe(false);
    await expect(store.create(rec)).rejects.toThrow('throttled');
    expect(put.mock.calls[0][0]).toMatchObject({ TableName: 'T', ConditionExpression: 'attribute_not_exists(code)' });
  });

  it('revoke is conditional on existence and keeps the first revokedAt', async () => {
    const update = jest.fn().mockReturnValueOnce(req(() => ({}))).mockReturnValueOnce(req(() => { throw conditionFailure; }));
    const store = new DynamoZomaReferralStore(dbOf({ update }), 'T');
    expect(await store.revoke('sandra', 'now')).toBe(true);
    expect(await store.revoke('ghost', 'now')).toBe(false);
    expect(update.mock.calls[0][0]).toMatchObject({
      ConditionExpression: 'attribute_exists(code)',
      UpdateExpression: expect.stringContaining('if_not_exists(revokedAt'),
    });
  });

  it('list pages through the scan and sorts by code', async () => {
    const scan = jest.fn()
      .mockReturnValueOnce(req(() => ({ Items: [{ code: 'zeta' }], LastEvaluatedKey: { code: 'zeta' } })))
      .mockReturnValueOnce(req(() => ({ Items: [{ code: 'alpha' }] })));
    const store = new DynamoZomaReferralStore(dbOf({ scan }), 'T');
    expect((await store.list()).map((r) => r.code)).toEqual(['alpha', 'zeta']);
    expect(scan.mock.calls[1][0]).toMatchObject({ ExclusiveStartKey: { code: 'zeta' } });
  });
});
