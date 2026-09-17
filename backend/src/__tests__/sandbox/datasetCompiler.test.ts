import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { compileSandboxDataset } from '../../services/sandbox/datasetCompiler';
const metrics = 'spend,impressions,clicks,inline_link_clicks,reported_leads,reported_complete_registrations,reported_purchases';
const values = '1.01,11,3,2,1,1,0';
let packet: string;
function fixture(periodValues = values, overrides: Record<string, string> = {}) {
  packet = mkdtempSync(join(tmpdir(), 'sandbox-packet-'));
  const files: Record<string, string> = {
    'performance_daily.csv': `date,period,account_id,campaign_id,adset_id,ad_id,currency,${metrics}\n2026-04-09,A,ACCOUNT_A,CAMPAIGN_01,ADSET_01,AD_01,USD,${values}\n`,
    'performance_period.csv': `period,start,end,level,entity_id,currency,${metrics}\nA,2026-04-09,2026-04-09,account,ACCOUNT_A,USD,${periodValues}\n`,
    'settings.csv': 'level,entity_id,setting,value\naccount,ACCOUNT_A,currency,USD\n',
    'creative_index.csv': 'ad_id,campaign_id,adset_id,creative_id,asset_paths,availability\nAD_01,CAMPAIGN_01,ADSET_01,CREATIVE_01,[],withheld\n',
  };
  Object.assign(files, overrides);
  const manifest = Object.entries(files).map(([path, body]) => {
    writeFileSync(join(packet, path), body);
    return `${path},${createHash('sha256').update(body).digest('hex')},${Buffer.byteLength(body)},${body.trim().split('\n').length - 1},${path.startsWith('performance') ? `account,${periodValues}` : ',,,,,,,'}`;
  });
  writeFileSync(join(packet, 'manifest.csv'), `path,sha256,bytes,data_rows,totals_scope,${metrics}\n${manifest.join('\n')}\n`);
}
const config = { datasetId: 'test', version: 1, caseId: 'test', name: 'Sandbox', currency: 'USD', timezone: 'UTC' };
afterEach(() => { if (packet) rmSync(packet, { recursive: true, force: true }); });
test('daily totals reconcile and deterministic breakdowns preserve metrics and actions', () => {
  fixture(); const d = compileSandboxDataset(packet, config);
  expect(d.insightsDaily[0]).toMatchObject({ spend: 101, impressions: 11, clicks: 3 });
  expect(d).toEqual(compileSandboxDataset(packet, config));
  for (const family of new Set(d.insightsBreakdownDaily.map(r => r.breakdown))) {
    const rows = d.insightsBreakdownDaily.filter(r => r.breakdown === family);
    expect(rows.reduce((n, r) => n + r.spend, 0)).toBe(101);
    expect(rows.reduce((n, r) => n + r.impressions, 0)).toBe(11);
    expect(rows.reduce((n, r) => n + (r.actions.find(a => a.action_type === 'lead')?.value || 0), 0)).toBe(1);
  }
  expect(d.account.account_id).toMatch(/^99\d+$/);
});
test('rejects period totals that disagree with daily rows', () => {
  fixture('2.01,11,3,2,1,1,0'); expect(() => compileSandboxDataset(packet, config)).toThrow(/reconcil/i);
});
test('one delivered impression has one reachable person in the simulated metrics (ENG-2024)', () => {
  const one = '0.02,1,1,1,0,0,0';
  fixture(one, {
    'performance_daily.csv': `date,period,account_id,campaign_id,adset_id,ad_id,currency,${metrics}\n2026-04-09,A,ACCOUNT_A,CAMPAIGN_01,ADSET_01,AD_01,USD,${one}\n`,
  });
  const d = compileSandboxDataset(packet, config);
  expect(d.insightsDaily[0]).toMatchObject({ impressions: 1, reach: 1 });
});
test('rejects changed files before compiling', () => {
  fixture(); writeFileSync(join(packet, 'settings.csv'), 'tampered'); expect(() => compileSandboxDataset(packet, config)).toThrow(/manifest/i);
});
test('rejects real domains and token-bearing case configuration', () => {
  fixture(); expect(() => compileSandboxDataset(packet, { ...config, name: 'https://real.example.com?access_token=secret' })).toThrow(/unsafe/i);
});

test('manifest totals are an independent reconciliation gate', () => {
  fixture();
  const path = join(packet, 'manifest.csv');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/account,1.01/g, 'account,2.01'));
  expect(() => compileSandboxDataset(packet, config)).toThrow(/reconciliation manifest/);
});
test.each([
  ['real object ID', 'date,period,account_id,campaign_id,adset_id,ad_id,currency,' + metrics + '\n2026-04-09,A,ACCOUNT_A,CAMPAIGN_01,ADSET_01,123456789012345,USD,' + values + '\n'],
  ['nonfinite metric', 'date,period,account_id,campaign_id,adset_id,ad_id,currency,' + metrics + '\n2026-04-09,A,ACCOUNT_A,CAMPAIGN_01,ADSET_01,AD_01,USD,NaN,11,3,2,1,1,0\n'],
])('rejects %s even with a valid file checksum', (_name, csv) => {
  fixture(values, { 'performance_daily.csv': csv });
  expect(() => compileSandboxDataset(packet, config)).toThrow();
});
test('rejects wrong-type elements inside asset_paths', () => {
  fixture(values, { 'creative_index.csv': 'ad_id,campaign_id,adset_id,creative_id,asset_paths,availability\nAD_01,CAMPAIGN_01,ADSET_01,CREATIVE_01,[123],supplied\n' });
  expect(() => compileSandboxDataset(packet, config)).toThrow(/asset_paths/);
});
test('committed Ryan dataset reconciles the frozen packet totals and every supplied asset checksum', () => {
  const dir = join(__dirname, '../../../datasets/agentweb-2026q2/1');
  const d = JSON.parse(readFileSync(join(dir, 'dataset.json'), 'utf8'));
  expect(d.meta).toMatchObject({ datasetId: 'agentweb-2026q2', version: 1, schemaVersion: 1 });
  expect(d.insightsDaily).toHaveLength(134);
  for (const [metric, total] of Object.entries({ spend: 205532, impressions: 22005, clicks: 804, inline_link_clicks: 436 })) {
    expect(d.insightsDaily.reduce((n: number, r: Record<string, number>) => n + r[metric], 0)).toBe(total);
  }
  for (const [action, total] of Object.entries({ lead: 32, 'offsite_conversion.fb_pixel_complete_registration': 17, purchase: 0 })) {
    expect(d.insightsDaily.reduce((n: number, r: { actions: Array<{action_type: string; value: number}> }) => n + r.actions.find(a => a.action_type === action)!.value, 0)).toBe(total);
  }
  for (const asset of d.assetsManifest) {
    const bytes = readFileSync(join(dir, asset.assetKey));
    expect(bytes.length).toBe(asset.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
  }
});
test('case context supplies names, page, pixel, destinations and targeting without importing real identities', () => {
  fixture(); const d = compileSandboxDataset(packet, { ...config,
    page: { name: 'Example team', category: 'Software' }, pixel: { name: 'Example events' },
    landers: [{ url: 'https://demo.example.invalid/start' }],
    displayNames: { CAMPAIGN_01: 'Founder demos', ADSET_01: 'US founders' },
    targeting: { ADSET_01: { countries: ['US'], ageMin: 25, ageMax: 54, summary: 'Founder audience' } },
  });
  expect(d.pages[0].name).toBe('Example team'); expect(d.pixels[0].name).toBe('Example events');
  expect(d.campaigns[0].name).toBe('Founder demos'); expect(d.adsets[0].targeting.age_min).toBe(25);
  expect(d.adcreatives[0].link_url).toBe('https://demo.example.invalid/start');
  expect(d.insightsDaily[0].actions.map(a => a.action_type)).toEqual(expect.arrayContaining(['offsite_conversion.fb_pixel_lead', 'landing_page_view', 'complete_registration']));
});
test.each([
  ['objective', 'campaign,CAMPAIGN_01,objective,OUTCOME_TRAFFIC'],
  ['billing', 'adset,ADSET_01,billing_event,LINK_CLICKS'],
  ['bid amount', 'adset,ADSET_01,bid_strategy,COST_CAP'],
  ['dual budgets', 'adset,ADSET_01,daily_budget,100\nadset,ADSET_01,lifetime_budget,1000'],
])('rejects invalid Meta %s configuration', (_label, rows) => {
  fixture(values, { 'settings.csv': `level,entity_id,setting,value\n${rows}\n` });
  expect(() => compileSandboxDataset(packet, config)).toThrow(/compatible|budget|bid_amount/);
});

test('rejects excessive CSV rows before reconciliation or expansion', () => {
  fixture();
  writeFileSync(join(packet, 'manifest.csv'), 'path,sha256,bytes,data_rows\n' + 'x,a,1,0\n'.repeat(5001));
  expect(() => compileSandboxDataset(packet, config)).toThrow(/row limit/);
});
