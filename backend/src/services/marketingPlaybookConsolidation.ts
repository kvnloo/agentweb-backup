/**
 * ENG-2971 (ENG-1970.6): pure playbook consolidation + archival planner.
 *
 * Shadow-only: no I/O, clock, persistence, LLM, or runtime wiring. Given a set
 * of versioned playbooks (and optional promotion/staleness decisions keyed by
 * playbook id), it proposes keep / archive / review / invalid / merge actions.
 * Nothing here mutates storage; persistence stays behind ENG-2776.
 */
import { diffPlaybooks, validatePlaybook, type CampaignPlaybook, type PlaybookValidationCode } from './marketingPlaybook';
import type { PlaybookDecision } from './marketingPlaybookPolicy';

/** A playbook optionally tagged with its owning org (tenant isolation). */
export type ConsolidationPlaybook = CampaignPlaybook & { orgId?: string };

export type ConsolidationAction = 'keep' | 'archive' | 'review' | 'invalid';

export interface ConsolidationEntry {
  id: string;
  version: string;
  orgId?: string;
  action: ConsolidationAction;
  /** e.g. `superseded_by:1.2.0`, `expired`, `stale`. */
  reason?: string;
  /** Validator codes, only for `invalid`. */
  codes?: PlaybookValidationCode[];
}

export interface MergeCandidate {
  /** Lexicographically smallest id in the duplicate set. */
  canonicalId: string;
  /** The other ids whose steps are identical to the canonical playbook. */
  duplicateIds: string[];
  orgId?: string;
}

export interface ConsolidationPlan {
  entries: ConsolidationEntry[];
  merges: MergeCandidate[];
}

export type PlaybookDecisions =
  | ReadonlyMap<string, Pick<PlaybookDecision, 'decision'>>
  | Readonly<Record<string, Pick<PlaybookDecision, 'decision'>>>;

function parseSemver(v: string): [number, number, number] {
  const [a, b, c] = v.trim().split('.').map((n) => Number(n));
  return [a, b, c];
}

function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function decisionFor(decisions: PlaybookDecisions | undefined, id: string): string | undefined {
  if (!decisions) return undefined;
  if (decisions instanceof Map) return decisions.get(id)?.decision;
  return (decisions as Readonly<Record<string, Pick<PlaybookDecision, 'decision'>>>)[id]?.decision;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function planPlaybookConsolidation(
  playbooks: ReadonlyArray<ConsolidationPlaybook | null | undefined>,
  decisions?: PlaybookDecisions,
): ConsolidationPlan {
  const entries: ConsolidationEntry[] = [];
  const groups = new Map<string, ConsolidationPlaybook[]>();

  for (const pb of playbooks ?? []) {
    const result = validatePlaybook(pb);
    if (!result.valid) {
      const entry: ConsolidationEntry = {
        id: asString(pb?.id),
        version: asString(pb?.version),
        action: 'invalid',
        codes: [...new Set(result.errors.map((e) => e.code))].sort(),
      };
      if (pb?.orgId) entry.orgId = pb.orgId;
      entries.push(entry);
      continue;
    }
    const valid = pb as ConsolidationPlaybook;
    // Group by org as well as id: the same id in two tenants is two playbooks.
    const key = `${valid.orgId ?? ''}\u0000${valid.id.trim()}`;
    const list = groups.get(key) ?? [];
    list.push(valid);
    groups.set(key, list);
  }

  const kept: ConsolidationPlaybook[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => compareSemver(b.version, a.version));
    const latest = sorted[0];
    const latestVersion = latest.version.trim();
    const base = (pb: ConsolidationPlaybook): ConsolidationEntry => {
      const e: ConsolidationEntry = { id: pb.id.trim(), version: pb.version.trim(), action: 'keep' };
      if (pb.orgId) e.orgId = pb.orgId;
      return e;
    };

    const decision = decisionFor(decisions, latest.id.trim());
    const head = base(latest);
    if (decision === 'expire') {
      head.action = 'archive';
      head.reason = 'expired';
    } else if (decision === 'stale') {
      head.action = 'review';
      head.reason = 'stale';
    } else {
      kept.push(latest);
    }
    entries.push(head);

    for (const older of sorted.slice(1)) {
      const e = base(older);
      e.action = 'archive';
      e.reason = `superseded_by:${latestVersion}`;
      entries.push(e);
    }
  }

  // Duplicate detection only among kept playbooks, never across orgs.
  const merges: MergeCandidate[] = [];
  const byOrg = new Map<string, ConsolidationPlaybook[]>();
  for (const pb of kept) {
    const org = pb.orgId ?? '';
    const list = byOrg.get(org) ?? [];
    list.push(pb);
    byOrg.set(org, list);
  }
  for (const [org, list] of byOrg) {
    const sorted = [...list].sort((a, b) => cmp(a.id.trim(), b.id.trim()));
    const used = new Set<string>();
    for (let i = 0; i < sorted.length; i += 1) {
      const canon = sorted[i];
      if (used.has(canon.id)) continue;
      const dups: string[] = [];
      for (let j = i + 1; j < sorted.length; j += 1) {
        const other = sorted[j];
        if (used.has(other.id)) continue;
        const d = diffPlaybooks(canon, other);
        if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) {
          dups.push(other.id.trim());
          used.add(other.id);
        }
      }
      if (dups.length > 0) {
        used.add(canon.id);
        const m: MergeCandidate = { canonicalId: canon.id.trim(), duplicateIds: dups };
        if (org) m.orgId = org;
        merges.push(m);
      }
    }
  }

  entries.sort(
    (a, b) =>
      cmp(a.orgId ?? '', b.orgId ?? '') ||
      cmp(a.id, b.id) ||
      (a.version && b.version && /^\d+\.\d+\.\d+$/.test(a.version) && /^\d+\.\d+\.\d+$/.test(b.version)
        ? compareSemver(b.version, a.version)
        : cmp(a.version, b.version)) ||
      cmp(a.action, b.action),
  );
  merges.sort((a, b) => cmp(a.orgId ?? '', b.orgId ?? '') || cmp(a.canonicalId, b.canonicalId));
  return { entries, merges };
}
