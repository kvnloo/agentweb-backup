/**
 * Issue intake orchestration — one place that decides where a filing goes.
 *
 * The FEATUREBASE_INTAKE flag is an EXPLICIT migration switch (Linear when on, Notion
 * when off — the off branch is deleted once the migration completes). It is NOT an
 * on-error fallback: we do not silently reroute a failed Linear write to Notion.
 * Instead we fail well —
 *   - non-critical sub-steps (dedup search, upvote, comment) are best-effort and degrade
 *     in place (dedup fails -> treat as new; upvote/comment fails -> still filed),
 *   - a core create failure propagates so the caller surfaces it (user-filed -> the user
 *     is told it didn't file; auto -> the call site logs and moves on, since a failed
 *     self-report must never break the user's real request).
 *
 * Two entry points:
 *  - fileUserIssue:  USER-filed feature/bug (Emma report_product_issues + the in-app
 *    "report a bug" button). Dedups against open public canonicals; on a match it stacks
 *    (upvote the Featurebase post + comment the canonical); otherwise creates a canonical
 *    Linear issue (tagged "Featurebase" -> imported as a public, votable post).
 *  - fileAutoIssue:  AUTO-identified by the system. Creates a PRIVATE Linear issue
 *    (tagged "Auto", NO "Featurebase" label -> never public) and dedups by normalized title
 *    so recurring auto-issues group onto one item instead of flooding the board.
 */

const FEATUREBASE_BOARD_URL = 'https://agentweb.featurebase.app/';

function intakeEnabled(): boolean {
  return process.env.FEATUREBASE_INTAKE === 'true';
}

function contextLines(context?: Record<string, any>): string[] {
  if (!context) return [];
  return Object.entries(context).map(([k, v]) => {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `- ${k}: ${val.length > 400 ? val.slice(0, 400) + '…' : val}`;
  });
}

export interface FileUserIssueParams {
  type: 'feature_request' | 'bug';
  title: string;
  description: string;
  userEmail: string;
  userName?: string;
  /** Admin email when filed via a delegated session. */
  reportedByAdmin?: string;
  /** Tags + context for the Notion path (flag off). */
  notionTags?: string[];
  notionContext?: Record<string, any>;
}

export interface FiledUserResult {
  pageId: string;       // Linear identifier (or Notion pageId when the flag is off)
  trackerUrl: string;   // internal tracker link (Linear issue / Notion page)
  userUrl?: string;     // public, user-facing Featurebase link
  deduped: boolean;
  tracker: 'Linear' | 'Notion';
}

export async function fileUserIssue(p: FileUserIssueParams): Promise<FiledUserResult> {
  // Migration switch (NOT a fallback): off -> Notion, the pre-migration default.
  if (!intakeEnabled()) {
    const { createOncallItem } = await import('./notionService');
    const o = await createOncallItem({
      title: p.title,
      description: p.description,
      additionalTags: p.notionTags || ['Customer Reported'],
      context: p.notionContext,
    });
    return { pageId: o.pageId, trackerUrl: o.notionUrl, deduped: false, tracker: 'Notion' };
  }

  // Linear path. dedup is best-effort internally (returns null on error -> treated as new).
  const { findDuplicateCanonical } = await import('./dedupService');
  const dup = await findDuplicateCanonical({ type: p.type, title: p.title, description: p.description });
  if (dup) {
    // Stacking writes are best-effort — a failure here must not turn this into a duplicate
    // issue, so degrade in place rather than failing the whole filing.
    const reportedLine = `Also reported by ${p.userEmail} on ${new Date().toISOString().slice(0, 10)}${p.reportedByAdmin ? ` (via ${p.reportedByAdmin} acting on their behalf)` : ''}.`;
    try {
      const { addIssueComment } = await import('./linearService');
      await addIssueComment(dup.issueId, reportedLine);
    } catch (e) {
      console.warn('[intake] dedup comment failed:', e instanceof Error ? e.message : e);
    }
    try {
      const { findPostByTitle, addVoter } = await import('./featurebaseService');
      const post = await findPostByTitle(dup.title);
      if (post) await addVoter(post.id, p.userEmail, p.userName);
    } catch (e) {
      console.warn('[intake] dedup upvote failed:', e instanceof Error ? e.message : e);
    }
    return {
      pageId: dup.identifier,
      trackerUrl: dup.featurebasePostUrl || dup.identifier,
      userUrl: dup.featurebasePostUrl || FEATUREBASE_BOARD_URL,
      deduped: true,
      tracker: 'Linear',
    };
  }

  // Core create: if this throws, it propagates — the caller surfaces a clean failure to
  // the user. We do NOT reroute to Notion.
  const { createLinearIssue } = await import('./linearService');
  const li = await createLinearIssue({
    type: p.type,
    title: p.title,
    description: p.description,
    userEmail: p.userEmail,
    reportedByAdmin: p.reportedByAdmin,
  });
  return { pageId: li.identifier, trackerUrl: li.url, userUrl: FEATUREBASE_BOARD_URL, deduped: false, tracker: 'Linear' };
}

export interface FileAutoIssueParams {
  title: string;
  description: string;
  /** Human label for where this came from, e.g. "Context limit", "Scheduled chat". */
  source: string;
  /** Extra Linear labels beyond "Auto" (e.g. ["Scheduled Chat"]). Unknown names are dropped. */
  extraLabels?: string[];
  /** Tags + context for the Notion path (flag off). */
  notionTags?: string[];
  notionContext?: Record<string, any>;
}

export interface FiledAutoResult {
  pageId: string;
  /** Link to the filed item (Linear issue or Notion page), for alert emails. */
  url?: string;
  deduped: boolean;
  tracker: 'Linear' | 'Notion';
}

const LINEAR_ISSUE_BASE = 'https://linear.app/emmabyaw/issue';

/**
 * File an auto-identified issue. Callers should treat this as best-effort and wrap it
 * (a failed self-report must not break the user's real request) — it throws on a hard
 * failure rather than rerouting to another tracker.
 */
export async function fileAutoIssue(p: FileAutoIssueParams): Promise<FiledAutoResult> {
  // Migration switch (NOT a fallback): off -> Notion.
  if (!intakeEnabled()) {
    const { createOncallItem } = await import('./notionService');
    const o = await createOncallItem({
      title: p.title,
      description: p.description,
      additionalTags: p.notionTags || ['Oncall'],
      context: p.notionContext,
    });
    return { pageId: o.pageId, url: o.notionUrl, deduped: false, tracker: 'Notion' };
  }

  const { listOpenIssuesByLabel, addIssueComment, createInternalLinearIssue } = await import('./linearService');
  const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const open = await listOpenIssuesByLabel('Auto', 50);
  const match = open.find((i) => norm(i.title) === norm(p.title));
  if (match) {
    try {
      await addIssueComment(match.issueId, [`Recurred on ${new Date().toISOString().slice(0, 10)}.`, ...contextLines(p.notionContext)].join('\n'));
    } catch (e) {
      console.warn('[intake] auto recur-comment failed:', e instanceof Error ? e.message : e);
    }
    return { pageId: match.identifier, url: `${LINEAR_ISSUE_BASE}/${match.identifier}`, deduped: true, tracker: 'Linear' };
  }
  const body = [
    p.description,
    '',
    '---',
    `Source: ${p.source} — auto-identified by the system.`,
    ...contextLines(p.notionContext),
  ].join('\n');
  const li = await createInternalLinearIssue({
    title: p.title,
    description: body,
    labelNames: ['Auto', ...(p.extraLabels || [])],
  });
  return { pageId: li.identifier, url: li.url, deduped: false, tracker: 'Linear' };
}
