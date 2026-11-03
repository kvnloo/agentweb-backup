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
const sizedCfg = (n: number) => cfg(...Array.from({ length: n }, (_, i) => `f${i}`));

/** Fake lead store: pages of 200, `email` per lead. */
function deps(emails: Array<string | undefined>, config?: EnrichmentConfig, hasUsable = (e: unknown) => typeof e === 'string' && e.includes('@') && !e.endsWith('@example.com')): QuoteDeps & { pages: number } {
  const state = { pages: 0 };
  const d: QuoteDeps & { readonly pages: number } = {
    getLeadsPage: async (_l: string, limit: number, lastKey?: unknown) => {
      state.pages++;
      const start = typeof lastKey === 'number' ? lastKey : 0;
      const items = emails.slice(start, start + limit).map((email, i) => ({ leadId: `l${start + i}`, email }));
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
    expect(await inspectLeads(d, 'l')).toEqual({ count: 450, emailless: 300 });
    expect(d.pages).toBe(3);
  });

  it('counts a selected subset only for ids that belong to the list, with their real email state', async () => {
    const d = deps(['a@acme.com', '', 'junk@example.com', 'b@acme.com']);
    // l0 has an email, l1 none, l2 placeholder; l99 and "x" do not exist; l1 is repeated
    expect(await inspectLeads(d, 'l', ['l0', 'l1', 'l2', 'l1', 'l99', 'x'])).toEqual({ count: 3, emailless: 2 });
    expect(d.pages).toBe(1);
  });

  it('fake ids cannot amplify the count (they match nothing), so the quote cannot be scaled to resolve the rate', async () => {
    const fake = Array.from({ length: 100_000 }, (_, i) => `fake-${i}`);
    expect(await inspectLeads(deps(['a@acme.com', '']), 'l', fake)).toEqual({ count: 0, emailless: 0 });
  });

  it('stops scanning once every requested id has been found (a small subset does not read the whole list)', async () => {
    const d = deps(Array(1000).fill(''));
    expect(await inspectLeads(d, 'l', ['l0', 'l1'])).toEqual({ count: 2, emailless: 2 });
    expect(d.pages).toBe(1); // 1000 leads = 5 pages, the ids are on the first
    const far = deps(Array(1000).fill(''));
    expect(await inspectLeads(far, 'l', ['l999'])).toEqual({ count: 1, emailless: 1 });
    expect(far.pages).toBe(5);
  });

  it('still scans the whole list when a requested id does not exist (bounded by the list)', async () => {
    const d = deps(Array(1000).fill(''));
    expect(await inspectLeads(d, 'l', ['l0', 'nope'])).toEqual({ count: 1, emailless: 1 });
    expect(d.pages).toBe(5);
  });

  it('ignores non-string lead ids on the page', async () => {
    const d = deps(['']);
    d.getLeadsPage = async () => ({ items: [{ leadId: 5 as unknown as string, email: '' }, { email: '' }] });
    expect(await inspectLeads(d, 'l', ['5', 'undefined'])).toEqual({ count: 0, emailless: 0 });
  });

  it('handles an empty list', async () => {
    expect(await inspectLeads(deps([]), 'l')).toEqual({ count: 0, emailless: 0 });
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

  it('falls back to the reference config when the saved config cannot be read', async () => {
    const d = deps(Array(5).fill(''));
    d.getSavedConfig = async () => undefined;
    expect((await price(d)).leadCount).toBe(5);
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
