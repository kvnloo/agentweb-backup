/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ENG-3130 / ENG-3131: pre-launch rehearsal of the Zoma plan ($1 7-day trial -> $50/month, 5,000 calls included,
 * 1 cent overage, day-3 reminder) against REAL Stripe TEST mode and Stripe test clocks. It runs the production
 * code in `mcp/zomaBilling.ts` unchanged. Nothing here touches live Stripe, production data or any Dev table.
 *
 *   cd backend
 *   NODE_ENV=development npx ts-node --transpile-only src/scripts/zomaBillingRehearsal.ts [--keep] [--out file.json] [--checkout-url-file path]
 *
 * Credentials: STRIPE_SECRET_KEY in the environment (an `sk_test_` / `rk_test_` key), or, when unset, the app's own
 * loader (`dev/AgentWeb/Stripe` in Secrets Manager). A key that is not a test key aborts the run before any Stripe
 * call. STRIPE_API_BASE must be unset.
 *
 * What is real: the Stripe account (test mode), test clocks, a billing meter, the product and three prices the run
 * creates for itself (and deactivates at the end), hosted Checkout, Stripe Search, the `stripe` SDK, and every
 * function in zomaBilling.ts. Webhook events are PULLED from Stripe and replayed, signed locally, through the
 * production webhook controller (no public endpoint or Stripe CLI needed).
 *
 * The agent's path is real too: section 2b and the later gateway checks call `handleMetaToolkitCall` (the same entry the MCP
 * route uses) with an `UPDATE status=ACTIVE` write, so the paywall, the success-only metering and the failure audit run in
 * the real gateway against real Stripe. Section 10 cancels the plan and checks the returning-user Checkout (no trial, no $1).
 *
 * What is not real: the funnel rows go to an in-memory store (same conditional-write semantics as the table), the
 * day-3 email is captured and printed instead of sent, ad performance is a fixed string, the Meta write itself is a fake
 * (there is no Meta account here), journey milestones are stubbed, and there is no AgentWeb user.
 *
 * ONE STEP IS MANUAL: hosted Checkout cannot be completed through the API. The script prints the Checkout URL (and
 * writes it to --checkout-url-file); open it and pay with test card 4242 4242 4242 4242, any future expiry, any CVC.
 * The script waits up to 20 minutes for that.
 *
 * Checks marked NOTE record behaviour that was UNKNOWN before the run (for example whether meter events work on a
 * test clock); they never fail the run but are the point of the exercise: write them into the brain.
 */
import crypto from 'crypto';
import fs from 'fs';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

const RUN = crypto.randomBytes(3).toString('hex');
const DAY_S = 24 * 60 * 60;
const results: Array<{ check: string; ok: boolean; evidence: unknown }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
function check(label: string, ok: boolean, evidence?: unknown) {
  results.push({ check: label, ok, evidence: evidence ?? null });
  log(ok ? '  PASS' : '  FAIL', label, evidence === undefined ? '' : JSON.stringify(evidence));
}
function note(label: string, evidence: unknown) {
  results.push({ check: `NOTE ${label}`, ok: true, evidence });
  log('  NOTE', label, JSON.stringify(evidence));
}

async function main() {
  // ---- hard guards, before anything is imported or any network call is made --------------------------------
  if (process.env.NODE_ENV !== 'development') throw new Error(`Refusing to run: NODE_ENV must be "development" (found: ${String(process.env.NODE_ENV)}).`);
  if (process.env.STRIPE_API_BASE) throw new Error('Refusing to run: STRIPE_API_BASE is set; this rehearsal needs real Stripe test mode.');
  if (!process.env.STRIPE_SECRET_KEY) {
    log('STRIPE_SECRET_KEY not set; loading the Dev Stripe credentials with the app loader (dev/AgentWeb/Stripe)');
    const { getStripeCredentials } = await import('../utils/secretsManager');
    await getStripeCredentials();
  }
  const key = process.env.STRIPE_SECRET_KEY as string;
  if (!/^(sk|rk)_test_/.test(key)) throw new Error('Refusing to run: the Stripe key is not a TEST-mode key (must start with sk_test_ or rk_test_).');
  process.env.STRIPE_WEBHOOK_SECRET = `whsec_rehearsal_${RUN}`;
  process.env.BACKEND_URL = 'https://example.com'; // Checkout return pages are not served by this run
  process.env.JWT_SECRET ||= `rehearsal-${RUN}-${crypto.randomBytes(16).toString('hex')}`; // signs the cancel redirect; this run only

  const { createStripeClient, STRIPE_API_VERSION } = await import('../services/stripeClientFactory');
  const stripe = createStripeClient(key);
  const balance = await stripe.balance.retrieve();
  if ((balance as any).livemode !== false) throw new Error('Refusing to run: Stripe reports livemode.');
  const account = await stripe.accounts.retrieve();
  log(`Stripe TEST account ${account.id}; pinned API version ${STRIPE_API_VERSION}; run ${RUN}`);

  const cleanup: Array<() => Promise<unknown>> = [];
  const startedAt = Math.floor(Date.now() / 1000) - 60;
  const userId = `zoma-rh-${RUN}`;
  const email = `zoma-rehearsal+${RUN}@example.invalid`;
  const INCLUDED = 3; // graduated tier boundary used for this run, so the overage is cheap to reach

  try {
    // ---- Stripe objects the plan needs (test mode, tagged with this run) --------------------------------------
    const eventName = `zoma_rh_${RUN}`;
    const meter: any = await (stripe as any).billing.meters.create({
      display_name: `Zoma rehearsal ${RUN}`, event_name: eventName,
      default_aggregation: { formula: 'sum' },
      customer_mapping: { event_payload_key: 'stripe_customer_id', type: 'by_id' },
      value_settings: { event_payload_key: 'value' },
    });
    cleanup.push(() => (stripe as any).billing.meters.deactivate(meter.id));
    const product = await stripe.products.create({ name: `Zoma rehearsal ${RUN}`, metadata: { rehearsal: RUN } });
    cleanup.push(() => stripe.products.update(product.id, { active: false }));
    const planPrice = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 5000, recurring: { interval: 'month' } });
    const overagePrice = await stripe.prices.create({
      product: product.id, currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated',
      tiers: [{ up_to: INCLUDED, unit_amount: 0 }, { up_to: 'inf', unit_amount: 1 }],
      recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
    } as any);
    const feePrice = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 100 });
    for (const p of [planPrice, overagePrice, feePrice]) cleanup.push(() => stripe.prices.update(p.id, { active: false }));
    Object.assign(process.env, {
      ZOMA_BILLING_ENABLED: 'true', ZOMA_STRIPE_PLAN_PRICE_ID: planPrice.id, ZOMA_STRIPE_OVERAGE_PRICE_ID: overagePrice.id,
      ZOMA_STRIPE_TRIAL_FEE_PRICE_ID: feePrice.id, ZOMA_STRIPE_METER_EVENT_NAME: eventName, ZOMA_PLAN_INCLUDED_CALLS: String(INCLUDED),
    });

    const billing = await import('../mcp/zomaBilling');
    const { recordZomaBillingFunnel } = await import('../services/mcpUsageEventsService');

    // ---- in-process fakes: funnel store, captured email, fixed ad summary, no AgentWeb user ---------------------
    const rows: any[] = [];
    const keys = new Set<string>();
    const store: any = {
      async put(item: any, options?: { condition?: string }) {
        if (options?.condition === 'attribute_not_exists' && keys.has(item.tsSession)) throw Object.assign(new Error('exists'), { code: 'ConditionalCheckFailedException' });
        keys.add(item.tsSession); rows.push(item);
      },
      async queryByLoopId() { return rows; },
    };
    const steps = () => rows.map((r) => r.dimensions?.step as string);
    const mails: Array<{ to: string; subject: string; text: string }> = [];
    let clockMs = 0;
    const sleepUntilFound = async <T>(what: string, fn: () => Promise<T | null | undefined>, ms = 150_000): Promise<T | null> => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn();
        if (v) { note(`${what} took`, { seconds: Math.round((Date.now() - t0) / 1000) }); return v; }
        if (Date.now() - t0 > ms) { check(`${what} (timed out)`, false); return null; }
        await sleep(5000);
      }
    };
    const deps: any = {
      ...billing.defaultZomaBillingDeps,
      getUser: async () => ({ userId, email }),
      recordFunnel: (input: any) => recordZomaBillingFunnel(input, store),
      getUsage: async () => ({ start: '', end: '', toolCalls: 42, writes: { total: 3, confirmed: 3, mismatch: 0, unconfirmed: 0 }, recentWrites: [] }),
      getAdsSummary: async () => '$120.00 spent, 3,400 impressions, 85 clicks (rehearsal fixture)',
      sendEmail: async (to: string, subject: string, text: string) => { mails.push({ to, subject, text }); return 'sent'; },
    };
    const clockDeps = () => ({ ...deps, now: () => clockMs });

    // ---- the real toolkit gateway, with a fake Meta write and in-memory usage/failure rows -----------------------
    const journey: any = await import('../services/journeyMilestones');
    journey.noteProductUse = async () => undefined; // would write the (non-existent) user row in the Dev tables
    journey.zomaMilestone = async () => undefined;
    const { handleMetaToolkitCall } = await import('../mcp/metaToolkitGateway');
    const counts = { write: 0, usage: 0, failure: 0 };
    let writeResult: any = { success: true, verification: 'CONFIRMED', id: '5' };
    const metaAccount = { platform: 'meta', account_id: '111', config: { account_type: 'ad_account', ad_account_id: '111', access_token: 'rehearsal' } } as any;
    const gwDeps: any = {
      validateApiKey: async () => ({ userId, keyId: 'rehearsal-key' }),
      validateOAuthToken: async () => null,
      listAccounts: async () => [metaAccount],
      execute: async () => ({ data: [] }),
      executeWrite: async () => { counts.write += 1; return writeResult; },
      recordUsage: async () => { counts.usage += 1; return true; },
      recordFailure: async () => { counts.failure += 1; return true; },
      recordWrite: async () => true,
      now: () => Date.now(),
      reportBillableCall: (uid: string, id: string) => billing.reportZomaBillableCall(uid, id, deps),
      assertPublishAllowed: (uid: string, ctx: any) => billing.assertZomaPublishAllowed(uid, ctx, deps),
    };
    const gw = (params: Record<string, unknown>, action = 'UPDATE') => handleMetaToolkitCall(
      { authorization: 'Bearer aw_rehearsal', toolName: 'call_meta_marketing_api', args: { entity_type: 'CAMPAIGN', action, campaign_id: '5', params } }, gwDeps);

    // ---- customer on a test clock (the code never creates clocks; this is how the acceptance run does it) -----
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000), name: `zoma-rehearsal-${RUN}` });
    cleanup.push(() => stripe.testHelpers.testClocks.del(clock.id));
    const customer = await stripe.customers.create({ test_clock: clock.id, metadata: { zomaBillingUserId: userId, product: 'zoma_plan' } });
    const advance = async (toEpoch: number) => {
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: Math.floor(toEpoch) });
      for (let i = 0; i < 80; i++) {
        const c = await stripe.testHelpers.testClocks.retrieve(clock.id);
        if (c.status === 'ready') { clockMs = c.frozen_time * 1000; return; }
        await sleep(3000);
      }
      throw new Error('test clock did not become ready');
    };
    clockMs = clock.frozen_time * 1000;

    log('\n=== 1. Stripe Search finds a test-clock customer by metadata (UNKNOWN before this run)');
    const found = await sleepUntilFound('findCustomerId', () => billing.defaultZomaBillingDeps.findCustomerId(userId));
    check('findCustomerId returns the clock customer', found === customer.id, { found, expected: customer.id });
    if (!found) throw new Error('Stripe Search did not return the clock customer; cannot continue');
    // Search is eventually consistent and not monotonic: one hit does not mean the next call hits too. A miss here would
    // make the code create a second (non-clock) customer, which only happens in this harness because the clock customer
    // is made outside the code's idempotent createCustomer. Wait for several consecutive hits before going on.
    let streak = 0;
    for (let i = 0; i < 60 && streak < 4; i++) {
      streak = (await billing.defaultZomaBillingDeps.findCustomerId(userId)) === customer.id ? streak + 1 : 0;
      if (streak < 4) await sleep(5000);
    }
    check('Stripe Search returned the clock customer on 4 consecutive calls (harness precondition)', streak >= 4, { streak });
    if (streak < 4) throw new Error('Stripe Search stayed inconsistent; stopping so the run does not split the customer');

    log('\n=== 2. Paywall before any plan');
    const refusal: any = await billing.assertZomaPublishAllowed(userId, { platform: 'meta', toolName: 'rehearsal' }, deps).catch((e: any) => e);
    check('go-live is refused with a pay link', refusal instanceof billing.ZomaPaywallError && /\/api\/zoma\/billing\/checkout\/cs_/.test(refusal.link ?? ''), { link: refusal.link });
    check('refusal copy states the trial and the automatic charge', /\$1 7-day trial/.test(refusal.message) && /charged \$50\/month automatically/.test(refusal.message));
    const again: any = await billing.assertZomaPublishAllowed(userId, { platform: 'meta' }, deps).catch((e: any) => e);
    check('asking again returns the SAME link (open session reused, one Checkout)', again.link === refusal.link, { first: refusal.link, second: again.link });
    const summary = await billing.getZomaPlanSummary(userId, deps);
    check('zoma_status shows the same link and is not publish-enabled', summary?.link === refusal.link && summary?.publish_enabled === false);
    const sessionId = String(refusal.link).split('/').pop() as string;
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
    check('the Checkout belongs to the test-clock customer (one customer for the user)', session.customer === customer.id, { sessionCustomer: session.customer, clockCustomer: customer.id });
    check('Checkout is USD-only (adaptive pricing off, no converted amount)', (session as any).adaptive_pricing?.enabled === false && session.currency === 'usd', { adaptive_pricing: (session as any).adaptive_pricing, currency: session.currency });
    check('Checkout is subscription mode with plan + metered overage + $1 fee, 7-day trial',
      session.mode === 'subscription' && session.line_items?.data.length === 3, { mode: session.mode, items: session.line_items?.data.map((l) => `${l.price?.id === feePrice.id ? 'fee' : l.price?.id === planPrice.id ? 'plan' : 'overage'}:${l.amount_total}`) });
    const opened = await billing.openZomaCheckout(sessionId, deps);
    check('our pay link redirects to the hosted Stripe page and records checkout_started', opened.kind === 'redirect' && steps().includes('checkout_started'));
    check('paywall_shown recorded once per surface per hour', steps().filter((s) => s === 'paywall_shown').length === 2, { steps: steps() });

    log('\n=== 2b. The agent path through the real gateway, before paying');
    const gwRefusal: any = await gw({ status: 'ACTIVE' }).then(() => null, (e: any) => e);
    check('agent sets the campaign ACTIVE: refused with the same pay link, nothing sent to Meta, nothing metered',
      Boolean(gwRefusal) && String(gwRefusal.message).includes(refusal.link) && counts.write === 0 && counts.usage === 0, { message: String(gwRefusal?.message).slice(0, 160), counts });
    await gw({ name: 'draft rename' });
    check('an edit (not a go-live) goes through and is metered', counts.write === 1 && counts.usage === 1, counts);
    await handleMetaToolkitCall({ authorization: 'Bearer aw_rehearsal', toolName: 'get_campaigns', args: {} }, gwDeps);
    check('a read goes through and is metered', counts.usage === 2, counts);
    writeResult = { success: false, error: 'Meta said no' };
    await gw({ name: 'rejected edit' });
    check('a write Meta rejects in-band is not metered but leaves one failure audit row', counts.usage === 2 && counts.failure === 1, counts);
    writeResult = { success: true, verification: 'CONFIRMED', id: '5' };

    log('\n=== 3. MANUAL: pay the $1 trial on the hosted Checkout page');
    const url = (opened as any).url as string;
    if (opt('checkout-url-file')) fs.writeFileSync(opt('checkout-url-file') as string, url);
    console.log(`\n  Open this URL, pay with 4242 4242 4242 4242 (any future expiry, any CVC):\n  ${url}\n`);
    const t0 = Date.now();
    for (;;) {
      const s = await stripe.checkout.sessions.retrieve(sessionId);
      if (s.status === 'complete') break;
      if (Date.now() - t0 > 20 * 60 * 1000) throw new Error('Checkout was not completed within 20 minutes');
      await sleep(5000);
    }
    log('  Checkout completed');

    log('\n=== 4. After paying');
    let state: any = null;
    await sleepUntilFound('trialing plan state', async () => {
      state = await billing.getZomaPlanState(userId, deps);
      return state.status === 'trialing' ? state : null;
    });
    check('subscription is trialing and the $1 invoice is paid', state?.status === 'trialing' && state?.latestInvoicePaid === true, state);
    const sub = (await stripe.subscriptions.list({ customer: customer.id, status: 'all', expand: ['data.latest_invoice'] })).data[0] as any;
    check('the $1 one-time line was charged while the subscription is trialing (UNPROVEN until now)', sub?.latest_invoice?.amount_paid === 100, { amount_paid: sub?.latest_invoice?.amount_paid, total: sub?.latest_invoice?.total, status: sub?.latest_invoice?.status });
    check('trial is 7 days', sub && Math.round((sub.trial_end - sub.trial_start) / DAY_S) === 7, { days: sub && (sub.trial_end - sub.trial_start) / DAY_S });
    check('subscription and session carry metadata.product=zoma_plan and the user id', sub?.metadata?.product === 'zoma_plan' && sub?.metadata?.userId === userId, sub?.metadata);
    check('publishing is now allowed', await billing.assertZomaPublishAllowed(userId, { platform: 'meta' }, deps).then(() => true, () => false));
    const writesBefore = counts.write;
    const live: any = await gw({ status: 'ACTIVE' }).then((r: any) => r, (e: any) => e);
    check('agent retries the ACTIVE write through the gateway: it now goes to Meta and succeeds', counts.write === writesBefore + 1 && live?.success === true, { counts, result: live?.message ?? live?.success });
    check('the old pay link is gone (no second plan can be bought)', (await billing.openZomaCheckout(sessionId, deps)).kind === 'gone');
    const line = billing.formatZomaPlanLine((await billing.getZomaPlanSummary(userId, deps))!, deps.config());
    check('zoma_status shows the trial', /\[x\] Zoma plan: trial until \d{4}-\d{2}-\d{2}, then \$50\/month/.test(line), { line });

    log('\n=== 5. Meter events during the trial');
    let sent = 0;
    for (let i = 0; i < 2; i++) {
      await billing.reportZomaBillableCall(userId, `rh-${RUN}-trial-${i}`, deps).then(() => { sent += 1; }, (e: any) => note('meter event rejected (trial, real time)', e?.raw?.message ?? e?.message));
    }
    check('meter events with real timestamps are accepted for the clock customer', sent === 2, { sent });

    log('\n=== 6. Day 3 reminder (clock time injected; the deployed job uses wall-clock time)');
    const trialStart = sub.trial_start as number;
    await advance(trialStart + 3 * DAY_S + 3600);
    note('clock now', new Date(clockMs).toISOString());
    const dueFound = await sleepUntilFound('Stripe Search lists the trialing clock subscription', async () => (await billing.defaultZomaBillingDeps.searchTrialingSubscriptions()).find((s) => s.id === sub.id));
    check('searchTrialingSubscriptions finds a clock subscription', Boolean(dueFound));
    const reminderDeps = clockDeps();
    const [r1, r2] = await Promise.all([billing.runZomaTrialReminders(reminderDeps), billing.runZomaTrialReminders(reminderDeps)]);
    check('two concurrent passes send exactly one email (hourly claim)', mails.length === 1, { r1, r2, mails: mails.length });
    const mail = mails[0];
    check('email subject and plan terms', Boolean(mail) && /^Your Zoma trial ends on \d{4}-\d{2}-\d{2}$/.test(mail.subject) && /\$50\/month with 3 calls included/.test(mail.text), { subject: mail?.subject });
    check('email carries the ad performance summary', Boolean(mail) && mail.text.includes('How your ads are doing: $120.00 spent'));
    console.log('\n--- captured email ---\n' + (mail ? `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}` : '(none)') + '\n----------------------\n');
    const marked = (await stripe.subscriptions.retrieve(sub.id)).metadata?.[billing.TRIAL_REMINDER_METADATA_KEY];
    check('the sent marker is on the subscription', Boolean(marked), { marked });
    const r3 = await billing.runZomaTrialReminders(reminderDeps);
    check('a later pass sends nothing more', r3.sent === 0 && mails.length === 1, r3);
    check('funnel has claimed + sent', steps().includes('trial_reminder_claimed') && steps().includes('trial_reminder_sent'), { steps: steps() });

    log('\n=== 7. Day 7: conversion to the $50 plan');
    await advance((sub.trial_end as number) + 300);
    const converted: any = (await stripe.subscriptions.list({ customer: customer.id, status: 'all', expand: ['data.latest_invoice'] })).data[0];
    check('subscription is active after the trial', converted.status === 'active', { status: converted.status });
    note('renewal invoice 5 minutes after conversion', { status: converted.latest_invoice?.status, total: converted.latest_invoice?.total, amount_due: converted.latest_invoice?.amount_due });
    const allowedDuringDraft = await billing.assertZomaPublishAllowed(userId, { platform: 'meta' }, deps).then(() => true, (e: any) => e.message);
    check('publishing still works while the renewal invoice is not yet paid (active plan)', allowedDuringDraft === true, { invoiceStatus: converted.latest_invoice?.status, allowedDuringDraft });
    await advance((sub.trial_end as number) + 2 * 3600);
    const afterHours: any = (await stripe.subscriptions.list({ customer: customer.id, status: 'all', expand: ['data.latest_invoice'] })).data[0];
    check('the first $50 invoice is paid within a couple of hours', afterHours.latest_invoice?.status === 'paid' && afterHours.latest_invoice?.amount_paid === 5000, { status: afterHours.latest_invoice?.status, amount_paid: afterHours.latest_invoice?.amount_paid });

    log('\n=== 8. Overage on a clock (UNKNOWN: meter-event timestamps on a test clock)');
    let acceptedClockTime = 0;
    const periodStart = afterHours.items.data[0].current_period_start as number;
    for (let i = 0; i < 5; i++) {
      await billing.reportZomaBillableCall(userId, `rh-${RUN}-paid-${i}`, clockDeps()).then(() => { acceptedClockTime += 1; }, (e: any) => { if (i === 0) note('meter event with a CLOCK timestamp rejected', e?.raw?.message ?? e?.message); });
    }
    note('meter events accepted with the clock timestamp (in the paid period)', { accepted: acceptedClockTime, of: 5, periodStart: new Date(periodStart * 1000).toISOString() });
    await advance((afterHours.items.data[0].current_period_end as number) + 2 * 3600);
    const invoices = (await stripe.invoices.list({ customer: customer.id, limit: 10 })).data;
    const usageLines = invoices.flatMap((i) => i.lines.data).filter((l: any) => l.pricing?.price_details?.price === overagePrice.id || (l as any).price?.id === overagePrice.id);
    note('invoice lines for the metered price', usageLines.map((l: any) => ({ quantity: l.quantity, amount: l.amount, description: l.description })));
    if (acceptedClockTime === 5) {
      const billed = usageLines.reduce((s: number, l: any) => s + (l.amount ?? 0), 0);
      check('5 calls with 3 included bill 2 overage calls at 1 cent (2 cents)', billed === 2, { billedCents: billed });
    } else {
      note('overage billing could not be exercised on this clock', { accepted: acceptedClockTime });
    }

    log('\n=== 9. Webhook events pulled from Stripe, replayed through the production controller');
    const { handleWebhook } = await import('../controllers/stripeController');
    process.env.ZOMA_REFERRAL_ENABLED = 'false'; // replay must never write the real referral ledger (ENG-3132)
    const types = ['checkout.session.completed', 'checkout.session.expired', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.created', 'invoice.finalized', 'invoice.paid', 'invoice.payment_succeeded'];
    const events = (await stripe.events.list({ types, created: { gte: startedAt }, limit: 100 } as any).autoPagingToArray({ limit: 500 }))
      .filter((e: any) => e.data.object.customer === customer.id).reverse();
    note('events replayed', { count: events.length, types: [...new Set(events.map((e: any) => e.type))] });
    const unclaimed: string[] = [];
    for (const e of events as any[]) {
      const claimed = await billing.handleZomaBillingWebhookEvent(e, { recordFunnel: deps.recordFunnel });
      if (!claimed) { unclaimed.push(`${e.type}:${e.id}`); continue; } // would reach Emma handlers: report, never deliver
      const payload = Buffer.from(JSON.stringify(e));
      const header = stripe.webhooks.generateTestHeaderString({ payload: payload.toString(), secret: process.env.STRIPE_WEBHOOK_SECRET as string });
      let code = 0;
      const res: any = { status(c: number) { code = c; return this; }, json() { if (!code) code = 200; return this; } };
      await handleWebhook({ body: payload, headers: { 'stripe-signature': header } } as any, res);
      if (code !== 200) check(`webhook ${e.type} answered 200`, false, { code });
    }
    check('every Zoma plan event (session, subscription, invoice) is claimed before the Emma handlers', unclaimed.length === 0, { unclaimed });
    check('funnel recorded paid and trial_converted', steps().includes('paid') && steps().includes('trial_converted'), { steps: steps() });
    note('api_version of events vs pinned', { seen: [...new Set(events.map((e: any) => e.api_version))], pinned: STRIPE_API_VERSION });

    log('\n=== 10. Returning user: the plan was cancelled, so the next go-live buys the plan itself (no trial, no $1)');
    await stripe.subscriptions.cancel(sub.id);
    let returning: any = null;
    await sleepUntilFound('cancelled plan state', async () => {
      const st = await billing.getZomaPlanState(userId, deps);
      return st.status === 'canceled' && st.hadPlan ? st : null;
    });
    const gwReturning: any = await gw({ status: 'ACTIVE' }).then(() => null, (e: any) => e);
    returning = gwReturning;
    check('after cancelling, the go-live refusal sells the plan, charged today, with no trial wording',
      Boolean(returning) && /\$50\/month, charged today/.test(returning.message) && !/trial/i.test(returning.message), { message: String(returning?.message).slice(0, 200) });
    const retLink = String(returning?.message).match(/https:\/\/\S*\/api\/zoma\/billing\/checkout\/(cs_[A-Za-z0-9_]+)/);
    const retSession = retLink ? await stripe.checkout.sessions.retrieve(retLink[1], { expand: ['line_items'] }) : null;
    check('the returning Checkout has the plan and metered price only, no $1 fee line, $50 due today, USD-only',
      Boolean(retSession) && retSession!.line_items?.data.length === 2 && retSession!.amount_total === 5000 && retSession!.currency === 'usd' && (retSession as any).adaptive_pricing?.enabled === false,
      { items: retSession?.line_items?.data.length, amount_total: retSession?.amount_total, currency: retSession?.currency });
    const retLine = billing.formatZomaPlanLine((await billing.getZomaPlanSummary(userId, deps))!, deps.config());
    check('zoma_status offers the plan, not a trial', /\$50\/month → https:/.test(retLine) && !/trial/i.test(retLine), { line: retLine.slice(0, 120) });
  } finally {
    if (flag('keep')) {
      log('KEPT (--keep): Stripe test clock, meter, product and prices of run', RUN);
    } else {
      for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
      log('cleaned up: test clock (and its customer/subscription), meter deactivated, product and prices deactivated (test mode invoices remain)');
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.filter((r) => r.ok && !r.check.startsWith('NOTE')).length} passed, ${failed.length} failed`);
  failed.forEach((f) => console.log('FAILED:', f.check, JSON.stringify(f.evidence)));
  if (opt('out')) fs.writeFileSync(opt('out') as string, JSON.stringify({ run: RUN, results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('rehearsal aborted:', e?.raw?.message ?? e?.message ?? e); process.exit(2); });
