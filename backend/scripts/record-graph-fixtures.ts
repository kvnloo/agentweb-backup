/**
 * Record sanitized Graph API transcripts of exactly the read set the product performs
 * (ENG-1908 AC 2: the simulator must match real responses field-for-field).
 *
 * Usage (token only ever lives in this process's environment):
 *   env META_FIXTURE_TOKEN="$(aws secretsmanager get-secret-value --secret-id dev/AgentWeb/Meta --query SecretString --output text)" \
 *       META_FIXTURE_ACCOUNT=<numeric ad account id> \
 *       npx ts-node scripts/record-graph-fixtures.ts <output-dir>
 *
 * Never point this at a customer's account. Every real id becomes a deterministic fake id
 * of the same length, names and URLs are replaced, tokens and trace ids removed; keys,
 * types, nesting and ordering are preserved so the fixtures stay a faithful shape contract.
 */
import * as fs from 'fs';
import * as path from 'path';

const GRAPH = 'https://graph.facebook.com/v25.0';
const token = process.env.META_FIXTURE_TOKEN;
const accountId = process.env.META_FIXTURE_ACCOUNT;
const outDir = process.argv[2];
if (!token || !accountId || !outDir) {
  console.error('META_FIXTURE_TOKEN, META_FIXTURE_ACCOUNT and an output directory are required');
  process.exit(2);
}
if (!/^\d+$/.test(accountId)) { console.error('META_FIXTURE_ACCOUNT must be numeric'); process.exit(2); }

const CAMPAIGN_READ_FIELDS = 'id,name,status,objective,daily_budget,lifetime_budget,budget_remaining,spend_cap,bid_strategy,start_time,stop_time,effective_status,special_ad_categories';
const AD_SET_READ_FIELDS = 'id,name,status,campaign_id,optimization_goal,billing_event,destination_type,promoted_object,bid_strategy,bid_amount,daily_budget,lifetime_budget,start_time,end_time,targeting';
const AD_EFFECTIVE_STATUSES = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES'];
const PERF_FIELDS = 'impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,ad_id,actions,cost_per_action_type';

const yesterday = new Date(Date.now() - 86400000);
const since = new Date(yesterday.getTime() - 29 * 86400000);
const day = (d: Date) => d.toISOString().slice(0, 10);
const timeRange = JSON.stringify({ since: day(since), until: day(yesterday) });

// ---- sanitization -------------------------------------------------------------------------
const idMap = new Map<string, string>();
let idCounter = 0;
function fakeId(real: string): string {
  if (!idMap.has(real)) {
    idCounter += 1;
    const body = String(idCounter).padStart(Math.max(real.length - 4, 1), '0');
    idMap.set(real, ('1200' + body).slice(0, Math.max(real.length, 5)).padEnd(Math.max(real.length, 5), '0'));
  }
  return idMap.get(real)!;
}
const ID_KEYS = new Set(['id', 'account_id', 'campaign_id', 'adset_id', 'ad_id', 'creative_id', 'report_run_id', 'page_id', 'user_id', 'pixel_id', 'business_id', 'custom_conversion_id', 'instagram_actor_id', 'object_story_id', 'target_ids', 'video_id']);
const NAME_KEYS = new Set(['name', 'campaign_name', 'adset_name', 'ad_name', 'account_name', 'title', 'body', 'message', 'caption', 'description']);
const URL_KEYS = new Set(['link', 'link_url', 'url', 'image_url', 'thumbnail_url', 'picture', 'website_url', 'next', 'previous']);
/** Real paging cursors base64-encode the first/last object id of the page — a decoded cursor is a leak. */
const CURSOR_KEYS = new Set(['before', 'after']);
let nameCounter = 0; let assetCounter = 0; let cursorCounter = 0;
const hashMap = new Map<string, string>();
/** Real image hashes name assets in the recording account; synthetic hex keeps the shape. */
function fakeHash(real: string): string {
  if (!hashMap.has(real)) hashMap.set(real, (hashMap.size + 1).toString(16).padStart(32, 'ab'));
  return hashMap.get(real)!;
}
function sanitize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map(v => sanitize(v, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'fbtrace_id') { out[k] = 'sanitized'; continue; }
      if (k === 'app_id' || k === 'application') { out[k] = typeof v === 'string' ? '0' : v; continue; }
      if (k === 'access_token') continue;
      out[k] = sanitize(v, k);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (value.startsWith('EAA') && value.length > 40) return 'removed';
    if (ID_KEYS.has(key) && /^\d{5,}$/.test(value)) return fakeId(value);
    if (key === 'id' && /^act_\d+$/.test(value)) return `act_${fakeId(value.slice(4))}`;
    if (CURSOR_KEYS.has(key)) return Buffer.from(`sanitized-cursor-${++cursorCounter}`).toString('base64');
    if (key === 'image_hash') return fakeHash(value);
    if (URL_KEYS.has(key) || /^https?:\/\//.test(value)) {
      if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(value) || key === 'image_url' || key === 'thumbnail_url' || key === 'picture') return `https://example.invalid/asset/${++assetCounter}.jpg`;
      // The path of a paging URL carries the ad account id (…/act_<id>/adcreatives); remap it too.
      try { return `https://example.invalid${sanitizePath(new URL(value).pathname)}`; } catch { return 'https://example.invalid/'; }
    }
    if (NAME_KEYS.has(key)) return `${key === 'title' ? 'Headline' : key === 'body' || key === 'message' ? 'Primary text' : 'Object'} ${++nameCounter}`;
    if (/^\d{5,}$/.test(value) && idMap.has(value)) return idMap.get(value)!;
    // Any other long all-digit string is an object id under a key this list does not know
    // (instagram actors, pages inside nested specs, …). No metric in this read set is 9+ digits.
    if (/^\d{9,}$/.test(value)) return fakeId(value);
    return value;
  }
  return value;
}

/** Every run of 5+ digits in a path is an object id: campaign, ad account, report run. */
function sanitizePath(p: string): string {
  return p.replace(/\d{5,}/g, m => fakeId(m));
}
/** Credentials never reach the fixture even in the recorded request. */
function stripSecrets(query: Record<string, string>): Record<string, string> {
  const out = { ...query };
  delete out.access_token; delete out.input_token; delete out.appsecret_proof;
  return out;
}

// ---- recording ----------------------------------------------------------------------------
interface Fixture { name: string; file: string; kind: 'node' | 'edge' | 'insights' | 'report' | 'meta' }
const fixtures: Fixture[] = [];
const failures: string[] = [];
fs.mkdirSync(outDir, { recursive: true });

async function graph(method: 'GET' | 'POST', p: string, query: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const params = new URLSearchParams({ ...query, access_token: token! });
  const url = `${GRAPH}/${p}${method === 'GET' ? `?${params}` : ''}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() });
  const body = await res.json();
  return { status: res.status, body };
}
/**
 * Belt and braces over the structural sanitizer: a run of 9+ digits outside the synthetic
 * 1200… range inside ANY string (a bare id, an act_ id, a URL path, a PAGE_POST compound id)
 * is a real object id. Refuse to write the fixture rather than ship it.
 */
function assertNoRealIds(value: unknown, name: string): void {
  if (Array.isArray(value)) return value.forEach(v => assertNoRealIds(v, name));
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).forEach(v => assertNoRealIds(v, name));
  if (typeof value === 'string') {
    for (const run of value.match(/\d{9,}/g) || []) {
      if (!run.startsWith('1200')) throw new Error(`${name}: unsanitized id ${run} in "${value.slice(0, 80)}" — fixture not written`);
    }
  }
}
function write(name: string, kind: Fixture['kind'], method: 'GET' | 'POST', p: string, query: Record<string, string>, status: number, body: unknown) {
  const file = `${name}.json`;
  const fixture = { request: { method, path: sanitizePath(p), query: sanitize(stripSecrets(query)) }, status, body: sanitize(body) };
  assertNoRealIds(fixture, name);
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(fixture, null, 2));
  fixtures.push({ name, file, kind });
  console.log(`recorded ${name}`);
}
/** Records one read. A failure is logged (sanitized, first 300 chars) and remembered; the run continues so one denied edge does not lose the rest. */
async function record(name: string, kind: Fixture['kind'], method: 'GET' | 'POST', p: string, query: Record<string, string>): Promise<any> {
  const { status, body } = await graph(method, p, query);
  if (status !== 200 || (body as { error?: unknown }).error) {
    console.error(`${name}: ${status} ${JSON.stringify(sanitize(body)).slice(0, 300)}`);
    failures.push(name);
    return null;
  }
  write(name, kind, method, p, query, status, body);
  return body;
}

(async () => {
  // The token may see several ad accounts (a Business Manager token typically does). Only the
  // account explicitly named is recorded; every other row is dropped before anything is written.
  const meQuery = { fields: 'id,name,account_id,currency,account_status' };
  const me = await graph('GET', 'me/adaccounts', meQuery);
  const rows: Array<{ account_id: string }> = (me.body as any)?.data || [];
  if (me.status !== 200 || !rows.some(a => a.account_id === accountId)) {
    throw new Error('META_FIXTURE_ACCOUNT is not among the token\'s ad accounts — refusing to record a foreign account');
  }
  write('me-adaccounts', 'edge', 'GET', 'me/adaccounts', meQuery, 200, { ...(me.body as object), data: rows.filter(a => a.account_id === accountId) });
  await record('me-permissions', 'edge', 'GET', 'me/permissions', {});
  await record('debug-token', 'meta', 'GET', 'debug_token', { input_token: token! });
  await record('account', 'node', 'GET', `act_${accountId}`, { fields: 'account_id,name,currency,timezone_name,account_status,business' });
  await record('campaigns', 'edge', 'GET', `act_${accountId}/campaigns`, { fields: CAMPAIGN_READ_FIELDS, limit: '100' });
  await record('adsets', 'edge', 'GET', `act_${accountId}/adsets`, { fields: AD_SET_READ_FIELDS, limit: '100' });
  await record('ads', 'edge', 'GET', `act_${accountId}/ads`, { fields: 'id,name,status,effective_status,adset_id,campaign_id,creative{id,name,body,title,image_url,thumbnail_url,object_story_spec}', effective_status: JSON.stringify(AD_EFFECTIVE_STATUSES), limit: '100' });
  await record('adcreatives', 'edge', 'GET', `act_${accountId}/adcreatives`, { fields: 'id,name,status,body,title,image_url,thumbnail_url,object_type,link_url,object_story_spec,url_tags', limit: '100' });
  await record('adspixels', 'edge', 'GET', `act_${accountId}/adspixels`, { fields: 'id,name,last_fired_time,is_created_by_business', limit: '100' });
  for (const level of ['ad', 'adset', 'campaign']) {
    await record(`insights-${level}`, 'insights', 'GET', `act_${accountId}/insights`, { level, fields: PERF_FIELDS, action_breakdowns: 'action_type', action_report_time: 'conversion', action_attribution_windows: 'default', time_range: timeRange, limit: '500' });
  }
  for (const [name, breakdowns] of [['breakdown-age-gender', 'age,gender'], ['breakdown-placement', 'publisher_platform,platform_position'], ['breakdown-device', 'impression_device']]) {
    await record(`insights-${name}`, 'insights', 'GET', `act_${accountId}/insights`, { level: 'campaign', fields: 'impressions,clicks,spend,reach,frequency,campaign_id,actions', breakdowns, time_range: timeRange, limit: '500' });
  }
  // Async report flow exactly as callMetaAdsInsightsApiWrapper drives it.
  const started = await record('insights-async-start', 'report', 'POST', `act_${accountId}/insights`, { level: 'campaign', fields: 'impressions,spend,actions,date_start,date_stop', time_increment: '1', date_preset: 'last_7d', limit: '5000' });
  if (started?.report_run_id) {
    const rid = started.report_run_id as string;
    let done = false;
    for (let i = 0; i < 30 && !done; i++) {
      const { body } = await graph('GET', rid, {});
      const state = (body as { async_status?: string }).async_status || '';
      if (state === 'Job Completed') done = true;
      else if (/Failed|Skipped/.test(state)) { console.error(`async report ended in ${state}`); break; }
      else await new Promise(r => setTimeout(r, 2000));
    }
    await record('insights-async-status', 'report', 'GET', rid, {});
    if (done) await record('insights-async-rows', 'insights', 'GET', `${rid}/insights`, { limit: '5000' });
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({
    source: 'real-account', recordedAt: new Date().toISOString(), graphVersion: 'v25.0',
    accountClass: 'agentweb-own-ad-account', sanitization: 'ids remapped deterministically (values and URL paths), names/urls replaced, paging cursors and image hashes synthetic, tokens and trace ids removed',
    fixtures, ...(failures.length ? { notRecorded: failures } : {}),
  }, null, 2));
  console.log(`wrote ${fixtures.length} fixtures + index.json to ${outDir}${failures.length ? `; NOT recorded: ${failures.join(', ')}` : ''}`);
  if (failures.length) process.exit(3);
})().catch(e => { console.error(e.message); process.exit(1); });
