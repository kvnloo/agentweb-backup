/**
 * ENG-2914 acceptance — Zoma custom audiences (zoma_custom_audiences):
 *  - reads: LIST, GET (ownership-scoped), LIST_AD_SETS;
 *  - CREATE customer_list / website / engagement / lookalike (1-10%) through preview + token;
 *    external_provider is registered but refused "not available yet";
 *  - Custom Audience Terms not accepted → TERMS_NOT_ACCEPTED with the business terms URL;
 *  - UPDATE name/description/rule; ADD/REMOVE users: raw emails/phones normalized + SHA-256
 *    hashed server-side, batched at 10k, raw PII never sent, returned or logged;
 *  - DELETE behind preview + token, refused while an active ad set uses it unless confirm_in_use;
 *  - EXCLUDE_CUSTOMERS: create/reuse the list and add it to excluded_custom_audiences through
 *    the shared AD_SET UPDATE preview + dispatch path, preview shows the targeting diff;
 *  - read-back verdicts CONFIRMED / MISMATCH / UNCONFIRMED.
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../mcp/zomaOnboarding', () => {
  const actual = jest.requireActual('../mcp/zomaOnboarding');
  return { ...actual, assertZomaWriteReady: jest.fn() };
});

import crypto from 'crypto';
import { executeMetaToolkitAudience, isTermsNotAccepted, termsAcceptanceUrl, type MetaToolkitAudienceDeps } from '../mcp/metaToolkitAudiences';
import {
  AUDIENCE_SOURCES, buildAudienceSpec, hashIdentifiers, normalizeEmail, normalizePhone, batches,
} from '../mcp/metaToolkitAudienceSources';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { ZomaNotReadyError } from '../mcp/zomaOnboarding';

const NOW = 1_800_000_000_000;
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const account = (scopes: string[] = ['ads_read', 'ads_management']) => ({
  platform: 'meta',
  account_id: 'act_111',
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '111', granted_scopes: scopes },
});

/** Tiny in-memory Meta: audiences + ad sets keyed by id, owned by account 111 unless stated. */
function fakeMeta() {
  const audiences: Record<string, any> = {
    '501': { id: '501', name: 'Buyers', subtype: 'CUSTOM', account_id: '111', description: 'old' },
    '502': { id: '502', name: 'Site visitors', subtype: 'WEBSITE', account_id: '111', rule: '{"inclusions":{}}' },
    '900': { id: '900', name: 'Foreign', subtype: 'CUSTOM', account_id: '222' },
  };
  const adSets: Record<string, any> = {
    '701': { id: '701', name: 'Prospecting', account_id: '111', status: 'ACTIVE', effective_status: 'ACTIVE', targeting: { geo_locations: { countries: ['US'] }, excluded_custom_audiences: [{ id: '333', name: 'Old' }] } },
    '702': { id: '702', name: 'Retargeting', account_id: '111', status: 'PAUSED', effective_status: 'PAUSED', targeting: { custom_audiences: [{ id: '501' }] } },
    '799': { id: '799', name: 'Foreign set', account_id: '222', status: 'ACTIVE', targeting: {} },
  };
  let nextId = 600;
  const notFound = () => Object.assign(new Error('Unsupported get request'), { metaError: { code: 100, error_subcode: 33, message: 'Unsupported get request' } });
  const graph = jest.fn(async (_u: string, _a: string, method: string, path: string, params: any = {}) => {
    if (method === 'GET' && path === '{account}/customaudiences') return { data: Object.values(audiences).filter((a) => a.account_id === '111') };
    if (method === 'GET' && path === '{account}/adsets') return { data: Object.values(adSets).filter((a) => a.account_id === '111') };
    if (method === 'POST' && path === '{account}/customaudiences') {
      const id = String(nextId++);
      audiences[id] = { id, account_id: '111', name: params.name, description: params.description, subtype: params.subtype ?? (params.rule ? 'WEBSITE' : 'CUSTOM'), ...(params.rule ? { rule: params.rule } : {}) };
      return { id };
    }
    if (method === 'GET') {
      const node = audiences[path] ?? adSets[path];
      if (!node) throw notFound();
      return JSON.parse(JSON.stringify(node));
    }
    if (method === 'POST' && audiences[path]) {
      Object.assign(audiences[path], params);
      return { success: true };
    }
    if (method === 'DELETE' && audiences[path]) {
      delete audiences[path];
      return { success: true };
    }
    throw new Error(`unexpected graph ${method} ${path}`);
  });
  return { audiences, adSets, graph };
}

function makeDeps(over: Partial<MetaToolkitAudienceDeps> = {}) {
  const meta = fakeMeta();
  const deps: MetaToolkitAudienceDeps = {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([account()]),
    graph: meta.graph as any,
    users: jest.fn(async (_u, _a, _id, _schema, hashes) => ({ success: true, received: hashes.length })),
    previewAdSetUpdate: jest.fn(async (_u, accountId, adSetId, params) => ({
      success: true, awaitingUserConfirmation: true, summary: `UPDATE AD_SET ${adSetId}`,
      metaWriteDispatch: { entity_type: 'AD_SET', action: 'UPDATE', account_id: accountId, ad_set_id: adSetId, params },
    })),
    dispatch: jest.fn(async (_u, d) => {
      meta.adSets[d.ad_set_id].targeting = d.params.targeting;
      return { result: { success: true } };
    }),
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
    ...over,
  };
  return { deps, meta };
}

const base = { account_id: '111' };
async function previewThenConfirm(args: any, deps: MetaToolkitAudienceDeps) {
  const preview: any = await executeMetaToolkitAudience('u1', args, deps);
  expect(preview.status).toBe('PREVIEW');
  return { preview, result: await executeMetaToolkitAudience('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps) };
}
const writesSent = (graph: jest.Mock) => graph.mock.calls.filter((c) => c[2] !== 'GET');

describe('ENG-2914 audience sources (pluggable)', () => {
  it('registers every source type; external_provider is refused "not available yet"', () => {
    expect(Object.keys(AUDIENCE_SOURCES).sort()).toEqual(['customer_list', 'engagement', 'external_provider', 'lookalike', 'website']);
    expect(AUDIENCE_SOURCES.external_provider.available).toBe(false);
    expect(() => buildAudienceSpec({ type: 'external_provider', provider: 'tero' })).toThrow(/not available yet/);
    expect(() => buildAudienceSpec({ type: 'nope' })).toThrow(MetaToolkitRefusal);
  });

  it('lookalike: ratio 1-10% of a 2-letter country, sent as Meta ratio 0.01-0.10', () => {
    const spec = buildAudienceSpec({ type: 'lookalike', origin_audience_id: '501', country: 'us', ratio_percent: 3 });
    expect(spec.createParams).toEqual({ subtype: 'LOOKALIKE', origin_audience_id: '501', lookalike_spec: JSON.stringify({ type: 'similarity', ratio: 0.03, country: 'US' }) });
    for (const bad of [0, 11, 2.5, undefined]) {
      expect(() => buildAudienceSpec({ type: 'lookalike', origin_audience_id: '501', country: 'US', ratio_percent: bad })).toThrow(/ratio_percent/);
    }
    expect(() => buildAudienceSpec({ type: 'lookalike', origin_audience_id: '501', country: 'USA', ratio_percent: 1 })).toThrow(/country/);
  });

  it('website builds a pixel rule; engagement builds a page/IG rule', () => {
    const web = buildAudienceSpec({ type: 'website', pixel_id: '42', retention_days: 30, url_contains: '/thank-you' });
    const rule = JSON.parse(web.createParams.rule);
    expect(rule.inclusions.rules[0]).toMatchObject({ event_sources: [{ id: '42', type: 'pixel' }], retention_seconds: 30 * 86400 });
    expect(rule.inclusions.rules[0].filter.filters).toEqual([{ field: 'url', operator: 'i_contains', value: '/thank-you' }]);
    expect(() => buildAudienceSpec({ type: 'website', pixel_id: '42', retention_days: 181 })).toThrow(/retention_days/);
    const eng = JSON.parse(buildAudienceSpec({ type: 'engagement', source_type: 'ig_business', source_id: '77' }).createParams.rule);
    expect(eng.inclusions.rules[0]).toMatchObject({ event_sources: [{ id: '77', type: 'ig_business' }], retention_seconds: 365 * 86400 });
    expect(() => buildAudienceSpec({ type: 'engagement', source_type: 'tiktok', source_id: '77' })).toThrow(/source_type/);
  });

  it('normalizes and hashes emails/phones; dedupes; counts invalid; batches at 10k', () => {
    expect(normalizeEmail('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizePhone('+1 (415) 555-0123')).toBe('14155550123');
    expect(normalizePhone('12')).toBeNull();
    const ids = hashIdentifiers(['Jane@x.com', 'jane@X.com ', 'bad'], ['+1 415 555 0123', sha('14155550199')]);
    expect(ids.EMAIL).toEqual([sha('jane@x.com')]);
    expect(ids.PHONE).toEqual([sha('14155550123'), sha('14155550199')]);
    expect(ids.duplicates).toBe(1);
    expect(ids.invalid).toBe(1);
    expect(batches(Array.from({ length: 25_000 }, (_, i) => i)).map((b) => b.length)).toEqual([10_000, 10_000, 5_000]);
  });
});

describe('ENG-2914 reads', () => {
  it('LIST and GET; GET refuses an audience from another ad account', async () => {
    const { deps } = makeDeps();
    const list: any = await executeMetaToolkitAudience('u1', { ...base, action: 'LIST' }, deps);
    expect(list.audiences.map((a: any) => a.id)).toEqual(['501', '502']);
    const got: any = await executeMetaToolkitAudience('u1', { ...base, action: 'GET', audience_id: '501' }, deps);
    expect(got.audience).toMatchObject({ id: '501', name: 'Buyers' });
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'GET', audience_id: '900' }, deps)).rejects.toThrow(/not in the selected ad account/);
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'GET', audience_id: '../me' }, deps)).rejects.toThrow(/numeric/);
    expect(deps.assertReady).not.toHaveBeenCalled();
  });

  it('LIST_AD_SETS returns ad sets including or excluding the audience', async () => {
    const { deps } = makeDeps();
    const r: any = await executeMetaToolkitAudience('u1', { ...base, action: 'LIST_AD_SETS', audience_id: '501' }, deps);
    expect(r.ad_sets).toEqual([expect.objectContaining({ id: '702', usage: 'included', effective_status: 'PAUSED' })]);
  });
});

describe('ENG-2914 CREATE', () => {
  it('a preview sends nothing; the approved token creates the customer list with hashed members, CONFIRMED by read-back', async () => {
    const { deps, meta } = makeDeps();
    const args = { ...base, action: 'CREATE', source: { type: 'customer_list' }, params: { name: 'VIPs', emails: ['VIP@shop.com'], phones: ['+44 20 7946 0000'] } };
    const preview: any = await executeMetaToolkitAudience('u1', args, deps);
    expect(preview.status).toBe('PREVIEW');
    expect(preview.preview).toMatch(/2 hashed identifier/);
    expect(preview.preview).not.toMatch(/VIP@shop.com/i);
    expect(writesSent(meta.graph)).toHaveLength(0);
    expect(deps.users).not.toHaveBeenCalled();

    const result: any = await executeMetaToolkitAudience('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps);
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', id: '600' });
    expect(writesSent(meta.graph)[0].slice(2)).toEqual(['POST', '{account}/customaudiences', { subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', name: 'VIPs' }]);
    expect(deps.users).toHaveBeenCalledWith('u1', '111', '600', 'EMAIL', [sha('vip@shop.com')], false);
    expect(deps.users).toHaveBeenCalledWith('u1', '111', '600', 'PHONE', [sha('442079460000')], false);

    // single use
    await expect(executeMetaToolkitAudience('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps)).rejects.toThrow(/already used/);
  });

  it('confirm without a valid token, or with changed arguments, is PREVIEW_MISMATCH and sends nothing', async () => {
    const { deps, meta } = makeDeps();
    const args = { ...base, action: 'CREATE', source: { type: 'lookalike', origin_audience_id: '501', country: 'US', ratio_percent: 1 }, params: { name: 'LAL 1%' } };
    const preview: any = await executeMetaToolkitAudience('u1', args, deps);
    expect(preview.preview).toMatch(/closest 1% of people in US/);
    const changed: any = await executeMetaToolkitAudience('u1', {
      ...args, source: { ...args.source, ratio_percent: 10 }, confirm: true, preview_token: preview.preview_token,
    }, deps);
    expect(changed.status).toBe('PREVIEW_MISMATCH');
    const none: any = await executeMetaToolkitAudience('u1', { ...args, confirm: true }, deps);
    expect(none.status).toBe('PREVIEW_MISMATCH');
    expect(writesSent(meta.graph)).toHaveLength(0);
  });

  it('lookalike creates with ratio 0.0N after the source audience ownership check; foreign source refused', async () => {
    const { deps, meta } = makeDeps();
    const { result } = await previewThenConfirm({ ...base, action: 'CREATE', source: { type: 'lookalike', origin_audience_id: '501', country: 'GB', ratio_percent: 5 }, params: { name: 'LAL' } }, deps);
    expect(result.verification).toBe('CONFIRMED');
    expect(writesSent(meta.graph)[0][4]).toMatchObject({ subtype: 'LOOKALIKE', origin_audience_id: '501', lookalike_spec: JSON.stringify({ type: 'similarity', ratio: 0.05, country: 'GB' }) });
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'CREATE', source: { type: 'lookalike', origin_audience_id: '900', country: 'GB', ratio_percent: 5 }, params: { name: 'x' } }, deps))
      .rejects.toThrow(/not in the selected ad account/);
  });

  it('Custom Audience Terms not accepted → TERMS_NOT_ACCEPTED with the business terms URL', async () => {
    const termsError = Object.assign(new Error('Custom Audience Terms Not Accepted'), {
      metaError: { code: 200, error_subcode: 1870090, message: 'Permissions error', error_user_msg: 'You need to accept the Custom Audience terms' },
    });
    const { deps, meta } = makeDeps();
    const inner = meta.graph.getMockImplementation()!;
    meta.graph.mockImplementation(async (...a: any[]) => {
      if (a[2] === 'POST') throw termsError;
      return (inner as any)(...a);
    });
    const { result } = await previewThenConfirm({ ...base, action: 'CREATE', source: { type: 'website', pixel_id: '42' }, params: { name: 'Visitors' } }, deps);
    expect(result).toMatchObject({ success: false, status: 'TERMS_NOT_ACCEPTED', terms_url: 'https://business.facebook.com/ads/manage/customaudiences/tos/?act=111' });
    expect(result.message).toContain(termsAcceptanceUrl('act_111'));
    expect(result.verification).toBeUndefined();
    expect(isTermsNotAccepted('Custom audience terms not accepted')).toBe(true);
    expect(isTermsNotAccepted('Invalid parameter')).toBe(false);
  });

  it('external_provider is refused before any write gate or Meta call', async () => {
    const { deps, meta } = makeDeps();
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'CREATE', source: { type: 'external_provider' }, params: { name: 'x' } }, deps))
      .rejects.toThrow(/not available yet/);
    expect(meta.graph).not.toHaveBeenCalled();
  });

  it('write gate: not ready / ads_management not granted → refused; read-back missing → UNCONFIRMED', async () => {
    const notReady = makeDeps({ assertReady: jest.fn().mockRejectedValue(new ZomaNotReadyError('Add a payment method first.')) });
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'CREATE', source: { type: 'customer_list' }, params: { name: 'x' } }, notReady.deps)).rejects.toThrow(/payment method/);
    const noScope = makeDeps({ listAccounts: jest.fn().mockResolvedValue([account(['ads_read'])]) });
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'CREATE', source: { type: 'customer_list' }, params: { name: 'x' } }, noScope.deps)).rejects.toThrow(/ads_management/);

    const { deps, meta } = makeDeps();
    const inner = meta.graph.getMockImplementation()!;
    meta.graph.mockImplementation(async (...a: any[]) => {
      if (a[2] === 'GET' && a[3] === '600') throw new Error('timeout');
      return (inner as any)(...a);
    });
    const { result } = await previewThenConfirm({ ...base, action: 'CREATE', source: { type: 'customer_list' }, params: { name: 'x' } }, deps);
    expect(result).toMatchObject({ success: false, verification: 'UNCONFIRMED', id: '600' });
  });
});

describe('ENG-2914 UPDATE / ADD_USERS / REMOVE_USERS', () => {
  it('UPDATE name + description, preview shows the diff, CONFIRMED by read-back; other fields refused', async () => {
    const { deps } = makeDeps();
    const { preview, result } = await previewThenConfirm({ ...base, action: 'UPDATE', audience_id: '501', params: { name: 'Buyers 2026', description: 'new' } }, deps);
    expect(preview.preview).toContain('name: "Buyers" → "Buyers 2026"');
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', id: '501' });
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'UPDATE', audience_id: '501', params: { subtype: 'LOOKALIKE' } }, deps)).rejects.toThrow(/can change only/);
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'UPDATE', audience_id: '501', params: { rule: { inclusions: {} } } }, deps)).rejects.toThrow(/not rule-based/);
  });

  it('ADD_USERS: 25,000 raw emails are hashed and sent in 3 batches; raw PII never sent, returned or logged', async () => {
    const { deps, meta } = makeDeps();
    const emails = Array.from({ length: 25_000 }, (_, i) => `Person${i}@Example.com`);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
    try {
      const { preview, result } = await previewThenConfirm({ ...base, action: 'ADD_USERS', audience_id: '501', params: { emails } }, deps);
      expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', identifiers_sent: 25_000, identifiers_received: 25_000 });
      const calls = (deps.users as jest.Mock).mock.calls;
      expect(calls.map((c) => c[4].length)).toEqual([10_000, 10_000, 5_000]);
      for (const c of calls) expect(c[4].every((h: string) => /^[a-f0-9]{64}$/.test(h))).toBe(true);
      expect(calls[0][4][0]).toBe(sha('person0@example.com'));
      const everything = JSON.stringify([preview, result, calls, meta.graph.mock.calls, spies.map((s) => s.mock.calls)]);
      expect(everything).not.toMatch(/person\d+@example\.com/i);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('REMOVE_USERS goes through the removal path; fewer received than sent → MISMATCH; non-customer-list refused', async () => {
    const { deps } = makeDeps({ users: jest.fn(async (_u, _a, _id, _s, hashes) => ({ success: true, received: hashes.length - 1 })) });
    const { result } = await previewThenConfirm({ ...base, action: 'REMOVE_USERS', audience_id: '501', params: { phones: ['+1 415 555 0123', '+1 415 555 0124'] } }, deps);
    expect((deps.users as jest.Mock).mock.calls[0][5]).toBe(true);
    expect(result).toMatchObject({ success: false, verification: 'MISMATCH' });
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'ADD_USERS', audience_id: '502', params: { emails: ['a@b.co'] } }, deps)).rejects.toThrow(/customer-list/);
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'ADD_USERS', audience_id: '501', params: { emails: ['nope'] } }, deps)).rejects.toThrow(/None of the supplied/);
  });

  it('UPDATE rule: CONFIRMED only when Meta reads back the approved rule; still the old rule → MISMATCH', async () => {
    const newRule = { inclusions: { operator: 'or', rules: [{ retention_seconds: 86400 }] } };
    let { deps } = makeDeps();
    let r = await previewThenConfirm({ ...base, action: 'UPDATE', audience_id: '502', params: { rule: newRule } }, deps);
    expect(r.result).toMatchObject({ verification: 'CONFIRMED' });
    ({ deps } = makeDeps());
    const graph = deps.graph as jest.Mock;
    const real = graph.getMockImplementation()!;
    graph.mockImplementation(async (u: string, a: string, method: string, path: string, params: any) =>
      method === 'POST' && path === '502' ? { success: true } : real(u, a, method, path, params));
    r = await previewThenConfirm({ ...base, action: 'UPDATE', audience_id: '502', params: { rule: newRule } }, deps);
    expect(r.result).toMatchObject({ success: false, verification: 'MISMATCH' });
  });

  it('identifiers Meta rejects as invalid are not success even when every one was received', async () => {
    const { deps } = makeDeps({ users: jest.fn(async (_u, _a, _id, _s, hashes) => ({ success: true, received: hashes.length, invalid: 1 })) });
    const { result } = await previewThenConfirm({ ...base, action: 'ADD_USERS', audience_id: '501', params: { emails: ['a@b.co', 'c@d.co'] } }, deps);
    expect(result).toMatchObject({ success: false, verification: 'MISMATCH', identifiers_invalid: 1 });
    expect(result.message).toMatch(/rejected 1 as invalid/);
  });

  it('a users upload refused for terms → TERMS_NOT_ACCEPTED', async () => {
    const { deps } = makeDeps({ users: jest.fn().mockResolvedValue({ success: false, message: 'You must accept the Custom Audience Terms for this ad account.' }) });
    const { result } = await previewThenConfirm({ ...base, action: 'ADD_USERS', audience_id: '501', params: { emails: ['a@b.co'] } }, deps);
    expect(result.status).toBe('TERMS_NOT_ACCEPTED');
  });
});

describe('ENG-2914 DELETE', () => {
  it('refuses while an active ad set uses the audience unless confirm_in_use=true', async () => {
    const { deps, meta } = makeDeps();
    meta.adSets['702'].effective_status = 'ACTIVE';
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'DELETE', audience_id: '501' }, deps)).rejects.toThrow(/1 active ad set.*Retargeting/);
    const { preview, result } = await previewThenConfirm({ ...base, action: 'DELETE', audience_id: '501', confirm_in_use: true }, deps);
    expect(preview.preview).toMatch(/Used by 1 ad set/);
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', id: '501' });
    expect(meta.audiences['501']).toBeUndefined();
  });

  it('unused audience: preview first, nothing deleted without the token; still present after delete → MISMATCH', async () => {
    const { deps, meta } = makeDeps();
    const preview: any = await executeMetaToolkitAudience('u1', { ...base, action: 'DELETE', audience_id: '502' }, deps);
    expect(preview.status).toBe('PREVIEW');
    expect(meta.audiences['502']).toBeDefined();
    const inner = meta.graph.getMockImplementation()!;
    meta.graph.mockImplementation(async (...a: any[]) => (a[2] === 'DELETE' ? { success: true } : (inner as any)(...a)));
    const result: any = await executeMetaToolkitAudience('u1', { ...base, action: 'DELETE', audience_id: '502', confirm: true, preview_token: preview.preview_token }, deps);
    expect(result.verification).toBe('MISMATCH');
  });
});

describe('ENG-2914 EXCLUDE_CUSTOMERS', () => {
  it('one call: creates the customer list, adds hashed members, excludes it from the ad sets via the shared AD_SET UPDATE path', async () => {
    const { deps, meta } = makeDeps();
    const args = { ...base, action: 'EXCLUDE_CUSTOMERS', ad_set_ids: ['701'], params: { emails: ['buyer@shop.com', 'b2@shop.com'] } };
    const { preview, result } = await previewThenConfirm(args, deps);
    expect(preview.preview).toContain('Create customer-list audience "Existing customers (Zoma)"');
    expect(preview.preview).toContain('excluded_custom_audiences [333] → [333, <new audience>]');
    expect(preview.preview).not.toContain('buyer@shop.com');

    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', audience_id: '600' });
    expect(deps.previewAdSetUpdate).toHaveBeenCalledWith('u1', '111', '701', {
      targeting: { geo_locations: { countries: ['US'] }, excluded_custom_audiences: [{ id: '333' }, { id: '600' }] },
    });
    expect(deps.dispatch).toHaveBeenCalledWith('u1', expect.objectContaining({ entity_type: 'AD_SET', action: 'UPDATE', ad_set_id: '701' }));
    // status/budget untouched
    expect(meta.adSets['701'].status).toBe('ACTIVE');
  });

  it('reuses an existing customer list with the same name, and a given audience_id', async () => {
    const { deps, meta } = makeDeps();
    const reuse = await previewThenConfirm({ ...base, action: 'EXCLUDE_CUSTOMERS', ad_set_ids: ['701'], params: { name: 'Buyers', emails: ['a@b.co'] } }, deps);
    expect(reuse.preview.preview).toContain('Use existing customer list "Buyers" (501)');
    expect(reuse.result).toMatchObject({ verification: 'CONFIRMED', audience_id: '501' });
    expect(writesSent(meta.graph).filter((c) => c[3] === '{account}/customaudiences')).toHaveLength(0);

    const again = await previewThenConfirm({ ...base, action: 'EXCLUDE_CUSTOMERS', ad_set_ids: ['701'], audience_id: '501' }, deps);
    expect(again.preview.preview).toContain('unchanged (already excluded)');
    expect(again.result.verification).toBe('CONFIRMED');
  });

  it('refuses an ad set that targets the audience, and ad sets from another account', async () => {
    const { deps } = makeDeps();
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'EXCLUDE_CUSTOMERS', ad_set_ids: ['702'], audience_id: '501' }, deps)).rejects.toThrow(/cannot also exclude/);
    await expect(executeMetaToolkitAudience('u1', { ...base, action: 'EXCLUDE_CUSTOMERS', ad_set_ids: ['799'], audience_id: '501' }, deps)).rejects.toThrow(/not in the selected ad account/);
  });

  it('a changed ad set targeting after the preview invalidates the token (PREVIEW_MISMATCH)', async () => {
    const { deps, meta } = makeDeps();
    const args = { ...base, action: 'EXCLUDE_CUSTOMERS', ad_set_ids: ['701'], audience_id: '501' };
    const preview: any = await executeMetaToolkitAudience('u1', args, deps);
    meta.adSets['701'].targeting.excluded_custom_audiences.push({ id: '444' });
    const r: any = await executeMetaToolkitAudience('u1', { ...args, confirm: true, preview_token: preview.preview_token }, deps);
    expect(r.status).toBe('PREVIEW_MISMATCH');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('read-back without the exclusion → MISMATCH; shared gate refusal is reported per ad set', async () => {
    const { deps } = makeDeps({ dispatch: jest.fn().mockResolvedValue({ result: { success: true } }) });
    const { result } = await previewThenConfirm({ ...base, action: 'EXCLUDE_CUSTOMERS', ad_set_ids: ['701'], audience_id: '501' }, deps);
    expect(result).toMatchObject({ success: false, verification: 'MISMATCH' });
    const blocked = makeDeps({ previewAdSetUpdate: jest.fn().mockResolvedValue({ success: false, error: 'Ad set is archived' }) });
    const b = await previewThenConfirm({ ...base, action: 'EXCLUDE_CUSTOMERS', ad_set_ids: ['701'], audience_id: '501' }, blocked.deps);
    expect(b.result.steps).toEqual([expect.objectContaining({ ad_set_id: '701', result: 'not_sent', error: 'Ad set is archived' })]);
    expect(blocked.deps.dispatch).not.toHaveBeenCalled();
  });
});
