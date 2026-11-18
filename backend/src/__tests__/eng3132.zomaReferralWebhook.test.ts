/** ENG-3132 slice B5. The webhook entry is dark by default, retries safely, and never swallows a failure. */
import { handleZomaBillingWebhookEvent } from '../mcp/zomaBilling';
import { createZomaReferralWebhookHandler, trialFeePriceIds } from '../services/zomaReferralWebhook';
import type { AccrualDeps } from '../services/zomaReferralAccrual';
import type { ZomaLedgerEntry } from '../services/zomaReferralLedger';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

const deps = (over: Partial<AccrualDeps> = {}): AccrualDeps => ({
  config: { enabled: true, percentBps: 2000, months: 3 },
  registry: { create: jest.fn(), get: jest.fn(), revoke: jest.fn() },
  ledger: { append: jest.fn(), listForReferredUser: jest.fn(async () => []), listAll: jest.fn() },
  feePriceIds: ['price_fee'],
  getReferredUser: jest.fn(async () => ({ signupRef: 'sandra', createdAt: '2026-11-20T00:00:00Z' })),
  listPaidInvoices: jest.fn(async () => []),
  now: () => new Date('2026-12-01T00:00:00Z'),
  ...over,
});
const invoice = { id: 'in_1', parent: { subscription_details: { metadata: { userId: 'u1' } } } } as never;

describe('dark by default', () => {
  it('does nothing, and touches no store, unless ZOMA_REFERRAL_ENABLED is true', async () => {
    delete process.env.ZOMA_REFERRAL_ENABLED;
    const d = deps();
    const retrieveInvoice = jest.fn();
    const listCreditNotes = jest.fn();
    const h = createZomaReferralWebhookHandler({ isZomaPlanObject: () => true, accrualDeps: () => d, retrieveInvoice, listCreditNotes });
    await h.onInvoicePaid(invoice);
    await h.onCreditNoteCreated({ id: 'cn_1', invoice: 'in_1' } as never);
    await h.onCreditNoteVoided({ id: 'cn_1', invoice: 'in_1' } as never);
    expect(d.getReferredUser).not.toHaveBeenCalled();
    expect(retrieveInvoice).not.toHaveBeenCalled();
    expect(listCreditNotes).not.toHaveBeenCalled();
  });
});

describe('enabled', () => {
  beforeEach(() => { process.env.ZOMA_REFERRAL_ENABLED = 'true'; });

  it('lets a store outage surface so the webhook can 5xx and Stripe retries', async () => {
    const d = deps({ getReferredUser: jest.fn(async () => { throw new Error('dynamo down'); }) });
    const h = createZomaReferralWebhookHandler({ isZomaPlanObject: () => true, accrualDeps: () => d });
    await expect(h.onInvoicePaid(invoice)).rejects.toThrow('dynamo down');
  });

  it('logs an unsafe invoice for an operator instead of dropping it silently', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const d = deps({ registry: { create: jest.fn(), revoke: jest.fn(), get: jest.fn(async () => ({ code: 'sandra', referrerId: 's', payeeName: 'S', status: 'active' as const, createdAt: '2026-11-01T00:00:00Z', createdBy: 'a' })) } });
      const h = createZomaReferralWebhookHandler({ isZomaPlanObject: () => true, accrualDeps: () => d });
      await h.onInvoicePaid({ ...(invoice as object), status: 'paid', currency: 'usd', amount_paid: 5000 } as never); // no totals/lines: cannot be computed safely
      expect(error).toHaveBeenCalledWith(expect.stringContaining('commission NOT recorded'));
    } finally {
      error.mockRestore();
    }
  });

  it('ignores a credit note on a non-Zoma (Emma) invoice without touching the ledger', async () => {
    const d = deps();
    const h = createZomaReferralWebhookHandler({ isZomaPlanObject: () => false, accrualDeps: () => d, retrieveInvoice: jest.fn(async () => ({ id: 'in_9' }) as never) });
    await h.onCreditNoteCreated({ id: 'cn_1', invoice: 'in_9', status: 'issued' } as never);
    expect(d.ledger.listForReferredUser).not.toHaveBeenCalled();
  });
});

describe('end to end on an in-memory ledger', () => {
  beforeEach(() => { process.env.ZOMA_REFERRAL_ENABLED = 'true'; });
  const PAID = Date.parse('2026-12-10T00:00:00Z') / 1000;
  const paidInvoice = {
    id: 'in_1', status: 'paid', currency: 'usd', amount_paid: 5000, total_excluding_tax: 5000, customer: 'cus_1',
    lines: { data: [{ id: 'il_plan', amount: 5000, pricing: { price_details: { price: 'price_plan' } } }] },
    status_transitions: { paid_at: PAID },
    parent: { subscription_details: { metadata: { product: 'zoma_plan', userId: 'u1' } } },
  };
  const issuedNote = { id: 'cn_1', status: 'issued', invoice: 'in_1', total_excluding_tax: 5000, created: PAID + 86400, lines: { data: [{ invoice_line_item: 'il_plan', amount: 5000, discount_amount: 0 }] } };

  function harness() {
    const rows: ZomaLedgerEntry[] = [];
    const ledger = {
      append: async (e: ZomaLedgerEntry) => (rows.some((r) => r.entry === e.entry) ? false : (rows.push(e), true)),
      listForReferredUser: async () => rows,
      listAll: async () => rows,
    };
    const d = deps({
      ledger,
      registry: { create: jest.fn(), revoke: jest.fn(), get: jest.fn(async () => ({ code: 'sandra', referrerId: 's', payeeName: 'S', status: 'active' as const, createdAt: '2026-11-01T00:00:00Z', createdBy: 'a' })) },
    });
    const handler = (notes: unknown[]) => createZomaReferralWebhookHandler({
      isZomaPlanObject: () => true,
      accrualDeps: () => d,
      retrieveInvoice: async () => paidInvoice as never,
      listCreditNotes: async () => notes as never,
    });
    return { rows, handler, net: () => rows.reduce((sum, r) => sum + r.commissionCents, 0) };
  }

  it('a credit note that arrives BEFORE its invoice is applied when the invoice accrues', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { handler, net } = harness();
      await handler([issuedNote]).onCreditNoteCreated(issuedNote as never); // nothing to reverse yet
      expect(net()).toBe(0);
      await handler([issuedNote]).onInvoicePaid(paidInvoice as never);
      expect(net()).toBe(0); // accrued 1000, then reversed 1000: the referrer is not paid on a refunded invoice
    } finally {
      warn.mockRestore();
    }
  });

  it('a replayed invoice.paid and credit note change nothing', async () => {
    const { handler, net, rows } = harness();
    const h = handler([]);
    await h.onInvoicePaid(paidInvoice as never);
    await h.onInvoicePaid(paidInvoice as never);
    expect(net()).toBe(1000);
    await handler([issuedNote]).onCreditNoteCreated(issuedNote as never);
    await handler([issuedNote]).onCreditNoteCreated(issuedNote as never);
    expect(net()).toBe(0);
    expect(rows).toHaveLength(2);
  });

  it('a voided credit note gives the commission back', async () => {
    const { handler, net } = harness();
    await handler([]).onInvoicePaid(paidInvoice as never);
    await handler([]).onCreditNoteCreated(issuedNote as never);
    await handler([]).onCreditNoteVoided({ ...issuedNote, status: 'void' } as never);
    expect(net()).toBe(1000);
  });

  it('ignores a credit note with no invoice and one whose invoice no longer exists, instead of looping retries', async () => {
    const { handler } = harness();
    await expect(handler([]).onCreditNoteCreated({ id: 'cn_x', invoice: null } as never)).resolves.toBeUndefined();
    const gone = createZomaReferralWebhookHandler({
      isZomaPlanObject: () => true,
      accrualDeps: () => deps(),
      retrieveInvoice: async () => { throw Object.assign(new Error('No such invoice'), { code: 'resource_missing' }); },
    });
    await expect(gone.onCreditNoteCreated({ id: 'cn_x', invoice: 'in_gone' } as never)).resolves.toBeUndefined();
  });
});

describe('trialFeePriceIds', () => {
  it('merges the current and retired fee prices, trimmed and de-duplicated', () => {
    expect(trialFeePriceIds({ ZOMA_STRIPE_TRIAL_FEE_PRICE_ID: 'price_a', ZOMA_STRIPE_TRIAL_FEE_PRICE_IDS_HISTORICAL: ' price_b, price_a ,' })).toEqual(['price_a', 'price_b']);
    expect(trialFeePriceIds({})).toEqual([]);
  });
});

describe('handleZomaBillingWebhookEvent wiring', () => {
  const handler = () => ({ onInvoicePaid: jest.fn(async () => undefined), onCreditNoteCreated: jest.fn(async () => undefined), onCreditNoteVoided: jest.fn(async () => undefined) });
  const recordFunnel = jest.fn(async () => true);
  const zomaInvoice = { id: 'in_1', parent: { subscription_details: { metadata: { product: 'zoma_plan', userId: 'u1' } } } };

  it('routes a voided credit note to its own handler', async () => {
    const referral = handler();
    const cn = { id: 'cn_1', invoice: 'in_1', status: 'void' };
    expect(await handleZomaBillingWebhookEvent({ id: 'evt_5', type: 'credit_note.voided', created: 1, data: { object: cn } }, { recordFunnel }, referral)).toBe(false);
    expect(referral.onCreditNoteVoided).toHaveBeenCalledWith(cn);
    expect(referral.onCreditNoteCreated).not.toHaveBeenCalled();
  });

  it.each(['invoice.paid', 'invoice.payment_succeeded'] as const)('routes a Zoma %s to accrual and still claims the event from Emma', async (type) => {
    const referral = handler();
    expect(await handleZomaBillingWebhookEvent({ id: 'evt_1', type, created: 1, data: { object: zomaInvoice } }, { recordFunnel }, referral)).toBe(true);
    expect(referral.onInvoicePaid).toHaveBeenCalledWith(zomaInvoice);
  });

  it('never accrues an Emma invoice', async () => {
    const referral = handler();
    const emma = { id: 'in_2', parent: { subscription_details: { metadata: { userId: 'u2' } } } };
    expect(await handleZomaBillingWebhookEvent({ id: 'evt_2', type: 'invoice.paid', created: 1, data: { object: emma } }, { recordFunnel }, referral)).toBe(false);
    expect(referral.onInvoicePaid).not.toHaveBeenCalled();
  });

  it('routes a credit note to reversal but leaves it to the Emma path (returns false)', async () => {
    const referral = handler();
    const cn = { id: 'cn_1', invoice: 'in_1' };
    expect(await handleZomaBillingWebhookEvent({ id: 'evt_3', type: 'credit_note.created', created: 1, data: { object: cn } }, { recordFunnel }, referral)).toBe(false);
    expect(referral.onCreditNoteCreated).toHaveBeenCalledWith(cn);
  });

  it('propagates a referral failure so the webhook 5xxs and Stripe retries', async () => {
    const referral = handler();
    referral.onInvoicePaid.mockRejectedValueOnce(new Error('dynamo down'));
    await expect(handleZomaBillingWebhookEvent({ id: 'evt_4', type: 'invoice.paid', created: 1, data: { object: zomaInvoice } }, { recordFunnel }, referral)).rejects.toThrow('dynamo down');
  });
});
