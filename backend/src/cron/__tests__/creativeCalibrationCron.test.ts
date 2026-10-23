/**
 * ENG-2142: the weekly calibration job is inert by default, writes each week's batch once across
 * instances, and posts at most ONE Slack message per batch — none with the flag off.
 */

import { jest } from '@jest/globals';

jest.mock('../../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));
jest.mock('../../services/slackService', () => ({ postSlackMessage: jest.fn() }));
jest.mock('../../utils/instanceState', () => ({ isCronEnabled: jest.fn(() => true) }));

import { postSlackMessage as realPostSlackMessage } from '../../services/slackService';
import {
  calibrationSlackText,
  postCalibrationSlack,
  runCreativeCalibration,
  type CalibrationSettings,
  type CreativeCalibrationDeps,
} from '../creativeCalibrationCron';
import type { CalibrationCandidate } from '../../loops/eval/creativeCalibration';
import type { GoldenCase } from '../../loops/eval/goldenSet';
import type { GoldenSetStore } from '../../loops/eval/goldenSetStore';

const NOW = new Date('2026-09-22T09:00:00Z'); // ISO week 2026-W39; draws from 2026-09-14..21

function memoryStore(provisioned = true): GoldenSetStore & { rows: Map<string, GoldenCase> } {
  const rows = new Map<string, GoldenCase>();
  return {
    rows,
    tableName: provisioned ? 'T' : null,
    isProvisioned: () => provisioned,
    getCase: async (id) => rows.get(id) ?? null,
    // Like the real store: excluded cases only when asked for.
    listCases: async (surface, opts = {}) => [...rows.values()].filter((c) => c.surface === surface && (opts.includeExcluded || !c.excluded)),
    createCase: async (c) => {
      if (rows.has(c.caseId)) return 'exists';
      rows.set(c.caseId, c);
      return 'created';
    },
    saveLabels: async () => {
      throw new Error('not used');
    },
    saveDraft: async () => {
      throw new Error('not used');
    },
    setExclusion: async () => {
      throw new Error('not used');
    },
  };
}

function candidates(): CalibrationCandidate[] {
  const out: CalibrationCandidate[] = [];
  for (let u = 0; u < 4; u++) {
    out.push({ candidateId: `prior-${u}`, userId: `u${u}`, reviewType: 'creative_image', artifactUrl: 'https://img.test/p.png', createdAt: '2026-09-01T00:00:00Z', category: 'ad' });
    for (let i = 0; i < 8; i++) {
      out.push({ candidateId: `new-${u}-${i}`, userId: `u${u}`, reviewType: 'creative_image', artifactUrl: 'https://img.test/n.png', createdAt: `2026-09-1${5 + (i % 4)}T0${i}:00:00Z`, category: 'ad' });
    }
  }
  return out;
}

function settingsOf(values: Record<string, string>): CalibrationSettings {
  return { getSetting: async (name) => (name in values ? { settingValue: values[name] } : null) };
}

const CHANNEL_SETTINGS = { human_eval_slack_channel: 'C_EVAL', human_eval_reviewer_matt_slack_user_id: 'U_MATT' };

function deps(overrides: Partial<CreativeCalibrationDeps> = {}): CreativeCalibrationDeps & { post: jest.Mock<(channel: string, text: string) => Promise<unknown>> } {
  const post = jest.fn<(channel: string, text: string) => Promise<unknown>>(async () => ({ ts: '1', channel: 'C' }));
  return {
    env: { CREATIVE_CALIBRATION_ENABLED: 'true', CREATIVE_CALIBRATION_SLACK_ENABLED: 'true', FRONTEND_URL: 'https://partner.test/' },
    now: NOW,
    store: memoryStore(),
    loadCandidates: async () => candidates(),
    settings: settingsOf(CHANNEL_SETTINGS),
    postSlackMessage: post,
    cronEnabled: () => true,
    post,
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('runCreativeCalibration: inert by default', () => {
  it('refuses a live run without CREATIVE_CALIBRATION_ENABLED=true and touches nothing', async () => {
    const d = deps({ env: { CREATIVE_CALIBRATION_SLACK_ENABLED: 'true' } });
    const loadCandidates = jest.fn(d.loadCandidates);
    const summary = await runCreativeCalibration({}, { ...d, loadCandidates });
    expect(summary.status).toBe('refused_disabled');
    expect(loadCandidates).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });

  it('writes nothing until the golden-set store is provisioned (OPS-2)', async () => {
    const d = deps({ store: memoryStore(false) });
    expect((await runCreativeCalibration({}, d)).status).toBe('store_not_provisioned');
    expect(d.post).not.toHaveBeenCalled();
  });

  it('does not run on a draining instance', async () => {
    const d = deps({ cronEnabled: () => false });
    expect((await runCreativeCalibration({}, d)).status).toBe('refused_draining');
  });

  it('a dry run reads and counts but writes and posts nothing', async () => {
    const d = deps();
    const summary = await runCreativeCalibration({ dryRun: true }, d);
    expect(summary).toMatchObject({ status: 'dry_run', batch: '2026-W39', eligiblePairs: 32, selected: 20, accounts: 4 });
    expect((d.store as ReturnType<typeof memoryStore>).rows.size).toBe(0);
    expect(d.post).not.toHaveBeenCalled();
  });
});

describe('runCreativeCalibration: weekly batch', () => {
  it('writes ~20 pairwise cases and posts exactly one message with the portal link', async () => {
    const d = deps();
    const summary = await runCreativeCalibration({}, d);
    expect(summary).toMatchObject({ status: 'written', selected: 20, created: 20, existing: 0, slack: 'posted' });
    const rows = [...(d.store as ReturnType<typeof memoryStore>).rows.values()];
    expect(rows).toHaveLength(20);
    expect(rows.every((c) => c.pair?.batch === '2026-W39' && c.pair.batchSize === 20)).toBe(true);
    expect(d.post).toHaveBeenCalledTimes(1);
    expect(d.post).toHaveBeenCalledWith(
      'C_EVAL',
      '<@U_MATT> — weekly creative calibration 2026-W39 is ready: 20 pairs, pick the better ad in each (one click per pair): <https://partner.test/eval-labelling/calibration?batch=2026-W39>',
    );
  });

  it('posts nothing with CREATIVE_CALIBRATION_SLACK_ENABLED unset, but still writes the batch', async () => {
    const d = deps({ env: { CREATIVE_CALIBRATION_ENABLED: 'true' } });
    const summary = await runCreativeCalibration({}, d);
    expect(summary).toMatchObject({ status: 'written', created: 20, slack: 'disabled' });
    expect(d.post).not.toHaveBeenCalled();
    expect(realPostSlackMessage).not.toHaveBeenCalled();
  });

  it('is idempotent across instances and days: a second run writes nothing and posts nothing', async () => {
    const d = deps();
    await runCreativeCalibration({}, d);
    const again = await runCreativeCalibration({}, { ...d, now: new Date('2026-09-25T09:00:00Z') });
    expect(again).toMatchObject({ status: 'already_complete', existing: 20 });
    expect(d.post).toHaveBeenCalledTimes(1);
  });

  it('counts an excluded pair toward a complete batch, so the batch is not drawn again (ENG-2608)', async () => {
    const d = deps();
    await runCreativeCalibration({}, d);
    const store = d.store as ReturnType<typeof memoryStore>;
    const [first] = store.rows.values();
    store.rows.set(first.caseId, { ...first, excluded: { reason: 'bad pair', by: 'a@example.com', at: NOW.toISOString() } });
    const again = await runCreativeCalibration({}, { ...d, now: new Date('2026-09-25T09:00:00Z') });
    expect(again).toMatchObject({ status: 'already_complete', existing: 20 });
  });

  it('an instance that loses the race for the first case finishes the batch but does not post', async () => {
    const winner = deps();
    await runCreativeCalibration({}, winner);
    const firstCase = [...(winner.store as ReturnType<typeof memoryStore>).rows.values()].find((c) => c.pair?.position === 0);
    // The loser's view: the winner has written only the first case so far.
    const store = memoryStore();
    if (firstCase) store.rows.set(firstCase.caseId, firstCase);
    const loser = deps({ store });
    expect(await runCreativeCalibration({}, loser)).toMatchObject({ status: 'written', created: 19, existing: 1, slack: 'not_owner' });
    expect(loser.post).not.toHaveBeenCalled();
    expect(winner.post).toHaveBeenCalledTimes(1);
  });

  it('does not draw a pair again that an earlier week already holds', async () => {
    const d = deps();
    await runCreativeCalibration({ batch: '2026-W39' }, d);
    const store = d.store as ReturnType<typeof memoryStore>;
    const w39 = new Set(store.rows.keys());
    // Same pool, next week's batch: 32 eligible pairs minus the 20 already drawn.
    const next = await runCreativeCalibration({ batch: '2026-W40' }, { ...d, loadCandidates: async () => candidates().map((c) => ({ ...c, createdAt: c.createdAt.replace('2026-09-1', '2026-09-2') })) });
    expect(next.created).toBeGreaterThan(0);
    const w40 = [...store.rows.values()].filter((c) => c.pair?.batch === '2026-W40');
    expect(w40.some((c) => w39.has(c.caseId))).toBe(false);
  });

  it('reports no_pairs and posts nothing when the week had no pairable creative', async () => {
    const d = deps({ loadCandidates: async () => [] });
    expect(await runCreativeCalibration({}, d)).toMatchObject({ status: 'no_pairs', selected: 0 });
    expect(d.post).not.toHaveBeenCalled();
  });
});

describe('postCalibrationSlack', () => {
  const input = { batch: '2026-W39', pairs: 20 };

  it('respects the ENG-1854 kill switch even with the flag on', async () => {
    const d = deps({ settings: settingsOf({ ...CHANNEL_SETTINGS, human_eval_slack_posting_enabled: 'false' }) });
    expect(await postCalibrationSlack(input, d)).toBe('kill_switch');
    expect(d.post).not.toHaveBeenCalled();
  });

  it('prefers the calibration channel setting, and skips when no channel is configured', async () => {
    const d = deps({ settings: settingsOf({ ...CHANNEL_SETTINGS, creative_calibration_slack_channel: 'C_CAL' }) });
    expect(await postCalibrationSlack(input, d)).toBe('posted');
    expect(d.post.mock.calls[0][0]).toBe('C_CAL');
    const none = deps({ settings: settingsOf({}) });
    expect(await postCalibrationSlack(input, none)).toBe('no_channel');
    expect(none.post).not.toHaveBeenCalled();
  });

  it('never throws: a failed post or settings read is reported, not raised', async () => {
    const failing = deps({ postSlackMessage: jest.fn(async () => Promise.reject(new Error('slack down'))) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await postCalibrationSlack(input, failing)).toBe('failed');
    const badSettings = deps({ settings: { getSetting: async () => Promise.reject(new Error('ddb')) } });
    expect(await postCalibrationSlack(input, badSettings)).toBe('failed');
    warn.mockRestore();
  });

  it('names Matt in plain text when no reviewer Slack id is configured', () => {
    expect(calibrationSlackText({ batch: '2026-W39', pairs: 3, link: 'https://x' })).toBe(
      'Matt — weekly creative calibration 2026-W39 is ready: 3 pairs, pick the better ad in each (one click per pair): <https://x>',
    );
  });
});
