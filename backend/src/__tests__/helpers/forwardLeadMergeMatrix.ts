/**
 * The (existing row x incoming payload) matrix shared by the ENG-2320 equivalence suite and the
 * throwaway dynamodb-local diff harness. Data only: no jest globals, so a plain node script can
 * import it.
 */
import { phoneLeadId } from '../../utils/smokeTestLead';

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
  // denormalised attribution stored as empty strings (a CSV-import shape): an `if_not_exists`
  // backfill would keep them, the snapshot check overwrites them — see the PR on why that stays
  emptyDenorm: { ...base, firstName: 'Ann', customFields: { source: 'lp' }, utmSource: '', utmMedium: '' },
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
  // an OWN `__proto__` key (what JSON.parse of a hostile body produces); the whole-map write dropped it
  protoKey: { body: JSON.parse('{"customFields":{"__proto__":{"x":1},"constructor":"c","ok":1}}') },
  // the AI-readiness funnel: a valid `stage` makes the route mark the lead after sending the roadmap
  roadmap: { body: { source: 'ai-readiness-popup', firstName: 'Rae', customFields: { stage: 3, q: 'x' } } },
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

// ── phone-only adopt branch (a synthetic smoke-test number: deterministic leadId, no email) ──
export const PHONE = '4155550142';
export const ADOPT_EXISTING: Record<string, any> = {
  adoptBare: { listId: 'L0', leadId: phoneLeadId(PHONE), phone: PHONE, createdAt: OLD, updatedAt: OLD },
  adoptFull: {
    listId: 'L0', leadId: phoneLeadId(PHONE), phone: PHONE, firstName: 'Pat', company: 'Acme', createdAt: OLD, updatedAt: OLD,
    customFields: { source: 'phone-lp', forwardedAt: OLD, a: 1, nested: { x: 1, y: 2 }, zero: 0 },
  },
};
export const ADOPT_PAYLOADS: Record<string, Payload> = {
  adoptEmpty: { body: {} },
  adoptNewKey: { body: { customFields: { q1: 'yes' } } },
  adoptChanged: { body: { customFields: { a: 2 } } },
  adoptSameAfterNormalize: { body: { customFields: { a: '1' } } },
  adoptSource: { body: { source: 'step2', customFields: { q2: 'x' } } },
  adoptNames: { body: { firstName: 'Pat2', lastName: 'Q', company: 'Acme2' } },
  adoptSpecialKeys: { body: { customFields: { domain: 'd', system: 's', name: 'n', 'a.b': 1 } } },
  adoptEmptyValues: { body: { customFields: { a: '', b: null, c: 'v' } } },
};

export const CASES: Array<[string, string, string]> = [];
for (const e of Object.keys(EXISTING)) for (const p of Object.keys(PAYLOADS)) CASES.push([e, p, 'normal']);
// list-shape variants: the fieldNames sync must behave the same when the list row is bare or drifted
for (const l of ['noFieldNames', 'drifted']) {
  for (const e of ['full', 'bare']) for (const p of ['emailOnly', 'newKey', 'names', 'attribution']) CASES.push([e, p, l]);
}
for (const e of Object.keys(ADOPT_EXISTING)) for (const p of Object.keys(ADOPT_PAYLOADS)) CASES.push([e, p, 'normal']);

/**
 * The reduced set committed to the repo as the permanent regression net: together these cases
 * exercise every merge rule (precedence, source / forwardedAt, attribution matrix, match-quality,
 * fieldNames incl. drift, GSI self-heal, bootstrap, chunking, special keys (chunking is covered by the crmDb unit test), roadmap marker, adopt
 * branch). The FULL matrix (CASES) is the one-off migration proof recorded on the PR.
 */
export const REDUCED_KEYS = [
  'full x emailOnly @ normal', 'full x sameValues @ normal', 'full x newKey @ normal', 'full x changedValue @ normal',
  'full x namedSource @ normal', 'full x sourceInCustomFields @ normal', 'full x names @ normal',
  'full x namesEqualAfterTrim @ normal', 'full x flatPassthrough @ normal', 'full x nestedKeyOrder @ normal',
  'full x falsyValues @ normal', 'full x specialKeys @ normal', 'full x callerForwardedAt @ normal',
  'full x protoKey @ normal', 'full x roadmap @ normal',
  'bare x newKey @ normal', 'bare x emailOnly @ normal', 'bare x roadmap @ normal', 'noSource x newKey @ normal',
  'attributed x attribution @ normal', 'attributed x lastTouchSeparate @ normal', 'attributed x matchQuality @ normal',
  'attributed x everything @ normal', 'firstTouchOnly x attribution @ normal', 'firstTouchOnly x matchQuality @ normal',
  'firstTouchOnly x matchQualityDeclared @ normal', 'noAttribution x attribution @ normal',
  'noAttribution x promotedFromCustomFields @ normal', 'noAttribution x flatUtm @ normal',
  'noAttribution x attributionOnly @ normal', 'emptyDenorm x attribution @ normal', 'legacyEmptyGsi x names @ normal',
  'full x newKey @ drifted', 'full x names @ noFieldNames', 'bare x emailOnly @ noFieldNames',
  'adoptBare x adoptNewKey @ normal', 'adoptBare x adoptEmpty @ normal', 'adoptFull x adoptEmpty @ normal',
  'adoptFull x adoptNewKey @ normal', 'adoptFull x adoptChanged @ normal', 'adoptFull x adoptSameAfterNormalize @ normal',
  'adoptFull x adoptSource @ normal', 'adoptFull x adoptNames @ normal', 'adoptFull x adoptSpecialKeys @ normal',
  'adoptFull x adoptEmptyValues @ normal',
];
