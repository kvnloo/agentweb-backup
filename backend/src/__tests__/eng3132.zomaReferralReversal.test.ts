/** ENG-3132 slice B4. Refund invariants: only commissionable money reverses, never beyond the accrual, idempotent. */
import { reverseReferralCommission, voidReferralReversal, type CreditNoteLike, type ReversalDeps, type ReversalInvoice } from '../services/zomaReferralReversal';
import { buildAccrualEntry, type ZomaLedgerEntry, type ZomaReferralLedgerStore } from '../services/zomaReferralLedger';

class MemoryLedger implements ZomaReferralLedgerStore {
  rows: ZomaLedgerEntry[] = [];
  async append(e: ZomaLedgerEntry) {
    if (this.rows.some((r) => r.referredUserId === e.referredUserId && r.entry === e.entry)) return false;
    this.rows.push(e);
    return true;
  }
  async listForReferredUser(u: string) {
    return this.rows.filter((r) => r.referredUserId === u);
  }
  async listAll() {
    return this.rows;
  }
}

const net = (ledger: MemoryLedger) => ledger.rows.reduce((s, r) => s + r.commissionCents, 0);
const invoice: ReversalInvoice = {
  userId: 'u1',
  lines: {
    data: [
      { id: 'il_plan', pricing: { price_details: { price: 'price_plan' } } },
      { id: 'il_fee', pricing: { price_details: { price: 'price_fee' } } },
    ],
  },
};
const note = (over: Partial<CreditNoteLike> = {}): CreditNoteLike => ({
  id: 'cn_1',
  status: 'issued',
  invoice: 'in_1',
  total_excluding_tax: 5000,
  lines: { data: [{ invoice_line_item: 'il_plan', amount: 5000, discount_amount: 0 }] },
  ...over,
});

function setup(accrualBase = 5000) {
  const ledger = new MemoryLedger();
  ledger.rows.push(buildAccrualEntry({ referredUserId: 'u1', referrerId: 'sandra', code: 'sandra', percentBps: 2000, invoiceId: 'in_1', paidAt: '2026-12-10T00:00:00.000Z', baseCents: accrualBase, now: new Date('2026-12-10T00:00:00Z') }));
  const deps: ReversalDeps = { ledger, getInvoice: async () => invoice, feePriceIds: ['price_fee'], now: () => new Date('2026-12-20T00:00:00Z') };
  return { ledger, deps };
}

describe('reverseReferralCommission', () => {
  it('a full refund nets the accrual to zero, at the rate recorded on the accrual', async () => {
    const { ledger, deps } = setup();
    const r = await reverseReferralCommission(note(), deps);
    expect(r).toMatchObject({ status: 'reversed', clamped: false, entry: { entry: 'in_1#reversal#cn_1', commissionCents: -1000, payoutMonth: '2026-12' } });
    expect(net(ledger)).toBe(0);
  });

  it('a partial refund reverses proportionally', async () => {
    const { ledger, deps } = setup();
    await reverseReferralCommission(note({ total_excluding_tax: 1000, lines: { data: [{ invoice_line_item: 'il_plan', amount: 1000, discount_amount: 0 }] } }), deps);
    expect(net(ledger)).toBe(800);
  });

  it('a duplicate credit note delivery writes nothing', async () => {
    const { ledger, deps } = setup();
    await reverseReferralCommission(note(), deps);
    expect(await reverseReferralCommission(note(), deps)).toEqual({ status: 'duplicate' });
    expect(ledger.rows).toHaveLength(2);
  });

  it('two credit notes can never reverse more than the accrual', async () => {
    const { ledger, deps } = setup();
    const partial = (id: string, cents: number) => note({ id, total_excluding_tax: cents, lines: { data: [{ invoice_line_item: 'il_plan', amount: cents, discount_amount: 0 }] } });
    await reverseReferralCommission(partial('cn_1', 4000), deps);
    const second = await reverseReferralCommission(partial('cn_2', 4000), deps);
    expect(second).toMatchObject({ status: 'reversed', clamped: true });
    expect(await reverseReferralCommission(partial('cn_3', 100), deps)).toEqual({ status: 'nothing_to_reverse', reason: 'fully_reversed' });
    expect(net(ledger)).toBe(0);
  });

  it('crediting only the $1 fee reverses nothing, and a mixed note reverses only the commissionable part', async () => {
    const { ledger, deps } = setup();
    const fee = { invoice_line_item: 'il_fee', amount: 100, discount_amount: 0 };
    expect(await reverseReferralCommission(note({ id: 'cn_fee', total_excluding_tax: 100, lines: { data: [fee] } }), deps)).toEqual({ status: 'nothing_to_reverse', reason: 'fee_only' });
    await reverseReferralCommission(note({ id: 'cn_mix', total_excluding_tax: 600, lines: { data: [fee, { invoice_line_item: 'il_plan', amount: 500, discount_amount: 0 }] } }), deps);
    expect(net(ledger)).toBe(1000 - 100);
  });

  it('returns no_accrual for an invoice that never accrued', async () => {
    const { deps } = setup();
    expect(await reverseReferralCommission(note({ invoice: 'in_other' }), deps)).toEqual({ status: 'no_accrual' });
  });

  it('ignores a credit note that is not issued', async () => {
    const { deps } = setup();
    expect(await reverseReferralCommission(note({ status: 'void' }), deps)).toEqual({ status: 'ignored', reason: 'not_issued' });
  });

  it('fails closed on shapes it cannot read', async () => {
    const { deps } = setup();
    expect(await reverseReferralCommission(note({ total_excluding_tax: null }), deps)).toEqual({ status: 'unsafe', reason: 'missing_totals' });
    expect(await reverseReferralCommission(note({ lines: { data: [], has_more: true } }), deps)).toEqual({ status: 'unsafe', reason: 'lines_truncated' });
    expect(await reverseReferralCommission(note({ lines: { data: [{ invoice_line_item: 'il_unknown', amount: 5000, discount_amount: 0 }] } }), deps)).toEqual({ status: 'unsafe', reason: 'unmapped_line' });
    expect(await reverseReferralCommission(note(), { ...deps, feePriceIds: [] })).toEqual({ status: 'unsafe', reason: 'no_fee_price_configured' });
    expect(await reverseReferralCommission(note(), { ...deps, getInvoice: async () => ({ ...invoice, userId: undefined }) })).toEqual({ status: 'unsafe', reason: 'no_user' });
  });

  it('lets outages surface so the webhook retries', async () => {
    const { ledger, deps } = setup();
    ledger.listForReferredUser = async () => {
      throw new Error('dynamo down');
    };
    await expect(reverseReferralCommission(note(), deps)).rejects.toThrow('dynamo down');
    await expect(reverseReferralCommission(note(), { ...deps, getInvoice: async () => { throw new Error('stripe down'); } })).rejects.toThrow('stripe down');
  });
});

describe('cumulative rounding', () => {
  const partial = (id: string, cents: number) => note({ id, total_excluding_tax: cents, lines: { data: [{ invoice_line_item: 'il_plan', amount: cents, discount_amount: 0 }] } });

  it('two 3c credits on a 6c accrual (1c commission) return exactly 1c, never 2c', async () => {
    const { ledger, deps } = setup(6);
    await reverseReferralCommission(partial('cn_1', 3), deps);
    await reverseReferralCommission(partial('cn_2', 3), deps);
    expect(net(ledger)).toBe(0);
  });

  it('three 1c credits cannot leave the referrer ahead: the final credit returns the remainder', async () => {
    const { ledger, deps } = setup(3);
    for (const id of ['cn_1', 'cn_2', 'cn_3']) await reverseReferralCommission(partial(id, 1), deps);
    expect(net(ledger)).toBe(0);
  });
});

describe('payout month of a reversal', () => {
  it('is the month the credit note was issued, so a clawback after payout hits the open month', async () => {
    const { ledger, deps } = setup();
    await reverseReferralCommission(note({ created: Date.parse('2027-01-05T10:00:00Z') / 1000 }), deps);
    expect(ledger.rows.find((r) => r.kind === 'reversal')).toMatchObject({ payoutMonth: '2027-01', paidAt: '2026-12-10T00:00:00.000Z' });
  });
});

describe('voidReferralReversal', () => {
  const voided = (over: Partial<CreditNoteLike> = {}) => note({ status: 'void', ...over });

  it('puts back exactly what the credit note took, once', async () => {
    const { ledger, deps } = setup();
    await reverseReferralCommission(note(), deps);
    expect(net(ledger)).toBe(0);
    expect(await voidReferralReversal(voided(), deps)).toMatchObject({ status: 'voided' });
    expect(net(ledger)).toBe(1000);
    expect(await voidReferralReversal(voided(), deps)).toEqual({ status: 'duplicate' });
    expect(net(ledger)).toBe(1000);
  });

  it('a void frees the cap, so a later credit note can reverse again', async () => {
    const { ledger, deps } = setup();
    await reverseReferralCommission(note(), deps);
    await voidReferralReversal(voided(), deps);
    await reverseReferralCommission(note({ id: 'cn_2' }), deps);
    expect(net(ledger)).toBe(0);
  });

  it('is a no-op for a note that never reversed anything, and ignores a note that is not void', async () => {
    const { ledger, deps } = setup();
    expect(await voidReferralReversal(voided(), deps)).toEqual({ status: 'no_reversal' });
    expect(await voidReferralReversal(note(), deps)).toEqual({ status: 'ignored', reason: 'not_void' });
    expect(net(ledger)).toBe(1000);
  });
});
