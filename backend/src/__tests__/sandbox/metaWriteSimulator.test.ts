import { createMetaSimulator } from '../../services/sandbox/metaSimulator';
import { EMPTY_OVERLAY, SandboxOverlay, SimRequest } from '../../services/sandbox/types';
import { buildFixtureDataset, FIXTURE_ACCOUNT_ID, FIXTURE_IDS } from './fixtures/fixtureDataset';

/**
 * ENG-1909 AC 1/3: the full create -> activate flow succeeds end to end through the real
 * simulator router, every step is Meta-shaped, and nothing leaves the process for Meta's real
 * network. AC 2 (the launch gate) is a separate slice, not covered here.
 */
jest.mock('../../utils/s3Utils', () => ({
  uploadFileToS3WithPath: jest.fn(async () => ({ success: true, url: 'https://agentweb-user-files.s3.amazonaws.com/sandbox/eval_fixture/adimages/testhash.jpg' })),
}));

const dataset = buildFixtureDataset();
const token = 'sbx.eval_fixture.0123456789abcdef01234567';
let clockNow = new Date('2026-09-13T15:00:00Z');
const now = () => clockNow;
const req = (path: string, query: Record<string, string> = {}, method: SimRequest['method'] = 'GET', extra: Partial<SimRequest> = {}): SimRequest =>
  ({ userId: 'eval_fixture', token, method, version: 'v25.0', path, query, ...extra });
const body = (res: any) => JSON.parse(res.body);

/** A live in-memory overlay, updated by every mutateOverlay call and read back by every loadOverlay call — mirrors what the real sandboxOverlayStore does, without DynamoDB. */
function makeDeps() {
  let overlay: SandboxOverlay = { ...EMPTY_OVERLAY };
  return {
    loadPolicy: jest.fn(async (userId: string) => (userId === 'eval_fixture' ? { datasetId: 'fixture-agentweb', datasetVersion: 1 } : null)),
    loadDataset: jest.fn(async () => dataset),
    loadOverlay: jest.fn(async () => overlay),
    mutateOverlay: jest.fn(async (_userId: string, fn: (current: SandboxOverlay) => SandboxOverlay) => { overlay = fn(overlay); return overlay; }),
    now,
    getOverlay: () => overlay,
  };
}

describe('write simulator — create, update, delete, effective_status, adimages', () => {
  beforeEach(() => { clockNow = new Date('2026-09-13T15:00:00Z'); });

  it('full create -> activate flow: campaign -> adset -> adcreative -> ad, appears in reads, PENDING_REVIEW then ACTIVE, zero metrics, zero network egress', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(() => { throw new Error('network egress attempted during a sandbox write'); }) as any;
    try {
      const deps = makeDeps();
      const sim = createMetaSimulator(deps);

      const createCampaign = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, {}, 'POST', {
        form: { name: 'Candidate Campaign', objective: 'OUTCOME_LEADS', daily_budget: '4200', status: 'ACTIVE' },
      })));
      expect(typeof createCampaign.id).toBe('string');
      expect(createCampaign.id.startsWith('9')).toBe(true);

      const createAdSet = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adsets`, {}, 'POST', {
        form: { name: 'Candidate AdSet', campaign_id: createCampaign.id, optimization_goal: 'LEAD_GENERATION', billing_event: 'IMPRESSIONS', status: 'ACTIVE' },
      })));

      const createCreative = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adcreatives`, {}, 'POST', {
        form: { name: 'Candidate Creative', body: 'Body copy', title: 'Headline' },
      })));

      const createAd = body(await sim.handle(req(`${createAdSet.id}/ads`, {}, 'POST', {
        form: { name: 'Candidate Ad', status: 'ACTIVE', creative: JSON.stringify({ creative_id: createCreative.id }) },
      })));
      expect(typeof createAd.id).toBe('string');

      // Immediately after creation, an ACTIVE ad is PENDING_REVIEW (the simulated review window).
      const adRead1 = body(await sim.handle(req(createAd.id, { fields: 'id,name,status,effective_status,adset_id,campaign_id' })));
      expect(adRead1).toMatchObject({ id: createAd.id, status: 'ACTIVE', effective_status: 'PENDING_REVIEW', adset_id: createAdSet.id, campaign_id: createCampaign.id });

      // Past the review window, the same ad reads back ACTIVE.
      clockNow = new Date(clockNow.getTime() + 61_000);
      const adRead2 = body(await sim.handle(req(createAd.id, { fields: 'id,effective_status' })));
      expect(adRead2.effective_status).toBe('ACTIVE');

      // The created objects appear in the NEXT list reads.
      const campaignList = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, { fields: 'id' })));
      expect(campaignList.data.map((c: any) => c.id)).toContain(createCampaign.id);
      const adList = body(await sim.handle(req(`${createAdSet.id}/ads`, { fields: 'id' })));
      expect(adList.data.map((a: any) => a.id)).toEqual([createAd.id]);

      // Insights only ever read from the frozen dataset — a candidate-launched object reports
      // zero metrics (decision 3), never fabricated numbers, because it has no insightsDaily rows.
      const insights = body(await sim.handle(req(`${createAd.id}/insights`, { fields: 'impressions,spend', date_preset: 'maximum' })));
      expect(insights.data).toEqual([]);

      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('read-back is byte-identical to what was written (the "loud mismatch" invariant)', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const created = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, {}, 'POST', {
      form: { name: 'Exact Echo Campaign', objective: 'OUTCOME_TRAFFIC', daily_budget: '3333', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', start_time: '2026-09-13T00:00:00+0000' },
    })));
    const read = body(await sim.handle(req(created.id, { fields: 'id,name,daily_budget,bid_strategy,start_time' })));
    expect(read).toMatchObject({ id: created.id, name: 'Exact Echo Campaign', daily_budget: '3333', bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
    // start_time survives the store-unshifted / read-shifted round trip exactly.
    expect(read.start_time).toBe('2026-09-13T00:00:00+0000');
  });

  it('effective_status cascades from a paused campaign to its child adset and ad', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const campaign = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, {}, 'POST', { form: { name: 'C', objective: 'OUTCOME_LEADS', status: 'ACTIVE' } })));
    const adset = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adsets`, {}, 'POST', { form: { name: 'A', campaign_id: campaign.id, status: 'ACTIVE' } })));
    const creative = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adcreatives`, {}, 'POST', { form: { name: 'Cr' } })));
    const ad = body(await sim.handle(req(`${adset.id}/ads`, {}, 'POST', { form: { name: 'Ad', status: 'ACTIVE', creative: JSON.stringify({ creative_id: creative.id }) } })));
    clockNow = new Date(clockNow.getTime() + 61_000); // past the review window
    expect(body(await sim.handle(req(ad.id, { fields: 'effective_status' }))).effective_status).toBe('ACTIVE');

    await sim.handle(req(campaign.id, {}, 'POST', { form: { status: 'PAUSED' } }));
    expect(body(await sim.handle(req(adset.id, { fields: 'effective_status' }))).effective_status).toBe('CAMPAIGN_PAUSED');
    expect(body(await sim.handle(req(ad.id, { fields: 'effective_status' }))).effective_status).toBe('CAMPAIGN_PAUSED');
  });

  it('soft delete: a deleted ad disappears from list reads and a direct node read 404s', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const campaign = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, {}, 'POST', { form: { name: 'C', objective: 'OUTCOME_LEADS' } })));
    const adset = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adsets`, {}, 'POST', { form: { name: 'A', campaign_id: campaign.id } })));
    const creative = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adcreatives`, {}, 'POST', { form: { name: 'Cr' } })));
    const ad = body(await sim.handle(req(`${adset.id}/ads`, {}, 'POST', { form: { name: 'Ad', creative: JSON.stringify({ creative_id: creative.id }) } })));

    const del = body(await sim.handle(req(ad.id, {}, 'DELETE')));
    expect(del).toEqual({ success: true });

    const list = body(await sim.handle(req(`${adset.id}/ads`, { fields: 'id' })));
    expect(list.data).toEqual([]);
    const nodeRead = await sim.handle(req(ad.id, { fields: 'id' }));
    expect(body(nodeRead).error).toMatchObject({ code: 100 });

    // Deleting again is idempotent, not an error (CodeRabbit, ENG-1909 — the idempotency
    // check runs BEFORE resolving the object, so a repeated delete never reaches the
    // "unknown to the resolver" path this test used to assert on).
    const del2 = body(await sim.handle(req(ad.id, {}, 'DELETE')));
    expect(del2).toEqual({ success: true });
  });

  it('deleting a seeded (dataset) object also removes it from reads', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const del = body(await sim.handle(req(FIXTURE_IDS.campaigns[0], {}, 'DELETE')));
    expect(del).toEqual({ success: true });
    const list = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, { fields: 'id' })));
    expect(list.data.map((c: any) => c.id)).not.toContain(FIXTURE_IDS.campaigns[0]);
  });

  it('adimages: upload returns the Meta {images:{filename:{hash,url}}} shape, and a creative referencing it exposes image_url/thumbnail_url', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const upload = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adimages`, {}, 'POST', {
      multipart: { fields: {}, files: [{ field: 'file', filename: 'ad.png', contentType: 'image/png', bytes: Buffer.from([1, 2, 3, 4]) }] },
    })));
    const filenames = Object.keys(upload.images);
    expect(filenames).toHaveLength(1);
    const { hash, url } = upload.images[filenames[0]];
    expect(typeof hash).toBe('string');
    expect(url).toContain('adimages');

    const creative = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adcreatives`, {}, 'POST', { form: { name: 'Uses upload', image_hash: hash } })));
    const read = body(await sim.handle(req(creative.id, { fields: 'id,image_hash,image_url,thumbnail_url' })));
    expect(read.image_hash).toBe(hash);
    expect(read.image_url).toBe(url);
    expect(read.thumbnail_url).toBe(url);
  });

  it('creating a creative with an unknown image_hash is rejected, not silently accepted', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const res = await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adcreatives`, {}, 'POST', { form: { name: 'X', image_hash: 'doesnotexist' } }));
    expect(body(res).error).toMatchObject({ code: 100 });
  });

  it('customaudiences: create, read back, and delete', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const created = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/customaudiences`, {}, 'POST', { form: { name: 'Candidate Audience', subtype: 'CUSTOM' } })));
    expect(typeof created.id).toBe('string');
    const read = body(await sim.handle(req(created.id, { fields: 'id,name,subtype' })));
    expect(read).toMatchObject({ id: created.id, name: 'Candidate Audience', subtype: 'CUSTOM' });
    const list = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/customaudiences`, { fields: 'id' })));
    expect(list.data.map((a: any) => a.id)).toContain(created.id);
    const del = body(await sim.handle(req(created.id, {}, 'DELETE')));
    expect(del).toEqual({ success: true });
    const listAfter = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/customaudiences`, { fields: 'id' })));
    expect(listAfter.data.map((a: any) => a.id)).not.toContain(created.id);
  });

  it('create-then-immediately-update in the same flow reads back the update (overlay CAS round trip within one flow)', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const created = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, {}, 'POST', { form: { name: 'Before', objective: 'OUTCOME_LEADS' } })));
    await sim.handle(req(created.id, {}, 'POST', { form: { name: 'After' } }));
    const read = body(await sim.handle(req(created.id, { fields: 'id,name' })));
    expect(read.name).toBe('After');
    expect(deps.mutateOverlay).toHaveBeenCalledTimes(2);
  });

  it('rejects an adset whose campaign_id does not exist, and an ad whose adset_id/creative_id does not exist', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const badAdSet = await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adsets`, {}, 'POST', { form: { name: 'A', campaign_id: 'nonexistent' } }));
    expect(body(badAdSet).error).toMatchObject({ code: 100 });
    const badAd = await sim.handle(req(`${FIXTURE_IDS.adsets[0]}/ads`, {}, 'POST', { form: { name: 'Ad', creative: JSON.stringify({ creative_id: 'nonexistent' }) } }));
    expect(body(badAd).error).toMatchObject({ code: 100 });
  });

  it('rejects a bogus status value on create and update instead of silently storing it (CodeRabbit)', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const badCreate = await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, {}, 'POST', {
      form: { name: 'X', objective: 'OUTCOME_LEADS', status: 'BROKEN' },
    }));
    expect(body(badCreate).error).toMatchObject({ code: 100 });

    const created = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, {}, 'POST', { form: { name: 'Y', objective: 'OUTCOME_LEADS' } })));
    const badUpdate = await sim.handle(req(created.id, {}, 'POST', { form: { status: 'BROKEN' } }));
    expect(body(badUpdate).error).toMatchObject({ code: 100 });
    const stillGood = body(await sim.handle(req(created.id, { fields: 'id,status' })));
    expect(stillGood.status).toBe('PAUSED');
  });

  it('a repeated DELETE on an already-deleted id is idempotent, not an error (CodeRabbit)', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const created = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, {}, 'POST', { form: { name: 'Z', objective: 'OUTCOME_LEADS' } })));
    const first = body(await sim.handle(req(created.id, {}, 'DELETE')));
    expect(first).toEqual({ success: true });
    const second = await sim.handle(req(created.id, {}, 'DELETE'));
    expect(body(second)).toEqual({ success: true });
    expect(second.status).toBe(200);
  });

  it('deleting a campaign cascades to its own ad sets and ads — no orphan reads back ACTIVE (CodeRabbit)', async () => {
    const deps = makeDeps();
    const sim = createMetaSimulator(deps);
    const campaign = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, {}, 'POST', { form: { name: 'Parent', objective: 'OUTCOME_LEADS' } })));
    const adset = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adsets`, {}, 'POST', {
      form: { name: 'Child AdSet', campaign_id: campaign.id, status: 'ACTIVE' },
    })));
    const creative = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adcreatives`, {}, 'POST', { form: { name: 'Creative' } })));
    const ad = body(await sim.handle(req(`${adset.id}/ads`, {}, 'POST', {
      form: { name: 'Child Ad', status: 'ACTIVE', creative: JSON.stringify({ creative_id: creative.id }) },
    })));

    const del = body(await sim.handle(req(campaign.id, {}, 'DELETE')));
    expect(del).toEqual({ success: true });

    const campaigns = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/campaigns`, { fields: 'id' })));
    expect(campaigns.data.map((c: any) => c.id)).not.toContain(campaign.id);
    const adsets = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/adsets`, { fields: 'id' })));
    expect(adsets.data.map((a: any) => a.id)).not.toContain(adset.id);
    const ads = body(await sim.handle(req(`act_${FIXTURE_ACCOUNT_ID}/ads`, { fields: 'id' })));
    expect(ads.data.map((a: any) => a.id)).not.toContain(ad.id);

    // Not just absent from lists — a direct read-by-id must also be gone, never falling
    // through to a spuriously-ACTIVE orphan.
    expect(body(await sim.handle(req(adset.id, {}))).error).toMatchObject({ code: 100 });
    expect(body(await sim.handle(req(ad.id, {}))).error).toMatchObject({ code: 100 });
  });
});
