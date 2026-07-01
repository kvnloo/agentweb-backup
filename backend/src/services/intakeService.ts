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
  /** Chat session id of the reporter, so eng can jump straight to the offending session. */
  sessionId?: string;
  /** Tags + context for the Notion path (flag off). */
  notionTags?: string[];
  notionContext?: Record<string, any>;
}

export interface FiledUserResult {
  pageId: string;       // Featurebase post id (or Notion pageId when the flag is off)
  trackerUrl: string;   // internal tracker link (Featurebase post / Notion page)
  userUrl?: string;     // public, user-facing Featurebase post link
  deduped: boolean;
  tracker: 'Featurebase' | 'Notion';
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

  // Featurebase-first. Bugs -> a private per-reporter TICKET (their own card) grouped onto a
  // Linear canonical (the resolve-bridge notifies every reporter on fix). Feature requests ->
  // a public, votable POST. This split matches Featurebase's own guidance (public requests on
  // boards; private issues as tickets).
  return p.type === 'bug' ? fileBugReport(p) : fileFeatureRequest(p);
}

function reporterLabel(p: FileUserIssueParams): string {
  return `${p.userEmail}${p.userName && p.userName !== p.userEmail ? ` (${p.userName})` : ''}`;
}

/** Feature request -> public Featurebase post (FB-first); on dedup, stack a voter + private comment. */
async function fileFeatureRequest(p: FileUserIssueParams): Promise<FiledUserResult> {
  const { findDuplicate, MAX_CANDIDATES } = await import('./dedupService');
  const { listOpenPosts, createPost, addComment, addVoter } = await import('./featurebaseService');

  const posts = await listOpenPosts(MAX_CANDIDATES);
  const byRef = new Map(posts.map((x) => [x.id, x]));
  const dup = await findDuplicate(
    { type: 'feature_request', title: p.title, description: p.description },
    posts.map((x) => ({ ref: x.id, title: x.title, description: x.description })),
  );

  if (dup) {
    const post = byRef.get(dup.ref)!;
    // Best-effort stacking — a failure must not create a duplicate post. Private (eng-only)
    // comment keeps the reporter's full text + session out of the public body.
    const reportedNote = [
      `Also reported by ${reporterLabel(p)} on ${new Date().toISOString().slice(0, 10)}${p.reportedByAdmin ? ` — via ${p.reportedByAdmin} acting on their behalf` : ''}.`,
      ...(p.sessionId ? [`Session: ${p.sessionId}`] : []),
      '',
      'Their report:',
      p.description,
      ...contextLines(p.notionContext),
    ].join('\n');
    try { await addComment(post.id, reportedNote, true); } catch (e) { console.warn('[intake] feature dedup comment failed:', e instanceof Error ? e.message : e); }
    try { await addVoter(post.id, p.userEmail, p.userName); } catch (e) { console.warn('[intake] feature dedup upvote failed:', e instanceof Error ? e.message : e); }
    return { pageId: post.id, trackerUrl: post.url || FEATUREBASE_BOARD_URL, userUrl: post.url || FEATUREBASE_BOARD_URL, deduped: true, tracker: 'Featurebase' };
  }

  // New public post, authored by the filer (-> their "My profile"); Featurebase pushes it to
  // Linear for eng. Propagates on failure — no Notion reroute.
  const post = await createPost({ title: p.title, description: p.description, authorEmail: p.userEmail, authorName: p.userName });
  const filedNote = [
    p.reportedByAdmin ? `Filed by ${reporterLabel(p)} via ${p.reportedByAdmin} acting on their behalf (delegated session).` : `Filed by ${reporterLabel(p)}.`,
    ...(p.sessionId ? [`Session: ${p.sessionId}`] : []),
    ...contextLines(p.notionContext),
  ].join('\n');
  try { await addComment(post.id, filedNote, true); } catch (e) { console.warn('[intake] feature filed comment failed:', e instanceof Error ? e.message : e); }
  return { pageId: post.id, trackerUrl: post.url || FEATUREBASE_BOARD_URL, userUrl: post.url || FEATUREBASE_BOARD_URL, deduped: false, tracker: 'Featurebase' };
}

/**
 * Bug -> a PRIVATE per-reporter Featurebase ticket (the reporter's own card, authorOnly) grouped
 * onto ONE canonical Linear ticket per bug.
 *
 * Each reporter gets their own card (their words). All reporters of the same bug group onto a
 * single canonical Linear issue (Bug + Customer Reported, NO Featurebase label) — the one ticket
 * eng works. That canonical lists every affected user (email + session) via a `[reporter-ticket #N]`
 * comment per reporter; eng sees who's impacted, and the Linear resolve-bridge reads those numbers
 * to flip + notify every reporter's card when the canonical is marked Done.
 *
 * Requires Linear sync to be OFF for the Bug Report ticket category (so cards don't each spawn
 * their own Linear issue) — the canonical is the only Linear ticket per bug.
 */
async function fileBugReport(p: FileUserIssueParams): Promise<FiledUserResult> {
  const { findDuplicate, MAX_CANDIDATES } = await import('./dedupService');
  const { listOpenBugCanonicals, createInternalLinearIssue, addIssueComment } = await import('./linearService');
  const { createTicket } = await import('./featurebaseService');

  // 1. The reporter's OWN private card. Body = their words (what THEY see). Propagates on failure.
  const ticket = await createTicket({ title: p.title, content: p.description, authorEmail: p.userEmail, authorName: p.userName });

  // 2. Find or create the ONE canonical Linear ticket for this bug (dedup groups reporters).
  const cans = await listOpenBugCanonicals(MAX_CANDIDATES);
  const byRef = new Map(cans.map((c) => [c.identifier, c]));
  const dup = await findDuplicate(
    { type: 'bug', title: p.title, description: p.description },
    cans.map((c) => ({ ref: c.identifier, title: c.title, description: c.description })),
  );

  let canonicalUuid = '';
  if (dup) {
    canonicalUuid = byRef.get(dup.ref)!.issueId;
  } else {
    const filedBy = p.reportedByAdmin
      ? `via ${p.reportedByAdmin} acting on their behalf (delegated session)`
      : 'self-reported';
    const li = await createInternalLinearIssue({
      title: p.title,
      description: [
        p.description,
        '',
        '---',
        'Customer-reported bug. Each affected user has their own private Featurebase ticket; resolving THIS issue notifies them all (see the [reporter-ticket #N] comments).',
        '',
        `Affected user: ${reporterLabel(p)} (${filedBy})`,
        ...(p.sessionId ? [`Session: ${p.sessionId}`] : []),
        ...contextLines(p.notionContext),
      ].join('\n'),
      labelNames: ['Bug', 'Customer Reported'],
    });
    canonicalUuid = li.id || '';
  }

  // 3. Record this reporter on the canonical (best-effort). `[reporter-ticket #N]` is the contract
  //    the resolve-bridge parses to notify each card; eng also sees the affected user + session.
  if (canonicalUuid) {
    const note = [
      `[reporter-ticket #${ticket.number} ${p.userEmail}] Affected user: ${reporterLabel(p)}${p.reportedByAdmin ? ` — via ${p.reportedByAdmin}` : ''} on ${new Date().toISOString().slice(0, 10)}.`,
      ...(p.sessionId ? [`Session: ${p.sessionId}`] : []),
      // For the FIRST reporter the text is already in the canonical description.
      ...(dup ? ['', 'Their report:', p.description] : []),
      ...contextLines(p.notionContext),
    ].join('\n');
    try { await addIssueComment(canonicalUuid, note); } catch (e) { console.warn('[intake] bug canonical comment failed:', e instanceof Error ? e.message : e); }
  }

  return {
    pageId: String(ticket.number),
    trackerUrl: ticket.url || FEATUREBASE_BOARD_URL,
    userUrl: ticket.url || FEATUREBASE_BOARD_URL, // the reporter's OWN private card
    deduped: !!dup,
    tracker: 'Featurebase',
  };
}

export interface FileAutoIssueParams {
  title: string;
  description: string;
  /** Human label for where this came from, e.g. "Context limit", "Scheduled chat". */
  source: string;
  /** Extra Linear labels beyond "Auto" (e.g. ["Scheduled Chat"]). Unknown names are dropped. */
  extraLabels?: string[];
  /**
   * Incident dedupe key — the runId. When set (and the run store is enabled),
   * a conditional put on incident#<key> guarantees at most ONE filed incident
   * per run, even when multiple failure paths fire for the same run
   * (the exact ENG-145/146 double-filing failure). Losers get {deduped: true}.
   */
  dedupeKey?: string;
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
  // Per-run incident dedupe (guards BOTH tracker paths): the conditional
  // incident#<runId> claim in the run store makes "one run, one incident"
  // structural. A claim error propagates to the caller's best-effort wrapper —
  // no silent double-file, no silent reroute.
  if (p.dedupeKey) {
    const { isRunStoreEnabled, claimIncident } = await import('./agentMode/runStore');
    if (isRunStoreEnabled()) {
      const claimed = await claimIncident(p.dedupeKey);
      if (!claimed) {
        return { pageId: '', deduped: true, tracker: intakeEnabled() ? 'Linear' : 'Notion' };
      }
    }
  }

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

/**
 * Resolve bridge: when a bug canonical Linear issue is marked Done, notify EVERY reporter whose
 * private card is grouped onto it. We read the canonical's `[reporter-ticket #N <email>]` comments
 * (written at intake) to find each card + its reporter, then EMAIL the reporter and flip their card
 * to Completed. The email is sent from our own system address because Featurebase exposes no API
 * trigger for ticket emails (a ticket reply/status-change via API stays silent) — so we own
 * delivery rather than depend on a path that doesn't fire. Per-reporter best-effort so one failure
 * can't block the rest; idempotent in effect (re-flipping a Completed card is a no-op; a duplicate
 * email is harmless). Returns the ticket numbers we acted on. Called by the Linear webhook handler.
 *
 * Feature requests need no bridge: their Featurebase post is synced to Linear, so marking the Linear
 * issue Done flips the post to Completed and Featurebase emails every upvoter natively (verified).
 */
const REPORTER_TICKET_RE = /\[reporter-ticket #(\d+)\s+([^\]\s]+)\]/g;
const escapeHtml = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

export async function notifyCanonicalResolved(
  canonicalIssueId: string,
  issueTitle = 'the issue you reported',
): Promise<{ ticketNumbers: number[] }> {
  const { getIssueComments } = await import('./linearService');
  const { getTicketStatusId, patchTicketStatus } = await import('./featurebaseService');
  const { resendService } = await import('./resendService');

  const comments = await getIssueComments(canonicalIssueId);
  const reporters = new Map<number, string>(); // ticket number -> reporter email
  for (const body of comments) {
    let m: RegExpExecArray | null;
    REPORTER_TICKET_RE.lastIndex = 0;
    while ((m = REPORTER_TICKET_RE.exec(body)) !== null) reporters.set(Number(m[1]), m[2]);
  }
  if (reporters.size === 0) return { ticketNumbers: [] };

  const completedId = await getTicketStatusId('Completed');
  const safeTitle = escapeHtml(issueTitle);
  const acted: number[] = [];
  for (const [num, email] of reporters) {
    try {
      // The EMAIL is what notifies the reporter; the status flip reflects the resolved state on their card.
      await resendService.sendSystemEmail({
        to: email,
        subject: `Resolved: ${issueTitle}`,
        html: `<p>Good news — the issue you reported (<strong>${safeTitle}</strong>) has been resolved. Thanks for flagging it!</p><p>If you still run into it, just reply to this email and we'll take another look.</p>`,
      });
      await patchTicketStatus(num, completedId);
      acted.push(num);
    } catch (e) {
      console.warn(`[resolve-bridge] notifying reporter #${num} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { ticketNumbers: acted };
}
