jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'test-secret' }));
import { runMetaExperimentWriteTool, type MetaExperimentWriteDeps, isMetaExperimentWrite } from '../mcp/metaToolkitExperimentWrites';
import { ZOMA_META_PARITY_MATRIX } from '../mcp/zomaMetaParityMatrix';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const DAY = 86_400;
const iso = (s: number) => new Date(s * 1000).toISOString();

function makeDeps(opts: { foreignCampaign?: string; studies?: any[]; postError?: any; readBack?: (id: string) => any } = {}) {
  const posts: Array<{ path: string; params: Record<string, string> }> = [];
  const created: Record<string, any> = {};
  const graph = jest.fn(async (_u: string, _a: string, method: 'GET' | 'POST', path: string, params: Record<string, string>) => {
    if (method === 'POST') {
      if (opts.postError) throw opts.postError;
      posts.push({ path, params });
      const id = path === 'act_123/ad_studies' ? '900' : path;
      created[id] = {
        id, type: params.type ?? 'SPLIT_TEST', name: params.name ?? 'Old', description: params.description,
        start_time: params.start_time ? iso(Number(params.start_time)) : iso(NOW_S + DAY), end_time: params.end_time ? iso(Number(params.end_time)) : iso(NOW_S + 10 * DAY),
        cells: { data: params.cells ? JSON.parse(params.cells).map((c: any) => ({ name: c.name, treatment_percentage: c.treatment_percentage })) : [] },
      };
      return path === 'act_123/ad_studies' ? { id: '900' } : { success: true };
    }
    if (path === 'act_123/ad_studies') return { data: opts.studies ?? [{ id: '555', end_time: iso(NOW_S + 5 * DAY), cells: { data: [{ campaigns: { data: [{ id: '77' }] } }] } }] };
    if (opts.readBack && created[path]) return opts.readBack(path);
    if (created[path]) return created[path];
    if (path === '555') return { id: '555', type: 'SPLIT_TEST', name: 'Old', start_time: iso(NOW_S + DAY), end_time: iso(NOW_S + 10 * DAY) };
    if (path === '666') return { id: '666', type: 'LIFT', name: 'Lift' };
    return { id: path, name: `C${path}`, account_id: path === opts.foreignCampaign ? 'act_999' : 'act_123', effective_status: 'ACTIVE' };
  });
  const deps: MetaExperimentWriteDeps = { graph: graph as any, secret: () => 'test-secret', now: () => NOW_MS, consumedTokens: new Map(), tokenOutcomes: new Map() };
  return { deps, graph, posts };
}

const createArgs = {
  name: 'Creative test', end_time: NOW_S + 15 * DAY,
  cells: [{ name: 'A', treatment_percentage: 50, campaign_ids: ['11'] }, { name: 'B', treatment_percentage: 50, campaign_ids: ['12'] }],
};

describe('ENG-2980 experiment writes', () => {
  it('eligibility is read-only and reports campaigns already in a study', async () => {
    const { deps, posts } = makeDeps();
    expect(isMetaExperimentWrite('ads_experiment_check_eligibility')).toBe(false);
    const res: any = await runMetaExperimentWriteTool('ads_experiment_check_eligibility', 'u1', '123', { campaign_ids: ['11', '77'] }, deps);
    expect(res.eligible).toBe(false);
    expect(res.campaigns.find((c: any) => c.campaign_id === '77').reasons[0]).toMatch(/already in study 555/);
    expect(res.campaigns.find((c: any) => c.campaign_id === '11').eligible).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it('eligibility refuses a campaign from another account', async () => {
    const { deps } = makeDeps({ foreignCampaign: '12' });
    await expect(runMetaExperimentWriteTool('ads_experiment_check_eligibility', 'u1', '123', { campaign_ids: ['11', '12'] }, deps)).rejects.toThrow(/not in the selected ad account/);
  });

  it.each([['ads_experiment_abtest_create_test', 'SPLIT_TEST'], ['ads_experiment_lift_create_test', 'LIFT']] as const)(
    '%s previews the full spec, then creates on confirm and verifies by read-back', async (tool, type) => {
      const { deps, posts } = makeDeps();
      const preview: any = await runMetaExperimentWriteTool(tool, 'u1', '123', createArgs, deps);
      expect(preview.status).toBe('PREVIEW');
      expect(preview.study_spec).toMatchObject({ type, start_time: NOW_S + DAY, cells: createArgs.cells });
      expect(preview.preview).toMatch(/cannot start before/);
      expect(posts).toHaveLength(0);
      const done: any = await runMetaExperimentWriteTool(tool, 'u1', '123', { ...createArgs, confirm: true, preview_token: preview.preview_token }, deps);
      expect(done).toMatchObject({ success: true, verification: 'CONFIRMED', id: '900' });
      expect(posts).toHaveLength(1);
      expect(posts[0].path).toBe('act_123/ad_studies');
      expect(posts[0].params).toMatchObject({ type, start_time: String(NOW_S + DAY) });
      expect(JSON.parse(posts[0].params.cells)[0]).toEqual({ name: 'A', treatment_percentage: 50, campaigns: ['11'] });
    });

  it('refuses a missing or invalid token and never posts', async () => {
    const { deps, posts } = makeDeps();
    const noToken: any = await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', { ...createArgs, confirm: true }, deps);
    expect(noToken.status).toBe('PREVIEW_MISMATCH');
    const bad: any = await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', { ...createArgs, confirm: true, preview_token: 'v1.9999999999999.x' }, deps);
    expect(bad.status).toBe('PREVIEW_MISMATCH');
    const preview: any = await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', createArgs, deps);
    const changed: any = await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', { ...createArgs, name: 'Other', confirm: true, preview_token: preview.preview_token }, deps);
    expect(changed.status).toBe('PREVIEW_MISMATCH');
    expect(posts).toHaveLength(0);
  });

  it('a used token replays the outcome instead of creating twice', async () => {
    const { deps, posts } = makeDeps();
    const preview: any = await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', createArgs, deps);
    const args = { ...createArgs, confirm: true, preview_token: preview.preview_token };
    await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', args, deps);
    const again: any = await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', args, deps);
    expect(again.replayed).toBe(true);
    expect(posts).toHaveLength(1);
  });

  it('refuses a start_time in the past, foreign campaigns and campaigns already in a study', async () => {
    const { deps } = makeDeps({ foreignCampaign: '12' });
    await expect(runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', { ...createArgs, start_time: NOW_S - 1 }, deps)).rejects.toThrow(/future/);
    await expect(runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', createArgs, deps)).rejects.toThrow(/not in the selected ad account/);
    const { deps: d2 } = makeDeps();
    const busy = { ...createArgs, cells: [createArgs.cells[0], { name: 'B', treatment_percentage: 50, campaign_ids: ['77'] }] };
    await expect(runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', busy, d2)).rejects.toThrow(/already in a study: 77/);
  });

  it('update refuses a study id not owned by the account and a lift study', async () => {
    const { deps, posts } = makeDeps();
    await expect(runMetaExperimentWriteTool('ads_experiment_abtest_update_test', 'u1', '123', { study_id: '4242', name: 'X' }, deps)).rejects.toThrow(/not in the selected ad account/);
    const { deps: d2 } = makeDeps({ studies: [{ id: '666' }] });
    await expect(runMetaExperimentWriteTool('ads_experiment_abtest_update_test', 'u1', '123', { study_id: '666', name: 'X' }, d2)).rejects.toThrow(/not SPLIT_TEST/);
    expect(posts).toHaveLength(0);
  });

  it('update previews, applies on confirm and verifies by read-back', async () => {
    const { deps, posts } = makeDeps();
    const args = { study_id: '555', name: 'Renamed' };
    const preview: any = await runMetaExperimentWriteTool('ads_experiment_abtest_update_test', 'u1', '123', args, deps);
    expect(preview.preview).toMatch(/"Old" -> "Renamed"/);
    const done: any = await runMetaExperimentWriteTool('ads_experiment_abtest_update_test', 'u1', '123', { ...args, confirm: true, preview_token: preview.preview_token }, deps);
    expect(done).toMatchObject({ success: true, verification: 'CONFIRMED', id: '555' });
    expect(posts).toEqual([{ path: '555', params: { name: 'Renamed' } }]);
  });

  it('reports MISMATCH when the read-back differs', async () => {
    const { deps } = makeDeps({ readBack: (id) => ({ id, type: 'SPLIT_TEST', name: 'Wrong', cells: { data: [] } }) });
    const preview: any = await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', createArgs, deps);
    const done: any = await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', { ...createArgs, confirm: true, preview_token: preview.preview_token }, deps);
    expect(done).toMatchObject({ success: false, verification: 'MISMATCH' });
    expect(done.message).toMatch(/name/);
  });

  it('surfaces a Meta refusal through the error explainer', async () => {
    const err: any = new Error('Permissions error');
    err.metaError = { code: 200, message: 'Permissions error' };
    err.outcomeUnknown = false;
    const { deps } = makeDeps({ postError: err });
    const preview: any = await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', createArgs, deps);
    const done: any = await runMetaExperimentWriteTool('ads_experiment_abtest_create_test', 'u1', '123', { ...createArgs, confirm: true, preview_token: preview.preview_token }, deps);
    expect(done).toMatchObject({ status: 'FAILED', success: false });
    expect(done.message).toMatch(/Permissions error/);
    expect(done.verification).toBeUndefined();
  });

  it('parity matrix marks the four experiment tools covered', () => {
    for (const t of ['ads_experiment_check_eligibility', 'ads_experiment_abtest_create_test', 'ads_experiment_abtest_update_test', 'ads_experiment_lift_create_test']) {
      expect((ZOMA_META_PARITY_MATRIX as any[]).find((r) => r.metaTool === t)?.status).toBe('covered');
    }
  });
});
