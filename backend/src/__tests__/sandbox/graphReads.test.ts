import { handleGraphRead, parseFields } from '../../services/sandbox/graphReads';
import { computeShiftDays, shiftDay } from '../../services/sandbox/dateShift';
import { EMPTY_OVERLAY, SimRequest } from '../../services/sandbox/types';
import { buildFixtureDataset, FIXTURE_IDS, FIXTURE_ACCOUNT_ID, fixtureTotal } from './fixtures/fixtureDataset';

/**
 * ENG-1908 AC 1/2: every Graph read the product performs (design doc §5–6 inventory) must
 * come back in Meta's wire shape — envelopes, numeric-string ids, account_id on nodes,
 * string budgets, nested selectors, shifted dates, effective-status inheritance.
 */
const dataset = buildFixtureDataset();
const now = new Date('2026-09-13T15:00:00Z');
const shift = computeShiftDays(dataset.meta.frozenWindow.until, now);
const token = 'sbx.eval_fixture.0123456789abcdef01234567';
const ctx = { dataset, overlay: EMPTY_OVERLAY, shift, now, userId: 'eval_fixture', token };
const act = `act_${FIXTURE_ACCOUNT_ID}`;
const req = (path: string, query: Record<string, string> = {}, method: SimRequest['method'] = 'GET'): SimRequest =>
  ({ userId: 'eval_fixture', token, method, version: 'v25.0', path, query });
const body = (res: any) => JSON.parse(res.body);

describe('field selector parser', () => {
  it('parses nested selectors and field calls', () => {
    const tree = parseFields('id,name,creative{id,thumbnail_url,object_story_spec{page_id,link_data{link}}},insights.time_ranges([{"since":"2026-09-01","until":"2026-09-07"}]){spend,ctr}');
    expect(tree.map(f => f.name)).toEqual(['id', 'name', 'creative', 'insights']);
    expect(tree[2].children?.map(f => f.name)).toEqual(['id', 'thumbnail_url', 'object_story_spec']);
    expect(tree[2].children?.[2].children?.[1].children?.[0].name).toBe('link');
    expect(tree[3].args?.time_ranges).toEqual([{ since: '2026-09-01', until: '2026-09-07' }]);
    expect(tree[3].children?.map(f => f.name)).toEqual(['spend', 'ctr']);
  });
});

describe('account and identity endpoints', () => {
  it('act_ node with fields', () => {
    const res = handleGraphRead(ctx, req(act, { fields: 'account_id,name,currency,timezone_name,account_status,business' }))!;
    expect(res.status).toBe(200);
    expect(body(res)).toEqual({ id: act, account_id: FIXTURE_ACCOUNT_ID, name: 'AgentWeb Sandbox', currency: 'USD', timezone_name: 'UTC', account_status: 1, business: { id: FIXTURE_IDS.business, name: 'AgentWeb Sandbox Business' } });
  });
  it('me, me/adaccounts, me/accounts, me/permissions, debug_token, owned_pages, oauth/access_token', () => {
    expect(body(handleGraphRead(ctx, req('me', { fields: 'id,name' }))!)).toMatchObject({ id: expect.stringMatching(/^10\d{12}$/), name: 'AgentWeb Sandbox' });
    expect(body(handleGraphRead(ctx, req('me/adaccounts', { fields: 'id,name,account_id,currency,account_status' }))!)).toEqual({ data: [{ id: act, name: 'AgentWeb Sandbox', account_id: FIXTURE_ACCOUNT_ID, currency: 'USD', account_status: 1 }], paging: { cursors: { before: 'MAAZDZD', after: 'MjQZD' } } });
    const pages = body(handleGraphRead(ctx, req('me/accounts', { fields: 'id,name,access_token,category,tasks' }))!);
    expect(pages.data[0]).toMatchObject({ id: FIXTURE_IDS.page, name: 'AgentWeb', access_token: token, category: 'Software', tasks: expect.arrayContaining(['ADVERTISE']) });
    expect(body(handleGraphRead(ctx, req('me/permissions'))!).data).toEqual(expect.arrayContaining([{ permission: 'ads_management', status: 'granted' }, { permission: 'ads_read', status: 'granted' }]));
    const debug = body(handleGraphRead(ctx, req('debug_token', { input_token: token }))!).data;
    expect(debug).toMatchObject({ is_valid: true, scopes: expect.arrayContaining(['ads_management', 'ads_read']), granular_scopes: expect.arrayContaining([{ scope: 'ads_management', target_ids: [FIXTURE_ACCOUNT_ID] }]) });
    expect(debug.expires_at).toBeGreaterThan(Math.floor(now.getTime() / 1000) + 50 * 86400);
    expect(body(handleGraphRead(ctx, req(`${FIXTURE_IDS.business}/owned_pages`, { fields: 'id,name,category' }))!).data).toEqual([{ id: FIXTURE_IDS.page, name: 'AgentWeb', category: 'Software' }]);
    expect(body(handleGraphRead(ctx, req(`${FIXTURE_IDS.page}`, { fields: 'instagram_business_account,connected_instagram_account,id,name' }))!)).toMatchObject({ id: FIXTURE_IDS.page, instagram_business_account: { id: '17800000000000001' } });
    for (const method of ['GET', 'POST'] as const) {
      expect(body(handleGraphRead(ctx, req('oauth/access_token', { grant_type: 'fb_exchange_token', fb_exchange_token: token }, method))!)).toEqual({ access_token: token, token_type: 'bearer', expires_in: 5184000 });
    }
  });
});

describe('campaign / adset / ad / creative reads', () => {
  it('act_/campaigns with the SDK default field set: string budgets, shifted times, account_id, envelope', () => {
    const res = body(handleGraphRead(ctx, req(`${act}/campaigns`, { fields: 'id,name,status,objective,daily_budget,lifetime_budget,budget_remaining,spend_cap,bid_strategy,start_time,stop_time,effective_status,special_ad_categories,account_id', limit: '100' }))!);
    expect(res.paging).toEqual({ cursors: { before: 'MAAZDZD', after: 'MjQZD' } });
    expect(res.paging.next).toBeUndefined();
    expect(res.data).toHaveLength(3);
    const c = res.data.find((x: any) => x.id === FIXTURE_IDS.campaigns[0]);
    expect(c).toMatchObject({ id: FIXTURE_IDS.campaigns[0], account_id: FIXTURE_ACCOUNT_ID, name: 'Founder Demos — Lead Gen', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS', daily_budget: '5000', budget_remaining: '5000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', special_ad_categories: [] });
    expect(c.start_time).toBe(`${shiftDay('2026-04-09', shift)}T00:00:00+0000`);
    expect(c.lifetime_budget).toBeUndefined();
    expect(c.stop_time).toBeUndefined();
  });
  it('GREATER_THAN/LESS_THAN filters compare numerically, not lexicographically (CodeRabbit)', () => {
    // daily_budget is a string on the wire ("1500", "4000", "5000"). A naive string
    // comparison puts "1500" BELOW "400" (first char '1' < '4'), so a numeric filter
    // implemented without coercion would wrongly drop the $1500 campaign here.
    const gt = body(handleGraphRead(ctx, req(`${act}/campaigns`, { fields: 'id,daily_budget', filtering: JSON.stringify([{ field: 'daily_budget', operator: 'GREATER_THAN', value: 400 }]) }))!);
    expect(gt.data.map((c: any) => c.daily_budget).sort()).toEqual(['1500', '4000', '5000']);
    const lt = body(handleGraphRead(ctx, req(`${act}/campaigns`, { fields: 'id,daily_budget', filtering: JSON.stringify([{ field: 'daily_budget', operator: 'LESS_THAN', value: 4500 }]) }))!);
    expect(lt.data.map((c: any) => c.daily_budget).sort()).toEqual(['1500', '4000']);
  });
  it('adsets: account edge, campaign edge, node read-back with targeting and promoted_object; effective_status inherits CAMPAIGN_PAUSED', () => {
    const all = body(handleGraphRead(ctx, req(`${act}/adsets`, { fields: 'id,name,status,campaign_id,optimization_goal,billing_event,destination_type,promoted_object,bid_strategy,daily_budget,start_time,end_time,targeting,effective_status' }))!);
    expect(all.data).toHaveLength(4);
    const paused = all.data.find((a: any) => a.campaign_id === FIXTURE_IDS.campaigns[2]);
    expect(paused.effective_status).toBe('CAMPAIGN_PAUSED');
    expect(paused.status).toBe('ACTIVE');
    const byCampaign = body(handleGraphRead(ctx, req(`${FIXTURE_IDS.campaigns[0]}/adsets`, { fields: 'id,name,campaign_id' }))!);
    expect(byCampaign.data.map((a: any) => a.id)).toEqual([FIXTURE_IDS.adsets[0], FIXTURE_IDS.adsets[1]]);
    const node = body(handleGraphRead(ctx, req(FIXTURE_IDS.adsets[1], { fields: 'id,name,status,campaign_id,bid_strategy,bid_amount,daily_budget,lifetime_budget,start_time,end_time,promoted_object,targeting,account_id' }))!);
    expect(node).toMatchObject({ id: FIXTURE_IDS.adsets[1], account_id: FIXTURE_ACCOUNT_ID, campaign_id: FIXTURE_IDS.campaigns[0], promoted_object: { pixel_id: FIXTURE_IDS.pixel, custom_event_type: 'LEAD' }, targeting: { geo_locations: { countries: ['US'] }, age_min: 25 } });
    expect(node.daily_budget).toBeUndefined();
  });
  it('ads: nested creative + campaign selectors, effective_status filter, exclusion of deleted, insights.time_ranges field call', () => {
    const res = body(handleGraphRead(ctx, req(`${act}/ads`, { fields: 'id,name,status,effective_status,adset_id,campaign_id,creative{id,name,body,title,image_url,thumbnail_url,object_story_spec}', effective_status: JSON.stringify(['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES']), limit: '100' }))!);
    expect(res.data).toHaveLength(6);
    const ad = res.data.find((a: any) => a.id === FIXTURE_IDS.ads[0]);
    expect(ad).toMatchObject({ adset_id: FIXTURE_IDS.adsets[0], campaign_id: FIXTURE_IDS.campaigns[0], effective_status: 'ACTIVE',
      creative: { id: FIXTURE_IDS.creatives[0], name: 'Creative 1', body: 'Body copy for creative 1', title: 'Headline 1', image_url: 'https://assets.example.invalid/sandbox/creative_1.jpg', thumbnail_url: 'https://assets.example.invalid/sandbox/creative_1_thumb.jpg', object_story_spec: { page_id: FIXTURE_IDS.page } } });
    const pausedOnly = body(handleGraphRead(ctx, req(`${act}/ads`, { fields: 'id,effective_status', effective_status: JSON.stringify(['CAMPAIGN_PAUSED']) }))!);
    expect(pausedOnly.data.map((a: any) => a.id)).toEqual([FIXTURE_IDS.ads[5]]);
    const activeOnly = body(handleGraphRead(ctx, req(`${act}/ads`, { fields: 'id,name,effective_status,campaign{id,name,objective},creative{link_url,object_story_spec,asset_feed_spec}', effective_status: '["ACTIVE"]' }))!);
    expect(activeOnly.data).toHaveLength(5);
    expect(activeOnly.data[0].campaign).toEqual({ id: FIXTURE_IDS.campaigns[0], name: 'Founder Demos — Lead Gen', objective: 'OUTCOME_LEADS' });
    expect(activeOnly.data[0].creative.link_url).toBe('https://landing.example.invalid/demo');
    const overlay = { ...EMPTY_OVERLAY, deletedIds: [FIXTURE_IDS.ads[1]] };
    expect(body(handleGraphRead({ ...ctx, overlay }, req(`${act}/ads`, { fields: 'id' }))!).data).toHaveLength(5);
    const windows = [{ since: shiftDay('2026-04-17', shift), until: shiftDay('2026-04-30', shift) }, { since: shiftDay('2026-04-03', shift), until: shiftDay('2026-04-16', shift) }];
    const withInsights = body(handleGraphRead(ctx, req(`${act}/ads`, { fields: `id,name,creative{id,name},status,insights.time_ranges(${JSON.stringify(windows)}){spend,frequency,ctr,cpm,date_start}`, filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [FIXTURE_IDS.campaigns[0]] }]) }))!);
    // campaign[0] owns adsets[0..1], which own ads[0..3] (4 ads) in the fixture.
    expect(withInsights.data).toHaveLength(4);
    expect(withInsights.data[0].insights.data).toHaveLength(2);
    expect(withInsights.data[0].insights.data[0]).toMatchObject({ date_start: windows[0].since, spend: expect.stringMatching(/^\d+\.\d\d$/) });
  });
  it('UTM audit and destination sweeps: link_url, url_tags, object_story_spec deep selection and asset_feed_spec', () => {
    const res = body(handleGraphRead(ctx, req(`${act}/ads`, { fields: 'id,campaign_id,creative{id,link_url,url_tags,object_story_spec{page_id,link_data{link,message,image_hash,picture,call_to_action{type,value}}},asset_feed_spec}', filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [FIXTURE_IDS.campaigns[1]] }]) }))!);
    // campaign[1] owns adsets[2], which owns ads[4] alone (1 ad) in the fixture.
    expect(res.data).toHaveLength(1);
    expect(res.data[0].creative).toMatchObject({ link_url: 'https://landing.example.invalid/demo', url_tags: expect.stringContaining('utm_source=meta'),
      object_story_spec: { page_id: FIXTURE_IDS.page, link_data: { link: 'https://landing.example.invalid/demo', call_to_action: { type: 'LEARN_MORE', value: { link: 'https://landing.example.invalid/demo' } } } } });
    expect(res.data[0].creative.object_story_spec.link_data.name).toBeUndefined();
  });
  it('creative node and adset/adcreatives edge; an ad node carries ad_review_feedback and creative{status}', () => {
    const creative = body(handleGraphRead(ctx, req(FIXTURE_IDS.creatives[2], { fields: 'id,account_id,name,body,title,image_url,thumbnail_url,object_type,link_url,object_story_spec,asset_feed_spec,url_tags' }))!);
    expect(creative).toMatchObject({ id: FIXTURE_IDS.creatives[2], account_id: FIXTURE_ACCOUNT_ID, object_type: 'SHARE' });
    const edge = body(handleGraphRead(ctx, req(`${FIXTURE_IDS.adsets[0]}/adcreatives`, { fields: 'id,name' }))!);
    expect(edge.data.map((c: any) => c.id).sort()).toEqual([FIXTURE_IDS.creatives[0], FIXTURE_IDS.creatives[1]].sort());
    const ad = body(handleGraphRead(ctx, req(FIXTURE_IDS.ads[0], { fields: 'id,name,status,effective_status,adset_id,campaign_id,account_id,ad_review_feedback,creative{id,name,status}' }))!);
    expect(ad).toMatchObject({ ad_review_feedback: null, creative: { id: FIXTURE_IDS.creatives[0], status: 'ACTIVE' }, account_id: FIXTURE_ACCOUNT_ID });
  });
  it('unknown or foreign ids fail like Meta does, and an overlay object shadows the dataset', () => {
    const missing = handleGraphRead(ctx, req('120219999999999999', { fields: 'id,account_id' }))!;
    expect(missing.status).toBe(400);
    expect(body(missing).error).toMatchObject({ code: 100, error_subcode: 33, type: 'GraphMethodException' });
    const foreign = handleGraphRead(ctx, req('act_1358071355944019/campaigns', { fields: 'id' }))!;
    expect(foreign.status).toBe(400);
    const renamed = { ...dataset.campaigns[0], name: 'Renamed by candidate', updated_time: '2026-04-30T12:00:00+0000' };
    const overlay = { ...EMPTY_OVERLAY, campaigns: { [renamed.id]: renamed } };
    expect(body(handleGraphRead({ ...ctx, overlay }, req(FIXTURE_IDS.campaigns[0], { fields: 'id,name' }))!)).toEqual({ id: FIXTURE_IDS.campaigns[0], name: 'Renamed by candidate' });
  });
});

describe('pixels, audiences, targeting, account-level insights via the edge', () => {
  it('adspixels list, pixel stats by event and match keys, dataset event_stats', () => {
    const list = body(handleGraphRead(ctx, req(`${act}/adspixels`, { fields: 'id,name,last_fired_time,is_created_by_business', limit: '100' }))!);
    expect(list.data).toEqual([{ id: FIXTURE_IDS.pixel, name: 'AgentWeb Pixel', last_fired_time: `${shiftDay('2026-04-30', shift)}T00:00:00+0000`, is_created_by_business: true }]);
    const start = Math.floor(new Date(`${shiftDay('2026-04-24', shift)}T00:00:00Z`).getTime() / 1000);
    const end = Math.floor(new Date(`${shiftDay('2026-04-30', shift)}T23:59:59Z`).getTime() / 1000);
    const stats = body(handleGraphRead(ctx, req(`${FIXTURE_IDS.pixel}/stats`, { aggregation: 'event', start_time: String(start), end_time: String(end) }))!);
    const leads = dataset.pixels[0].statsByDay.filter(d => d.date >= '2026-04-24' && d.date <= '2026-04-30').reduce((n, d) => n + d.events.Lead, 0);
    expect(stats.data[0].data).toEqual(expect.arrayContaining([{ value: 'Lead', count: leads }]));
    const keys = body(handleGraphRead(ctx, req(`${FIXTURE_IDS.pixel}/stats`, { aggregation: 'match_keys' }))!);
    expect(keys.data[0].data.map((d: any) => d.value)).toEqual(expect.arrayContaining(['em']));
    const node = body(handleGraphRead(ctx, req(FIXTURE_IDS.pixel, { fields: 'id,name,event_stats' }))!);
    expect(node.event_stats.some((e: any) => e.event === 'Lead')).toBe(true);
  });
  it('custom audiences, targeting search and geo search are deterministic', () => {
    expect(body(handleGraphRead(ctx, req(`${act}/customaudiences`, { fields: 'id,name,description,delivery_status,subtype,customer_file_source,lookalike_spec' }))!).data[0]).toMatchObject({ id: FIXTURE_IDS.audience, subtype: 'WEBSITE', delivery_status: { code: 200 } });
    expect(body(handleGraphRead(ctx, req(`${act}/targetingsearch`, { q: 'market', type: 'adinterest' }))!).data[0]).toMatchObject({ name: 'Marketing' });
    expect(body(handleGraphRead(ctx, req('search', { type: 'adgeolocation', q: 'united', limit: '25' }))!).data[0]).toMatchObject({ key: 'US', type: 'country' });
  });
  it('act_/insights, <campaign>/insights and <ad>/insights honour level, action_breakdowns and a time_range', () => {
    const range = { since: shiftDay('2026-04-24', shift), until: shiftDay('2026-04-30', shift) };
    const acct = body(handleGraphRead(ctx, req(`${act}/insights`, { fields: 'impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,actions,cost_per_action_type', level: 'campaign', time_range: JSON.stringify(range), action_breakdowns: 'action_type', action_report_time: 'conversion', action_attribution_windows: JSON.stringify(['default']), filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: [FIXTURE_IDS.campaigns[0], FIXTURE_IDS.campaigns[1]] }]) }))!);
    expect(acct.data).toHaveLength(2);
    expect(acct.data[0]).toMatchObject({ campaign_id: expect.any(String), date_start: range.since, date_stop: range.until, actions: expect.any(Array) });
    const ad = body(handleGraphRead(ctx, req(`${FIXTURE_IDS.ads[0]}/insights`, { fields: 'spend,actions,date_start', time_increment: '1', date_preset: 'last_7d' }))!);
    expect(ad.data).toHaveLength(7);
    const campaignRows = body(handleGraphRead(ctx, req(`${FIXTURE_IDS.campaigns[2]}/insights`, { fields: 'spend,actions,date_start,objective,campaign_name', level: 'campaign', time_increment: '1', date_preset: 'last_90d' }))!);
    expect(campaignRows.data).toHaveLength(10);
    expect(campaignRows.data[0]).toMatchObject({ objective: 'OUTCOME_TRAFFIC', campaign_name: 'Blog Traffic — Spring' });
    const spendAll = fixtureTotal(dataset, 'spend');
    const max = body(handleGraphRead(ctx, req(`${act}/insights`, { fields: 'spend', date_preset: 'maximum' }))!);
    expect(max.data[0].spend).toBe((spendAll / 100).toFixed(2));
  });
  it('returns null for paths this module does not serve so the router can decide', () => {
    expect(handleGraphRead(ctx, req(`${act}/campaigns`, {}, 'POST'))).toBeNull();
    expect(handleGraphRead(ctx, req(`${act}/adimages`, {}, 'POST'))).toBeNull();
  });
});

it('ENG-2026 retains effective delivery restrictions while configured status stays ACTIVE', () => {
  const d = buildFixtureDataset();
  d.campaigns[0].effective_status = 'WITH_ISSUES';
  d.adsets[0].effective_status = 'PENDING_BILLING_INFO';
  d.ads[0].effective_status = 'DISAPPROVED';
  const c = { ...ctx, dataset: d };
  for (const [object, status] of [[d.campaigns[0], 'WITH_ISSUES'], [d.adsets[0], 'PENDING_BILLING_INFO'], [d.ads[0], 'DISAPPROVED']] as const) {
    expect(body(handleGraphRead(c, req(object.id, { fields: 'id,status,effective_status' }))!)).toMatchObject({ status: 'ACTIVE', effective_status: status });
  }
});

it('parent delivery restrictions cascade and survive a configured pause/resume', () => {
  const d = buildFixtureDataset();
  d.campaigns[0].effective_status = 'WITH_ISSUES';
  const c = { ...ctx, dataset: d, overlay: structuredClone(EMPTY_OVERLAY) };
  for (const obj of [d.campaigns[0], d.adsets[0], d.ads[0]]) {
    expect(body(handleGraphRead(c, req(obj.id, { fields: 'effective_status' }))!).effective_status).toBe('WITH_ISSUES');
  }
  c.overlay.campaigns[d.campaigns[0].id] = { ...d.campaigns[0], status: 'PAUSED' };
  expect(body(handleGraphRead(c, req(d.ads[0].id, { fields: 'effective_status' }))!).effective_status).toBe('CAMPAIGN_PAUSED');
  c.overlay.campaigns[d.campaigns[0].id].status = 'ACTIVE';
  expect(body(handleGraphRead(c, req(d.ads[0].id, { fields: 'effective_status' }))!).effective_status).toBe('WITH_ISSUES');
});
