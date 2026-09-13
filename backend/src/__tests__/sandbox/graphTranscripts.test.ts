/**
 * ENG-1908 AC 2: the simulator must match real Graph API responses field-for-field. The
 * fixtures under fixtures/graph-transcripts are sanitized recordings of the product's exact
 * read set against a real ad account (see scripts/record-graph-fixtures.ts). This suite
 * pins that every fixture is well-formed and exports the key/type skeleton the simulator's
 * parity tests compare against.
 */
import * as fs from 'fs';
import * as path from 'path';

const dir = path.join(__dirname, 'fixtures', 'graph-transcripts');

export interface Transcript {
  request: { method: 'GET' | 'POST'; path: string; query: Record<string, string> };
  status: number;
  body: unknown;
}
interface Index { source: 'real-account' | 'documented'; recordedAt: string; fixtures: Array<{ name: string; file: string; kind: 'node' | 'edge' | 'insights' | 'report' | 'meta' }> }

export function loadIndex(): Index {
  return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
}
export function loadTranscript(name: string): Transcript {
  const entry = loadIndex().fixtures.find(f => f.name === name);
  if (!entry) throw new Error(`no transcript named ${name}`);
  return JSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8'));
}

/**
 * Key/type skeleton of a response: arrays are represented by the skeleton of their first
 * element, scalars by their JSON type. Two responses with the same skeleton have the same
 * fields with the same types in the same nesting — the parity contract for the simulator.
 */
export function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0])] : [];
  if (value === null) return 'null';
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shapeOf(v)]));
  }
  return typeof value;
}
export function transcriptShape(name: string): unknown {
  return shapeOf(loadTranscript(name).body);
}

const NUMERIC_ID_KEYS = new Set(['id', 'account_id', 'campaign_id', 'adset_id', 'ad_id', 'creative_id', 'report_run_id', 'page_id', 'user_id', 'instagram_user_id']);
const METRIC_KEYS = new Set(['impressions', 'clicks', 'spend', 'reach', 'frequency', 'ctr', 'cpc', 'cpm', 'inline_link_clicks', 'daily_budget', 'lifetime_budget', 'budget_remaining', 'spend_cap', 'bid_amount']);
/** `value` is a string metric inside these action arrays, but an object elsewhere (call_to_action.value). */
const ACTION_LISTS = new Set(['actions', 'cost_per_action_type', 'conversions', 'action_values', 'cost_per_conversion']);

function walk(value: unknown, visit: (key: string, v: unknown, parent: string) => void, key = '', parent = ''): void {
  if (Array.isArray(value)) return value.forEach(v => walk(v, visit, key, parent));
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).forEach(([k, v]) => { visit(k, v, key); walk(v, visit, k, key); });
}

describe('recorded Graph transcripts', () => {
  const index = loadIndex();

  it('declares its provenance', () => {
    expect(['real-account', 'documented']).toContain(index.source);
    expect(index.fixtures.length).toBeGreaterThanOrEqual(12);
  });

  it.each(index.fixtures.map(f => [f.name, f.kind] as const))('%s is well-formed (%s)', (name, kind) => {
    const t = loadTranscript(name);
    expect(t.status).toBe(200);
    expect(t.body).toBeTruthy();
    expect((t.body as Record<string, unknown>).error).toBeUndefined();
    if (kind === 'edge' || kind === 'insights') {
      expect(Array.isArray((t.body as { data: unknown[] }).data)).toBe(true);
      const paging = (t.body as { paging?: unknown }).paging;
      if (paging !== undefined) expect(typeof paging).toBe('object');
    }
    walk(t.body, (key, v, parent) => {
      if (v === null || v === undefined) return;
      // Graph ids are numeric strings; the ad account node alone is prefixed act_.
      if (NUMERIC_ID_KEYS.has(key)) { expect(typeof v).toBe('string'); expect(v).toMatch(/^(act_)?\d+$/); }
      if (METRIC_KEYS.has(key) || (key === 'value' && ACTION_LISTS.has(parent))) expect(typeof v).toBe('string');
    });
    // Sanitization held over the whole transcript, request path included: every 9+ digit run
    // inside ANY string (a bare id, an act_ id, a paging URL path, a PAGE_POST compound id) was
    // remapped onto the synthetic 1200… range. Numbers (epoch timestamps) are not ids.
    walk({ request: t.request, body: t.body }, (key, v) => {
      if (typeof v !== 'string') return;
      for (const run of v.match(/\d{9,}/g) || []) expect(run).toMatch(/^1200/);
      // Real paging cursors base64-encode object ids; a recorded cursor must be the synthetic marker.
      if (key === 'before' || key === 'after') expect(Buffer.from(v, 'base64').toString('utf8')).toMatch(/^sanitized-cursor-\d+$/);
    });
    // Sanitization held: no token-looking strings, no real domains, no trace ids, no addresses.
    const raw = JSON.stringify(t.body);
    expect(raw).not.toMatch(/EAA[A-Za-z0-9]{20,}/);
    expect(raw).not.toMatch(/fbtrace_id":"(?!sanitized)/);
    expect(raw).not.toMatch(/https?:\/\/(?!example\.invalid)/);
    expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
  });

  it('the skeleton helper is stable and type-faithful', () => {
    expect(shapeOf({ data: [{ id: '1', spend: '2.00', actions: [{ action_type: 'lead', value: '3' }] }], paging: { cursors: { before: 'a' } } }))
      .toEqual({ data: [{ id: 'string', spend: 'string', actions: [{ action_type: 'string', value: 'string' }] }], paging: { cursors: { before: 'string' } } });
  });
});
