/**
 * Deterministic Fathom → ExtractedActionItem extraction layer (ENG-259).
 *
 * Turns a raw Fathom `recording.ready` webhook meeting payload into the structured
 * `FathomMeetingRef` + `ExtractedActionItem[]` the canonical reconciliation engine
 * (`fathomLinearRouter`) consumes.
 *
 * Deliberately deterministic — no LLM call. Retries of the same payload MUST produce
 * byte-identical output (item ids included) so the engine's idempotency rail holds:
 * `fathomKey(recordingId, itemId)` must be stable across webhook redeliveries.
 *
 * Scope contract (ENG-259 #2): only actionable Harsha-owned or Harsha-PM (unassigned)
 * items are marked actionable; items explicitly assigned to someone else, pleasantries,
 * and already-completed items are kept as non-actionable FYI (the engine reports them
 * under `notFiled` with a reason — they are never silently dropped).
 */

import type {
  ExtractedActionItem,
  FathomMeetingRef,
  LinearTeamKey,
} from './fathomLinearRouter';

export interface ExtractionResult {
  meeting: FathomMeetingRef;
  items: ExtractedActionItem[];
}

// ---------------------------------------------------------------------------
// Team classification — deterministic keyword scoring
// ---------------------------------------------------------------------------

const TEAM_KEYWORDS: Record<LinearTeamKey, string[]> = {
  ENG: [
    'bug', 'fix', 'error', 'crash', 'api', 'endpoint', 'backend', 'frontend',
    'deploy', 'build', 'code', 'database', 'migration', 'schema', 'integration',
    'webhook', 'latency', 'timeout', 'login', 'portal', 'mcp',
  ],
  GROW: [
    'campaign', 'ads', 'ad', 'creative', 'landing', 'outreach', 'lead', 'leads',
    'content', 'seo', 'blog', 'linkedin', 'marketing', 'retargeting',
    'impressions', 'audience', 'prospect', 'prospects',
  ],
  CS: [
    'onboarding', 'onboard', 'activation', 'walkthrough', 'training', 'churn',
    'renewal', 'escalation', 'check-in', 'health',
  ],
  OPS: [
    'invoice', 'billing', 'contract', 'legal', 'vendor', 'credential',
    'credentials', 'payroll', 'compliance', 'insurance', 'procurement', 'payment',
  ],
};

/** Deterministic tie-break order when two teams score equally. */
const TEAM_ORDER: LinearTeamKey[] = ['ENG', 'GROW', 'CS', 'OPS'];

function matchKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function classifyTeam(text: string, hasCustomer: boolean): { team: LinearTeamKey; matchedKeywords: string[] } {
  const matchedKeywords: string[] = [];
  const scores = new Map<LinearTeamKey, number>();
  for (const team of TEAM_ORDER) {
    let score = 0;
    for (const kw of TEAM_KEYWORDS[team]) {
      if (matchKeyword(text, kw)) {
        score++;
        if (!matchedKeywords.includes(kw)) matchedKeywords.push(kw);
      }
    }
    scores.set(team, score);
  }

  let best: LinearTeamKey | null = null;
  let bestScore = 0;
  for (const team of TEAM_ORDER) {
    const score = scores.get(team) || 0;
    if (score > bestScore) {
      best = team;
      bestScore = score;
    }
  }

  if (best) return { team: best, matchedKeywords };
  // No signal at all: a customer-shaped follow-up defaults to CS; otherwise ENG.
  return { team: hasCustomer ? 'CS' : 'ENG', matchedKeywords };
}

// ---------------------------------------------------------------------------
// Actionability — pleasantries, completed items, non-Harsha assignees
// ---------------------------------------------------------------------------

const PLEASANTRY_PATTERNS: RegExp[] = [
  /^(great|good|nice|awesome|thanks|thank you|sounds good|yeah|yes|ok|okay)\b/i,
  /^(let'?s talk|see you|talk soon|have a good|bye)\b/i,
  /that makes sense/i,
  /^(sure|absolutely|definitely|agreed|perfect|cool)\b/i,
];

function isPleasantry(text: string): boolean {
  return PLEASANTRY_PATTERNS.some((p) => p.test(text.trim()));
}

function isHarsha(name?: string, email?: string): boolean {
  return /harsha/i.test(name || '') || /harsha/i.test(email || '');
}

// ---------------------------------------------------------------------------
// Customer resolution — CRM matches first, single external domain as fallback
// ---------------------------------------------------------------------------

const INTERNAL_DOMAINS = new Set(['agentweb.pro', 'usethread.io', 'hireemma.ai']);
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com', 'msn.com',
]);

function crmCompanyName(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const value = obj.company ?? obj.name ?? '';
    return typeof value === 'string' ? value.trim() : '';
  }
  return '';
}

function participantEmails(rawParticipants: unknown[]): string[] {
  const emails: string[] = [];
  for (const p of rawParticipants) {
    if (typeof p === 'string' && p.includes('@')) emails.push(p);
    else if (p && typeof p === 'object') {
      const email = (p as Record<string, unknown>).email;
      if (typeof email === 'string' && email.includes('@')) emails.push(email);
    }
  }
  return emails;
}

/**
 * Resolve the customer for the meeting.
 *  - Exactly one distinct CRM company → that customer.
 *  - Two or more distinct CRM companies → ambiguous (Needs PM, never guess).
 *  - No CRM signal → exactly one external corporate participant domain → its first
 *    label; zero or several external domains → undefined (absent, NOT ambiguous —
 *    the engine only binds on customer + workflow, so absence is safe).
 */
function resolveCustomer(raw: Record<string, unknown>): { customer?: string; ambiguous: boolean } {
  const crmEntries = Array.isArray(raw.crm_matches) ? raw.crm_matches : [];
  const names = crmEntries.map(crmCompanyName).filter((n) => n.length > 0);
  const distinct = new Map<string, string>();
  for (const n of names) {
    const key = n.toLowerCase();
    if (!distinct.has(key)) distinct.set(key, n);
  }
  if (distinct.size === 1) return { customer: [...distinct.values()][0], ambiguous: false };
  if (distinct.size > 1) return { customer: undefined, ambiguous: true };

  const domains = new Set<string>();
  for (const email of participantEmails(Array.isArray(raw.participants) ? raw.participants : [])) {
    const domain = email.split('@')[1]?.toLowerCase().trim();
    if (!domain || INTERNAL_DOMAINS.has(domain) || FREE_MAIL_DOMAINS.has(domain)) continue;
    domains.add(domain);
  }
  if (domains.size === 1) {
    return { customer: [...domains][0].split('.')[0], ambiguous: false };
  }
  return { customer: undefined, ambiguous: false };
}

// ---------------------------------------------------------------------------
// Stable ids
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash, hex — a stable fallback id derived only from payload content. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const ISSUE_ID_PATTERN = /\b(ENG|GROW|CS|OPS)-\d+\b/gi;

/**
 * Extract the meeting reference + structured action items from a raw Fathom webhook
 * meeting payload. `recordingId` is the webhook's `data.recording_id` when present.
 * Throws on a payload without a title (fail loud — the route validates first).
 */
export function extractMeetingActionItems(
  rawMeeting: unknown,
  recordingId?: string | number,
): ExtractionResult {
  const raw = (rawMeeting || {}) as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) {
    throw new Error('Fathom meeting payload has no title — cannot extract action items.');
  }

  const createdAt = typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString();
  const url =
    (typeof raw.url === 'string' && raw.url) ||
    (typeof raw.share_url === 'string' && raw.share_url) ||
    (typeof raw.recording_url === 'string' && raw.recording_url) ||
    '';

  const resolvedRecordingId =
    recordingId !== undefined && recordingId !== null
      ? String(recordingId)
      : raw.id !== undefined && raw.id !== null
        ? String(raw.id)
        : fnv1a(`${title}|${typeof raw.created_at === 'string' ? raw.created_at : ''}`);

  const rawParticipants = Array.isArray(raw.participants) ? raw.participants : [];
  const participants = rawParticipants.map((p) => {
    if (typeof p === 'string') return p;
    const obj = (p || {}) as Record<string, unknown>;
    return (typeof obj.email === 'string' && obj.email) || (typeof obj.name === 'string' && obj.name) || 'Unknown';
  });

  const meeting: FathomMeetingRef = {
    recordingId: resolvedRecordingId,
    title,
    url,
    date: createdAt,
    participants,
  };

  const { customer, ambiguous } = resolveCustomer(raw);

  const rawItems = Array.isArray(raw.action_items) ? raw.action_items : [];
  const items: ExtractedActionItem[] = [];

  rawItems.forEach((rawItem, index) => {
    const obj = (typeof rawItem === 'object' && rawItem !== null ? rawItem : {}) as Record<string, unknown>;
    const text = (
      typeof rawItem === 'string'
        ? rawItem
        : (typeof obj.text === 'string' && obj.text) || (typeof obj.description === 'string' && obj.description) || ''
    ).trim();
    if (!text) return; // nothing to route or report; positional ids stay stable via `index`

    const id = obj.id !== undefined && obj.id !== null ? String(obj.id) : `item-${index}`;

    // Assignee → owner + the Harsha-owned/Harsha-PM filter (ENG-259 scope #2).
    let assigneeName: string | undefined;
    let assigneeEmail: string | undefined;
    if (typeof obj.assignee === 'string') assigneeName = obj.assignee;
    else if (obj.assignee && typeof obj.assignee === 'object') {
      const a = obj.assignee as Record<string, unknown>;
      assigneeName = typeof a.name === 'string' ? a.name : undefined;
      assigneeEmail = typeof a.email === 'string' ? a.email : undefined;
    }
    const hasAssignee = Boolean(assigneeName || assigneeEmail);
    const assignedToHarsha = hasAssignee && isHarsha(assigneeName, assigneeEmail);

    const actionable =
      obj.completed !== true &&
      !isPleasantry(text) &&
      (!hasAssignee || assignedToHarsha);

    const { team, matchedKeywords } = classifyTeam(text, Boolean(customer));

    const relatedIssueIds = [
      ...new Set([...text.matchAll(ISSUE_ID_PATTERN)].map((m) => m[0].toUpperCase())),
    ];

    const groundingUrl =
      (typeof obj.recording_timestamp_url === 'string' && obj.recording_timestamp_url) ||
      (typeof obj.timestamp_url === 'string' && obj.timestamp_url) ||
      undefined;

    items.push({
      id,
      action: text,
      team,
      customer,
      owner: hasAssignee ? assigneeName || assigneeEmail : undefined,
      workflowNouns: matchedKeywords,
      relatedIssueIds,
      groundingUrl,
      actionable,
      customerAmbiguous: ambiguous || undefined,
    });
  });

  return { meeting, items };
}
