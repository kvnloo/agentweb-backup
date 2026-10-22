/**
 * Weekly creative calibration batch (ENG-2142, ENG-2128 T10).
 *
 * Draws the week's ~20 creative pairs (loops/eval/creativeCalibration.ts) from AW-HumanEvalQueue,
 * writes them as pairwise golden cases to the golden-set store, and posts ONE Slack message with
 * the portal link — never a message per pair. The reviewer labels them in the partner portal
 * (/eval-labelling/calibration); the labels are golden-set labels, not a gate on anything.
 *
 * Inert by default, three independent switches (all OPS steps, none set by this code):
 *  - CREATIVE_CALIBRATION_ENABLED=true   server.ts schedules this job; a live run refuses without it.
 *  - EVAL_GOLDEN_CASES_TABLE             the golden-set store (OPS-2, ENG-2147); unset → nothing written.
 *  - CREATIVE_CALIBRATION_SLACK_ENABLED=true  the weekly Slack message. The ENG-1854 kill switch
 *    (AW-Settings `human_eval_slack_posting_enabled` = 'false') still silences it.
 *
 * Every instance runs the job daily. It is idempotent: the batch for an ISO week is the same on
 * every instance (seeded selection over the closed previous week), each case is a conditional put,
 * and only the instance whose put created the batch's first case posts to Slack. Once the week's
 * batch is complete later runs stop after one query of the store.
 */

import { settingsService } from '../services/settingsService';
import { postSlackMessage } from '../services/slackService';
import { isCronEnabled } from '../utils/instanceState';
import {
  buildCalibrationPairs,
  CALIBRATION_REVIEW_TYPES,
  calibrationWindow,
  DEFAULT_CALIBRATION_BATCH_SIZE,
  isoWeekOf,
  selectCalibrationPairs,
  toCalibrationCases,
  type CalibrationCandidate,
} from '../loops/eval/creativeCalibration';
import type { PairSignal } from '../loops/eval/goldenSet';
import { goldenSetStoreFromEnv, type GoldenSetStore } from '../loops/eval/goldenSetStore';

const TAG = '[creativeCalibrationCron]';

export const CREATIVE_CALIBRATION_ENABLED_ENV = 'CREATIVE_CALIBRATION_ENABLED';
export const CREATIVE_CALIBRATION_SLACK_ENABLED_ENV = 'CREATIVE_CALIBRATION_SLACK_ENABLED';
/** AW-Settings key for the calibration channel; falls back to the #eval-queue channel setting. */
export const CALIBRATION_SLACK_CHANNEL_SETTING = 'creative_calibration_slack_channel';
export const CALIBRATION_PORTAL_PATH = '/eval-labelling/calibration';

type Env = Record<string, string | undefined>;

export interface CalibrationSettings {
  getSetting(name: string): Promise<{ settingValue: string } | null>;
}

export interface CreativeCalibrationDeps {
  env: Env;
  now: Date;
  store: GoldenSetStore;
  loadCandidates: () => Promise<CalibrationCandidate[]>;
  settings: CalibrationSettings;
  postSlackMessage: (channelId: string, text: string) => Promise<unknown>;
  cronEnabled: () => boolean;
}

async function loadCreativeCandidates(): Promise<CalibrationCandidate[]> {
  const { humanEvalService } = await import('../services/humanEvalService');
  const perType = await Promise.all(CALIBRATION_REVIEW_TYPES.map((t) => humanEvalService.listCandidatesByReviewType(t)));
  return perType.flat();
}

function defaultDeps(): CreativeCalibrationDeps {
  return {
    env: process.env,
    now: new Date(),
    store: goldenSetStoreFromEnv(),
    loadCandidates: loadCreativeCandidates,
    settings: settingsService,
    postSlackMessage,
    cronEnabled: isCronEnabled,
  };
}

export type SlackOutcome = 'posted' | 'disabled' | 'kill_switch' | 'no_channel' | 'failed' | 'not_owner';

export type CalibrationRunStatus =
  | 'refused_disabled'
  | 'refused_draining'
  | 'store_not_provisioned'
  | 'already_complete'
  | 'no_pairs'
  | 'dry_run'
  | 'written';

export interface CreativeCalibrationSummary {
  batch: string;
  status: CalibrationRunStatus;
  /** Eligible pairs before selection. */
  eligiblePairs: number;
  selected: number;
  created: number;
  existing: number;
  bySignal: Partial<Record<PairSignal, number>>;
  byStratum: Record<string, number>;
  accounts: number;
  slack?: SlackOutcome;
}

function emptySummary(batch: string, status: CalibrationRunStatus): CreativeCalibrationSummary {
  return { batch, status, eligiblePairs: 0, selected: 0, created: 0, existing: 0, bySignal: {}, byStratum: {}, accounts: 0 };
}

async function settingValue(settings: CalibrationSettings, name: string): Promise<string | undefined> {
  return (await settings.getSetting(name))?.settingValue?.trim() || undefined;
}

/** The one weekly message: reviewer mention, pair count, link. Never lists the pairs. */
export function calibrationSlackText(input: { batch: string; pairs: number; link: string; reviewerSlackUserId?: string }): string {
  const who = input.reviewerSlackUserId ? `<@${input.reviewerSlackUserId}>` : 'Matt';
  return `${who} — weekly creative calibration ${input.batch} is ready: ${input.pairs} pairs, pick the better ad in each (one click per pair): <${input.link}>`;
}

/**
 * Posts the weekly calibration message, or says why not. Off unless
 * CREATIVE_CALIBRATION_SLACK_ENABLED=true; the ENG-1854 kill switch wins over it. Never throws.
 */
export async function postCalibrationSlack(
  input: { batch: string; pairs: number },
  deps: Pick<CreativeCalibrationDeps, 'env' | 'settings' | 'postSlackMessage'>,
): Promise<SlackOutcome> {
  if (deps.env[CREATIVE_CALIBRATION_SLACK_ENABLED_ENV] !== 'true') return 'disabled';
  try {
    if ((await settingValue(deps.settings, 'human_eval_slack_posting_enabled')) === 'false') return 'kill_switch';
    const channel =
      (await settingValue(deps.settings, CALIBRATION_SLACK_CHANNEL_SETTING)) ??
      (await settingValue(deps.settings, 'human_eval_slack_channel')) ??
      deps.env.HUMAN_EVAL_SLACK_CHANNEL?.trim();
    if (!channel) return 'no_channel';
    const reviewerSlackUserId =
      (await settingValue(deps.settings, 'human_eval_reviewer_matt_slack_user_id')) ?? (deps.env.HUMAN_EVAL_MATT_SLACK_USER_ID?.trim() || undefined);
    const portal = (deps.env.FRONTEND_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, '');
    const link = `${portal}${CALIBRATION_PORTAL_PATH}?batch=${encodeURIComponent(input.batch)}`;
    await deps.postSlackMessage(channel, calibrationSlackText({ batch: input.batch, pairs: input.pairs, link, reviewerSlackUserId }));
    return 'posted';
  } catch (error) {
    console.warn(`${TAG} Slack post failed (batch still written):`, error instanceof Error ? error.message : error);
    return 'failed';
  }
}

/**
 * Draws this week's batch and, unless `dryRun`, writes it and posts the weekly message.
 * A dry run reads only and works without the store (it then cannot exclude earlier batches).
 */
export async function runCreativeCalibration(
  opts: { dryRun?: boolean; batch?: string; target?: number } = {},
  overrides: Partial<CreativeCalibrationDeps> = {},
): Promise<CreativeCalibrationSummary> {
  const deps: CreativeCalibrationDeps = { ...defaultDeps(), ...overrides };
  const dryRun = opts.dryRun ?? false;
  const batch = opts.batch ?? isoWeekOf(deps.now);
  const window = calibrationWindow(batch);

  if (!dryRun && deps.env[CREATIVE_CALIBRATION_ENABLED_ENV] !== 'true') {
    console.log(`${TAG} ${CREATIVE_CALIBRATION_ENABLED_ENV} is not 'true'; refusing a live run`);
    return emptySummary(batch, 'refused_disabled');
  }
  if (!dryRun && !deps.cronEnabled()) {
    console.log(`${TAG} cron disabled on this instance (draining); skipping`);
    return emptySummary(batch, 'refused_draining');
  }
  if (!dryRun && !deps.store.isProvisioned()) {
    console.log(`${TAG} golden-set store not provisioned (EVAL_GOLDEN_CASES_TABLE, OPS-2); nothing to write`);
    return emptySummary(batch, 'store_not_provisioned');
  }

  const excludeCaseIds = new Set<string>();
  if (deps.store.isProvisioned()) {
    // Excluded pairs too (ENG-2608): they still fill their batch and must never be drawn again.
    const pairCases = (await deps.store.listCases('creative', { includeExcluded: true })).filter((c) => c.pair !== undefined);
    const thisBatch = pairCases.filter((c) => c.pair?.batch === batch);
    const expected = thisBatch[0]?.pair?.batchSize;
    if (expected !== undefined && thisBatch.length >= expected) {
      console.log(`${TAG} batch ${batch} already complete (${thisBatch.length} pairs)`);
      return { ...emptySummary(batch, 'already_complete'), existing: thisBatch.length };
    }
    for (const c of pairCases) if (c.pair?.batch !== batch) excludeCaseIds.add(c.caseId);
  }

  const pairs = buildCalibrationPairs(await deps.loadCandidates(), window);
  const selected = selectCalibrationPairs(pairs, { batch, target: opts.target ?? DEFAULT_CALIBRATION_BATCH_SIZE, excludeCaseIds });
  const summary: CreativeCalibrationSummary = {
    ...emptySummary(batch, dryRun ? 'dry_run' : 'written'),
    eligiblePairs: pairs.length,
    selected: selected.length,
    accounts: new Set(selected.map((p) => p.userId)).size,
  };
  for (const p of selected) {
    summary.bySignal[p.signal] = (summary.bySignal[p.signal] ?? 0) + 1;
    const stratum = `${p.category}|${p.placement}`;
    summary.byStratum[stratum] = (summary.byStratum[stratum] ?? 0) + 1;
  }
  if (selected.length === 0) return { ...summary, status: 'no_pairs' };
  if (dryRun) return summary;

  const cases = toCalibrationCases(selected, batch, deps.now);
  let ownsBatch = false;
  for (const c of cases) {
    const result = await deps.store.createCase(c);
    if (result === 'created') summary.created++;
    else summary.existing++;
    if (c.pair?.position === 0) ownsBatch = result === 'created';
  }
  // Exactly one instance creates the first case, so exactly one posts.
  summary.slack = ownsBatch ? await postCalibrationSlack({ batch, pairs: cases.length }, deps) : 'not_owner';
  console.log(
    `${TAG} batch ${batch}: eligible=${summary.eligiblePairs} selected=${summary.selected} created=${summary.created} ` +
      `existing=${summary.existing} accounts=${summary.accounts} slack=${summary.slack}`,
  );
  return summary;
}
