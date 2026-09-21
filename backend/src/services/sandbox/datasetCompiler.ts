import { readDatasetFile } from './datasetFiles';
import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import { resolve, sep } from 'path';
import { parse } from 'csv-parse/sync';
import { load } from 'js-yaml';
import { META_OBJ_GOAL_MAP, META_GOAL_BILLING_MAP, META_GOAL_BID_STRATEGY_MAP } from '../../utils/metaConstants';
import { isDay } from './dateShift';
import { validateDataset } from './sandboxDatasetStore';
import type { SandboxDataset, SandboxInsightsDaily, SandboxBreakdown } from './types';

type Row = Record<string, string>;
export interface SandboxCase {
  datasetId: string; version: number; caseId: string; name: string;
  currency: string; timezone: string; reviewWindowSeconds?: number;
  page?: { name: string; category: string }; pixel?: { name: string };
  landers?: Array<{ url: string }>;
  displayNames?: Record<string, string>;
  targeting?: Record<string, { countries: string[]; ageMin: number; ageMax: number; summary?: string }>;
}
const METRICS = ['spend', 'impressions', 'clicks', 'inline_link_clicks', 'reported_leads', 'reported_complete_registrations', 'reported_purchases'] as const;
type Metric = typeof METRICS[number];
const fail = (message: string): never => { throw new Error(`Sandbox compiler: ${message}`); };
export const SANDBOX_PLACEHOLDER_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoaGj4DwAFhAKAjM1mJgAAAABJRU5ErkJggg==', 'base64');
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function safeTree(value: unknown, inUrl: boolean): void {
  if (typeof value === 'string') {
    if (/\bEAA[A-Za-z0-9]+|access_token|bearer\s+|graph(?:-video)?\.facebook\.com|\b\d{8,}\b/i.test(value)) fail('unsafe case value');
    if (inUrl) {
      const url = (() => {
        try { return new URL(value); } catch { return fail('invalid case URL'); }
      })();
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.example.invalid')) fail('unsafe real domain in case URL');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) safeTree(item, false);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) safeTree(item, key === 'url');
}

function validateCompiledDataset(dataset: SandboxDataset): void {
  validateDataset(dataset);
  for (const adset of dataset.adsets) {
    const campaign = dataset.campaigns.find(candidate => candidate.id === adset.campaign_id)!;
    const optimizationGoal = adset.optimization_goal;
    if (!campaign.objective || !optimizationGoal || !META_OBJ_GOAL_MAP[campaign.objective]?.includes(optimizationGoal)) {
      fail(`objective ${campaign.objective} is not compatible with optimization goal ${adset.optimization_goal}`);
    }
    if (!adset.billing_event || !META_GOAL_BILLING_MAP[optimizationGoal]?.includes(adset.billing_event)) {
      fail(`billing event ${adset.billing_event} is not compatible with optimization goal ${adset.optimization_goal}`);
    }
    if (!adset.bid_strategy || !META_GOAL_BID_STRATEGY_MAP[optimizationGoal]?.includes(adset.bid_strategy)) {
      fail(`bid strategy ${adset.bid_strategy} is not compatible with optimization goal ${adset.optimization_goal}`);
    }
    if (adset.bid_strategy !== 'LOWEST_COST_WITHOUT_CAP' && !adset.bid_amount) {
      fail(`bid_amount is required for ${adset.bid_strategy}`);
    }
  }
}

export function parseSandboxCase(yaml: string): SandboxCase {
  return checkCase(load(yaml));
}
function checkCase(value: unknown): SandboxCase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('case.yaml must be a mapping');
  const c = value as SandboxCase;
  const allowed = ['datasetId', 'version', 'caseId', 'name', 'currency', 'timezone', 'reviewWindowSeconds', 'page', 'pixel', 'landers', 'displayNames', 'targeting'];
  if (Object.keys(c).some(k => !allowed.includes(k))) fail('unknown case.yaml field');
  for (const key of ['datasetId', 'caseId', 'name', 'currency', 'timezone'] as const) {
    if (typeof c[key] !== 'string' || !c[key] || c[key].length > 100) fail(`invalid case.${key}`);
    if (/[.:?@=]|\d{8,}|access_token|bearer|\bEAA[A-Za-z0-9]+/i.test(c[key])) fail(`unsafe case.${key}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.datasetId) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.caseId)) fail('invalid dataset/case id');
  if (!Number.isSafeInteger(c.version) || c.version < 1 || !/^[A-Z]{3}$/.test(c.currency)) fail('invalid version/currency');
  try { new Intl.DateTimeFormat('en-US', { timeZone: c.timezone }); } catch { fail('invalid timezone'); }
  if (c.reviewWindowSeconds !== undefined && (!Number.isSafeInteger(c.reviewWindowSeconds) || c.reviewWindowSeconds < 0 || c.reviewWindowSeconds > 86400)) fail('invalid reviewWindowSeconds');
  const mapping = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const text = (x: unknown) => { if (typeof x !== 'string' || !x || x.length > 200) fail('invalid case text'); };
  if (c.page !== undefined) { if (!mapping(c.page) || Object.keys(c.page).some(k => !['name', 'category'].includes(k))) fail('invalid page'); text(c.page.name); text(c.page.category); }
  if (c.pixel !== undefined) { if (!mapping(c.pixel) || Object.keys(c.pixel).some(k => k !== 'name')) fail('invalid pixel'); text(c.pixel.name); }
  if (c.landers !== undefined && (!Array.isArray(c.landers) || !c.landers.length || c.landers.some(l => !mapping(l) || Object.keys(l).some(k => k !== 'url') || typeof l.url !== 'string' || !l.url.startsWith('https://')))) fail('invalid landers');
  if (c.displayNames !== undefined) {
    if (!mapping(c.displayNames)) fail('invalid displayNames');
    for (const [key, value] of Object.entries(c.displayNames)) { if (!/^(CAMPAIGN|ADSET|AD|CREATIVE)_[0-9]{1,4}$/.test(key)) fail('invalid displayNames alias'); text(value); }
  }
  if (c.targeting !== undefined) {
    if (!mapping(c.targeting)) fail('invalid targeting');
    for (const [key, t] of Object.entries(c.targeting)) {
      if (!/^ADSET_[0-9]{1,4}$/.test(key) || !mapping(t) || Object.keys(t).some(k => !['countries', 'ageMin', 'ageMax', 'summary'].includes(k)) || !Array.isArray(t.countries) || !t.countries.length || t.countries.some(country => typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) || !Number.isInteger(t.ageMin) || !Number.isInteger(t.ageMax) || t.ageMin < 18 || t.ageMax > 65 || t.ageMin > t.ageMax) fail('invalid targeting');
      if (t.summary !== undefined) text(t.summary);
    }
  }
  safeTree(c, false);
  return c;
}
function csv(bytes: Buffer, label: string): Row[] {
  const rows = parse(bytes, { max_record_size: 64 * 1024, to: 5001, bom: true, columns: (headers: string[]) => {
    if (new Set(headers).size !== headers.length) fail(`duplicate CSV header in ${label}`);
    return headers;
  }, skip_empty_lines: true }) as Row[];
  if (rows.length > 5000) fail(`CSV row limit exceeded in ${label}`);
  if (!Array.isArray(rows) || rows.some(r => !r || Object.values(r).some(v => typeof v !== 'string'))) fail(`invalid CSV ${label}`);
  return rows;
}
function number(value: string, money = false): number {
  if (typeof value !== 'string' || !(money ? /^\d+(?:\.\d{1,2})?$/ : /^\d+$/).test(value)) fail(`invalid ${money ? 'money' : 'count'} ${value}`);
  const [whole, fraction = ''] = value.split('.');
  const result = money ? Number(whole) * 100 + Number(fraction.padEnd(2, '0')) : Number(whole);
  if (!Number.isSafeInteger(result)) fail('metric exceeds safe integer range');
  return result;
}
function totals(rows: Row[]): Record<Metric, number> {
  return Object.fromEntries(METRICS.map(k => [k, rows.reduce((sum, r) => {
    const next = sum + number(r[k], k === 'spend');
    if (!Number.isSafeInteger(next)) fail('total exceeds safe integer range');
    return next;
  }, 0)])) as Record<Metric, number>;
}
function reconcile(rows: Row[], expected: Row, label: string): void {
  const actual = totals(rows);
  for (const k of METRICS) if (actual[k] !== number(expected[k], k === 'spend')) fail(`reconciliation ${label}: ${k} expected ${expected[k]}, got ${actual[k]}${k === 'spend' ? ' cents' : ''}`);
}
function alias(value: string, kind: string): string {
  if (!new RegExp(`^${kind}_(?:[A-Z]+|[0-9]{1,4})$`).test(value)) fail(`unsafe ${kind} alias`);
  return value;
}

/** Fully offline: packet checksums are verified before any source values are used. */
export function compileSandboxDataset(packet: string, config: unknown): SandboxDataset {
  const c = checkCase(config), root = realpathSync(packet);
  let totalBytes = 0;
  const read = (path: string): Buffer => {
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(p => p === '..' || !p)) fail('unsafe manifest path');
    const full = realpathSync(resolve(root, path));
    if (!full.startsWith(root + sep)) fail('manifest path escapes packet');
    const bytes = readDatasetFile(full);
    totalBytes += bytes.length;
    if (totalBytes > 64 * 1024 * 1024) fail('packet byte limit exceeded');
    return bytes;
  };
  const manifestBytes = read('manifest.csv'), manifest = csv(manifestBytes, 'manifest.csv');
  if (manifest.length > 256) fail('manifest file limit exceeded');
  const files = new Map<string, Buffer>(), tables = new Map<string, Row[]>();
  for (const entry of manifest) {
    if (files.has(entry.path) || entry.path === 'manifest.csv') fail('duplicate/circular manifest entry');
    const bytes = read(entry.path);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || sha(bytes) !== entry.sha256 || bytes.length !== number(entry.bytes)) fail(`manifest integrity mismatch: ${entry.path}`);
    files.set(entry.path, bytes);
    if (entry.path.endsWith('.csv')) {
      const rows = csv(bytes, entry.path); tables.set(entry.path, rows);
      if (number(entry.data_rows) !== rows.length) fail(`manifest row count mismatch: ${entry.path}`);
    }
  }
  const table = (name: string): Row[] => tables.get(name) ?? fail(`manifest missing ${name}`);
  const daily = table('performance_daily.csv'), period = table('performance_period.csv'), settings = table('settings.csv'), creatives = table('creative_index.csv');
  if (!daily.length || !period.length) fail('empty performance exports');
  const keys = new Set<string>();
  for (const row of daily) {
    if (!isDay(row.date) || row.currency !== c.currency || !/^[A-Z0-9_]+$/.test(row.period)) fail('invalid daily date/currency/period');
    for (const kind of ['account', 'campaign', 'adset', 'ad']) alias(row[`${kind}_id`], kind.toUpperCase());
    const key = `${row.date}/${row.ad_id}`;
    if (keys.has(key)) fail('duplicate daily ad/date'); keys.add(key);
  }
  totals(daily);
  const accounts = [...new Set(daily.map(r => r.account_id))];
  if (accounts.length !== 1) fail('packet must have exactly one account');
  const periodKeys = new Set<string>();
  for (const row of period) {
    if (!['account', 'campaign', 'adset', 'ad'].includes(row.level) || !isDay(row.start) || !isDay(row.end) || row.start > row.end || row.currency !== c.currency) fail('invalid period row');
    alias(row.entity_id, row.level.toUpperCase());
    const key = `${row.period}/${row.level}/${row.entity_id}`;
    if (periodKeys.has(key)) fail('duplicate period entity'); periodKeys.add(key);
    const selected = daily.filter(d => d.period === row.period && d.date >= row.start && d.date <= row.end && d[`${row.level}_id`] === row.entity_id);
    reconcile(selected, row, key);
  }
  for (const row of daily) {
    if (!period.some(p => p.level === 'account' && p.entity_id === row.account_id && p.period === row.period && p.start <= row.date && p.end >= row.date)) fail('daily row has no account period reconciliation');
  }
  for (const name of ['performance_daily.csv', 'performance_period.csv']) {
    reconcile(name === 'performance_daily.csv' ? daily : period.filter(r => r.level === 'account'), manifest.find(r => r.path === name)!, `manifest ${name}`);
  }
  // All identifiers are allocated afresh in a disjoint, visibly synthetic numeric namespace.
  const idMap = new Map<string, string>();
  const id = (key: string) => {
    if (!idMap.has(key)) idMap.set(key, `990000000000${String(idMap.size + 1).padStart(6, '0')}`);
    return idMap.get(key)!;
  };
  const accountId = id(accounts[0]), pageId = id('PAGE'), pixelId = id('PIXEL');
  const since = daily.map(r => r.date).sort()[0], until = daily.map(r => r.date).sort().slice(-1)[0];
  const timestamp = `${since}T00:00:00.000Z`;
  const settingsMap = new Map<string, string>();
  for (const row of settings) {
    if (!['account', 'campaign', 'adset', 'ad'].includes(row.level)) fail('invalid settings level');
    alias(row.entity_id, row.level.toUpperCase());
    const key = `${row.entity_id}/${row.setting}`;
    if (settingsMap.has(key)) fail('duplicate setting'); settingsMap.set(key, row.value);
  }
  if (settingsMap.has(`${accounts[0]}/currency`) && settingsMap.get(`${accounts[0]}/currency`) !== c.currency) fail('case/packet currency mismatch');
  if (settingsMap.has(`${accounts[0]}/timezone_name`) && settingsMap.get(`${accounts[0]}/timezone_name`) !== c.timezone) fail('case/packet timezone mismatch');
  const setting = (entity: string, key: string, fallback: string) => {
    const value = settingsMap.get(`${entity}/${key}`) ?? fallback;
    if (!/^[A-Z_]+$/.test(value)) fail(`unsafe setting ${key}`);
    return value;
  };
  const budgets = (entity: string) => {
    const result = Object.fromEntries(['daily_budget', 'lifetime_budget'].flatMap(k => settingsMap.has(`${entity}/${k}`) && number(settingsMap.get(`${entity}/${k}`)!) > 0 ? [[k, number(settingsMap.get(`${entity}/${k}`)!)]] : []));
    if (result.daily_budget && result.lifetime_budget) fail('daily and lifetime budget cannot coexist');
    return result;
  };
  const displayName = (key: string) => c.displayNames?.[key] ?? key;
  const targeting = (key: string) => {
    const t = c.targeting?.[key];
    return { geo_locations: { countries: t?.countries ?? ['US'] }, age_min: t?.ageMin ?? 18, age_max: t?.ageMax ?? 65, ...(t?.summary ? { description: t.summary } : {}) };
  };
  const dataset: SandboxDataset = {
    meta: { datasetId: c.datasetId, version: c.version, schemaVersion: 1, caseId: c.caseId, frozenWindow: { since, until }, dateShift: 'anchor_until_to_yesterday_utc', createdAt: timestamp,
      approximations: ['Names, IDs, page, pixel, audience and destination are synthetic; settings are current snapshots, not historical truth.', 'Reach is approximated as 80% of daily impressions; it is not measured unique reach.', 'Pixel event stats mirror reported actions; PageView uses link clicks as a synthetic proxy.', 'All breakdown dimensions use equal deterministic shares with integer remainder allocation; they are not observed performance.', 'Withheld creatives use synthetic placeholders; supplied assets retain packet checksums and are staged separately.'],
      ...(c.reviewWindowSeconds === undefined ? {} : { reviewWindowSeconds: c.reviewWindowSeconds }) },
    account: { id: `act_${accountId}`, account_id: accountId, name: c.name, currency: c.currency, timezone_name: c.timezone, account_status: 1 },
    pages: [{ id: pageId, name: c.page?.name ?? c.name, category: c.page?.category ?? 'Software', tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT', 'MANAGE', 'MODERATE'] }],
    pixels: [{ id: pixelId, name: c.pixel?.name ?? 'Sandbox pixel', last_fired_time: `${until}T00:00:00.000Z`, is_created_by_business: true, statsByDay: [] }],
    customAudiences: [{ id: id('AUDIENCE'), name: 'Sandbox website visitors', subtype: 'WEBSITE', delivery_status: { code: 200, description: 'Ready' }, approximate_count_lower_bound: 1000, time_created: timestamp, time_updated: timestamp }],
    campaigns: [], adsets: [], ads: [], adcreatives: [], adimages: [], insightsDaily: [], insightsBreakdownDaily: [],
    landers: (c.landers ?? [{ url: 'https://landing.example.invalid/demo' }]).map(l => ({ url: l.url, pixelIds: [pixelId] })), assetsManifest: [],
    reconciliation: { packetManifestSha256: sha(manifestBytes), dailyRows: daily.length, periodRows: period.length, totals: totals(daily) },
  };
  const creativeByAd = new Map<string, Row>();
  const assetByPath = new Map<string, NonNullable<SandboxDataset['assetsManifest']>[number]>();
  for (const row of creatives) {
    alias(row.creative_id, row.ad_id ? 'CREATIVE' : 'BRAND');
    if (row.ad_id) {
      alias(row.ad_id, 'AD'); alias(row.campaign_id, 'CAMPAIGN'); alias(row.adset_id, 'ADSET');
      if (creativeByAd.has(row.ad_id)) fail('duplicate creative ad mapping'); creativeByAd.set(row.ad_id, row);
    } else if (row.campaign_id || row.adset_id) fail('brand asset has an ad parent');
    const paths: unknown = JSON.parse(row.asset_paths);
    if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) fail('invalid creative asset_paths');
    for (const path of paths as string[]) {
      if (!/^source_assets\/[a-z0-9_]+\.png$/.test(path)) fail('unsafe asset path');
      if (assetByPath.has(path)) continue;
      const bytes = files.get(path) ?? fail(`manifest missing asset ${path}`);
      if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('asset must be PNG');
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width > 20000 || height > 20000) fail('invalid asset dimensions');
      const entry = { assetKey: `assets/${sha(bytes)}.png`, sourcePath: path, sha256: sha(bytes), bytes: bytes.length, width, height };
      assetByPath.set(path, entry); dataset.assetsManifest!.push(entry);
      dataset.adimages.push({ hash: entry.sha256.slice(0, 32), url: `https://assets.example.invalid/${entry.assetKey}`, name: path.split('/').pop()!, width, height, status: 'ACTIVE', assetKey: entry.assetKey });
    }
  }
  for (const row of [...creativeByAd.values()].sort((a, b) => a.ad_id.localeCompare(b.ad_id))) {
    if (!dataset.campaigns.some(o => o.id === id(row.campaign_id))) dataset.campaigns.push({ id: id(row.campaign_id), account_id: accountId, name: displayName(row.campaign_id), status: 'ACTIVE', effective_status: 'ACTIVE', objective: setting(row.campaign_id, 'objective', 'OUTCOME_LEADS'), ...budgets(row.campaign_id), start_time: timestamp, created_time: timestamp, updated_time: timestamp, special_ad_categories: [] });
    const existing = dataset.adsets.find(o => o.id === id(row.adset_id));
    if (existing && existing.campaign_id !== id(row.campaign_id)) fail('adset campaign hierarchy conflict');
    if (!existing) dataset.adsets.push({ id: id(row.adset_id), account_id: accountId, campaign_id: id(row.campaign_id), name: displayName(row.adset_id), status: 'ACTIVE', effective_status: 'ACTIVE', optimization_goal: setting(row.adset_id, 'optimization_goal', 'OFFSITE_CONVERSIONS'), billing_event: setting(row.adset_id, 'billing_event', 'IMPRESSIONS'), bid_strategy: setting(row.adset_id, 'bid_strategy', 'LOWEST_COST_WITHOUT_CAP'), ...budgets(row.adset_id), ...(settingsMap.has(`${row.adset_id}/bid_amount`) ? { bid_amount: number(settingsMap.get(`${row.adset_id}/bid_amount`)!) } : {}), start_time: timestamp, ...(budgets(row.adset_id).lifetime_budget ? { end_time: `${until}T23:59:59.000Z` } : {}), destination_type: 'WEBSITE', promoted_object: { pixel_id: pixelId, custom_event_type: 'LEAD' }, targeting: targeting(row.adset_id) });
    const asset = assetByPath.get((JSON.parse(row.asset_paths) as string[])[0]);
    const placeholderSha = sha(SANDBOX_PLACEHOLDER_PNG);
    const imageAsset = asset ?? { assetKey: `assets/${placeholderSha}.png`, sourcePath: 'generated/placeholder.png', sha256: placeholderSha, bytes: SANDBOX_PLACEHOLDER_PNG.length, width: 1, height: 1 };
    if (!dataset.assetsManifest!.some(a => a.assetKey === imageAsset.assetKey)) dataset.assetsManifest!.push(imageAsset);
    const hash = imageAsset.sha256.slice(0, 32);
    const url = `https://assets.example.invalid/${imageAsset.assetKey}`;
    if (!dataset.adcreatives.some(o => o.id === id(row.creative_id))) {
      dataset.adcreatives.push({ id: id(row.creative_id), account_id: accountId, name: displayName(row.creative_id), status: 'ACTIVE', image_hash: hash, image_url: url, thumbnail_url: url, link_url: dataset.landers[0].url, object_type: 'SHARE', object_story_spec: { page_id: pageId, link_data: { link: dataset.landers[0].url, image_hash: hash } } });
      if (!asset && !dataset.adimages.some(a => a.hash === hash)) dataset.adimages.push({ hash, url, name: 'Withheld creative placeholder', width: 1, height: 1, status: 'ACTIVE', assetKey: imageAsset.assetKey });
    }
    dataset.ads.push({ id: id(row.ad_id), account_id: accountId, campaign_id: id(row.campaign_id), adset_id: id(row.adset_id), name: displayName(row.ad_id), status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: id(row.creative_id) }, created_time: timestamp, updated_time: timestamp });
  }
  for (const row of [...daily].sort((a, b) => a.date.localeCompare(b.date) || a.ad_id.localeCompare(b.ad_id))) {
    const mapping = creativeByAd.get(row.ad_id);
    if (!mapping || mapping.campaign_id !== row.campaign_id || mapping.adset_id !== row.adset_id) fail('daily/creative hierarchy mismatch');
    const insight: SandboxInsightsDaily = { date: row.date, ad_id: id(row.ad_id), adset_id: id(row.adset_id), campaign_id: id(row.campaign_id), impressions: number(row.impressions), reach: Math.floor(number(row.impressions) * 0.8), clicks: number(row.clicks), inline_link_clicks: number(row.inline_link_clicks), spend: number(row.spend, true), actions: [
      { action_type: 'link_click', value: number(row.inline_link_clicks) }, { action_type: 'landing_page_view', value: number(row.inline_link_clicks) }, { action_type: 'lead', value: number(row.reported_leads) }, { action_type: 'offsite_conversion.fb_pixel_lead', value: number(row.reported_leads) }, { action_type: 'complete_registration', value: number(row.reported_complete_registrations) },
      { action_type: 'offsite_conversion.fb_pixel_complete_registration', value: number(row.reported_complete_registrations) }, { action_type: 'purchase', value: number(row.reported_purchases) },
    ] };
    dataset.insightsDaily.push(insight);
    let day = dataset.pixels[0].statsByDay.find(d => d.date === row.date);
    if (!day) { day = { date: row.date, events: { PageView: 0, Lead: 0, CompleteRegistration: 0, Purchase: 0 } }; dataset.pixels[0].statsByDay.push(day); }
    day.events.PageView += insight.inline_link_clicks; day.events.Lead += number(row.reported_leads);
    day.events.CompleteRegistration += number(row.reported_complete_registrations); day.events.Purchase += number(row.reported_purchases);
    for (const [breakdown, buckets] of BREAKDOWNS) buckets.forEach((dims, i) => {
      const split = (total: number) => Math.floor(total / buckets.length) + (i < total % buckets.length ? 1 : 0);
      dataset.insightsBreakdownDaily.push({ date: insight.date, ad_id: insight.ad_id, adset_id: insight.adset_id, campaign_id: insight.campaign_id, breakdown, dims, impressions: split(insight.impressions), reach: split(insight.reach), clicks: split(insight.clicks), spend: split(insight.spend), actions: insight.actions.map(a => ({ action_type: a.action_type, value: split(a.value) })) });
    });
  }
  validateCompiledDataset(dataset);
  return dataset;
}
const BREAKDOWNS: Array<[SandboxBreakdown, Array<Record<string, string>>]> = [
  ['age,gender', [{ age: '25-34', gender: 'female' }, { age: '25-34', gender: 'male' }, { age: '35-44', gender: 'female' }, { age: '35-44', gender: 'male' }]],
  ['publisher_platform,platform_position', [{ publisher_platform: 'facebook', platform_position: 'feed' }, { publisher_platform: 'instagram', platform_position: 'feed' }]],
  ['impression_device', [{ impression_device: 'iphone' }, { impression_device: 'android_smartphone' }]],
  ['device_platform', [{ device_platform: 'mobile' }, { device_platform: 'desktop' }]],
  ['country', [{ country: 'US' }]], ['region', [{ region: 'California' }, { region: 'New York' }]],
];
