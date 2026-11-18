/** ENG-3132 slice D. The reconcile reports where the ledger and Stripe disagree; it never writes. */
import { buildAccrualEntry, buildReversalEntry, buildVoidEntry, type ZomaLedgerEntry } from '../services/zomaReferralLedger';
import { reconcileReferralLedger, type InvoiceFacts } from '../services/zomaReferralReconcile';

const attribution = { referredUserId: 'u1', referrerId: 'sandra', code: 'sandra', percentBps: 2000, invoiceId: 'in_1', paidAt: '2026-12-10T00:00:00.000Z', now: new Date('2026-12-10T00:00:00Z') };
const accrual = (baseCents = 5000, over: Partial<typeof attribution> = {}) => buildAccrualEntry({ ...attribution, ...over, baseCents });
const reversal = (creditedBaseCents: number, commissionCentsToReverse: number, creditNoteId = 'cn_1') =>
  buildReversalEntry({ ...attribution, creditNoteId, creditedBaseCents, commissionCentsToReverse, creditedAt: '2027-01-05T00:00:00.000Z' });

const run = (rows: ZomaLedgerEntry[], facts: Record<string, InvoiceFacts | null>, month?: string) => {
  const listAll = jest.fn(async () => rows);
  const getInvoiceFacts = jest.fn(async (id: string) => (id in facts ? facts[id] : null));
  return reconcileReferralLedger({ ledger: { listAll }, getInvoiceFacts }, { month });
};
const paid = (refundedCents = 0, amountPaidCents = 5000): InvoiceFacts => ({ status: 'paid', amountPaidCents, refundedCents });

describe('reconcileReferralLedger', () => {
  it('reports nothing for a clean ledger and counts what it checked', async () => {
    const r = await run([accrual()], { in_1: paid() });
    expect(r).toMatchObject({ checkedInvoices: 1, discrepancies: [], totals: { actualCommissionCents: 1000, expectedCommissionCents: 1000 } });
  });

  it('flags a charge refund that has no credit note: Stripe refunded half, the ledger reversed nothing', async () => {
    const r = await run([accrual()], { in_1: paid(2500) });
    expect(r.discrepancies).toEqual([
      expect.objectContaining({ kind: 'refund_not_reversed', invoiceId: 'in_1', expectedCommissionCents: 500, actualCommissionCents: 1000, differenceCents: 500 }),
    ]);
    expect(r.totals.byKind).toEqual({ refund_not_reversed: 1 });
  });

  it('a fully refunded invoice with the full reversal is clean, and without it is flagged for the whole commission', async () => {
    expect((await run([accrual(), reversal(5000, 1000)], { in_1: paid(5000) })).discrepancies).toEqual([]);
    expect((await run([accrual()], { in_1: paid(5000) })).discrepancies[0]).toMatchObject({ kind: 'refund_not_reversed', expectedCommissionCents: 0, differenceCents: 1000 });
  });

  it('flags a reversal Stripe has no refund for', async () => {
    const r = await run([accrual(), reversal(5000, 1000)], { in_1: paid(0) });
    expect(r.discrepancies[0]).toMatchObject({ kind: 'over_reversed', expectedCommissionCents: 1000, actualCommissionCents: 0, differenceCents: -1000 });
  });

  it('respects a void: the reversal it cancels is not counted against Stripe', async () => {
    const rev = reversal(5000, 1000);
    const rows = [accrual(), rev, buildVoidEntry(rev, '2027-01-06T00:00:00.000Z', new Date())];
    expect((await run(rows, { in_1: paid(0) })).discrepancies).toEqual([]);
  });

  it('tolerates a one-cent rounding difference but not two', async () => {
    expect((await run([accrual(), reversal(1666, 332)], { in_1: paid(1667) })).discrepancies).toEqual([]);
    expect((await run([accrual(), reversal(1666, 330)], { in_1: paid(1667) })).discrepancies[0]).toMatchObject({ kind: 'refund_not_reversed' });
  });

  it('flags an accrual whose invoice is unpaid or missing in Stripe', async () => {
    const r = await run([accrual(), accrual(5000, { invoiceId: 'in_2' })], { in_1: { status: 'open', amountPaidCents: 0, refundedCents: 0 } });
    expect(r.discrepancies.map((d) => [d.invoiceId, d.kind])).toEqual([['in_1', 'accrual_without_paid_invoice'], ['in_2', 'invoice_missing_in_stripe']]);
  });

  it('flags a ledger that nets above the accrual with no refund as net_mismatch', async () => {
    const rev = reversal(5000, 1000);
    const r = await run([accrual(), buildVoidEntry(rev, '2027-01-06T00:00:00.000Z', new Date())], { in_1: paid(0) });
    expect(r.discrepancies[0]).toMatchObject({ kind: 'net_mismatch', actualCommissionCents: 2000, expectedCommissionCents: 1000 });
  });

  it('flags reversal rows that have no accrual, without asking Stripe', async () => {
    const getInvoiceFacts = jest.fn();
    const r = await reconcileReferralLedger({ ledger: { listAll: async () => [reversal(5000, 1000)] }, getInvoiceFacts });
    expect(r.discrepancies[0]).toMatchObject({ kind: 'over_reversed', expectedCommissionCents: 0, actualCommissionCents: -1000 });
    expect(getInvoiceFacts).not.toHaveBeenCalled();
  });

  it('--month selects invoices by their accrual month and still counts later reversals of them', async () => {
    const dec = accrual();
    const jan = accrual(5000, { invoiceId: 'in_2', paidAt: '2027-01-03T00:00:00.000Z' });
    const facts = { in_1: paid(5000), in_2: paid() };
    const r = await run([dec, reversal(5000, 1000), jan], facts, '2026-12');
    expect(r).toMatchObject({ checkedInvoices: 1, discrepancies: [] });
  });

  it('never writes: the ledger dependency only exposes listAll', async () => {
    const ledger = { listAll: jest.fn(async () => [accrual()]) };
    await reconcileReferralLedger({ ledger, getInvoiceFacts: async () => paid() });
    expect(Object.keys(ledger)).toEqual(['listAll']);
  });
});
