/**
 * Fathom → Linear canonical reconciliation engine (ENG-259).
 *
 * This is the PURE decision core of the Fathom-to-Linear router: given a set of
 * already-extracted, structured meeting action items and a `LinearPort` (the Fathom +
 * Linear boundaries injected so it is fully unit-testable with mocks), it decides — per
 * item — whether to CREATE a new issue, ENRICH the canonical existing issue, RELATE a
 * distinct follow-on, or NO-OP, and returns a run report that exactly reconciles the
 * actual writes.
 *
 * It deliberately does NOT do ingestion (reading Fathom), extraction/classification
 * (turning transcript text into structured items — that is the LLM/taste layer gated on
 * Fangfang's shadow-mode review per the PRD), or the managed-vs-hosted product decision.
 * Those are tracked separately. The engine is the reusable "canonical dedupe contract"
 * every path shares (see the PRD's FR#4 + FR#6).
 *
 * Design contract (ENG-259 acceptance criteria + the reconciliation PRD):
 *  - Cross-board search: candidates come from ALL four teams (ENG/GROW/CS/OPS) before any
 *    write, matched on customer/account, source meeting URL, participants, workflow nouns,
 *    related issue IDs, and title variants.
 *  - Idempotency: each item carries a stable key (recordingId + itemId); a marker is
 *    embedded on every write, and a re-run finds it via `findByFathomKey` → no-op, never a
 *    second issue. Retries are safe.
 *  - Enrich-over-create: a matching customer/workflow issue is enriched with a source-linked
 *    comment; a new issue is created only when owner AND next action AND completion criteria
 *    are all distinct — and then it is RELATED to the canonical rather than cloned across boards.
 *  - Fail well: a per-item port failure is recorded in `errors` and does not abort the run or
 *    get mis-reported as created/skipped.
 *  - Shadow mode (`dryRun`): computes every decision and reports PROPOSED actions without any
 *    mutating write (PRD rollout Phase 1). Reads still run.
 *  - Reconciliation invariant: every input item lands in exactly one outcome bucket; nothing
 *    reported "not filed" was actually written.
 */

export type LinearTeamKey = 'ENG' | 'GROW' | 'CS' | 'OPS';

export const ALL_TEAMS: LinearTeamKey[] = ['ENG', 'GROW', 'CS', 'OPS'];

/** The meeting a batch of action items came from — the grounding for every write. */
export interface FathomMeetingRef {
  /** Stable Fathom recording id — half of the idempotency key. */
  recordingId: string;
  title: string;
  /** Fathom call URL (used as a cross-board dedup signal + written into the issue). */
  url: string;
  /** ISO date/time the meeting was processed. */
  date: string;
  /** Participant names and/or emails. */
  participants: string[];
}

/**
 * One already-extracted, structured action item. Producing these from a transcript is the
 * extraction layer's job (deferred, Fangfang-gated); the engine consumes the structured form.
 */
export interface ExtractedActionItem {
  /** Stable id WITHIN the meeting (Fathom action-item id, or a deterministic index). */
  id: string;
  /** The concrete fact/decision the action is about. */
  action: string;
  /** Which Linear board this item's work belongs to. */
  team: LinearTeamKey;
  /** Account/customer this concerns, if resolved. */
  customer?: string;
  /** Explicit owner, if the meeting stated one. */
  owner?: string;
  /** Concrete next action, if stated. */
  nextAction?: string;
  /** Completion condition, if stated. */
  doneCriteria?: string;
  /** Product/workflow/integration nouns for dedup matching. */
  workflowNouns?: string[];
  /** Existing issue identifiers explicitly referenced in the meeting (e.g. ["GROW-6"]). */
  relatedIssueIds?: string[];
  /** Deep link with timestamp for a non-obvious action (grounding). */
  groundingUrl?: string;
  /** 0..1 extraction confidence. */
  confidence?: number;
  /** false for sentiment / speculation / non-actionable chatter → never filed. */
  actionable: boolean;
  /** true when the customer/account could not be confidently resolved → Needs PM, no write. */
  customerAmbiguous?: boolean;
}

/** A candidate existing issue returned by the search boundary. */
export interface LinearCandidateIssue {
  id: string; // internal uuid (for mutations)
  identifier: string; // e.g. GROW-6
  team: LinearTeamKey;
  title: string;
  description: string;
  url: string;
  /** Assignee name/email, if any (used for distinctness on owner). */
  owner?: string;
}

/**
 * The injected Linear boundary. Real impl wraps `linearService` (AWS-Secrets-Manager-backed
 * credentials); tests supply a mock. Read methods run in shadow mode too; write methods do not.
 */
export interface LinearPort {
  /** Idempotency rail: find an issue already carrying this Fathom key marker, or null. */
  findByFathomKey(key: string): Promise<LinearCandidateIssue | null>;
  /** Cross-board search of active + recently-closed issues on the given teams. */
  searchIssues(params: { teams: LinearTeamKey[]; query: string; limit?: number }): Promise<LinearCandidateIssue[]>;
  /** Create a new issue on a team. */
  createIssue(params: { team: LinearTeamKey; title: string; description: string; labels?: string[] }): Promise<LinearCandidateIssue>;
  /** Add a source-linked comment to an existing issue (enrichment). */
  addComment(params: { issueId: string; body: string }): Promise<void>;
  /** Relate a follow-on issue to its canonical (never clone across boards). */
  relateIssues(params: { issueId: string; relatedIssueId: string }): Promise<void>;
}

export type RouteOutcome = 'created' | 'enriched' | 'related' | 'noop' | 'notFiled' | 'needsPm' | 'error';

export interface RunReportEntry {
  itemId: string;
  action: string;
  team: LinearTeamKey;
  /** Issue identifier written to / matched (or '(proposed)' in shadow mode for a create). */
  identifier?: string;
  url?: string;
  /** For a related follow-on: the canonical it was related to. */
  canonicalIdentifier?: string;
  /** For notFiled / needsPm / error: why. */
  reason?: string;
  /** true in shadow mode — the action was computed but not written. */
  proposed?: boolean;
}

export interface RunReport {
  mode: 'live' | 'shadow';
  meetingsScanned: number;
  itemsScanned: number;
  created: RunReportEntry[];
  enriched: RunReportEntry[];
  related: RunReportEntry[];
  /** Idempotent no-ops (already processed) + facts already reflected. */
  duplicatesAvoided: RunReportEntry[];
  notFiled: RunReportEntry[];
  needsPm: RunReportEntry[];
  errors: RunReportEntry[];
}

export interface RouteOptions {
  /** Shadow mode: decide + report proposed actions, write nothing (PRD Phase 1). */
  dryRun?: boolean;
  /** Max candidates to pull per search (defaults to 30). */
  searchLimit?: number;
}

// ---------------------------------------------------------------------------
// Text helpers (pure, no deps)
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  const set = new Set<string>();
  for (const t of normalize(s).split(' ')) {
    if (t.length >= 3) set.add(t);
  }
  return set;
}

/** Bigram Dice coefficient (0..1) on normalized strings. */
function dice(a: string, b: string): number {
  const an = normalize(a);
  const bn = normalize(b);
  if (an === bn) return an.length === 0 ? 0 : 1;
  if (an.length < 2 || bn.length < 2) return 0;
  const bg = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = bg(an);
  const B = bg(bn);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** Jaccard overlap of token sets (0..1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------------------
// Idempotency + write payloads
// ---------------------------------------------------------------------------

/** Stable per-item idempotency key. */
export function fathomKey(recordingId: string, itemId: string): string {
  return `fathom:${recordingId}:${itemId}`;
}

/** The marker embedded on every write so a re-run recognises its own prior output. */
export function fathomKeyMarker(key: string): string {
  return `[[fathom-key:${key}]]`;
}

function meetingGrounding(meeting: FathomMeetingRef, item: ExtractedActionItem): string {
  const link = item.groundingUrl || meeting.url;
  const conf = typeof item.confidence === 'number' ? ` · confidence ${(item.confidence * 100).toFixed(0)}%` : '';
  return `Source: [${meeting.title}](${link}) (${meeting.date})${conf}`;
}

function buildIssueDescription(meeting: FathomMeetingRef, item: ExtractedActionItem, key: string): string {
  const lines = [
    item.action,
    '',
    '---',
    meetingGrounding(meeting, item),
  ];
  if (item.customer) lines.push(`Customer: ${item.customer}`);
  if (item.owner) lines.push(`Owner: ${item.owner}`);
  if (item.nextAction) lines.push(`Next action: ${item.nextAction}`);
  if (item.doneCriteria) lines.push(`Done when: ${item.doneCriteria}`);
  lines.push('', fathomKeyMarker(key));
  return lines.join('\n');
}

function buildEnrichComment(meeting: FathomMeetingRef, item: ExtractedActionItem, key: string): string {
  const lines = [
    `Meeting update: ${item.action}`,
    meetingGrounding(meeting, item),
  ];
  if (item.owner) lines.push(`Owner: ${item.owner}`);
  if (item.nextAction) lines.push(`Next action: ${item.nextAction}`);
  lines.push('', fathomKeyMarker(key));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Canonical matching (deterministic, biased to NEW)
// ---------------------------------------------------------------------------

/** A title is a "variant" of the candidate's when the two are this Dice-similar. */
const TITLE_VARIANT_SIM = 0.45;

/**
 * Find the canonical existing issue this item belongs to across all boards, or null.
 *
 * Binding is anchor-based, biased to NEW (a false cross-board merge is worse than a missed
 * one; the PM/human review catches the tail). A candidate qualifies only when:
 *   - the meeting explicitly named it (related-issue id), OR
 *   - the candidate already references this exact source meeting, OR
 *   - it is the SAME customer AND the same workflow (a shared workflow noun or a title variant).
 * Customer alone never binds (different workstreams for one account stay separate); a title
 * or noun coincidence without the same customer never binds either. Among qualifiers, the
 * strongest (customer + meeting + noun/title overlap) wins.
 */
export function matchCanonical(
  meeting: FathomMeetingRef,
  item: ExtractedActionItem,
  candidates: LinearCandidateIssue[],
): LinearCandidateIssue | null {
  if (candidates.length === 0) return null;

  // 1. Explicit reference — the meeting named the issue. Strongest possible signal.
  if (item.relatedIssueIds && item.relatedIssueIds.length > 0) {
    const wanted = new Set(item.relatedIssueIds.map((r) => normalize(r)));
    const explicit = candidates.find((c) => wanted.has(normalize(c.identifier)));
    if (explicit) return explicit;
  }

  const custTokens = item.customer ? tokens(item.customer) : new Set<string>();
  const nounTokens = new Set<string>();
  for (const n of item.workflowNouns || []) for (const t of tokens(n)) nounTokens.add(t);

  let best: LinearCandidateIssue | null = null;
  let bestScore = 0;

  for (const c of candidates) {
    const bodyTokens = tokens(`${c.title} ${c.description}`);

    // Customer/account name appears in the candidate.
    const customerMatch = custTokens.size > 0 && jaccard(custTokens, bodyTokens) > 0;
    // The candidate already references this exact source meeting.
    const meetingMatch = !!meeting.url && c.description.includes(meeting.url);
    // Same workflow: a shared workflow noun or a title variant.
    const nounOverlap = jaccard(nounTokens, bodyTokens);
    const titleSim = dice(item.action, c.title);
    const sameWorkflow = nounOverlap > 0 || titleSim >= TITLE_VARIANT_SIM;

    const qualifies = meetingMatch || (customerMatch && sameWorkflow);
    if (!qualifies) continue;

    // Rank qualifiers by combined signal strength.
    const score = (customerMatch ? 1 : 0) + (meetingMatch ? 1 : 0) + nounOverlap + titleSim;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }

  return best;
}

/**
 * A distinct follow-on (→ create + relate) vs an enrichment of the same work (→ comment).
 * Per ENG-259 / PRD: create a new issue only when owner, next action, AND completion
 * criteria are all present and at least one is genuinely distinct from the canonical.
 * Anything short of that is the same unit of work getting a status update → enrich.
 */
export function isDistinctFollowOn(item: ExtractedActionItem, canonical: LinearCandidateIssue): boolean {
  if (!item.owner || !item.nextAction || !item.doneCriteria) return false;

  const canonicalBody = normalize(`${canonical.title} ${canonical.description}`);

  const ownerDistinct = !!canonical.owner && normalize(item.owner) !== normalize(canonical.owner);
  const nextActionNew = !canonicalBody.includes(normalize(item.nextAction)) && dice(item.nextAction, canonical.title) < 0.5;
  const doneNew = !canonicalBody.includes(normalize(item.doneCriteria));

  return ownerDistinct || (nextActionNew && doneNew);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

function emptyReport(mode: 'live' | 'shadow', meetingsScanned: number, itemsScanned: number): RunReport {
  return {
    mode,
    meetingsScanned,
    itemsScanned,
    created: [],
    enriched: [],
    related: [],
    duplicatesAvoided: [],
    notFiled: [],
    needsPm: [],
    errors: [],
  };
}

async function routeItem(
  meeting: FathomMeetingRef,
  item: ExtractedActionItem,
  port: LinearPort,
  report: RunReport,
  opts: Required<RouteOptions>,
): Promise<void> {
  const base = { itemId: item.id, action: item.action, team: item.team };

  // Sentiment / speculative / non-actionable → never filed (PRD non-goal, hard-signals-only).
  if (!item.actionable) {
    report.notFiled.push({ ...base, reason: 'not-actionable (sentiment/speculative/FYI)' });
    return;
  }
  // Ambiguous customer → Needs PM, no write (never guess).
  if (item.customerAmbiguous) {
    report.needsPm.push({ ...base, reason: 'ambiguous customer/account — not resolved' });
    return;
  }

  const key = fathomKey(meeting.recordingId, item.id);

  try {
    // Idempotency rail: already processed this exact item → no-op, never a duplicate.
    const already = await port.findByFathomKey(key);
    if (already) {
      report.duplicatesAvoided.push({
        ...base,
        identifier: already.identifier,
        url: already.url,
        reason: 'already processed (idempotent)',
      });
      return;
    }

    // Cross-board canonical search over all four teams.
    const candidates = await port.searchIssues({
      teams: ALL_TEAMS,
      query: buildSearchQuery(meeting, item),
      limit: opts.searchLimit,
    });
    const canonical = matchCanonical(meeting, item, candidates);

    if (!canonical) {
      // Distinct new work with no existing home → create standalone.
      if (opts.dryRun) {
        report.created.push({ ...base, identifier: '(proposed)', proposed: true });
        return;
      }
      const created = await port.createIssue({
        team: item.team,
        title: item.action,
        description: buildIssueDescription(meeting, item, key),
      });
      report.created.push({ ...base, identifier: created.identifier, url: created.url });
      return;
    }

    if (isDistinctFollowOn(item, canonical)) {
      // Legitimate follow-on: create + relate to canonical (never clone across boards).
      if (opts.dryRun) {
        report.related.push({ ...base, identifier: '(proposed)', canonicalIdentifier: canonical.identifier, proposed: true });
        return;
      }
      const created = await port.createIssue({
        team: item.team,
        title: item.action,
        description: buildIssueDescription(meeting, item, key),
      });
      await port.relateIssues({ issueId: created.id, relatedIssueId: canonical.id });
      report.related.push({ ...base, identifier: created.identifier, url: created.url, canonicalIdentifier: canonical.identifier });
      return;
    }

    // Same unit of work → enrich the canonical with a source-linked comment.
    if (opts.dryRun) {
      report.enriched.push({ ...base, identifier: canonical.identifier, url: canonical.url, proposed: true });
      return;
    }
    await port.addComment({ issueId: canonical.id, body: buildEnrichComment(meeting, item, key) });
    report.enriched.push({ ...base, identifier: canonical.identifier, url: canonical.url });
  } catch (e) {
    // Fail well: surface the error in the report, never mis-report as filed/skipped, keep going.
    report.errors.push({ ...base, reason: e instanceof Error ? e.message : String(e) });
  }
}

/** Free-text query fed to the search boundary — packs the dedup signals into one string. */
export function buildSearchQuery(meeting: FathomMeetingRef, item: ExtractedActionItem): string {
  return [
    item.customer || '',
    ...(item.workflowNouns || []),
    ...(item.relatedIssueIds || []),
    item.action,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * Reconcile one processed Fathom meeting's extracted action items to Linear.
 * Returns a run report that exactly matches what was (or, in shadow mode, would be) written.
 */
export async function routeMeetingToLinear(
  meeting: FathomMeetingRef,
  items: ExtractedActionItem[],
  port: LinearPort,
  options: RouteOptions = {},
): Promise<RunReport> {
  const opts: Required<RouteOptions> = {
    dryRun: options.dryRun ?? false,
    searchLimit: options.searchLimit ?? 30,
  };
  const report = emptyReport(opts.dryRun ? 'shadow' : 'live', 1, items.length);

  for (const item of items) {
    await routeItem(meeting, item, port, report, opts);
  }

  return report;
}

/** Reconcile a batch of meetings in one run (shared report). */
export async function routeMeetingsBatch(
  meetings: Array<{ meeting: FathomMeetingRef; items: ExtractedActionItem[] }>,
  port: LinearPort,
  options: RouteOptions = {},
): Promise<RunReport> {
  const opts: Required<RouteOptions> = {
    dryRun: options.dryRun ?? false,
    searchLimit: options.searchLimit ?? 30,
  };
  const totalItems = meetings.reduce((n, m) => n + m.items.length, 0);
  const report = emptyReport(opts.dryRun ? 'shadow' : 'live', meetings.length, totalItems);

  for (const { meeting, items } of meetings) {
    for (const item of items) {
      await routeItem(meeting, item, port, report, opts);
    }
  }

  return report;
}
