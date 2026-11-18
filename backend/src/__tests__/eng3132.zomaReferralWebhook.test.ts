/** ENG-3132 slice B5. The webhook entry is dark by default, retries safely, and never swallows a failure. */
import { handleZomaBillingWebhookEvent } from '../mcp/zomaBilling';
import { createZomaReferralWebhookHandler, trialFeePriceIds } from '../services/zomaReferralWebhook';
import type { AccrualDeps } from '../services/zomaReferralAccrual';

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
    const h = createZomaReferralWebhookHandler({ isZomaPlanObject: () => true, accrualDeps: () => d, retrieveInvoice: jest.fn() });
    await h.onInvoicePaid(invoice);
    await h.onCreditNoteCreated({ id: 'cn_1', invoice: 'in_1' } as never);
    expect(d.getReferredUser).not.toHaveBeenCalled();
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

describe('trialFeePriceIds', () => {
  it('merges the current and retired fee prices, trimmed and de-duplicated', () => {
    expect(trialFeePriceIds({ ZOMA_STRIPE_TRIAL_FEE_PRICE_ID: 'price_a', ZOMA_STRIPE_TRIAL_FEE_PRICE_IDS_HISTORICAL: ' price_b, price_a ,' })).toEqual(['price_a', 'price_b']);
    expect(trialFeePriceIds({})).toEqual([]);
  });
});

describe('handleZomaBillingWebhookEvent wiring', () => {
  const handler = () => ({ onInvoicePaid: jest.fn(async () => undefined), onCreditNoteCreated: jest.fn(async () => undefined) });
  const recordFunnel = jest.fn(async () => true);
  const zomaInvoice = { id: 'in_1', parent: { subscription_details: { metadata: { product: 'zoma_plan', userId: 'u1' } } } };

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
