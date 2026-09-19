import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { runInsights } from '../../services/sandbox/insightsEngine';
import { addDays } from '../../services/sandbox/dateShift';
import { validateReconciliation } from '../../services/sandbox/datasetImport';
import { EMPTY_OVERLAY, SandboxDataset } from '../../services/sandbox/types';
const source: SandboxDataset = JSON.parse(readFileSync(join(__dirname, '../../../datasets/agentweb-2026q2/1/dataset.json'), 'utf8'));
const dir = join(__dirname, '../../../datasets/agentweb-evaluation-90d/1');
const candidate: SandboxDataset = JSON.parse(readFileSync(join(dir, 'dataset.json'), 'utf8'));
function read(days: number, ad?: string) {
  const id = ad ? candidate.ads.find(a => a.name === ad)!.id : candidate.account.account_id;
  return runInsights(candidate, EMPTY_OVERLAY, { node: { kind: ad ? 'ad' : 'account', id }, fields: ['impressions', 'reach', 'frequency', 'spend', 'clicks', 'actions'], breakdowns: [], actionBreakdowns: [], filtering: [], timeRange: { since: addDays(candidate.meta.frozenWindow.until, 1 - days), until: candidate.meta.frozenWindow.until } }, 0, new Date('2026-09-19')).data[0] as any;
}
it('ENG-2022 preserves EVERY actual 30d measured row and separately reconciles the synthetic older 60d', () => {
  const since = addDays(source.meta.frozenWindow.until, -29);
  const actual = (d: SandboxDataset) => d.insightsDaily.filter(r => r.date >= since).map(({ reach: _modeledReach, ...r }) => ({ ...r, actions: r.actions.filter(a => ['link_click', 'lead', 'offsite_conversion.fb_pixel_complete_registration', 'purchase'].includes(a.action_type)) }));
  expect(actual(candidate)).toEqual(actual(source));
  expect(candidate.meta.approximations).toContain('30d real + 60d synthetic');
  expect(read(30)).toMatchObject({ spend: '1030.24', impressions: '12992', clicks: '493' });
  expect(Number(read(90).spend)).toBeGreaterThan(Number(read(30).spend));
  expect(Number(read(90).impressions)).toBeGreaterThan(Number(read(30).impressions));
  expect(() => validateReconciliation(candidate)).not.toThrow();
});
it('ENG-2023 every creative including AD_15 serves a substantive asset with honest missing-source context', () => {
  for (const ad of candidate.ads) {
    const creative = candidate.adcreatives.find(c => c.id === ad.creative.id)!;
    const asset = candidate.assetsManifest!.find(a => creative.image_url!.endsWith(a.assetKey))!;
    const bytes = readFileSync(join(dir, asset.assetKey));
    expect(bytes.readUInt32BE(16)).toBeGreaterThan(1);
    expect(bytes.readUInt32BE(20)).toBeGreaterThan(1);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
    if (ad.name === 'AD_15') expect(creative.body).toMatch(/unavailable.*not the historical ad/);
  }
});
it('ENG-2024 AD_17 retains its one actual impression/click with reach and frequency one', () => {
  expect(read(90, 'AD_17')).toMatchObject({ impressions: '1', clicks: '1', reach: '1', frequency: '1.000000', spend: '0.02' });
});
it('ENG-2025 reach/frequency recompute for 7d/14d/30d/90d without impossible values', () => {
  const rows = [7,14,30,90].map(days => read(days));
  expect(new Set(rows.map(r => r.frequency)).size).toBe(4);
  for (const r of rows) {
    expect(Number(r.reach)).toBeGreaterThan(0);
    expect(Number(r.reach)).toBeLessThanOrEqual(Number(r.impressions));
    expect(Number(r.frequency)).toBeCloseTo(Number(r.impressions) / Number(r.reach), 5);
  }
});
