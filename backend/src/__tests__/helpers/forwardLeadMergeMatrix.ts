/**
 * The (existing row x incoming payload) matrix shared by the ENG-2320 equivalence suite and the
 * throwaway dynamodb-local diff harness. Data only: no jest globals, so a plain node script can
 * import it.
 */

export const OLD = '2020-01-01T00:00:00.000Z';
export const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
export const EMAIL = 'ann@example.com';

// ── existing rows ─────────────────────────────────────────────────────────────────────────
export const base = { listId: 'L0', leadId: 'lead_1', email: EMAIL, createdAt: OLD, updatedAt: OLD };
export const EXISTING: Record<string, any> = {
  bare: { ...base },
  full: {
    ...base, firstName: 'Ann', lastName: 'Lee', company: 'Acme', phone: '555', title: 'CTO', notes: 'n',
    linkedin: 'https://www.linkedin.com/in/ann', nameCompanyKey: 'ann|lee|acme', domain: 'example.com', lifecycle: 'inbox',
    status: 'qualified', dealValue: 5000, selectedSenderId: 's1', isICP: 1,
    customFields: {
      source: 'hero-form', forwardedAt: OLD, a: 1, nested: { x: 1, y: 2 }, blank: '', zero: 0, flag: false, nul: null, list: [1, 2],
    },
  },
  attributed: {
    ...base, firstName: 'Ann', customFields: { source: 'lp' },
    firstTouch: { timestamp: OLD, utm: { source: 'old', medium: 'email' }, clickIds: { gclid: 'OLD' } },
    lastTouch: { timestamp: OLD, utm: { source: 'old', medium: 'email' } },
    utmSource: 'old', utmMedium: 'email', clickIds: { gclid: 'OLD' },
    metaFbp: 'fb.old', clientIp: '198.51.100.1', clientUserAgent: 'UA-old',
  },
  firstTouchOnly: { ...base, customFields: { source: 'lp', a: '1' }, firstTouch: { timestamp: OLD, utm: { source: 'seed' } } },
  legacyEmptyGsi: { ...base, firstName: 'Bob', linkedin: '', nameCompanyKey: '', customFields: { source: 'lp' } },
  noSource: { ...base, customFields: { a: 1, b: 2 } },
  noAttribution: { ...base, firstName: 'Ann', customFields: { source: 'lp' } },
};

// ── incoming payloads ─────────────────────────────────────────────────────────────────────
export const TOUCH = { timestamp: '2026-01-01T00:00:00.000Z', utm: { source: 'google', medium: 'cpc', campaign: 'c1' }, clickIds: { gclid: 'G1' } };
export const many = (n: number, prefix: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, `v${i}`]));
export type Payload = { body: Record<string, any>; headers?: Record<string, string> };
export const MQ_HEADERS = { 'User-Agent': BROWSER_UA, 'X-Forwarded-For': '203.0.113.7' };
export const PAYLOADS: Record<string, Payload> = {
  emailOnly: { body: {} },
  sameValues: { body: { source: 'hero-form', customFields: { a: 1 } } },
  newKey: { body: { customFields: { q1: 'yes' } } },
  changedValue: { body: { customFields: { a: 2 } } },
  namedSource: { body: { source: 'step2', customFields: { q2: 'x' } } },
  sourceInCustomFields: { body: { customFields: { source: 'cfsrc' } } },
  names: { body: { firstName: 'Anna', lastName: ' Lee ', company: 'Acme', title: '   ', phone: '555', notes: 'new note', linkedin: ' https://www.linkedin.com/in/anna ' } },
  namesEqualAfterTrim: { body: { firstName: ' Ann ', lastName: 'Lee' } },
  flatPassthrough: { body: { referrerPage: '/pricing', plan: 'pro', customFields: { plan: 'enterprise' } } },
  nestedKeyOrder: { body: { customFields: { nested: { y: 2, x: 1 } } } },
  falsyValues: { body: { customFields: { zero: '', flag: null, blank: 'x', nul: 'v', list: [2, 1] } } },
  specialKeys: {
    body: { customFields: { domain: 'd', system: 's', name: 'n', status: 'st', type: 't', 'a.b': 1, 'with space': 2, 'café': 3, 'k-1': 4, '#h': 5, ':c': 6, '0lead': 7 } },
  },
  callerForwardedAt: { body: { customFields: { forwardedAt: 'caller-supplied' } } },
  attribution: { body: { attribution: TOUCH, customFields: { q: 1 } } },
  attributionOnly: { body: { attribution: TOUCH } },
  flatUtm: { body: { utm: { utm_source: 'fb', utm_medium: 'paid', timestamp: '2026-02-02T00:00:00.000Z' } } },
  lastTouchSeparate: { body: { attribution: TOUCH, lastTouch: { timestamp: '2026-03-03T00:00:00.000Z', utm: { source: 'li' } } } },
  promotedFromCustomFields: { body: { customFields: { utm_source: 'news', gclid: 'GP' } } },
  matchQuality: { body: { fbp: 'fb.1.2.3' }, headers: MQ_HEADERS },
  matchQualityDeclared: {
    body: { visitorIp: '203.0.113.9', visitorUserAgent: BROWSER_UA }, headers: { 'User-Agent': 'node', 'X-Forwarded-For': '44.202.76.171' },
  },
  everything: {
    body: {
      firstName: 'Zed', company: 'Zed Co', source: 'multi', customFields: { q1: 'a', source: 'multi', nested: { x: 9 } },
      attribution: TOUCH, fbp: 'fb.9.9.9',
    },
    headers: MQ_HEADERS,
  },
  manyKeys: { body: { customFields: many(120, 'k') } },
  passthroughOverCap: { body: many(60, 'flat') },
};

export const LISTS: Record<string, any> = {
  normal: { listId: 'L0', userId: 'u1', name: 'L', publicAccessEnabled: true, leadCount: 1, fieldNames: ['a', 'source'] },
  noFieldNames: { listId: 'L0', userId: 'u1', name: 'L', publicAccessEnabled: true, leadCount: 1 },
  drifted: { listId: 'L0', userId: 'u1', name: 'L', publicAccessEnabled: true, leadCount: 1, fieldNames: [] },
};

// ── normalisation ─────────────────────────────────────────────────────────────────────────
const NOW_WINDOW_MS = 24 * 3600 * 1000;
const isNowIso = (v: any) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Math.abs(Date.parse(v) - Date.now()) < NOW_WINDOW_MS;
export const norm = (v: any): any => {
  if (isNowIso(v)) return '<NOW>';
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, norm(x)]));
  return v;
};

export const CASES: Array<[string, string, string]> = [];
for (const e of Object.keys(EXISTING)) for (const p of Object.keys(PAYLOADS)) CASES.push([e, p, 'normal']);
// list-shape variants: the fieldNames sync must behave the same when the list row is bare or drifted
for (const l of ['noFieldNames', 'drifted']) {
  for (const e of ['full', 'bare']) for (const p of ['emailOnly', 'newKey', 'names', 'attribution']) CASES.push([e, p, l]);
}
