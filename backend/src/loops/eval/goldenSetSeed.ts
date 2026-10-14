/**
 * Golden-set seed builder (ENG-2135): picks candidate case ids from projected production rows.
 *
 * Pure: the caller (scripts/seedGoldenCases.ts) does the read-only scans and passes ids and
 * flags only — no transcript, feedback text, email or name ever reaches this module, and the
 * cases it returns carry ids only. Selection is deterministic (hash order of the case id), so a
 * re-run picks the same cases and the store write stays idempotent.
 *
 * Sources (ENG-2128 brain F4, F7, F10, F14):
 *   agent          sessions named in the judge false-positive catalogue (off-repo input file:
 *                  Linear issue -> session ids/prefixes) and sessions with satisfactionScore.adminOverride,
 *                  plus an unbiased `sampled_session` fill (ordinary recent sessions, hash order, see below)
 *   creative       AW-HumanEvalQueue image/landing-page candidates with feedback from their reviewer (Matt)
 *   account_health AW-Users with subscription_status canceled vs active (by userId; admins excluded)
 */

import { createHash } from 'crypto';
import { isEvaluationUser } from '../../services/evaluationPolicy';
import type { EvalSurface } from './evalRegistry';
import { newGoldenCase, type GoldenCase, type ReplayLink } from './goldenSet';

export const DEFAULT_SEED_TARGETS: Record<EvalSurface, number> = { agent: 50, creative: 50, account_health: 30 };

export interface SeedSessionRow {
  sessionId: string;
  adminOverride: boolean;
  /** Cheap attributes for the `sampled_session` source; a row missing createdAt or messageCount is never sampled. */
  createdAt?: string;
  sessionType?: string;
  messageCount?: number;
  userId?: string;
}

/** `sampled_session` eligibility: created within this many days of `inputs.now`, with at least this many messages. */
export const SAMPLE_WINDOW_DAYS = 90;
export const SAMPLE_MIN_MESSAGES = 4;

export interface SeedCandidateRow {
  candidateId: string;
  reviewType: string;
  reviewerSlackUserId?: string;
  /** Slack user ids of everyone who replied; text is never read. */
  feedbackSlackUserIds: string[];
}

export interface SeedUserRow {
  userId: string;
  subscriptionStatus?: string;
  isAdmin?: boolean;
}

/** Off-repo input: which sessions each false-positive issue names, and which session turn backs
 * each ENG-1312 replay fixture. Ids may be full session ids or 8+ hex-char prefixes. */
export interface FpCatalogue {
  issues: Record<string, string[]>;
  replayFixtures?: Record<string, { session: string; messageIndex: number }>;
}

export interface SeedInputs {
  sessions: SeedSessionRow[];
  candidates: SeedCandidateRow[];
  users: SeedUserRow[];
  fpCatalogue?: FpCatalogue;
  targets?: Partial<Record<EvalSurface, number>>;
  now: Date;
}

export interface SurfaceSeedReport {
  eligible: number;
  selected: number;
  target: number;
  bySource: Record<string, number>;
}

export interface SeedResult {
  cases: GoldenCase[];
  report: Record<EvalSurface, SurfaceSeedReport>;
  /** Catalogue ids that matched no session, or a prefix that matched more than one. */
  unresolvedCatalogueIds: number;
  unresolvedReplayFixtures: string[];
}

const CREATIVE_REVIEW_TYPES = new Set(['creative_image', 'landing_page']);
const MIN_PREFIX = 8;

/** Selection order. Salted so it is independent of the dev/test split, which hashes the bare
 * case id: ordering by the same hash would pick the lowest hashes and put nearly every selected
 * case in the test split. */
function selectionKey(c: GoldenCase): string {
  return createHash('sha256').update(`seed-order:${c.caseId}`).digest('hex');
}

function hashOrder(a: GoldenCase, b: GoldenCase): number {
  return selectionKey(a).localeCompare(selectionKey(b));
}

/** Resolve a full id or unique prefix against the known session ids. */
export function resolveSessionRef(ref: string, sessionIds: ReadonlySet<string>, sorted: readonly string[]): string | null {
  const needle = ref.trim().toLowerCase();
  if (sessionIds.has(needle)) return needle;
  if (needle.length < MIN_PREFIX || !/^[0-9a-f-]+$/.test(needle)) return null;
  const matches = sorted.filter((id) => id.startsWith(needle));
  return matches.length === 1 ? matches[0] : null;
}

function take(cases: GoldenCase[], target: number, pinned: (c: GoldenCase) => boolean): GoldenCase[] {
  const first = cases.filter(pinned).sort(hashOrder);
  const rest = cases.filter((c) => !pinned(c)).sort(hashOrder);
  return [...first, ...rest].slice(0, Math.max(target, first.length));
}

/** Ordinary interactive traffic only: scheduled runs, generation pipelines and other machine-started
 * session types are not what the agent judge is meant to agree with humans on. Legacy rows with no
 * sessionType were written as regular. */
function isSampleEligible(s: SeedSessionRow, now: Date): boolean {
  if (s.sessionType !== undefined && s.sessionType !== 'regular') return false;
  if (isEvaluationUser(s.userId)) return false;
  if (typeof s.messageCount !== 'number' || s.messageCount < SAMPLE_MIN_MESSAGES) return false;
  const created = s.createdAt ? Date.parse(s.createdAt) : NaN;
  if (Number.isNaN(created)) return false;
  return created <= now.getTime() && created >= now.getTime() - SAMPLE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

function countBy(cases: GoldenCase[], key: (c: GoldenCase) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cases) out[key(c)] = (out[key(c)] ?? 0) + 1;
  return out;
}

function report(eligible: GoldenCase[], selected: GoldenCase[], target: number): SurfaceSeedReport {
  return { eligible: eligible.length, selected: selected.length, target, bySource: countBy(selected, (c) => c.seedSource.split(':')[0]) };
}

function seedAgent(inputs: SeedInputs, target: number) {
  const sessionIds = new Set(inputs.sessions.map((s) => s.sessionId));
  const sorted = [...sessionIds].sort();
  const byId = new Map<string, GoldenCase>();
  let unresolved = 0;

  const replayBySession = new Map<string, ReplayLink>();
  const unresolvedReplayFixtures: string[] = [];
  for (const [fixtureId, link] of Object.entries(inputs.fpCatalogue?.replayFixtures ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const sessionId = resolveSessionRef(link.session, sessionIds, sorted);
    if (!sessionId || replayBySession.has(sessionId)) unresolvedReplayFixtures.push(fixtureId);
    else replayBySession.set(sessionId, { fixtureId, messageIndex: link.messageIndex });
  }

  const add = (sessionId: string, taskType: string, seedSource: string) => {
    if (byId.has(sessionId)) return;
    const replay = replayBySession.get(sessionId);
    byId.set(sessionId, newGoldenCase({ surface: 'agent', taskType, sourceId: sessionId, seedSource, now: inputs.now, ...(replay ? { replay } : {}) }));
  };

  for (const [sessionId, link] of replayBySession) add(sessionId, 'replay_fixture', `replay_fixture:${link.fixtureId}`);
  for (const s of inputs.sessions) if (s.adminOverride) add(s.sessionId, 'admin_override', 'admin_override');
  for (const [issue, refs] of Object.entries(inputs.fpCatalogue?.issues ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    for (const ref of refs) {
      const sessionId = resolveSessionRef(ref, sessionIds, sorted);
      if (!sessionId) unresolved++;
      else add(sessionId, 'fp_catalogue', `fp_catalogue:${issue}`);
    }
  }

  // Unbiased source, added last so a session already in another source keeps that source. Selection
  // below orders it by hash of the id (never recency or score), so a larger target only appends.
  for (const s of inputs.sessions) if (isSampleEligible(s, inputs.now)) add(s.sessionId, 'sampled_session', 'sampled_session');

  const eligible = [...byId.values()];
  // Replay-linked and human-overridden sessions are always kept; the catalogue fills next, then the sample.
  const tier = (c: GoldenCase) => (c.taskType === 'sampled_session' ? 2 : c.taskType === 'fp_catalogue' ? 1 : 0);
  const pinned = eligible.filter((c) => tier(c) === 0).length;
  const selected = [...eligible].sort((a, b) => tier(a) - tier(b) || hashOrder(a, b)).slice(0, Math.max(target, pinned));
  return { eligible, selected, unresolved, unresolvedReplayFixtures };
}

function seedCreative(inputs: SeedInputs, target: number) {
  const eligible = inputs.candidates
    .filter((c) => CREATIVE_REVIEW_TYPES.has(c.reviewType))
    .filter((c) => !!c.reviewerSlackUserId && c.feedbackSlackUserIds.includes(c.reviewerSlackUserId))
    .map((c) => newGoldenCase({ surface: 'creative', taskType: c.reviewType, sourceId: c.candidateId, seedSource: 'human_eval_reviewer_feedback', now: inputs.now }));
  return { eligible, selected: take(eligible, target, () => false) };
}

function seedAccount(inputs: SeedInputs, target: number) {
  const build = (status: 'canceled' | 'active') =>
    inputs.users
      .filter((u) => !u.isAdmin && u.subscriptionStatus === status)
      .map((u) => newGoldenCase({ surface: 'account_health', taskType: `subscription_${status}`, sourceId: u.userId, seedSource: `subscription_status:${status}`, now: inputs.now }))
      .sort(hashOrder);
  const canceled = build('canceled');
  const active = build('active');
  // Balance the two classes; if one runs short the other fills the remainder.
  const half = Math.ceil(target / 2);
  let nCanceled = Math.min(canceled.length, half);
  const nActive = Math.min(active.length, target - nCanceled);
  nCanceled = Math.min(canceled.length, target - nActive);
  return { eligible: [...canceled, ...active], selected: [...canceled.slice(0, nCanceled), ...active.slice(0, nActive)] };
}

export function buildSeedCases(inputs: SeedInputs): SeedResult {
  const targets = { ...DEFAULT_SEED_TARGETS, ...inputs.targets };
  const agent = seedAgent(inputs, targets.agent);
  const creative = seedCreative(inputs, targets.creative);
  const account = seedAccount(inputs, targets.account_health);
  return {
    cases: [...agent.selected, ...creative.selected, ...account.selected],
    report: {
      agent: report(agent.eligible, agent.selected, targets.agent),
      creative: report(creative.eligible, creative.selected, targets.creative),
      account_health: report(account.eligible, account.selected, targets.account_health),
    },
    unresolvedCatalogueIds: agent.unresolved,
    unresolvedReplayFixtures: agent.unresolvedReplayFixtures,
  };
}

/** Validates the off-repo catalogue file's shape. */
export function parseFpCatalogue(value: unknown): FpCatalogue {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isRecord(value) || !isRecord(value.issues)) throw new Error('fp catalogue: expected { issues: { "<issue>": ["<session id or prefix>", ...] } }');
  const issues: Record<string, string[]> = {};
  for (const [issue, refs] of Object.entries(value.issues)) {
    if (!Array.isArray(refs) || !refs.every((r) => typeof r === 'string')) throw new Error(`fp catalogue: issues.${issue} must be a string array`);
    issues[issue] = refs as string[];
  }
  let replayFixtures: FpCatalogue['replayFixtures'];
  if (value.replayFixtures !== undefined) {
    if (!isRecord(value.replayFixtures)) throw new Error('fp catalogue: replayFixtures must be an object');
    replayFixtures = {};
    for (const [fixtureId, link] of Object.entries(value.replayFixtures)) {
      if (!isRecord(link) || typeof link.session !== 'string' || !Number.isInteger(link.messageIndex) || (link.messageIndex as number) < 0) {
        throw new Error(`fp catalogue: replayFixtures.${fixtureId} must be { session: string, messageIndex: non-negative integer }`);
      }
      replayFixtures[fixtureId] = { session: link.session, messageIndex: link.messageIndex as number };
    }
  }
  return { issues, ...(replayFixtures ? { replayFixtures } : {}) };
}
