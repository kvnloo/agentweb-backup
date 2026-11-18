/** ENG-3132 slice B1. Money invariants: the $1 fee never earns, ex-tax, fail closed, window is order-independent. */
import { commissionBase, commissionCents, inCommissionWindow, payoutMonth, type InvoiceLike } from '../services/zomaReferralCommission';

const FEE = 'price_fee';
const PAID_AT = Date.parse('2026-12-31T23:30:00Z') / 1000;
const line = (amount: number, price: string, discounts: number[] = []) => ({
  amount,
  discount_amounts: discounts.map((amount) => ({ amount })),
  pricing: { price_details: { price } },
});
const inv = (over: Partial<InvoiceLike> = {}): InvoiceLike => ({
  id: 'in_1',
  status: 'paid',
  currency: 'usd',
  amount_paid: 5000,
  total_excluding_tax: 5000,
  lines: { data: [line(5000, 'price_plan')] },
  status_transitions: { paid_at: PAID_AT },
  ...over,
});

describe('commissionBase', () => {
  it('earns on plan + overage lines ex-tax', () => {
    expect(commissionBase(inv({ total_excluding_tax: 5300, amount_paid: 5830, lines: { data: [line(5000, 'price_plan'), line(300, 'price_over')] } }), [FEE])).toMatchObject({ status: 'ok', baseCents: 5300 });
  });
  it('never earns on the $1 fee line, even when it shares an invoice with plan lines', () => {
    expect(commissionBase(inv({ total_excluding_tax: 100, amount_paid: 100, lines: { data: [line(100, FEE)] } }), [FEE])).toEqual({ status: 'skip', reason: 'nothing_commissionable' });
    expect(commissionBase(inv({ total_excluding_tax: 5100, lines: { data: [line(5000, 'price_plan'), line(100, FEE)] } }), [FEE])).toMatchObject({ status: 'ok', baseCents: 5000, feeCents: 100 });
  });
  it('a returning user (no fee line) earns on their first invoice too', () => {
    expect(commissionBase(inv(), [FEE])).toMatchObject({ status: 'ok', baseCents: 5000, feeCents: 0 });
  });
  it('subtracts a discounted fee at its net amount, and honours any historical fee price id', () => {
    expect(commissionBase(inv({ total_excluding_tax: 4950, lines: { data: [line(5000, 'price_plan', [100]), line(100, 'price_fee_old', [50])] } }), [FEE, 'price_fee_old'])).toMatchObject({ baseCents: 4900, feeCents: 50 });
  });
  it('skips unpaid, zero-paid and non-USD invoices', () => {
    expect(commissionBase(inv({ status: 'open' }), [FEE])).toEqual({ status: 'skip', reason: 'not_paid' });
    expect(commissionBase(inv({ amount_paid: 0 }), [FEE])).toEqual({ status: 'skip', reason: 'not_paid' });
    expect(commissionBase(inv({ currency: 'eur' }), [FEE])).toEqual({ status: 'skip', reason: 'not_usd' });
  });
  it('fails closed instead of guessing', () => {
    expect(commissionBase(inv(), [])).toEqual({ status: 'unsafe', reason: 'no_fee_price_configured' });
    expect(commissionBase(inv({ lines: { data: [line(5000, 'p')], has_more: true } }), [FEE])).toEqual({ status: 'unsafe', reason: 'lines_truncated' });
    expect(commissionBase(inv({ total_excluding_tax: null }), [FEE])).toEqual({ status: 'unsafe', reason: 'missing_totals' });
    expect(commissionBase(inv({ status_transitions: null }), [FEE])).toEqual({ status: 'unsafe', reason: 'missing_paid_at' });
  });
});

describe('commissionCents / payoutMonth', () => {
  it('20% of $50 is $10; rounds half up; basis points', () => {
    expect(commissionCents(5000, 2000)).toBe(1000);
    expect(commissionCents(5, 2000)).toBe(1);
    expect(commissionCents(2, 2500)).toBe(1);
    expect(commissionCents(5000, 1250)).toBe(625);
  });
  it('groups by UTC month, not local time', () => {
    expect(payoutMonth('2026-12-31T23:30:00.000Z')).toBe('2026-12');
    expect(payoutMonth('2027-01-01T00:00:00.000Z')).toBe('2027-01');
  });
});

describe('inCommissionWindow', () => {
  const invs = [
    { id: 'in_c', paidAt: '2026-12-03T00:00:00Z' },
    { id: 'in_a', paidAt: '2026-10-03T00:00:00Z' },
    { id: 'in_d', paidAt: '2027-01-03T00:00:00Z' },
    { id: 'in_b', paidAt: '2026-11-03T00:00:00Z' },
  ];
  it('covers the first N by paid time regardless of webhook arrival order', () => {
    expect(['in_a', 'in_b', 'in_c', 'in_d'].map((id) => inCommissionWindow(id, invs, 3))).toEqual([true, true, true, false]);
  });
  it('is false for an invoice that is not commissionable at all', () => {
    expect(inCommissionWindow('in_x', invs, 3)).toBe(false);
  });
});
