// ENG-2720: the pre-run quote service (routes/crm.ts glue lives behind QuoteDeps). These cover the wiring the
// route used to hide: lead/email counting, subset handling, config-driven scaling, Enigma gating, the customer-safe
// view, and that the enrich-time price and the quote can never disagree.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.mock('../modelRoles', () => ({ resolveModelForUser: jest.fn() }));
jest.mock('../tokenUsageService', () => ({ checkTokenUsage: jest.fn(), TURN_ADMISSION: { recordAdmission: true } }));

import { checkTokenUsage } from '../tokenUsageService';
import { resolveModelForUser } from '../modelRoles';
import { inspectLeads, priceEnrichment, quoteEnrichment, quoteFromPriced, type QuoteDeps } from '../enrichmentQuote';
import { admissionEstimateMicroUsd } from '../enrichmentBatchBudget';
import type { EnrichmentConfig } from '../crmEnrichmentServiceV3';

const check = checkTokenUsage as jest.Mock;
const LUNA = 'openrouter/openai/gpt-5.6-luna';

const field = (name: string, over: Record<string, unknown> = {}) => ({
  name, type: 'string' as const, instruction: '', include: true, overwritePolicy: 'fill_if_empty' as const, ...over,
});
const cfg = (...names: string[]): EnrichmentConfig => ({
  fields: names.map(n => field(n)), globalOverwriteDefault: 'fill_if_empty', schemaVersion: 1, updatedAt: '', updatedBy: '',
});
// The first field is the email column (most saved configs request it), so an emailless lead can reach the Apollo broker.
const sizedCfg = (n: number) => cfg(...Array.from({ length: n }, (_, i) => (i === 0 ? 'email' : `f${i}`)));

/** Fake lead store: pages of 200, `email` per lead. */
function deps(emails: Array<string | undefined>, config?: EnrichmentConfig, hasUsable = (e: unknown) => typeof e === 'string' && e.includes('@') && !e.endsWith('@example.com')): QuoteDeps & { pages: number } {
  const state = { pages: 0 };
  const d: QuoteDeps & { readonly pages: number } = {
    getLeadsPage: async (_l: string, limit: number, lastKey?: unknown) => {
      state.pages++;
      const start = typeof lastKey === 'number' ? lastKey : 0;
      // Leads have a name and company by default, so an emailless lead can be sent to the Apollo broker.
      const items = emails.slice(start, start + limit).map((email, i) => ({ leadId: `l${start + i}`, email, firstName: 'Ada', lastName: 'Lovelace', company: 'Acme' }));
      return { items, lastEvaluatedKey: start + limit < emails.length ? start + limit : undefined };
    },
    getSavedConfig: async () => config,
    hasUsableEmail: hasUsable,
    get pages() { return state.pages; },
  };
  return d;
}

beforeEach(() => {
  check.mockReset().mockResolvedValue({ allowed: true, month: '2026-11', costAllowance: 150, costUsed: 5 });
  (resolveModelForUser as jest.Mock).mockReset().mockResolvedValue(LUNA);
  delete process.env.ENIGMA_ENRICHMENT_ENABLED;
  delete process.env.ENIGMA_ENRICHMENT_USER_ALLOWLIST;
});

describe('inspectLeads', () => {
  it('pages through the whole list and counts leads without a usable email', async () => {
    const emails = Array.from({ length: 450 }, (_, i) => (i % 3 === 0 ? `a${i}@acme.com` : i % 3 === 1 ? '' : 'junk@example.com'));
    const d = deps(emails);
    expect(await inspectLeads(d, 'l')).toEqual({ count: 450, emailless: 300, brokerEligible: 300, skipped: 0 });
    expect(d.pages).toBe(3);
  });

  it('counts a selected subset only for ids that belong to the list, with their real email state', async () => {
    const d = deps(['a@acme.com', '', 'junk@example.com', 'b@acme.com']);
    // l0 has an email, l1 none, l2 placeholder; l99 and "x" do not exist; l1 is repeated
    expect(await inspectLeads(d, 'l', ['l0', 'l1', 'l2', 'l1', 'l99', 'x'])).toEqual({ count: 3, emailless: 2, brokerEligible: 2, skipped: 0 });
    expect(d.pages).toBe(1);
  });

  it('fake ids cannot amplify the count (they match nothing), so the quote cannot be scaled to resolve the rate', async () => {
    const fake = Array.from({ length: 100_000 }, (_, i) => `fake-${i}`);
    expect(await inspectLeads(deps(['a@acme.com', '']), 'l', fake)).toEqual({ count: 0, emailless: 0, brokerEligible: 0, skipped: 0 });
  });

  it('stops scanning once every requested id has been found (a small subset does not read the whole list)', async () => {
    const d = deps(Array(1000).fill(''));
    expect(await inspectLeads(d, 'l', ['l0', 'l1'])).toEqual({ count: 2, emailless: 2, brokerEligible: 2, skipped: 0 });
    expect(d.pages).toBe(1); // 1000 leads = 5 pages, the ids are on the first
    const far = deps(Array(1000).fill(''));
    expect(await inspectLeads(far, 'l', ['l999'])).toEqual({ count: 1, emailless: 1, brokerEligible: 1, skipped: 0 });
    expect(far.pages).toBe(5);
  });

  it('still scans the whole list when a requested id does not exist (bounded by the list)', async () => {
    const d = deps(Array(1000).fill(''));
    expect(await inspectLeads(d, 'l', ['l0', 'nope'])).toEqual({ count: 1, emailless: 1, brokerEligible: 1, skipped: 0 });
    expect(d.pages).toBe(5);
  });

  it('ignores non-string lead ids on the page', async () => {
    const d = deps(['']);
    d.getLeadsPage = async () => ({ items: [{ leadId: 5 as unknown as string, email: '' }, { email: '' }] });
    expect(await inspectLeads(d, 'l', ['5', 'undefined'])).toEqual({ count: 0, emailless: 0, brokerEligible: 0, skipped: 0 });
  });

  it('handles an empty list', async () => {
    expect(await inspectLeads(deps([]), 'l')).toEqual({ count: 0, emailless: 0, brokerEligible: 0, skipped: 0 });
  });
});

describe('priceEnrichment', () => {
  const price = async (d: QuoteDeps, over: Record<string, unknown> = {}) => (await priceEnrichment(d, { userId: 'u1', listId: 'l', ...over })).estimate;

  it('quotes less Apollo when leads already have an email, and none when all do', async () => {
    const none = await price(deps(Array(20).fill('x@acme.com')));
    const half = await price(deps([...Array(10).fill('x@acme.com'), ...Array(10).fill('')]));
    const all = await price(deps(Array(20).fill('')));
    expect(none.breakdownUsd.apollo).toBe(0);
    expect(half.breakdownUsd.apollo).toBeCloseTo(all.breakdownUsd.apollo / 2, 1);
    expect(all.breakdownUsd.apollo).toBeGreaterThan(0);
  });

  it('scales the LLM line with the saved config and uses the reference config when none is saved', async () => {
    const emails = Array(20).fill('x@acme.com');
    const none = await price(deps(emails, undefined));
    const ten = await price(deps(emails, sizedCfg(10)));
    const forty = await price(deps(emails, sizedCfg(40)));
    expect(ten.totalUsd).toBe(none.totalUsd);
    expect(forty.breakdownUsd.llm).toBeCloseTo(ten.breakdownUsd.llm * 4, 1);
  });

  it('is model-aware: an org on a premium model is quoted more', async () => {
    const emails = Array(20).fill('x@acme.com');
    const luna = await price(deps(emails, sizedCfg(10)));
    (resolveModelForUser as jest.Mock).mockResolvedValue('gpt-5.5');
    const premium = await price(deps(emails, sizedCfg(10)));
    expect(premium.breakdownUsd.llm).toBeGreaterThan(luna.breakdownUsd.llm * 3);
  });

  it('adds the Enigma fetch only for an allowlisted user who asked for a card-revenue field', async () => {
    const emails = Array(10).fill('x@acme.com');
    const withField = cfg('Industry', 'card_revenue_12m');
    const baseline = (await price(deps(emails, cfg('Industry', 'Employees')))).totalUsd;
    expect((await price(deps(emails, withField))).totalUsd).toBe(baseline); // not allowlisted: cannot be bought
    process.env.ENIGMA_ENRICHMENT_ENABLED = 'true';
    process.env.ENIGMA_ENRICHMENT_USER_ALLOWLIST = 'u1';
    expect((await price(deps(emails, withField))).totalUsd).toBeCloseTo(baseline + 10 * 0.28, 1);
    expect((await price(deps(emails, cfg('Industry', 'Employees')))).totalUsd).toBe(baseline); // allowlisted but no card field
  });

  it('produces the same token for the same inputs and a different one per user, list or lead count', async () => {
    const d = () => deps(Array(5).fill(''), sizedCfg(10));
    const a = (await price(d())).confirmationToken;
    expect((await price(d())).confirmationToken).toBe(a);
    expect((await priceEnrichment(d(), { userId: 'u2', listId: 'l' })).estimate.confirmationToken).not.toBe(a);
    expect((await priceEnrichment(d(), { userId: 'u1', listId: 'other' })).estimate.confirmationToken).not.toBe(a);
    expect((await priceEnrichment(deps(Array(6).fill(''), sizedCfg(10)), { userId: 'u1', listId: 'l' })).estimate.confirmationToken).not.toBe(a);
  });

  it('uses the reference config when no config is saved', async () => {
    const d = deps(Array(5).fill(''));
    d.getSavedConfig = async () => undefined;
    expect((await price(d)).leadCount).toBe(5);
  });

  it('does NOT fall back when a saved config cannot be read: the error surfaces and no price or token is produced', async () => {
    const d = deps(Array(5).fill(''), sizedCfg(10));
    d.getSavedConfig = async () => { throw new Error("Cannot read properties of undefined (reading 'filter')"); };
    await expect(priceEnrichment(d, { userId: 'u1', listId: 'l' })).rejects.toThrow(/filter/);
    await expect(quoteEnrichment(d, { userId: 'u1', listId: 'l' })).rejects.toThrow(/filter/);
    expect(check).not.toHaveBeenCalled();
    expect(d.pages).toBe(0); // the config is read first, so a failure does not pay for a pass over the list
  });

  it('does not touch the usage ledger (the enrich-time token check must stay cheap)', async () => {
    await price(deps(Array(5).fill(''), sizedCfg(10)));
    expect(check).not.toHaveBeenCalled();
  });
});

describe('quoteEnrichment: the customer view', () => {
  it('returns exactly the four customer fields, with no dollar or vendor figure anywhere', async () => {
    const { customerView } = await quoteEnrichment(deps(Array(120).fill(''), sizedCfg(20)), { userId: 'u1', listId: 'l' });
    expect(Object.keys(customerView).sort()).toEqual(['confirmationToken', 'estimatedPercentOfAllowance', 'leadCount', 'withinAllowance']);
    expect(JSON.stringify(customerView)).not.toMatch(/usd|breakdown|apollo|perLead|total|cost|\$/i);
    expect(customerView.leadCount).toBe(120);
    expect(customerView.confirmationToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('shares its token with priceEnrichment, so the enrich-time check and the quote agree', async () => {
    const d = deps(Array(30).fill(''), sizedCfg(12));
    const quote = await quoteEnrichment(d, { userId: 'u1', listId: 'l' });
    const priced = await priceEnrichment(d, { userId: 'u1', listId: 'l' });
    expect(quote.customerView.confirmationToken).toBe(priced.estimate.confirmationToken);
  });

  it('reports the percent of the allowance, smaller when leads already have emails', async () => {
    const noEmail = await quoteEnrichment(deps(Array(120).fill(''), sizedCfg(20)), { userId: 'u1', listId: 'l' });
    const emailed = await quoteEnrichment(deps(Array(120).fill('x@acme.com'), sizedCfg(20)), { userId: 'u1', listId: 'l' });
    expect(noEmail.customerView.estimatedPercentOfAllowance).toBeGreaterThan(emailed.customerView.estimatedPercentOfAllowance as number);
    expect(emailed.customerView.estimatedPercentOfAllowance).toBeGreaterThan(0);
  });

  it('decides "within allowance" on the conservative reserve even when the expected cost fits', async () => {
    check.mockReset().mockImplementation(async (_u: string, o?: { projectedCostMicroUsd?: number }) =>
      ({ allowed: (o?.projectedCostMicroUsd ?? 0) < 10_000_000, month: '2026-11', costAllowance: 150, costUsed: 5 }));
    const wide = await quoteEnrichment(deps(Array(120).fill(''), sizedCfg(40)), { userId: 'u1', listId: 'l' });
    expect(wide.customerView.estimatedPercentOfAllowance).toBeLessThan(100);
    expect(wide.customerView.withinAllowance).toBe(false);
    const small = await quoteEnrichment(deps(Array(2).fill(''), sizedCfg(3)), { userId: 'u1', listId: 'l' });
    expect(small.customerView.withinAllowance).toBe(true);
  });

  it('returns a null percent for a plan with no dollar allowance', async () => {
    check.mockReset().mockResolvedValue({ allowed: true, month: '2026-11', costAllowance: null, costUsed: 0 });
    const { customerView } = await quoteEnrichment(deps(Array(10).fill('')), { userId: 'u1', listId: 'l' });
    expect(customerView.estimatedPercentOfAllowance).toBeNull();
  });

  it('never records admission', async () => {
    await quoteEnrichment(deps(Array(10).fill(''), sizedCfg(10)), { userId: 'u1', listId: 'l' });
    expect(check.mock.calls.some(([, o]) => o?.recordAdmission)).toBe(false);
  });
});

describe('quoteFromPriced (the 409 path)', () => {
  it('builds the customer view from an already-priced result without scanning the list again', async () => {
    const d = deps(Array(30).fill(''), sizedCfg(12));
    const priced = await priceEnrichment(d, { userId: 'u1', listId: 'l' });
    const pagesAfterPricing = d.pages;
    const view = await quoteFromPriced('u1', priced);
    expect(d.pages).toBe(pagesAfterPricing);
    expect(view.customerView.confirmationToken).toBe(priced.estimate.confirmationToken);
    expect(Object.keys(view.customerView).sort()).toEqual(['confirmationToken', 'estimatedPercentOfAllowance', 'leadCount', 'withinAllowance']);
  });

  it('decides "within allowance" on the conservative admission reserve, not on the expected cost alone', async () => {
    const config = sizedCfg(10);
    const d = deps(Array(20).fill(''), config);
    const priced = await priceEnrichment(d, { userId: 'u1', listId: 'l' });
    const expectedMicro = Math.round(priced.estimate.totalUsd * 1_000_000);
    const reserveMicro = await admissionEstimateMicroUsd('u1', config, priced.leadCount);
    expect(reserveMicro).toBeGreaterThan(expectedMicro * 1.5); // the reserve really is the bigger number
    const threshold = Math.round((expectedMicro + reserveMicro) / 2);
    check.mockReset().mockImplementation(async (_u: string, o?: { projectedCostMicroUsd?: number }) =>
      ({ allowed: (o?.projectedCostMicroUsd ?? 0) < threshold, month: '2026-11', costAllowance: 150, costUsed: 5 }));
    // expected cost fits under the threshold, the reserve does not: only the reserve can make this false
    expect((await quoteFromPriced('u1', priced)).customerView.withinAllowance).toBe(false);
    // with no saved config there is no reserve to apply, so the expected cost alone decides
    const noConfig = await priceEnrichment(deps(Array(20).fill(''), undefined), { userId: 'u1', listId: 'l' });
    expect(Math.round(noConfig.estimate.totalUsd * 1_000_000)).toBeLessThan(threshold);
    expect((await quoteFromPriced('u1', noConfig)).customerView.withinAllowance).toBe(true);
  });
});

describe('Apollo line: only leads the broker can reach, only when the config asks for an email (ENG-2720 recalibration)', () => {
  const named = (email: string, first?: string, last?: string, company?: string, extra: Record<string, unknown> = {}) => ({ email, firstName: first, lastName: last, company, ...extra });
  function depsLeads(leads: Array<Record<string, unknown>>, config?: EnrichmentConfig): QuoteDeps {
    return {
      getLeadsPage: async () => ({ items: leads.map((l, i) => ({ leadId: `l${i}`, ...l })) }),
      getSavedConfig: async () => config,
      hasUsableEmail: (e: unknown) => typeof e === 'string' && e.includes('@') && !e.endsWith('@example.com'),
    };
  }

  it('counts as broker-eligible only emailless leads with a first and last name plus a company or an email domain on the lead', async () => {
    const d = depsLeads([
      named('', 'A', 'B', 'Acme'),
      named('', 'A', 'B', undefined, { emailDomain: 'acme.com' }),
      // a website or domain alone is not enough: tier 3.5a reads only company / emailDomain
      named('', 'A', 'B', undefined, { website: 'https://acme.com' }),
      named('', 'A', 'B', undefined, { domain: 'acme.com' }),
      named('', 'A', undefined, 'Acme'),
      named('', undefined, 'B', 'Acme'),
      named('', '  ', 'B', 'Acme'),
      named('', 'A', 'B'),
      named('a@acme.com', 'A', 'B', 'Acme'),
    ]);
    expect(await inspectLeads(d, 'l')).toEqual({ count: 9, emailless: 8, brokerEligible: 2, skipped: 3 }); // skipped: the three with only one name part
  });

  it('counts leads with no identity signal as skipped (no usable email, LinkedIn, or first and last name)', async () => {
    const d = depsLeads([
      named('', undefined, undefined, 'Acme'),                       // company only: skipped
      named('', 'A', undefined, 'Acme'),                             // first name only: skipped
      named('   ', undefined, undefined, undefined, { website: 'https://acme.com' }), // website only: skipped
      named('', undefined, undefined, 'Acme', { linkedin: 'https://linkedin.com/in/x' }), // LinkedIn: resolvable
      named('', 'A', 'B', undefined),                                // full name: resolvable
      named('x@example.com', undefined, undefined, undefined),       // placeholder email, nothing else: skipped
      named('real@acme.com', undefined, undefined, undefined),       // usable email: resolvable
    ]);
    expect(await inspectLeads(d, 'l')).toEqual({ count: 7, emailless: 6, brokerEligible: 0, skipped: 4 });
  });

  it('quotes skipped leads at zero: a list of leads with nothing to identify them costs nothing', async () => {
    const nothing = Array.from({ length: 20 }, () => named('', undefined, undefined, 'Acme'));
    const named20 = Array.from({ length: 20 }, () => named('', 'A', 'B', 'Acme'));
    const free = await priceEnrichment(depsLeads(nothing, cfg('email', 'title')), { userId: 'u', listId: 'l' });
    const paid = await priceEnrichment(depsLeads(named20, cfg('email', 'title')), { userId: 'u', listId: 'l' });
    expect(free.estimate.totalUsd).toBe(0);
    expect(free.leadCount).toBe(20);
    expect(paid.estimate.totalUsd).toBeGreaterThan(0);
  });

  it('prices no Apollo line when the saved config does not include an email column', async () => {
    const leads = Array.from({ length: 20 }, () => named('', 'A', 'B', 'Acme'));
    const withEmail = await priceEnrichment(depsLeads(leads, cfg('email', 'title')), { userId: 'u', listId: 'l' });
    const noEmail = await priceEnrichment(depsLeads(leads, cfg('title', 'industry')), { userId: 'u', listId: 'l' });
    expect(withEmail.estimate.breakdownUsd.apollo).toBeGreaterThan(0);
    expect(noEmail.estimate.breakdownUsd.apollo).toBe(0);
  });

  it('treats an aliased email column, or a smart field depending on email, as asking for an email', async () => {
    const leads = Array.from({ length: 10 }, () => named('', 'A', 'B', 'Acme'));
    const aliased: EnrichmentConfig = { ...cfg('title'), fields: [field('Work Email', { aliasFor: 'email' }), field('title')] };
    const smartDep: EnrichmentConfig = { ...cfg('title'), fields: [field('reachable', { smartCondition: 'has an email', smartDependencies: ['email'] }), field('title')] };
    const excluded: EnrichmentConfig = { ...cfg('title'), fields: [field('email', { include: false }), field('title')] };
    for (const c of [aliased, smartDep]) expect((await priceEnrichment(depsLeads(leads, c), { userId: 'u', listId: 'l' })).estimate.breakdownUsd.apollo).toBeGreaterThan(0);
    expect((await priceEnrichment(depsLeads(leads, excluded), { userId: 'u', listId: 'l' })).estimate.breakdownUsd.apollo).toBe(0);
  });

  it('prices resolvable emailless leads the broker cannot reach yet (LinkedIn only) at the other rate, below the eligible rate', async () => {
    const reachable = await priceEnrichment(depsLeads(Array.from({ length: 30 }, () => named('', 'A', 'B', 'Acme')), cfg('email')), { userId: 'u', listId: 'l' });
    const linkedinOnly = await priceEnrichment(depsLeads(Array.from({ length: 30 }, () => named('', undefined, undefined, undefined, { linkedin: 'https://linkedin.com/in/x' })), cfg('email')), { userId: 'u', listId: 'l' });
    expect(linkedinOnly.estimate.breakdownUsd.apollo).toBeGreaterThan(0);
    expect(linkedinOnly.estimate.breakdownUsd.apollo).toBeLessThan(reachable.estimate.breakdownUsd.apollo);
  });
});
