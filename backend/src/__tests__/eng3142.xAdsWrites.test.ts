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
    campaigns: { c1: { id: 'c1', name: 'Launch', entity_status: 'PAUSED', funding_instrument_id: 'fi1', daily_budget_amount_local_micro: 50000000 } },
    line_items: { l1: { id: 'l1', name: 'LI', entity_status: 'PAUSED', campaign_id: 'c1', objective: 'ENGAGEMENTS', bid_strategy: 'AUTO' } },
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
  const listAll = jest.fn(async ({ path }: any) => (path.endsWith('promoted_tweets') ? promoted : path.endsWith('targeting_criteria') ? criteria : []));
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
  it('CAMPAIGN CREATE: preview sends nothing; confirm creates it PAUSED with micros, verified', async () => {
    const { d, x } = deps();
    const args = { entity_type: 'CAMPAIGN', action: 'CREATE', name: 'Black Friday', funding_instrument_id: 'fi1', daily_budget: 25.5 };
    const preview: any = await executeXAdsWrite('u1', args, session, 'USD', d);
    expect(preview.status).toBe('PREVIEW');
    expect(preview.preview).toContain('25.50 USD');
    expect(preview.preview).toContain('25500000 micros');
    expect(preview.preview).toMatch(/created PAUSED/);
    expect(x.writes).toHaveLength(0);

    const done: any = await executeXAdsWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, session, 'USD', d);
    expect(done).toMatchObject({ success: true, verification: 'CONFIRMED', entity_status: 'PAUSED' });
    expect(x.writes).toHaveLength(1);
    expect(x.writes[0].query).toMatchObject({ entity_status: 'PAUSED', daily_budget_amount_local_micro: 25500000, funding_instrument_id: 'fi1' });
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
    expect(() => validateXAdsWriteShape({ entity_type: 'CAMPAIGN', action: 'CREATE', name: 'n', funding_instrument_id: 'fi1', daily_budget: 5, entity_status: 'ACTIVE' }, 'USD'))
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
      entity_type: 'LINE_ITEM', action: 'CREATE', campaign_id: 'c1', name: 'US devs', objective: 'WEBSITE_CLICKS',
      targeting: { locations: ['96683cc9126741d1'], keywords: ['typescript'], follower_lookalike_user_ids: ['783214'] },
    }, d);
    expect(done).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(x.writes[0].query).toMatchObject({ entity_status: 'PAUSED', product_type: 'PROMOTED_TWEETS', bid_strategy: 'AUTO', placements: 'ALL_ON_TWITTER' });
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
