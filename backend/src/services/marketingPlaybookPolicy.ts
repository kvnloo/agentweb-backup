/**
 * ENG-2793 (ENG-1970.3): tenant-scoped playbook promotion / staleness policy.
 *
 * Given evaluated outcome records for past marketing actions, decides whether
 * a pattern (org + action kind) may be promoted into a reusable playbook, and
 * at what scope.
 *
 * Contract:
 *   - PURE + deterministic: no I/O, no persistence, no provider calls, no
 *     clock reads (`now` is injected). Same input -> same output.
 *   - Tenant isolation: records are grouped by orgId first; evidence from one
 *     org never contributes to another org's decision.
 *   - Campaign evidence promotes only to `campaign` scope. `tenant` scope needs
 *     a stricter threshold across >= 2 distinct campaigns. No global scope
 *     exists in the output type.
 *   - Newest evidence older than `staleAfterMs` -> `stale`; older than
 *     `expireAfterMs` -> `expire` (age checks win over promotion).
 *   - Mixed win/loss evidence below threshold -> `hold` /
 *     `contradictory_evidence`.
 *   - Malformed records (missing ids, unknown verdict, unparseable or future
 *     evaluatedAt) are dropped, never counted.
 *
 * SHADOW ONLY: not wired into any execution or write path.
 */

export type PlaybookOutcomeVerdict = 'win' | 'loss' | 'neutral';

export interface PlaybookOutcomeRecord {
  id: string;
  orgId: string;
  campaignId: string;
  actionKind: string;
  verdict: PlaybookOutcomeVerdict | string;
  /** ISO-8601 string or epoch ms. */
  evaluatedAt: string | number;
}

export type PlaybookDecisionKind =
  | 'promote_campaign'
  | 'promote_tenant'
  | 'hold'
  | 'stale'
  | 'expire';

export type PlaybookReasonCode =
  | 'threshold_met'
  | 'insufficient_evidence'
  | 'insufficient_campaigns'
  | 'below_win_rate'
  | 'contradictory_evidence'
  | 'evidence_stale'
  | 'evidence_expired';

export interface PlaybookDecision {
  orgId: string;
  actionKind: string;
  scope: 'campaign' | 'tenant';
  /** Set only for campaign scope. */
  campaignId?: string;
  decision: PlaybookDecisionKind;
  reasonCodes: PlaybookReasonCode[];
  /** Sorted ids of the records the decision used. */
  evidenceIds: string[];
}

export interface PlaybookPolicyOptions {
  now: number;
  campaignMinEvidence?: number;
  campaignMinWinRate?: number;
  tenantMinEvidence?: number;
  tenantMinCampaigns?: number;
  tenantMinWinRate?: number;
  staleAfterMs?: number;
  expireAfterMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const PLAYBOOK_POLICY_DEFAULTS = Object.freeze({
  campaignMinEvidence: 3,
  campaignMinWinRate: 0.75,
  tenantMinEvidence: 6,
  tenantMinCampaigns: 2,
  tenantMinWinRate: 0.85,
  staleAfterMs: 30 * DAY_MS,
  expireAfterMs: 90 * DAY_MS,
});

interface NormalizedRecord {
  id: string;
  orgId: string;
  campaignId: string;
  actionKind: string;
  verdict: PlaybookOutcomeVerdict;
  at: number;
}

const VERDICTS: ReadonlySet<string> = new Set(['win', 'loss', 'neutral']);

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function normalize(r: PlaybookOutcomeRecord, now: number): NormalizedRecord | null {
  if (!r || typeof r !== 'object') return null;
  const id = str(r.id);
  const orgId = str(r.orgId);
  const campaignId = str(r.campaignId);
  const actionKind = str(r.actionKind).toLowerCase();
  const verdict = str(r.verdict).toLowerCase();
  if (!id || !orgId || !campaignId || !actionKind || !VERDICTS.has(verdict)) return null;
  const at = typeof r.evaluatedAt === 'number' ? r.evaluatedAt : Date.parse(String(r.evaluatedAt));
  if (!Number.isFinite(at) || at > now) return null;
  return { id, orgId, campaignId, actionKind, verdict: verdict as PlaybookOutcomeVerdict, at };
}

function ageDecision(
  records: NormalizedRecord[],
  now: number,
  staleAfterMs: number,
  expireAfterMs: number,
): { decision: 'stale' | 'expire'; reason: PlaybookReasonCode } | null {
  const newest = Math.max(...records.map((r) => r.at));
  const age = now - newest;
  if (age > expireAfterMs) return { decision: 'expire', reason: 'evidence_expired' };
  if (age > staleAfterMs) return { decision: 'stale', reason: 'evidence_stale' };
  return null;
}

function thresholdDecision(
  records: NormalizedRecord[],
  minEvidence: number,
  minWinRate: number,
): PlaybookReasonCode[] {
  const wins = records.filter((r) => r.verdict === 'win').length;
  const losses = records.filter((r) => r.verdict === 'loss').length;
  const rate = records.length === 0 ? 0 : wins / records.length;
  if (records.length >= minEvidence && rate >= minWinRate) return ['threshold_met'];
  const reasons: PlaybookReasonCode[] = [];
  if (records.length < minEvidence) reasons.push('insufficient_evidence');
  if (wins > 0 && losses > 0) reasons.push('contradictory_evidence');
  else if (rate < minWinRate) reasons.push('below_win_rate');
  return reasons;
}

function ids(records: NormalizedRecord[]): string[] {
  return Array.from(new Set(records.map((r) => r.id))).sort();
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/**
 * Evaluate playbook promotion decisions. Returns one tenant-scope decision per
 * (orgId, actionKind) plus one campaign-scope decision per
 * (orgId, actionKind, campaignId), sorted deterministically.
 */
export function evaluatePlaybookPolicy(
  records: PlaybookOutcomeRecord[],
  options: PlaybookPolicyOptions,
): PlaybookDecision[] {
  const o = { ...PLAYBOOK_POLICY_DEFAULTS, ...stripUndefined(options) };
  const now = options.now;
  if (!Number.isFinite(now)) throw new Error('evaluatePlaybookPolicy: options.now must be a finite epoch ms');

  const normalized = (Array.isArray(records) ? records : [])
    .map((r) => normalize(r, now))
    .filter((r): r is NormalizedRecord => r !== null);

  const out: PlaybookDecision[] = [];
  // Group by org FIRST so no cross-tenant evidence can mix (AC2).
  const byOrg = groupBy(normalized, (r) => r.orgId);
  for (const [orgId, orgRecords] of byOrg) {
    const byKind = groupBy(orgRecords, (r) => r.actionKind);
    for (const [actionKind, kindRecords] of byKind) {
      const byCampaign = groupBy(kindRecords, (r) => r.campaignId);

      for (const [campaignId, campRecords] of byCampaign) {
        const aged = ageDecision(campRecords, now, o.staleAfterMs, o.expireAfterMs);
        const reasons = aged
          ? [aged.reason]
          : thresholdDecision(campRecords, o.campaignMinEvidence, o.campaignMinWinRate);
        out.push({
          orgId,
          actionKind,
          scope: 'campaign',
          campaignId,
          decision: aged ? aged.decision : reasons[0] === 'threshold_met' ? 'promote_campaign' : 'hold',
          reasonCodes: reasons,
          evidenceIds: ids(campRecords),
        });
      }

      const aged = ageDecision(kindRecords, now, o.staleAfterMs, o.expireAfterMs);
      let decision: PlaybookDecisionKind;
      let reasons: PlaybookReasonCode[];
      if (aged) {
        decision = aged.decision;
        reasons = [aged.reason];
      } else {
        reasons = thresholdDecision(kindRecords, o.tenantMinEvidence, o.tenantMinWinRate);
        if (byCampaign.size < o.tenantMinCampaigns) {
          reasons = reasons.filter((r) => r !== 'threshold_met');
          reasons.push('insufficient_campaigns');
        }
        decision = reasons.length === 1 && reasons[0] === 'threshold_met' ? 'promote_tenant' : 'hold';
      }
      out.push({ orgId, actionKind, scope: 'tenant', decision, reasonCodes: reasons, evidenceIds: ids(kindRecords) });
    }
  }

  return out.sort((a, b) =>
    cmp(a.orgId, b.orgId) ||
    cmp(a.actionKind, b.actionKind) ||
    cmp(a.scope, b.scope) ||
    cmp(a.campaignId ?? '', b.campaignId ?? ''),
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
