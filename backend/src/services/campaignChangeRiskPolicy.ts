/**
 * ENG-3196 (child of ENG-1970): deterministic campaign-change risk classifier.
 *
 * Pure policy function — no persistence, no provider calls, not wired into any
 * execution path. Shadow/library only. Fails closed on anything it does not
 * recognise.
 */

export type CampaignChangeKind =
  | 'budget_increase'
  | 'budget_decrease'
  | 'bid_adjustment'
  | 'pause'
  | 'creative_copy_edit'
  | 'conversion_definition'
  | 'targeting'
  | 'activation'
  | 'delete'
  | 'archive'
  | 'account_wide';

export interface CampaignChange {
  orgId: string;
  provider: string;
  objectId: string;
  kind: CampaignChangeKind | string;
  field: string;
  value: unknown;
  reversible: boolean;
}

export interface ApprovedManifestEntry {
  provider: string;
  objectId: string;
  field: string;
  value: unknown;
}

export interface StandingAuthorization {
  orgId: string;
  approvedEntries: ApprovedManifestEntry[];
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'forbidden';
export type PolicyDecision = 'execute' | 'stage_for_approval' | 'reject';

export interface CampaignChangeClassification {
  risk: RiskLevel;
  decision: PolicyDecision;
  reasons: string[];
}

/** Changes that are never auto-executed, even with an exact manifest match. */
export const ALWAYS_GATED_KINDS: ReadonlySet<string> = new Set([
  'budget_increase',
  'conversion_definition',
  'targeting',
  'activation',
  'delete',
  'archive',
  'account_wide',
]);

const KNOWN_KIND_RISK: Readonly<Record<CampaignChangeKind, RiskLevel>> = {
  budget_increase: 'high',
  budget_decrease: 'low',
  bid_adjustment: 'medium',
  pause: 'low',
  creative_copy_edit: 'medium',
  conversion_definition: 'high',
  targeting: 'high',
  activation: 'high',
  delete: 'high',
  archive: 'high',
  account_wide: 'high',
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

function matchesManifest(change: CampaignChange, entries: ApprovedManifestEntry[]): boolean {
  const want = canonical(change.value);
  return entries.some(
    (e) =>
      e.provider === change.provider &&
      e.objectId === change.objectId &&
      e.field === change.field &&
      canonical(e.value) === want,
  );
}

export function classifyCampaignChange(
  change: CampaignChange,
  authorization: StandingAuthorization | null | undefined,
): CampaignChangeClassification {
  const kind = change.kind as CampaignChangeKind;
  if (!Object.prototype.hasOwnProperty.call(KNOWN_KIND_RISK, kind)) {
    return { risk: 'forbidden', decision: 'reject', reasons: [`unknown change kind: ${String(change.kind)}`] };
  }
  const risk = KNOWN_KIND_RISK[kind];

  const authorized = !!authorization && !!change.orgId && authorization.orgId === change.orgId;
  if (!authorized) {
    return {
      risk,
      decision: 'reject',
      reasons: [authorization ? 'authorization belongs to a different org' : 'no standing authorization for org'],
    };
  }

  if (ALWAYS_GATED_KINDS.has(kind)) {
    return { risk, decision: 'stage_for_approval', reasons: [`${kind} always requires explicit approval`] };
  }
  if (!change.reversible) {
    return { risk, decision: 'stage_for_approval', reasons: ['change is not reversible'] };
  }
  if (!matchesManifest(change, authorization.approvedEntries)) {
    return { risk, decision: 'stage_for_approval', reasons: ['no exact approved manifest entry'] };
  }
  return { risk, decision: 'execute', reasons: ['exact approved manifest match, reversible, not gated'] };
}
