/** ENG-3132 slice B3. Who earns, on which invoices, exactly once; outages throw, never swallow. */
import { accrueReferralCommission, type AccrualDeps, type AccrualInvoice } from '../services/zomaReferralAccrual';
import type { ZomaLedgerEntry, ZomaReferralLedgerStore } from '../services/zomaReferralLedger';
import type { ZomaReferralCode, ZomaReferralStore } from '../services/zomaReferralRegistry';

const FEE = 'price_fee';
const day = (n: number) => Date.parse('2026-11-20T00:00:00Z') / 1000 + n * 86400;

const invoice = (id: string, paidDay: number, lines: Array<[number, string]> = [[5000, 'price_plan']], userId = 'u1'): AccrualInvoice => {
  const total = lines.reduce((s, [a]) => s + a, 0);
  return {
    id,
    status: 'paid',
    currency: 'usd',
    amount_paid: total,
    total_excluding_tax: total,
    lines: { data: lines.map(([amount, price]) => ({ amount, pricing: { price_details: { price } } })) },
    status_transitions: { paid_at: day(paidDay) },
    customer: 'cus_1',
    parent: { subscription_details: { metadata: { userId } } },
  };
};

const code = (over: Partial<ZomaReferralCode> = {}): ZomaReferralCode => ({
  code: 'sandra', referrerId: 'sandra', payeeName: 'S', status: 'active', createdAt: '2026-11-01T00:00:00Z', createdBy: 'a', ...over,
});

function setup(over: { record?: ZomaReferralCode | null; user?: { signupRef?: string; createdAt?: string } | null; paid?: AccrualInvoice[]; enabled?: boolean } = {}) {
  const rows = new Map<string, ZomaLedgerEntry>();
  const ledger: ZomaReferralLedgerStore = {
    async append(e) { if (rows.has(e.entry)) return false; rows.set(e.entry, e); return true; },
    async listForReferredUser() { return [...rows.values()]; },
    async listAll() { return [...rows.values()]; },
  };
  const record = over.record === undefined ? code() : over.record;
  const registry: ZomaReferralStore = { create: async () => true, get: async () => record, revoke: async () => true };
  const deps: AccrualDeps = {
    config: { enabled: over.enabled ?? true, percentBps: 2000, months: 3 },
    registry,
    ledger,
    feePriceIds: [FEE],
    getReferredUser: async () => (over.user === undefined ? { signupRef: 'sandra', createdAt: '2026-11-10T00:00:00Z' } : over.user),
    listPaidInvoices: async () => over.paid ?? [],
    now: () => new Date('2027-01-01T00:00:00Z'),
  };
  return { deps, rows };
}

describe('accrueReferralCommission', () => {
  it('accrues 20% of a plan invoice for a registered code', async () => {
    const { deps, rows } = setup();
    const r = await accrueReferralCommission(invoice('in_1', 0), deps);
    expect(r).toMatchObject({ status: 'accrued', entry: { commissionCents: 1000, referrerId: 'sandra', invoiceId: 'in_1' } });
    expect(rows.size).toBe(1);
  });

  it('is idempotent: the second delivery of the same invoice writes nothing', async () => {
    const { deps, rows } = setup();
    await accrueReferralCommission(invoice('in_1', 0), deps);
    expect(await accrueReferralCommission(invoice('in_1', 0), deps)).toEqual({ status: 'skipped', reason: 'already_recorded' });
    expect(rows.size).toBe(1);
  });

  it('earns nothing when disabled, without a user, a ref, or a registered code', async () => {
    expect(await accrueReferralCommission(invoice('in_1', 0), setup({ enabled: false }).deps)).toMatchObject({ reason: 'disabled' });
    expect(await accrueReferralCommission(invoice('in_1', 0), setup({ user: null }).deps)).toMatchObject({ reason: 'no_user' });
    expect(await accrueReferralCommission(invoice('in_1', 0), setup({ user: { createdAt: '2026-11-10T00:00:00Z' } }).deps)).toMatchObject({ reason: 'no_ref' });
    expect(await accrueReferralCommission(invoice('in_1', 0), setup({ record: null }).deps)).toMatchObject({ reason: 'not_a_referral' });
  });

  it('refuses self-referral', async () => {
    const { deps, rows } = setup({ record: code({ userId: 'u1' }) });
    expect(await accrueReferralCommission(invoice('in_1', 0), deps)).toMatchObject({ reason: 'self_referral' });
    expect(rows.size).toBe(0);
  });

  it('does not pay retroactively for a signup from before the code existed', async () => {
    const { deps } = setup({ user: { signupRef: 'sandra', createdAt: '2026-10-01T00:00:00Z' } });
    expect(await accrueReferralCommission(invoice('in_1', 0), deps)).toMatchObject({ reason: 'revoked_or_not_earning' });
  });

  it('a revoked code stops invoices paid after revocation but not earlier ones', async () => {
    const { deps } = setup({ record: code({ status: 'revoked', revokedAt: '2026-11-25T00:00:00Z' }) });
    expect(await accrueReferralCommission(invoice('in_1', 2), deps)).toMatchObject({ status: 'accrued' });
    expect(await accrueReferralCommission(invoice('in_2', 6), deps)).toMatchObject({ reason: 'revoked_or_not_earning' });
  });

  it('a fee-only invoice earns nothing', async () => {
    const { deps, rows } = setup();
    expect(await accrueReferralCommission(invoice('in_fee', 0, [[100, FEE]]), deps)).toMatchObject({ reason: 'nothing_commissionable' });
    expect(rows.size).toBe(0);
  });

  it('the 4th commissionable invoice earns nothing, and a late-arriving 2nd still counts', async () => {
    const all = [invoice('in_1', 0), invoice('in_2', 30), invoice('in_3', 60), invoice('in_4', 90)];
    const { deps } = setup({ paid: all });
    expect(await accrueReferralCommission(all[3], deps)).toMatchObject({ reason: 'outside_window' });
    // in_3 is delivered before in_2: Stripe's list, not delivery order, decides the window.
    expect(await accrueReferralCommission(all[2], deps)).toMatchObject({ status: 'accrued' });
    expect(await accrueReferralCommission(all[1], deps)).toMatchObject({ status: 'accrued' });
  });

  it('the $1 fee invoice does not use up a window slot', async () => {
    const all = [invoice('in_fee', 0, [[100, FEE]]), invoice('in_1', 7), invoice('in_2', 37), invoice('in_3', 67)];
    expect(await accrueReferralCommission(all[3], setup({ paid: all }).deps)).toMatchObject({ status: 'accrued' });
  });

  it('counts the current invoice even when Stripe has not listed it yet', async () => {
    expect(await accrueReferralCommission(invoice('in_1', 0), setup({ paid: [] }).deps)).toMatchObject({ status: 'accrued' });
  });

  it('surfaces unsafe results instead of guessing', async () => {
    const truncated = { ...invoice('in_1', 0), lines: { data: [], has_more: true } };
    expect(await accrueReferralCommission(truncated, setup().deps)).toMatchObject({ status: 'unsafe', reason: 'lines_truncated' });
    const noCustomer: AccrualInvoice = { ...invoice('in_1', 0), customer: null };
    expect(await accrueReferralCommission(noCustomer, setup().deps)).toMatchObject({ status: 'unsafe', reason: 'no_customer' });
    const bad = { ...invoice('in_0', -5), status_transitions: null };
    expect(await accrueReferralCommission(invoice('in_1', 0), setup({ paid: [bad] }).deps)).toMatchObject({ status: 'unsafe', invoiceId: 'in_0' });
  });

  it('lets store and Stripe outages surface so the webhook is retried', async () => {
    const a = setup();
    a.deps.registry.get = async () => { throw new Error('dynamo down'); };
    await expect(accrueReferralCommission(invoice('in_1', 0), a.deps)).rejects.toThrow('dynamo down');
    const b = setup();
    b.deps.listPaidInvoices = async () => { throw new Error('stripe down'); };
    await expect(accrueReferralCommission(invoice('in_1', 0), b.deps)).rejects.toThrow('stripe down');
    const c = setup();
    c.deps.ledger.append = async () => { throw new Error('throttled'); };
    await expect(accrueReferralCommission(invoice('in_1', 0), c.deps)).rejects.toThrow('throttled');
  });
});
