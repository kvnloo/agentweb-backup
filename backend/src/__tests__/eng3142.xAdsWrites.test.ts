/**
 * ENG-3142 — guarded X Ads writes: preview sends nothing, confirm applies once with the
 * matching single-use token, creates are always PAUSED, ACTIVATE is its own preview, and only a
 * read-back CONFIRMED is success. X is faked behind the `request` / `listAll` deps.
 */
jest.mock('../mcp/zomaOnboarding', () => ({
  assertZomaWriteReady: jest.fn(),
  ZomaNotReadyError: class ZomaNotReadyError extends Error {},
}));

import { executeXAdsWrite, validateXAdsWriteShape, type XAdsWriteDeps } from '../mcp/xAdsToolkitWrites';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { XAdsApiError } from '../services/xAdsClient';

const NOW = Date.parse('2026-11-20T00:00:00Z');
const session = { accountId: 'acc1', credentials: { consumerKey: 'ck', consumerSecret: 'cs', token: 't', tokenSecret: 'ts' } };

/** A tiny in-memory X Ads account. */
function fakeX() {
  const store: Record<string, Record<string, any>> = {
    funding_instruments: { fi1: { id: 'fi1', entity_status: 'ACTIVE', currency: 'USD', funded_amount_local_micro: 1 } },
    campaigns: {
      // Legacy campaign-budget campaign (pre-v12 CBO).
      c1: { id: 'c1', name: 'Launch', entity_status: 'PAUSED', funding_instrument_id: 'fi1', daily_budget_amount_local_micro: 50000000 },
      // Current shape: budget lives on its line items.
      c2: { id: 'c2', name: 'Spring', entity_status: 'PAUSED', funding_instrument_id: 'fi1', budget_optimization: 'LINE_ITEM' },
    },
    line_items: {
      l1: { id: 'l1', name: 'LI', entity_status: 'PAUSED', campaign_id: 'c1', objective: 'ENGAGEMENTS', bid_strategy: 'AUTO' },
      l2: { id: 'l2', name: 'A', entity_status: 'PAUSED', campaign_id: 'c2', objective: 'ENGAGEMENTS', bid_strategy: 'AUTO', daily_budget_amount_local_micro: 20000000 },
      l3: { id: 'l3', name: 'B', entity_status: 'ACTIVE', campaign_id: 'c2', objective: 'ENGAGEMENTS', bid_strategy: 'AUTO', daily_budget_amount_local_micro: 15000000 },
    },
  };
  const promoted: any[] = [];
  const criteria: any[] = [];
  const writes: Array<{ method: string; path: string; query?: any; json?: any }> = [];
  let seq = 0;
  const request = jest.fn(async ({ method = 'GET', path, query, json }: any) => {
    const m = path.match(/^\/accounts\/acc1\/(funding_instruments|campaigns|line_items)(?:\/(\w+))?$/);
    if (method === 'GET' && m?.[2]) {
      const row = store[m[1]][m[2]];
      if (!row) throw new XAdsApiError('X Ads API 404: NOT_FOUND', 404);
      return { data: { ...row } };
    }
    writes.push({ method, path, query, json });
    if (method === 'POST' && m && !m[2]) {
      const id = `new${++seq}`;
      store[m[1]][id] = { id, ...query, ...(query.placements ? { placements: String(query.placements).split(',') } : {}) };
      return { data: store[m[1]][id] };
    }
    if (method === 'PUT' && m?.[2]) {
      Object.assign(store[m[1]][m[2]], query);
      return { data: store[m[1]][m[2]] };
    }
    if (method === 'POST' && path === '/accounts/acc1/promoted_tweets') {
      for (const t of String(query.tweet_ids).split(',')) promoted.push({ id: `pt${t}`, tweet_id: t, line_item_id: query.line_item_id });
      return { data: promoted };
    }
    if (method === 'POST' && path === '/batch/accounts/acc1/targeting_criteria') {
      for (const op of json) criteria.push({ ...op.params });
      return { data: criteria };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const listAll = jest.fn(async ({ path, query }: any) => {
    if (path.endsWith('promoted_tweets')) return promoted;
    if (path.endsWith('targeting_criteria')) return criteria;
    if (path.endsWith('funding_instruments')) return Object.values(store.funding_instruments);
    if (path.endsWith('line_items')) return Object.values(store.line_items).filter((li) => !query?.campaign_ids || li.campaign_id === query.campaign_ids);
    return [];
  });
  return { store, writes, request, listAll };
}

function deps(x = fakeX(), over: Partial<XAdsWriteDeps> = {}) {
  const d: XAdsWriteDeps = {
    assertReady: jest.fn().mockResolvedValue(undefined),
    request: x.request as any,
    listAll: x.listAll as any,
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
    ...over,
  };
  return { d, x };
}

async function previewThenConfirm(args: any, d: XAdsWriteDeps) {
  const preview = await executeXAdsWrite('u1', args, session, 'USD', d);
  expect(preview.status).toBe('PREVIEW');
  return executeXAdsWrite('u1', { ...args, confirm: true, preview_token: (preview as any).preview_token }, session, 'USD', d);
}

describe('ENG-3142 X Ads guarded writes', () => {
  it('CAMPAIGN CREATE: preview sends nothing; confirm creates it PAUSED with budget_optimization=LINE_ITEM and no budget, verified', async () => {
    const { d, x } = deps();
    const args = { entity_type: 'CAMPAIGN', action: 'CREATE', name: 'Black Friday', funding_instrument_id: 'fi1' };
    const preview: any = await executeXAdsWrite('u1', args, session, 'USD', d);
    expect(preview.status).toBe('PREVIEW');
    expect(preview.preview).toMatch(/per line item/);
    expect(preview.preview).toMatch(/created PAUSED/);
    expect(x.writes).toHaveLength(0);

    const done: any = await executeXAdsWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, session, 'USD', d);
    expect(done).toMatchObject({ success: true, verification: 'CONFIRMED', entity_status: 'PAUSED' });
    expect(x.writes).toHaveLength(1);
    expect(x.writes[0].query).toMatchObject({ entity_status: 'PAUSED', budget_optimization: 'LINE_ITEM', funding_instrument_id: 'fi1' });
    expect(x.writes[0].query).not.toHaveProperty('daily_budget_amount_local_micro');
    expect(x.writes[0].query).not.toHaveProperty('total_budget_amount_local_micro');
  });

  it('CAMPAIGN CREATE with a budget is refused, pointing at line-item budgets', () => {
    for (const extra of [{ daily_budget: 25 }, { total_budget: 500 }]) {
      expect(() => validateXAdsWriteShape({ entity_type: 'CAMPAIGN', action: 'CREATE', name: 'n', funding_instrument_id: 'fi1', ...extra }, 'USD'))
        .toThrow(/LINE_ITEM CREATE/);
    }
  });

  it('CAMPAIGN CREATE without a usable funding instrument tells the user to add a payment method at ads.x.com', async () => {
    const args = { entity_type: 'CAMPAIGN', action: 'CREATE', name: 'n', funding_instrument_id: 'fi1' };
    for (const fi of [undefined, { id: 'fi1', entity_status: 'CANCELLED', currency: 'USD' }, { id: 'fi1', entity_status: 'ACTIVE', able_to_fund: false, currency: 'USD' }]) {
      const x = fakeX();
      if (fi) x.store.funding_instruments = { fi1: fi }; else x.store.funding_instruments = {};
      const { d } = deps(x);
      await expect(executeXAdsWrite('u1', args, session, 'USD', d)).rejects.toThrow(/payment method at ads\.x\.com \(Billing\)/);
      expect(x.writes).toHaveLength(0);
    }
    // A usable instrument exists but a different id was passed: refused, naming the usable one.
    const x = fakeX();
    const { d } = deps(x);
    await expect(executeXAdsWrite('u1', { ...args, funding_instrument_id: 'fi9' }, session, 'USD', d)).rejects.toThrow(/Usable funding instruments: fi1/);
  });

  it('CAMPAIGN UPDATE budget: allowed on a legacy campaign that has one, refused on a LINE_ITEM-budget campaign', async () => {
    const { d, x } = deps();
    const legacy: any = await previewThenConfirm({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: 'c1', daily_budget: 60 }, d);
    expect(legacy).toMatchObject({ success: true, verification: 'CONFIRMED' });
    await expect(executeXAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: 'c2', daily_budget: 60 }, session, 'USD', d))
      .rejects.toThrow(/LINE_ITEM UPDATE/);
    // A rename on the same campaign is still fine.
    await expect(previewThenConfirm({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: 'c2', name: 'Summer' }, d)).resolves.toMatchObject({ verification: 'CONFIRMED' });
    expect(x.writes).toHaveLength(2);
  });

  it('LINE_ITEM CREATE requires daily_budget and sends it (and total_budget) as micros; UPDATE can change both', async () => {
    expect(() => validateXAdsWriteShape({ entity_type: 'LINE_ITEM', action: 'CREATE', campaign_id: 'c2', name: 'n', objective: 'REACH' }, 'USD'))
      .toThrow(/needs daily_budget/);
    const { d, x } = deps();
    const args = { entity_type: 'LINE_ITEM', action: 'CREATE', campaign_id: 'c2', name: 'n', objective: 'REACH', daily_budget: 12.5, total_budget: 300 };
    const preview: any = await executeXAdsWrite('u1', args, session, 'USD', d);
    expect(preview.preview).toMatch(/Daily budget: 12\.50 USD/);
    expect(preview.preview).toMatch(/Total budget: 300\.00 USD/);
    const done: any = await executeXAdsWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, session, 'USD', d);
    expect(done).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(x.writes[0].query).toMatchObject({ daily_budget_amount_local_micro: 12500000, total_budget_amount_local_micro: 300000000 });

    const upd: any = await previewThenConfirm({ entity_type: 'LINE_ITEM', action: 'UPDATE', line_item_id: 'l2', daily_budget: 30, total_budget: 900 }, d);
    expect(upd).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(x.store.line_items.l2).toMatchObject({ daily_budget_amount_local_micro: 30000000, total_budget_amount_local_micro: 900000000 });
  });

  it('ACTIVATE: a campaign shows the sum of its line items\' daily budgets; a line item shows its own', async () => {
    const { d, x } = deps();
    const camp: any = await executeXAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: 'c2' }, session, 'USD', d);
    expect(camp.preview).toMatch(/up to 35\.00 USD .*\/day/);
    expect(camp.preview).toMatch(/2 line item/);
    const li: any = await executeXAdsWrite('u1', { entity_type: 'LINE_ITEM', action: 'ACTIVATE', line_item_id: 'l2' }, session, 'USD', d);
    expect(li.preview).toMatch(/up to 20\.00 USD .*\/day \(its daily budget\)/);
    expect(x.writes).toHaveLength(0);

    // The ceiling applies to the line-item sum on campaign activation.
    const capped = deps(undefined, { spendCeilingPolicy: () => ({ maxDailyBudget: 30000000 }) }).d;
    await expect(executeXAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: 'c2' }, session, 'USD', capped)).rejects.toThrow(/Activating/);
    await expect(executeXAdsWrite('u1', { entity_type: 'LINE_ITEM', action: 'ACTIVATE', line_item_id: 'l2' }, session, 'USD', capped)).resolves.toMatchObject({ status: 'PREVIEW' });
  });

  it('a preview token is single use and bound to the exact arguments', async () => {
    const { d, x } = deps();
    const args = { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: 'c1', daily_budget: 60 };
    const preview: any = await executeXAdsWrite('u1', args, session, 'USD', d);
    await expect(executeXAdsWrite('u1', { ...args, daily_budget: 600, confirm: true, preview_token: preview.preview_token }, session, 'USD', d))
      .rejects.toThrow(/does not match/);
    await executeXAdsWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, session, 'USD', d);
    // The applied change moved the state the token was bound to, so it no longer matches at all.
    await expect(executeXAdsWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, session, 'USD', d))
      .rejects.toThrow(/does not match/);
    expect(x.writes).toHaveLength(1);

    // A write whose bound state does not move (promote on an unchanged line item) is refused as already used.
    const promote = { entity_type: 'PROMOTED_TWEET', action: 'CREATE', line_item_id: 'l1', tweet_ids: ['1850000000000000009'] };
    const p2: any = await executeXAdsWrite('u1', promote, session, 'USD', d);
    await executeXAdsWrite('u1', { ...promote, confirm: true, preview_token: p2.preview_token }, session, 'USD', d);
    await expect(executeXAdsWrite('u1', { ...promote, confirm: true, preview_token: p2.preview_token }, session, 'USD', d))
      .rejects.toThrow(/already used/);
    expect(x.writes).toHaveLength(2);
  });

  it('a create can never carry a status; activation is its own ACTIVATE preview', async () => {
    expect(() => validateXAdsWriteShape({ entity_type: 'CAMPAIGN', action: 'CREATE', name: 'n', funding_instrument_id: 'fi1', entity_status: 'ACTIVE' }, 'USD'))
      .toThrow(/always PAUSED/);
    const { d, x } = deps();
    const preview: any = await executeXAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: 'c1' }, session, 'USD', d);
    expect(preview.preview).toMatch(/PAUSED → ACTIVE/);
    expect(preview.preview).toMatch(/50.00 USD/);
    expect(x.writes).toHaveLength(0);
  });

  it('LINE_ITEM CREATE: PAUSED, automatic bid by default, targeting applied in one batch and read back', async () => {
    const { d, x } = deps();
    const done: any = await previewThenConfirm({
      entity_type: 'LINE_ITEM', action: 'CREATE', campaign_id: 'c2', name: 'US devs', objective: 'WEBSITE_CLICKS', daily_budget: 10,
      targeting: { locations: ['96683cc9126741d1'], keywords: ['typescript'], follower_lookalike_user_ids: ['783214'] },
    }, d);
    expect(done).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(x.writes[0].query).toMatchObject({ entity_status: 'PAUSED', product_type: 'PROMOTED_TWEETS', bid_strategy: 'AUTO', placements: 'ALL_ON_TWITTER' });
    // X requires start_time on line items; defaulted to "now" at apply time.
    expect(x.writes[0].query.start_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(x.writes[1].json.map((o: any) => o.params.targeting_type)).toEqual(['LOCATION', 'BROAD_KEYWORD', 'SIMILAR_TO_FOLLOWERS_OF_USER']);
  });

  it('PROMOTED_TWEET CREATE promotes existing posts and confirms each one', async () => {
    const { d } = deps();
    const done: any = await previewThenConfirm({ entity_type: 'PROMOTED_TWEET', action: 'CREATE', line_item_id: 'l1', tweet_ids: ['1850000000000000001', '1850000000000000002'] }, d);
    expect(done).toMatchObject({ success: true, verification: 'CONFIRMED', promoted_tweet_ids: ['pt1850000000000000001', 'pt1850000000000000002'] });
  });

  it('an object that does not exist is refused before any token is minted', async () => {
    const { d, x } = deps();
    await expect(executeXAdsWrite('u1', { entity_type: 'LINE_ITEM', action: 'PAUSE', line_item_id: 'nope' }, session, 'USD', d)).rejects.toThrow(/not found/);
    expect(x.writes).toHaveLength(0);
  });

  it('spend ceiling (micros) refuses a budget and an activation above it', async () => {
    const { d } = deps(undefined, { spendCeilingPolicy: () => ({ maxDailyBudget: 40000000 }) });
    await expect(executeXAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: 'c1', daily_budget: 41 }, session, 'USD', d)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    await expect(executeXAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: 'c1' }, session, 'USD', d)).rejects.toThrow(/Activating/);
  });

  it('no definite answer from X is UNCONFIRMED (may have applied), a 4xx is a refusal (did not apply)', async () => {
    const x = fakeX();
    const real = x.request.getMockImplementation()!;
    const { d } = deps(x);
    x.request.mockImplementation(async (o: any) => {
      if (o.method === 'PUT') throw new XAdsApiError('X Ads API: no response was received', 0);
      return real(o);
    });
    const r: any = await previewThenConfirm({ entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: 'c1' }, d);
    expect(r).toMatchObject({ success: false, verification: 'UNCONFIRMED' });

    x.request.mockImplementation(async (o: any) => {
      if (o.method === 'PUT') throw new XAdsApiError('X Ads API 400: INVALID', 400);
      return real(o);
    });
    const fresh = deps(x).d; // new token store: same args + state + clock mint the same token
    await expect(previewThenConfirm({ entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: 'c1' }, fresh)).rejects.toThrow(/nothing was changed/);
  });

  it('accepted but unchanged on read-back is MISMATCH, never success', async () => {
    const x = fakeX();
    const real = x.request.getMockImplementation()!;
    x.request.mockImplementation(async (o: any) => (o.method === 'PUT' ? { data: {} } : real(o)));
    const { d } = deps(x);
    const r: any = await previewThenConfirm({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: 'c1', name: 'Renamed' }, d);
    expect(r).toMatchObject({ success: false, verification: 'MISMATCH', mismatched_fields: ['name'] });
  });

  it('money: extra precision is refused, never rounded', () => {
    expect(() => validateXAdsWriteShape({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: 'c1', daily_budget: 10.123 }, 'USD')).toThrow(/decimals/);
    expect(() => validateXAdsWriteShape({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: 'c1', daily_budget: 0 }, 'USD')).toThrow(/greater than 0/);
  });
});
