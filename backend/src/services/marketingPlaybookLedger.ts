/**
 * ENG-2976 (ENG-1970.7): playbook provenance + usage ledger reducer.
 *
 * Folds a stream of playbook events into a per (orgId, playbookId, version)
 * ledger of provenance and usage.
 *
 * Contract:
 *   - PURE + deterministic: no I/O, no persistence, no provider calls, no LLM,
 *     no clock reads (`now` is injected). Same input -> same output; events
 *     are processed in a stable (timestamp, input index) order and output is
 *     sorted by (orgId, playbookId, version).
 *   - Tenant isolation: the owning org of a playbook is fixed by its `created`
 *     event. Any later event whose orgId differs is rejected with
 *     `org_mismatch` and never counted.
 *   - Provenance: each version records its evidence ids and parent version; a
 *     version with no evidence ids is flagged `missing_provenance`.
 *   - `daysSinceLastUse` is surfaced for `marketingPlaybookPolicy`; no
 *     staleness decision is made here.
 *
 * SHADOW ONLY: not wired into any execution, write, or storage path.
 */

export type PlaybookLedgerVerdict = 'win' | 'loss' | 'neutral';

interface PlaybookEventBase {
  orgId: string;
  playbookId: string;
  /** ISO-8601 string or epoch ms. */
  at: string | number;
}

export interface PlaybookCreatedEvent extends PlaybookEventBase {
  type: 'created';
  version: number;
  evidenceIds: string[];
}

export interface PlaybookVersionPublishedEvent extends PlaybookEventBase {
  type: 'version_published';
  version: number;
  parentVersion?: number;
  evidenceIds: string[];
}

export interface PlaybookAppliedEvent extends PlaybookEventBase {
  type: 'applied';
  version: number;
  campaignId: string;
  actionEnvelopeId: string;
}

export interface PlaybookOutcomeEvent extends PlaybookEventBase {
  type: 'outcome';
  version: number;
  verdict: PlaybookLedgerVerdict | string;
  actionEnvelopeId?: string;
}

export type PlaybookLedgerEvent =
  | PlaybookCreatedEvent
  | PlaybookVersionPublishedEvent
  | PlaybookAppliedEvent
  | PlaybookOutcomeEvent;

export type PlaybookLedgerRejectReason =
  | 'malformed_event'
  | 'invalid_timestamp'
  | 'future_event'
  | 'unknown_playbook'
  | 'unknown_version'
  | 'org_mismatch'
  | 'duplicate_playbook'
  | 'duplicate_version'
  | 'unknown_verdict';

export interface PlaybookLedgerRejection {
  index: number;
  reason: PlaybookLedgerRejectReason;
  orgId?: string;
  playbookId?: string;
}

export type PlaybookLedgerFlag = 'missing_provenance';

export interface PlaybookVersionLedgerEntry {
  orgId: string;
  playbookId: string;
  version: number;
  parentVersion: number | null;
  evidenceIds: string[];
  flags: PlaybookLedgerFlag[];
  publishedAt: number;
  usageCount: number;
  distinctCampaigns: number;
  campaignIds: string[];
  firstUsedAt: number | null;
  lastUsedAt: number | null;
  /** Whole days since last use (or since publish when never used). */
  daysSinceLastUse: number;
  outcomes: Record<PlaybookLedgerVerdict, number>;
}

export interface PlaybookLedger {
  entries: PlaybookVersionLedgerEntry[];
  rejected: PlaybookLedgerRejection[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const VERDICTS: readonly PlaybookLedgerVerdict[] = ['win', 'loss', 'neutral'];

function toMs(at: unknown): number | null {
  if (typeof at === 'number') return Number.isFinite(at) ? at : null;
  if (typeof at === 'string' && at.trim()) {
    const ms = Date.parse(at);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

function isWellFormed(e: PlaybookLedgerEvent): boolean {
  if (!e || !nonEmpty(e.orgId) || !nonEmpty(e.playbookId) || !isVersion((e as { version?: unknown }).version)) {
    return false;
  }
  switch (e.type) {
    case 'created':
      return Array.isArray(e.evidenceIds);
    case 'version_published':
      return Array.isArray(e.evidenceIds) && (e.parentVersion === undefined || isVersion(e.parentVersion));
    case 'applied':
      return nonEmpty(e.campaignId) && nonEmpty(e.actionEnvelopeId);
    case 'outcome':
      return typeof e.verdict === 'string';
    default:
      return false;
  }
}

interface MutableVersion {
  entry: PlaybookVersionLedgerEntry;
  campaigns: Set<string>;
}

const TYPE_ORDER: Record<PlaybookLedgerEvent['type'], number> = {
  created: 0,
  version_published: 1,
  applied: 2,
  outcome: 3,
};

export function reducePlaybookLedger(events: readonly PlaybookLedgerEvent[], now: number): PlaybookLedger {
  const rejected: PlaybookLedgerRejection[] = [];
  const valid: { e: PlaybookLedgerEvent; ms: number; index: number }[] = [];

  (events ?? []).forEach((e, index) => {
    if (!isWellFormed(e)) {
      rejected.push({ index, reason: 'malformed_event', orgId: e?.orgId, playbookId: e?.playbookId });
      return;
    }
    const ms = toMs(e.at);
    if (ms === null) {
      rejected.push({ index, reason: 'invalid_timestamp', orgId: e.orgId, playbookId: e.playbookId });
      return;
    }
    if (ms > now) {
      rejected.push({ index, reason: 'future_event', orgId: e.orgId, playbookId: e.playbookId });
      return;
    }
    valid.push({ e, ms, index });
  });

  // Stable causal order: time, then lifecycle type, then input position.
  valid.sort((a, b) => a.ms - b.ms || TYPE_ORDER[a.e.type] - TYPE_ORDER[b.e.type] || a.index - b.index);

  // Ownership is keyed by playbookId alone so a foreign org cannot shadow it.
  const owners = new Map<string, string>();
  const versions = new Map<string, MutableVersion>();
  const vKey = (playbookId: string, version: number) => `${playbookId}\u0000${version}`;

  const addVersion = (
    e: PlaybookCreatedEvent | PlaybookVersionPublishedEvent,
    ms: number,
    parentVersion: number | null,
  ) => {
    const evidenceIds = Array.from(new Set(e.evidenceIds.filter(nonEmpty))).sort();
    versions.set(vKey(e.playbookId, e.version), {
      campaigns: new Set(),
      entry: {
        orgId: e.orgId,
        playbookId: e.playbookId,
        version: e.version,
        parentVersion,
        evidenceIds,
        flags: evidenceIds.length === 0 ? ['missing_provenance'] : [],
        publishedAt: ms,
        usageCount: 0,
        distinctCampaigns: 0,
        campaignIds: [],
        firstUsedAt: null,
        lastUsedAt: null,
        daysSinceLastUse: 0,
        outcomes: { win: 0, loss: 0, neutral: 0 },
      },
    });
  };

  for (const { e, ms, index } of valid) {
    const reject = (reason: PlaybookLedgerRejectReason) =>
      rejected.push({ index, reason, orgId: e.orgId, playbookId: e.playbookId });
    const owner = owners.get(e.playbookId);

    if (e.type === 'created') {
      if (owner !== undefined) {
        reject(owner === e.orgId ? 'duplicate_playbook' : 'org_mismatch');
        continue;
      }
      owners.set(e.playbookId, e.orgId);
      addVersion(e, ms, null);
      continue;
    }

    if (owner === undefined) {
      reject('unknown_playbook');
      continue;
    }
    if (owner !== e.orgId) {
      reject('org_mismatch');
      continue;
    }

    const existing = versions.get(vKey(e.playbookId, e.version));

    if (e.type === 'version_published') {
      if (existing) {
        reject('duplicate_version');
        continue;
      }
      if (e.parentVersion !== undefined && !versions.has(vKey(e.playbookId, e.parentVersion))) {
        reject('unknown_version');
        continue;
      }
      addVersion(e, ms, e.parentVersion ?? null);
      continue;
    }

    if (!existing) {
      reject('unknown_version');
      continue;
    }

    if (e.type === 'applied') {
      const entry = existing.entry;
      entry.usageCount += 1;
      existing.campaigns.add(e.campaignId);
      entry.firstUsedAt = entry.firstUsedAt === null ? ms : Math.min(entry.firstUsedAt, ms);
      entry.lastUsedAt = entry.lastUsedAt === null ? ms : Math.max(entry.lastUsedAt, ms);
      continue;
    }

    if (!(VERDICTS as readonly string[]).includes(e.verdict)) {
      reject('unknown_verdict');
      continue;
    }
    existing.entry.outcomes[e.verdict as PlaybookLedgerVerdict] += 1;
  }

  const entries = Array.from(versions.values()).map(({ entry, campaigns }) => {
    const campaignIds = Array.from(campaigns).sort();
    const ref = entry.lastUsedAt ?? entry.publishedAt;
    return {
      ...entry,
      campaignIds,
      distinctCampaigns: campaignIds.length,
      daysSinceLastUse: Math.max(0, Math.floor((now - ref) / DAY_MS)),
    };
  });

  entries.sort(
    (a, b) =>
      (a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0) ||
      (a.playbookId < b.playbookId ? -1 : a.playbookId > b.playbookId ? 1 : 0) ||
      a.version - b.version,
  );
  rejected.sort((a, b) => a.index - b.index);

  return { entries, rejected };
}

/** Ledger rows visible to a single tenant. */
export function ledgerForOrg(ledger: PlaybookLedger, orgId: string): PlaybookVersionLedgerEntry[] {
  return ledger.entries.filter((e) => e.orgId === orgId);
}
