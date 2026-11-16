/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ENG-668 / ENG-2671: pre-launch rehearsal of month-end Extra usage (pay-as-you-go) settlement against REAL
 * Stripe TEST mode and the REAL Dev-* DynamoDB tables. Nothing here touches live Stripe or production data.
 *
 *   cd backend
 *   NODE_ENV=development npx ts-node --transpile-only src/scripts/paygStripeRehearsal.ts [--only a,b] [--keep] [--out file.json]
 *   NODE_ENV=development npx ts-node --transpile-only src/scripts/paygStripeRehearsal.ts --feed <userId>
 *
 * Credentials: STRIPE_SECRET_KEY in the environment (an `sk_test_` / `rk_test_` key), or, when unset, the app's own
 * loader (`dev/AgentWeb/Stripe` in Secrets Manager, which needs AWS access to that secret). A key that is not a
 * test key aborts the run before any Stripe call. STRIPE_API_BASE must be unset.
 *
 * What is real: the Stripe account (test mode), Stripe test clocks (so "an hour after finalize", "the retry
 * schedule" and "7 days unconfirmed" are exercised for real), the `stripe` SDK, `settlePaygOverageMonth`,
 * `runPaygSettlement`, the production webhook controller (`handleWebhook`, with the event signature checked
 * against a local secret) and every PAYG handler, and the Dev-AW-Users / AW-SpendEvents / AW-SpendProjection /
 * AW-PaymentHistory tables. Webhook events are PULLED from Stripe (`events.list`, the same event objects a webhook
 * endpoint would be sent) and replayed in order into the controller: no public endpoint or Stripe CLI is needed.
 *
 * What is not real (stubbed in this process only): outbound email (captured and printed; nothing is sent), the CRM signup sync of created users, the
 * `payg_settlement_enabled` switch (forced on in-process; no Dev config is written), and the sweep's owner scan
 * (restricted to this run's users, so other developers' Dev rows are never settled).
 *
 * Stripe's own customer emails (receipts, failed-payment, 3DS) are only sent in test mode to the confirmed address of a
 * Stripe team member; set REHEARSAL_STRIPE_EMAIL to such an address to receive them (our emails are always captured, never sent).
 *
 * Cases (--only): a=happy path + receipt + re-delivery + idempotent re-run + refund, b=credit-paid, c=decline sequence
 * + hosted-invoice payment, d=3DS action required + unconfirmed past grace, void, uncollectible, dispute (won and
 * lost), idem=concurrent runs + record-removed rerun, manual3ds=3DS left open for a human to confirm on the hosted
 * invoice page (never in the default set; finish it with --feed <userId>).
 */
import crypto from 'crypto';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

const RUN = crypto.randomBytes(3).toString('hex');
const results: Array<{ scenario: string; check: string; ok: boolean; evidence: unknown }> = [];
let scenarioName = '';
let flagKeep = flag('keep');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

function check(label: string, ok: boolean, evidence?: unknown) {
  results.push({ scenario: scenarioName, check: label, ok, evidence: evidence ?? null });
  log(ok ? '  PASS' : '  FAIL', label, evidence === undefined ? '' : JSON.stringify(evidence));
}
function note(label: string, evidence: unknown) {
  results.push({ scenario: scenarioName, check: `NOTE ${label}`, ok: true, evidence });
  log('  NOTE', label, JSON.stringify(evidence));
}

async function main() {
  // ---- hard guards, before anything is imported or any network call is made -------------------------------
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('Refusing to run: NODE_ENV must be "development" so every table is the Dev-* one (found: ' + String(process.env.NODE_ENV) + ').');
  }
  if (process.env.STRIPE_API_BASE) throw new Error('Refusing to run: STRIPE_API_BASE is set; this rehearsal needs real Stripe test mode.');

  if (!process.env.STRIPE_SECRET_KEY) {
    log('STRIPE_SECRET_KEY not set; loading the Dev Stripe credentials with the app loader (dev/AgentWeb/Stripe)');
    const { getStripeCredentials } = await import('../utils/secretsManager');
    await getStripeCredentials(); // throws (and the run stops) when this machine cannot read the secret
  }
  const key = process.env.STRIPE_SECRET_KEY as string;
  if (!/^(sk|rk)_test_/.test(key)) throw new Error('Refusing to run: the Stripe key is not a TEST-mode key (must start with sk_test_ or rk_test_).');
  // The webhook controller verifies signatures against this; the rehearsal signs its own replayed events.
  process.env.STRIPE_WEBHOOK_SECRET = `whsec_rehearsal_${RUN}`;

  const { createStripeClient, STRIPE_API_VERSION } = await import('../services/stripeClientFactory');
  const { userDb } = await import('../services/db');
  const { emailService } = await import('../services/emailService');
  const crmSignalHooks = await import('../services/crmSignalHooks');
  const { settlePaygOverageMonth, runPaygSettlement } = await import('../services/paygSettlementService');
  const { previousUsageMonth } = await import('../services/paygSettlement');
  const { paygSettlementSwitch } = await import('../services/paygOverageService');
  const { paygSuspendedReasonOf } = await import('../services/paygOverage');
  const { recordSpendEvent, SPEND_EVENTS_TABLE } = await import('../services/spendEventDb');
  const { putProjection, SPEND_PROJECTION_TABLE } = await import('../services/spendProjectionDb');
  const { projectMonth } = await import('../services/spendProjection');
  const { handleWebhook } = await import('../controllers/stripeController');
  const AWS = (await import('aws-sdk')).default;

  const stripe = createStripeClient(key);
  const account = await stripe.accounts.retrieve();
  const balance = await stripe.balance.retrieve();
  if ((balance as any).livemode !== false) throw new Error('Refusing to run: Stripe reports livemode.');
  log(`Stripe TEST account ${account.id}; pinned API version ${STRIPE_API_VERSION}; Dev tables: ${SPEND_EVENTS_TABLE}, ${SPEND_PROJECTION_TABLE}`);
  const seenApiVersions = new Set<string>();

  // ---- in-process stubs ------------------------------------------------------------------------------------------
  (paygSettlementSwitch as any).isEnabled = async () => true;
  const sent: Array<{ kind: string; at: string; args: any }> = [];
  for (const kind of ['sendPaygOverageInvoiceEmail', 'sendPaygOveragePaymentFailedEmail', 'sendPaygOveragePaymentActionRequiredEmail', 'sendOncallAlert']) {
    (emailService as any)[kind] = async (...args: any[]) => { sent.push({ kind, at: new Date().toISOString(), args }); return 'sent'; };
  }
  // `userDb.createUser` fires the CRM signup sync (contact + lead in the founders' signups list). Those rows are not
  // part of what is rehearsed and cleanup does not remove them, so the hook is a no-op here.
  (crmSignalHooks as any).onUserSignup = async () => null;
  const mails = (u: U, kind: string) => sent.filter((m) => m.kind === kind && (m.kind === 'sendOncallAlert' ? JSON.stringify(m.args).includes(u.id) : m.args[0]?.to === u.email));

  // ---- fixtures --------------------------------------------------------------------------------------------------
  const month = previousUsageMonth(new Date());
  const POOL = 10_000_000; // micro-USD plan pool
  const CAP = 20_000_000;
  const SPENT = 12_000_000; // 2.00 USD over the pool, 11000 bps markup => 220 cents
  const EXPECTED_CENTS = 220;
  const startedAt = Math.floor(Date.now() / 1000) - 120;
  const users: U[] = [];
  const clocks: string[] = [];
  const dd = new AWS.DynamoDB.DocumentClient();

  interface U { id: string; email: string; customer: string; clock?: string; clockTime?: number; fed: Set<string>; tag: string }

  async function newUser(tag: string, o: { pm?: string; clock?: boolean; creditCents?: number } = {}): Promise<U> {
    const id = `payg-rh-${RUN}-${tag}`;
    const email = `payg-rehearsal+${RUN}-${tag}@example.invalid`;
    let clock: string | undefined;
    let clockTime: number | undefined;
    if (o.clock) {
      clockTime = Math.floor(Date.now() / 1000);
      const c = await stripe.testHelpers.testClocks.create({ frozen_time: clockTime, name: `payg-rehearsal-${RUN}-${tag}` });
      clock = c.id; clocks.push(c.id);
    }
    const customer = await stripe.customers.create({ email: process.env.REHEARSAL_STRIPE_EMAIL || email, name: `PAYG rehearsal ${tag}`, metadata: { rehearsal: RUN }, ...(clock ? { test_clock: clock } : {}) });
    const pm = await stripe.paymentMethods.attach(o.pm ?? 'pm_card_visa', { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
    if (o.creditCents) await stripe.customers.createBalanceTransaction(customer.id, { amount: -o.creditCents, currency: 'usd', description: 'rehearsal credit' });

    await userDb.createUser(email, id, crypto.randomBytes(12).toString('hex'), false, false, ['customer'], `PAYG rehearsal ${tag}`, undefined, customer.id);
    for (let i = 0; i < 30 && !(await userDb.getUserById(id)); i++) await sleep(1000); // UserIdIndex is eventually consistent
    if (!(await userDb.getUserById(id))) throw new Error(`Dev user ${id} never became readable`);
    await userDb.updateUser(id, {
      paygOverage: {
        enabled: true,
        capPercentOfPool: 200,
        admittedMonths: [{ month, capHighWaterMicroUsd: CAP, tierPoolHighWaterMicroUsd: POOL, markupBps: 11_000, spendBasis: 'spend_ledger' }],
      },
    } as any);
    const event = {
      billingUserId: id, eventId: `rehearsal-${RUN}-${tag}`, occurredAt: `${month}-15T12:00:00.000Z`, billingMonth: month,
      actingUserId: id, provider: 'rehearsal', operation: 'llm', unit: 'usd', quantity: 1, costMicroUsd: SPENT,
      costSource: 'measured' as const, lifecycle: 'settled' as const,
    };
    await recordSpendEvent(event);
    await putProjection(projectMonth(id, month, [event], { includedAllowanceMicroUsd: POOL }));
    const u: U = { id, email, customer: customer.id, clock, clockTime, fed: new Set(), tag };
    users.push(u);
    return u;
  }

  const row = async (u: U): Promise<any> => userDb.getUserByIdConsistent(u.id);
  const rec = async (u: U): Promise<any> => (await row(u))?.paygSettlements?.[month];
  const settle = (u: U, now = new Date()) => settlePaygOverageMonth(u.id, month, now);
  const invoice = async (u: U): Promise<any> => stripe.invoices.retrieve((await rec(u)).invoiceId);

  // ---- webhook replay: events pulled from Stripe, signed locally, run through the production controller -----------
  const EVENT_TYPES = ['invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'invoice.payment_action_required',
    'invoice.voided', 'invoice.marked_uncollectible', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed'];
  async function deliver(event: any): Promise<number> {
    const payload = Buffer.from(JSON.stringify(event));
    const header = stripe.webhooks.generateTestHeaderString({ payload: payload.toString(), secret: process.env.STRIPE_WEBHOOK_SECRET as string });
    let code = 0;
    const res: any = { status(c: number) { code = c; return this; }, json() { if (!code) code = 200; return this; } };
    await handleWebhook({ body: payload, headers: { 'stripe-signature': header } } as any, res);
    return code;
  }
  /** Pull this user's new events from Stripe, oldest first, and run each through the controller once. */
  async function pump(u: U, redeliver = false): Promise<string[]> {
    const chargeIds = new Set((await stripe.charges.list({ customer: u.customer, limit: 100 })).data.map((c) => c.id));
    const all = await stripe.events.list({ types: EVENT_TYPES, created: { gte: startedAt }, limit: 100 } as any).autoPagingToArray({ limit: 1000 });
    const mine = all.filter((e: any) => {
      const o = e.data.object;
      return o.customer === u.customer || (o.object === 'dispute' && chargeIds.has(o.charge));
    }).reverse();
    const handled: string[] = [];
    for (const e of mine) {
      if (u.fed.has(e.id) && !redeliver) continue;
      seenApiVersions.add(String((e as any).api_version));
      const code = await deliver(e);
      u.fed.add(e.id);
      handled.push(`${e.type}:${code}`);
      if (code !== 200) check(`webhook ${e.type} (${e.id}) answered 200`, false, { code });
    }
    return handled;
  }
  async function waitFor(u: U, what: string, pred: () => Promise<boolean>, timeoutMs = 120_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const h = await pump(u);
      if (h.length) log(`    replayed ${h.join(', ')}`);
      if (await pred()) return true;
      if (Date.now() > end) { check(`timed out waiting for ${what}`, false); return false; }
      await sleep(4000);
    }
  }
  async function advance(u: U, toEpoch: number) {
    await stripe.testHelpers.testClocks.advance(u.clock as string, { frozen_time: Math.floor(toEpoch) });
    u.clockTime = Math.floor(toEpoch);
    for (let i = 0; i < 60; i++) {
      const c = await stripe.testHelpers.testClocks.retrieve(u.clock as string);
      if (c.status === 'ready') return;
      await sleep(3000);
    }
    throw new Error('test clock did not become ready');
  }
  const invBrief = (i: any) => ({
    id: i.id, status: i.status, auto_advance: i.auto_advance, collection_method: i.collection_method, total: i.total, amount_due: i.amount_due,
    amount_paid: i.amount_paid, attempt_count: i.attempt_count, attempted: i.attempted,
    next_payment_attempt: i.next_payment_attempt ? new Date(i.next_payment_attempt * 1000).toISOString() : null,
    receipt_number: i.receipt_number ?? null, hosted: Boolean(i.hosted_invoice_url),
  });

  // ---- scenarios -------------------------------------------------------------------------------------------------
  const only = (opt('only') ?? 'a,b,c,d,void,uncollectible,dispute,idem').split(',');
  const scenarios: Array<[string, string, () => Promise<void>]> = [];
  const scenario = (id: string, title: string, fn: () => Promise<void>) => scenarios.push([id, title, fn]);

  scenario('a', 'A. Visa: finalized with auto_advance, collection after the delay, receipt, re-delivery, idempotent re-run, refund', async () => {
    const u = await newUser('a', { clock: true });
    const outcome = await settle(u);
    check('settle outcome is invoiced', outcome === 'invoiced', outcome);
    const inv = await invoice(u);
    check('invoice open, auto_advance true, charge_automatically, total matches record', inv.status === 'open' && inv.auto_advance === true && inv.collection_method === 'charge_automatically' && inv.total === EXPECTED_CENTS, invBrief(inv));
    check('metadata carries purchaseType/billingUserId/month', inv.metadata?.purchaseType === 'payg_overage' && inv.metadata?.billingUserId === u.id && inv.metadata?.month === month, inv.metadata);
    check('exactly one "invoiced" email, wording not paid', mails(u, 'sendPaygOverageInvoiceEmail').length === 1 && mails(u, 'sendPaygOverageInvoiceEmail')[0].args[0].paid === false);
    const invoicedEmailAt = mails(u, 'sendPaygOverageInvoiceEmail')[0]?.at;
    note('before the collection attempt (test clock not advanced): charges for the customer', (await stripe.charges.list({ customer: u.customer })).data.length);
    await advance(u, (inv.next_payment_attempt ?? u.clockTime! + 3600) + 120);
    const paid = await waitFor(u, 'record paid', async () => (await rec(u))?.status === 'paid');
    const after = await invoice(u);
    const charge = (await stripe.charges.list({ customer: u.customer })).data[0];
    check('invoice paid by Stripe after finalization (not at finalization)', paid && after.status === 'paid', invBrief(after));
    note('order: our invoiced email (real time) came before the charge (clock time)', { invoicedEmailAt, chargeCreatedClock: charge ? new Date(charge.created * 1000).toISOString() : null });
    check('Stripe receipt data exists for the charge (receipt_url)', Boolean(charge?.receipt_url), { receipt_url: Boolean(charge?.receipt_url), receipt_number: charge?.receipt_number ?? null, invoice_receipt_number: after.receipt_number ?? null, receipt_email: charge?.receipt_email ?? null });
    check('still exactly one invoice email after the paid webhook', mails(u, 'sendPaygOverageInvoiceEmail').length === 1);
    const before = (await rec(u)).paidAt;
    const again = await pump(u, true);
    note('re-delivered every event', again);
    check('re-delivery changed nothing (paidAt same, still one email)', (await rec(u)).paidAt === before && mails(u, 'sendPaygOverageInvoiceEmail').length === 1, { paidAt: before });
    check('re-run of settlement for the same month is a no-op', (await settle(u)) === 'already_recorded');
    check('Stripe still holds exactly one invoice for the customer', (await stripe.invoices.list({ customer: u.customer, limit: 10 })).data.length === 1);
    if (charge) {
      await stripe.refunds.create({ charge: charge.id });
      await waitFor(u, 'refund recorded', async () => (await rec(u))?.refundedCents === EXPECTED_CENTS);
      const r = await rec(u);
      check('refund recorded, month stays paid, PAYG not suspended', r.refundedCents === EXPECTED_CENTS && r.status === 'paid' && !(await row(u)).paygOverage?.suspended, { refundedCents: r.refundedCents, status: r.status });
    }
  });

  scenario('b', 'B. Paid from customer credit balance (no card charge)', async () => {
    const u = await newUser('b', { creditCents: 100_000 });
    const outcome = await settle(u);
    const inv = await invoice(u);
    check('settle outcome is paid (collected at finalization)', outcome === 'paid', outcome);
    check('invoice paid from balance, no charge exists', inv.status === 'paid' && (await stripe.charges.list({ customer: u.customer })).data.length === 0, { ...invBrief(inv), starting_balance: inv.starting_balance, ending_balance: inv.ending_balance });
    const m = mails(u, 'sendPaygOverageInvoiceEmail');
    check('one email, in the paid wording', m.length === 1 && m[0].args[0].paid === true, m.map((x) => x.args[0]));
    note('Stripe receipt for a credit-paid invoice (invoice.receipt_number; whether Stripe emails is NOT observable via the API)', { receipt_number: inv.receipt_number ?? null });
    await waitFor(u, 'paid events replayed', async () => u.fed.size > 0, 60_000);
    check('paid webhooks added no second email and left the record paid', mails(u, 'sendPaygOverageInvoiceEmail').length === 1 && (await rec(u)).status === 'paid');
  });

  scenario('c', 'C. Card decline sequence (retry schedule via test clock), then hosted-invoice payment', async () => {
    const u = await newUser('c', { pm: 'pm_card_chargeCustomerFail', clock: true });
    check('settle outcome is invoiced', (await settle(u)) === 'invoiced');
    let inv = await invoice(u);
    await advance(u, (inv.next_payment_attempt ?? u.clockTime! + 3600) + 120);
    await waitFor(u, 'first failure handled', async () => (await rec(u))?.status === 'failed');
    inv = await invoice(u);
    const firstSuspended = (await row(u)).paygOverage?.suspended;
    check('after the first decline: record failed, PAYG suspended payment_failed, one failed email', (await rec(u)).status === 'failed' && firstSuspended?.reason === 'payment_failed' && mails(u, 'sendPaygOveragePaymentFailedEmail').length === 1, { suspended: firstSuspended, invoice: invBrief(inv) });
    const trail: any[] = [invBrief(inv)];
    for (let i = 0; i < 12 && inv.status === 'open' && inv.next_payment_attempt; i++) {
      await advance(u, inv.next_payment_attempt + 120);
      await pump(u);
      inv = await invoice(u);
      trail.push({ ...invBrief(inv), ourStatus: (await rec(u)).status, failedEmails: mails(u, 'sendPaygOveragePaymentFailedEmail').length });
    }
    note('retry trail (next_payment_attempt follows each failure)', trail);
    await pump(u);
    const suspended = (await row(u)).paygOverage?.suspended;
    check('PAYG held exactly once: suspended stamp unchanged by retries', suspended?.at === firstSuspended?.at && suspended?.invoiceId === firstSuspended?.invoiceId, { first: firstSuspended, last: suspended });
    check('failed email sent exactly once across all retries', mails(u, 'sendPaygOveragePaymentFailedEmail').length === 1, mails(u, 'sendPaygOveragePaymentFailedEmail').length);
    inv = await invoice(u);
    note('final Stripe state of the declined invoice (depends on the account retry policy)', invBrief(inv));
    const r = await rec(u);
    check('our record agrees with the final Stripe state', inv.status === 'open' ? r.status === 'failed' : inv.status === 'uncollectible' ? r.status === 'failed' && Boolean(r.uncollectibleAt) : inv.status === 'void' ? r.status === 'written_off' : false, { stripe: inv.status, ours: r.status, uncollectibleAt: r.uncollectibleAt ?? null });
    // Hosted-invoice payment: the hosted page calls the same pay endpoint with the customer's chosen card.
    const good = await stripe.paymentMethods.attach('pm_card_visa', { customer: u.customer });
    await stripe.invoices.pay(inv.id, { payment_method: good.id });
    await waitFor(u, 'invoice.paid lifts the hold', async () => (await rec(u))?.status === 'paid');
    const after = await row(u);
    check('after paying (API equivalent of the hosted page): record paid, suspension lifted', after.paygSettlements[month].status === 'paid' && !after.paygOverage?.suspended, { status: after.paygSettlements[month].status, suspended: after.paygOverage?.suspended ?? null });
  });

  async function threeDs(tag: string) {
    const u = await newUser(tag, { pm: 'pm_card_authenticationRequired', clock: true });
    check('settle outcome is invoiced', (await settle(u)) === 'invoiced');
    const inv = await invoice(u);
    await advance(u, (inv.next_payment_attempt ?? u.clockTime! + 3600) + 120);
    await waitFor(u, 'action-required handled', async () => Boolean((await rec(u))?.actionRequiredAt));
    const r = await rec(u);
    const after = await invoice(u);
    check('3DS: month stays invoiced, nothing suspended, no failure email', r.status === 'invoiced' && !(await row(u)).paygOverage?.suspended && mails(u, 'sendPaygOveragePaymentFailedEmail').length === 0, { status: r.status, invoice: invBrief(after) });
    check('exactly one action-required email carrying the hosted invoice URL', mails(u, 'sendPaygOveragePaymentActionRequiredEmail').length === 1, mails(u, 'sendPaygOveragePaymentActionRequiredEmail').map((m) => m.args[0]));
    return { u, r };
  }

  scenario('d', 'D. 3-D Secure: invoice.payment_action_required, then left unconfirmed past the grace period', async () => {
    const { u } = await threeDs('d');
    const savedScan = (userDb as any).scanWithFilter;
    (userDb as any).scanWithFilter = async () => [await row(u)]; // only this run's user, never other Dev rows
    try {
      let now = new Date(Date.now() + 8 * 86_400_000);
      while (now.getUTCDate() < 2) now = new Date(now.getTime() + 86_400_000);
      const summary = await runPaygSettlement(now);
      check('sweep 8 days later holds the unconfirmed payment', summary.outcomes.payment_unconfirmed === 1, summary);
    } finally { (userDb as any).scanWithFilter = savedScan; }
    const after = await row(u);
    check('record failed with PAYG suspended (unconfirmed)', after.paygSettlements[month].status === 'failed' && after.paygOverage?.suspended?.reason === 'payment_failed', { status: after.paygSettlements[month].status, suspended: after.paygOverage?.suspended });
    note('emails sent for this user in order', sent.filter((m) => m.args?.[0]?.to === u.email).map((m) => ({ kind: m.kind, args: m.args[0] })));
  });

  scenario('manual3ds', 'MANUAL 3DS: leave an action-required invoice for a human to confirm on the hosted page', async () => {
    const { u } = await threeDs('m3ds');
    const inv = await invoice(u);
    note('NEXT: open this URL, complete the test 3DS challenge, then run --feed ' + u.id, { hosted_invoice_url: inv.hosted_invoice_url });
    flagKeep = true;
  });

  scenario('void', 'E. Invoice voided in Stripe', async () => {
    const u = await newUser('void');
    check('settle outcome is invoiced', (await settle(u)) === 'invoiced');
    const inv = await invoice(u);
    await stripe.invoices.voidInvoice(inv.id);
    await waitFor(u, 'void handled', async () => (await rec(u))?.status === 'written_off');
    const r = await rec(u);
    check('month written off (invoice_voided), on-call alerted once, nothing suspended', r.writtenOffReason === 'invoice_voided' && mails(u, 'sendOncallAlert').length === 1 && !(await row(u)).paygOverage?.suspended, { status: r.status, reason: r.writtenOffReason });
    check('re-running settlement does not re-bill a written-off month', (await settle(u)) === 'already_recorded' && (await stripe.invoices.list({ customer: u.customer })).data.length === 1);
  });

  scenario('uncollectible', 'F. Invoice marked uncollectible, then paid', async () => {
    const u = await newUser('unc');
    check('settle outcome is invoiced', (await settle(u)) === 'invoiced');
    const inv = await invoice(u);
    await stripe.invoices.markUncollectible(inv.id);
    await waitFor(u, 'uncollectible handled', async () => Boolean((await rec(u))?.uncollectibleAt));
    const r = await rec(u);
    check('record failed + uncollectibleAt, PAYG suspended, one failed email', r.status === 'failed' && (await row(u)).paygOverage?.suspended?.reason === 'payment_failed' && mails(u, 'sendPaygOveragePaymentFailedEmail').length === 1, { status: r.status, uncollectibleAt: r.uncollectibleAt });
    await stripe.invoices.pay(inv.id);
    await waitFor(u, 'paid after uncollectible', async () => (await rec(u))?.status === 'paid');
    check('paying an uncollectible invoice records paid and lifts the suspension', (await rec(u)).status === 'paid' && !(await row(u)).paygOverage?.suspended);
  });

  async function dispute(tag: string, evidence: 'winning_evidence' | 'losing_evidence') {
    const u = await newUser(tag, { pm: 'pm_card_createDispute', clock: true });
    check('settle outcome is invoiced', (await settle(u)) === 'invoiced');
    const inv = await invoice(u);
    await advance(u, (inv.next_payment_attempt ?? u.clockTime! + 3600) + 120);
    await waitFor(u, 'dispute recorded', async () => Object.keys((await rec(u))?.disputes ?? {}).length > 0, 180_000);
    const r = await rec(u);
    const susp = (await row(u)).paygOverage?.suspended;
    check('dispute opened: recorded on the month and PAYG suspended "dispute"', Object.keys(r.disputes ?? {}).length === 1 && susp?.reason === 'dispute', { status: r.status, disputes: r.disputes, suspended: susp });
    const disputeId = Object.keys(r.disputes ?? {})[0];
    if (!disputeId) return;
    await stripe.disputes.update(disputeId, { evidence: { uncategorized_text: evidence }, submit: true });
    const closed = await waitFor(u, 'dispute closed', async () => Boolean((await rec(u))?.disputes?.[disputeId]?.closedAt), 300_000);
    const after = await row(u);
    const d = await stripe.disputes.retrieve(disputeId);
    note('Stripe dispute outcome', { status: d.status });
    if (closed) {
      const won = evidence === 'winning_evidence';
      check(won ? 'won: hold lifted' : 'lost: hold stays (dispute_lost) and month written off', won ? !after.paygOverage?.suspended : paygSuspendedReasonOf(after.paygOverage?.suspended) === 'dispute_lost' && after.paygSettlements[month].status === 'written_off',
        { suspended: after.paygOverage?.suspended ?? null, status: after.paygSettlements[month].status, writtenOffReason: after.paygSettlements[month].writtenOffReason ?? null });
    }
  }
  scenario('dispute', 'G. Dispute on the settled charge: won and lost', async () => {
    await dispute('dw', 'winning_evidence');
    await dispute('dl', 'losing_evidence');
  });

  scenario('idem', 'H. Idempotency: concurrent runs, and a month record removed by hand', async () => {
    const u = await newUser('h1');
    const outcomes = await Promise.all([settle(u), settle(u), settle(u)]);
    note('three concurrent runs for one owner-month', outcomes);
    const count = async () => (await stripe.invoices.list({ customer: u.customer, limit: 10 })).data.length;
    check('exactly one Stripe invoice and one invoice email', (await count()) === 1 && mails(u, 'sendPaygOverageInvoiceEmail').length === 1, { invoices: await count() });
    const q = `metadata['purchaseType']:'payg_overage' AND metadata['billingUserId']:'${u.id}' AND metadata['month']:'${month}'`;
    let indexed = false;
    for (let i = 0; i < 40 && !indexed; i++) { indexed = (await stripe.invoices.search({ query: q })).data.length > 0; if (!indexed) await sleep(5000); }
    note('Stripe search index caught up', indexed);
    await userDb.updateUser(u.id, {}, { pathRemoves: [{ path: ['paygSettlements', month] }] } as any);
    const rerun = await settle(u);
    note('record removed by hand, run again', rerun);
    check('still exactly one Stripe invoice after the record was removed and settlement re-ran', (await count()) === 1, { outcome: rerun });
    note('invoice emails for this owner after the manual removal (a second one is expected: the sent-flag lived on the removed record)', mails(u, 'sendPaygOverageInvoiceEmail').length);
  });

  // ---- --feed: finish a manual case ----------------------------------------------------------------------------------
  const feedId = opt('feed');
  if (feedId) {
    const user: any = await userDb.getUserByIdConsistent(feedId);
    if (!user || !String(feedId).startsWith('payg-rh-')) throw new Error('--feed needs a payg-rh-* rehearsal user in the Dev table');
    const u: U = { id: feedId, email: user.email, customer: user.stripe_customer_id, fed: new Set(), tag: 'feed' };
    scenarioName = 'feed';
    log('replaying', await pump(u, true));
    const after: any = await userDb.getUserByIdConsistent(feedId);
    note('state after replay', { settlement: Object.values(after.paygSettlements ?? {})[0], suspended: after.paygOverage?.suspended ?? null, emails: sent.map((m) => m.kind), before: (Object.values(user.paygSettlements ?? {})[0] as any)?.status });
    return;
  }

  // ---- run ---------------------------------------------------------------------------------------------------------
  try {
    for (const [id, title, fn] of scenarios) {
      if (!only.includes(id)) continue;
      scenarioName = title;
      log(`\n=== ${title}`);
      try { await fn(); } catch (e: any) { check(`scenario error: ${e?.message ?? e}`, false, e?.raw?.message ?? undefined); }
    }
  } finally {
    note('Stripe event api_version(s) seen vs pinned', { seen: [...seenApiVersions], pinned: STRIPE_API_VERSION });
    if (!flagKeep) {
      for (const c of clocks) await stripe.testHelpers.testClocks.del(c).catch(() => undefined); // deletes the clock's customers too
      for (const u of users) {
        await userDb.deleteUserById(u.id).catch(() => undefined);
        await dd.delete({ TableName: SPEND_EVENTS_TABLE, Key: { billingUserId: u.id, eventId: `rehearsal-${RUN}-${u.tag}` } }).promise().catch(() => undefined);
        await dd.delete({ TableName: SPEND_PROJECTION_TABLE, Key: { billingUserId: u.id, billingMonth: month } }).promise().catch(() => undefined);
      }
      log('cleaned up test clocks, Dev users, spend events and projections (Stripe invoices and AW-PaymentHistory rows remain, test mode)');
    } else {
      log('KEPT (--keep or manual case):', users.map((u) => u.id));
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.filter((r) => r.ok && !r.check.startsWith('NOTE')).length} passed, ${failed.length} failed`);
  failed.forEach((f) => console.log('FAILED:', f.scenario, '|', f.check, JSON.stringify(f.evidence)));
  const out = opt('out');
  if (out) require('fs').writeFileSync(out, JSON.stringify({ run: RUN, month, results, emails: sent.map((m) => ({ kind: m.kind, at: m.at })) }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error('ABORTED:', e?.message ?? e); process.exitCode = 2; }).then(() => setTimeout(() => process.exit(process.exitCode ?? 0), 500));
