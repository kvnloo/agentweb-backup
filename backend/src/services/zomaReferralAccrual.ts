/**
 * ENG-3132 slice B3 — accrue referral commission for one paid Zoma invoice.
 *
 * Every dependency is injected. Store and Stripe failures THROW so the webhook returns 5xx and Stripe
 * retries; only a deliberate decision (a `skipped` result) is silent, and `unsafe` is returned for the
 * caller to alert on, never dropped. The 3-invoice window comes from Stripe's invoice list, not from the
 * ledger, so the answer does not depend on the order webhooks arrive in. payeeName is never read here.
 */
import { commissionBase, inCommissionWindow, type CommissionBase, type InvoiceLike } from './zomaReferralCommission';
import { buildAccrualEntry, type ZomaLedgerEntry, type ZomaReferralLedgerStore } from './zomaReferralLedger';
import { referralEarns, resolveReferrer, type ZomaReferralConfig, type ZomaReferralStore } from './zomaReferralRegistry';

/** The Zoma user rides on the invoice's subscription details (basil API shape); the customer is the Zoma-only one. */
export type AccrualInvoice = InvoiceLike & {
  customer?: string | { id: string } | null;
  parent?: { subscription_details?: { metadata?: Record<string, string> | null } | null } | null;
};

export interface AccrualDeps {
  config: ZomaReferralConfig;
  registry: ZomaReferralStore;
  ledger: ZomaReferralLedgerStore;
  /** Every trial-fee price id ever used (keep historical ids). */
  feePriceIds: readonly string[];
  /** AW-Users row: `signupRef` (set once at signup, ENG-2906) and `createdAt` (ISO signup time). */
  getReferredUser(userId: string): Promise<{ signupRef?: string; createdAt?: string } | null>;
  /** Every paid invoice of this Zoma customer, from Stripe. Per customer, not per subscription: a user who cancels and resubscribes must not get a fresh window. */
  listPaidInvoices(customerId: string): Promise<AccrualInvoice[]>;
  now(): Date;
}

export type SkipReason =
  | 'disabled'
  | 'no_user'
  | 'no_ref'
  | 'not_a_referral'
  | 'self_referral'
  | 'revoked_or_not_earning'
  | 'nothing_commissionable'
  | 'outside_window'
  | 'already_recorded';

export type UnsafeReason = Extract<CommissionBase, { status: 'unsafe' }>['reason'] | 'no_customer';

export type AccrualResult =
  | { status: 'accrued'; entry: ZomaLedgerEntry }
  | { status: 'skipped'; reason: SkipReason; detail?: string }
  | { status: 'unsafe'; reason: UnsafeReason; invoiceId: string };

const customerIdOf = (invoice: AccrualInvoice): string | undefined =>
  typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;

export async function accrueReferralCommission(invoice: AccrualInvoice, deps: AccrualDeps): Promise<AccrualResult> {
  const skip = (reason: SkipReason, detail?: string): AccrualResult => ({ status: 'skipped', reason, ...(detail ? { detail } : {}) });
  if (!deps.config.enabled) return skip('disabled');

  const userId = invoice.parent?.subscription_details?.metadata?.userId;
  if (!userId) return skip('no_user');
  const user = await deps.getReferredUser(userId);
  if (!user) return skip('no_user');
  if (!user.signupRef) return skip('no_ref');

  const resolved = await resolveReferrer(user.signupRef, deps.registry);
  if (resolved.kind === 'none') return skip('not_a_referral');
  const { record } = resolved;
  if (record.userId === userId) return skip('self_referral');

  const base = commissionBase(invoice, deps.feePriceIds);
  if (base.status === 'unsafe') return { status: 'unsafe', reason: base.reason, invoiceId: invoice.id };
  if (base.status === 'skip') return skip('nothing_commissionable', base.reason);

  // A revoked code still earns on invoices paid before the revocation, so revoked is decided here.
  if (!referralEarns(record, { signupAt: user.createdAt ?? '', paidAt: base.paidAt })) return skip('revoked_or_not_earning');

  const customerId = customerIdOf(invoice);
  if (!customerId) return { status: 'unsafe', reason: 'no_customer', invoiceId: invoice.id };
  const commissionable = new Map<string, { id: string; paidAt: string }>([[invoice.id, { id: invoice.id, paidAt: base.paidAt }]]);
  for (const other of await deps.listPaidInvoices(customerId)) {
    const b = commissionBase(other, deps.feePriceIds);
    if (b.status === 'unsafe') return { status: 'unsafe', reason: b.reason, invoiceId: other.id };
    if (b.status === 'ok') commissionable.set(other.id, { id: other.id, paidAt: b.paidAt });
  }
  if (!inCommissionWindow(invoice.id, [...commissionable.values()], deps.config.months)) return skip('outside_window');

  const entry = buildAccrualEntry({
    referredUserId: userId,
    referrerId: record.referrerId,
    code: record.code,
    percentBps: record.percentBps ?? deps.config.percentBps,
    invoiceId: invoice.id,
    paidAt: base.paidAt,
    baseCents: base.baseCents,
    now: deps.now(),
  });
  return (await deps.ledger.append(entry)) ? { status: 'accrued', entry } : skip('already_recorded');
}
