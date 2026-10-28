/**
 * ENG-2689 (ENG-2681 slice 2): the 40 super properties from the tracking plan's "#super properties"
 * tab, attached to every event. The SDK sends them as one `super` object; the ingest keeps only the
 * names below, typed and length-bounded, as `super.<name>` fields (leading `#` dropped). The field
 * set a list can acquire is therefore fixed by this table, never by the request body, and it is only
 * applied to lists that opted in with an ENG-2688 allow-list.
 *
 * `#ip` and the IP-derived geo fields are listed for completeness but are server-derived in the plan;
 * a browser-supplied `#ip` is spoofable personal data, so the ingest never stores it from the client.
 */
export type SuperPropKind = 'string' | 'number' | 'boolean' | 'time';

export const SUPER_PROPERTIES: Readonly<Record<string, SuperPropKind>> = Object.freeze({
  '#event_time': 'time',
  '#ip': 'string',
  '#country': 'string',
  '#country_code': 'string',
  '#province': 'string',
  '#city': 'string',
  '#os': 'string',
  '#os_version': 'string',
  '#browser': 'string',
  '#browser_version': 'string',
  '#screen_width': 'number',
  '#screen_height': 'number',
  '#ua': 'string',
  '#device_id': 'string',
  '#zone_offset': 'number',
  '#system_language': 'string',
  '#lib': 'string',
  '#lib_version': 'string',
  '#url': 'string',
  '#referrer': 'string',
  '#title': 'string',
  '#duration': 'number',
  funnel_type: 'string',
  site_domain: 'string',
  site_section: 'string',
  page_category: 'string',
  landing_page: 'string',
  referrer_domain: 'string',
  click_id: 'string',
  click_id_type: 'string',
  device_type: 'string',
  region: 'string',
  consent_marketing: 'string',
  session_intent_score: 'number',
  session_page_num: 'number',
  is_login: 'boolean',
  user_type: 'string',
  current_plan: 'string',
  company_domain: 'string',
  holdout_group: 'string',
});

/** Never accepted from the browser (see header). */
const SERVER_ONLY: ReadonlySet<string> = new Set(['#ip']);

const LONG: ReadonlySet<string> = new Set(['#url', '#referrer', '#ua', '#title']);
const URLISH: ReadonlySet<string> = new Set(['#url', '#referrer']);

const cleanText = (v: string, n: number): string => v.slice(0, n).replace(/[^\p{L}\p{M}\p{N}_.@+:/ -]/gu, '').trim();
const cleanUrlText = (v: string, n: number): string => v.slice(0, n).replace(/[^\w.~:/?#[\]@!$&'()*+,;=%-]/g, '');

/** Field name a super property is stored under. */
export const superFieldName = (name: string): string => `super.${name.replace(/^#/, '')}`;

/**
 * Typed, bounded super-property fields from an untrusted `super` object. Unknown names, wrong types,
 * non-finite numbers and empty strings are dropped. Booleans are stored as 1/0 (same as ENG-2688).
 */
export function parseSuperProps(input: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const src = input as Record<string, unknown>;
  for (const [name, kind] of Object.entries(SUPER_PROPERTIES)) {
    if (SERVER_ONLY.has(name) || !Object.prototype.hasOwnProperty.call(src, name)) continue;
    const v = src[name];
    const key = superFieldName(name);
    if (kind === 'string' && typeof v === 'string') {
      const s = URLISH.has(name) ? cleanUrlText(v, 1000) : cleanText(v, LONG.has(name) ? 300 : 120);
      if (s) out[key] = s;
    } else if ((kind === 'number' || kind === 'time') && typeof v === 'number' && Number.isFinite(v)) {
      out[key] = kind === 'time' ? Math.max(0, Math.min(Math.trunc(v), Number.MAX_SAFE_INTEGER)) : Math.max(-1e9, Math.min(v, 1e9));
    } else if (kind === 'boolean' && typeof v === 'boolean') {
      out[key] = v ? 1 : 0;
    }
  }
  return out;
}
