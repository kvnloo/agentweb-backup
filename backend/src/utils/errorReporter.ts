import { emailService } from '../services/emailService';

export interface UIErrorReport {
  operation: string;
  errorMessage: string;
  userId?: string;
  context?: Record<string, any>;
}

/**
 * Enrich the oncall context for onboarding-tagged errors. The Notion task IS
 * the investigation surface (no separate admin portal page) — so we pack
 * everything Rui needs to investigate directly into the task body:
 *   - User identity
 *   - Current onboardingStage
 *   - Per-step status table (icp / competitor / creativeDir / adImage / adCopy)
 *   - Last 20 onboarding events
 *   - A delegate-as-user URL for one-click manual UI inspection
 *
 * Best-effort and silent on failure — the base reportUIError flow must never
 * be blocked by an enrichment-fetch hiccup. If userDb is unreachable the
 * Notion task still fires with the original context.
 */
async function enrichOnboardingContext(
  userId: string,
  baseContext: Record<string, any>,
): Promise<Record<string, any>> {
  try {
    const { userDb } = await import('../services/db');
    const user: any = await userDb.getUserById(userId);
    if (!user) return baseContext;
    const enriched: Record<string, any> = { ...baseContext };
    if (user.email) enriched['User Email'] = user.email;
    if (user.onboardingStage) enriched['Onboarding Stage'] = user.onboardingStage;
    if (user.createdAt) enriched['Signup'] = user.createdAt;
    enriched['Investigate as User'] = `${process.env.PARTNER_PORTAL_URL || 'https://agentweb.pro'}/admin/delegate?targetUserId=${userId}`;

    // Per-step status table — collapse the 5 per-axis states into one
    // human-scannable string so the Notion bullet renders cleanly.
    const stepLines: string[] = [];
    for (const axis of ['brandBuild', 'icp', 'competitor', 'creativeDir', 'adImage', 'adCopy']) {
      const status = user[`${axis}Status`];
      if (!status) continue;
      const startedAt = user[`${axis}StartedAt`];
      const completedAt = user[`${axis}CompletedAt`];
      const error = user[`${axis}Error`];
      const parts = [`${axis}=${status}`];
      if (startedAt) parts.push(`startedAt=${startedAt}`);
      if (completedAt) parts.push(`completedAt=${completedAt}`);
      if (error) parts.push(`error=${String(error).slice(0, 200)}`);
      stepLines.push(parts.join(' '));
    }
    if (stepLines.length > 0) enriched['Step Status'] = stepLines.join('\n');

    // Last 20 onboarding events (oldest → newest) so Rui can see the
    // user's path through the funnel without leaving the Notion task.
    const events = Array.isArray(user.onboardingEvents) ? user.onboardingEvents : [];
    if (events.length > 0) {
      const lastN = events.slice(-20).map((e: any) => {
        const ts = e?.ts ? new Date(e.ts).toISOString() : '?';
        const dataStr = e?.data ? ` ${JSON.stringify(e.data).slice(0, 120)}` : '';
        return `${ts} ${e?.event ?? '<unknown>'}${dataStr}`;
      });
      enriched['Recent Events (last 20)'] = lastN.join('\n');
    }

    // Attribution from User.firstTouch (signup-time touch) and lastTouch
    // (most-recent return). Captured upstream by the auth/signup endpoints
    // via `normalizeAttribution`. Surfacing here means the responder can
    // see "user from utm_source=linkedin abandoned at brandReview" without
    // needing to cross-join the Lead row by email.
    const firstTouch: any = user.firstTouch;
    const lastTouch: any = user.lastTouch;
    if (firstTouch?.utm) {
      const u = firstTouch.utm;
      const parts = [
        u.source && `source=${u.source}`,
        u.medium && `medium=${u.medium}`,
        u.campaign && `campaign=${u.campaign}`,
        u.content && `content=${u.content}`,
        u.term && `term=${u.term}`,
      ].filter(Boolean);
      if (parts.length > 0) enriched['Attribution (first touch UTM)'] = parts.join(' | ');
    }
    if (firstTouch?.referrer) enriched['Attribution (first touch referrer)'] = String(firstTouch.referrer).slice(0, 300);
    if (firstTouch?.landingUrl) enriched['Attribution (first touch landing URL)'] = String(firstTouch.landingUrl).slice(0, 300);
    if (lastTouch?.utm?.source && lastTouch.utm.source !== firstTouch?.utm?.source) {
      // Only show last-touch source if it differs — otherwise it's noise.
      enriched['Attribution (last touch source)'] = String(lastTouch.utm.source);
    }
    return enriched;
  } catch {
    // Enrichment is purely additive — never block the original report.
    return baseContext;
  }
}

// In-memory dedup cache: fingerprint -> timestamp of last reported occurrence
const dedupCache = new Map<string, number>();
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/** Exposed only for unit tests — clears the dedup cache between test cases. */
export function __clearDedupCacheForTests(): void {
  dedupCache.clear();
}

/**
 * Normalize an error message for dedup fingerprinting.
 * Strips UUIDs and takes only the first line to group structurally identical errors.
 */
function normalizeError(message: string): string {
  return message
    .split('\n')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .trim();
}

/**
 * Detect whether this oncall report originated from a cron job. Cron-fired
 * tasks get routed to Backlog (not the current sprint) and get a per-user
 * title so identical-operation alerts stay visually distinct on the board.
 *
 * Heuristics:
 *   - `context.Source === 'cron'` (set by all stuck/abandoned cron paths)
 *   - operation contains `stuck` or `abandoned` substring (defense-in-depth
 *     for any future cron without the explicit Source tag)
 */
function isCronSource(operation: string, context?: Record<string, any>): boolean {
  if (context && typeof context === 'object') {
    const src = (context as any).Source;
    if (typeof src === 'string' && src.toLowerCase() === 'cron') return true;
  }
  const op = (operation || '').toLowerCase();
  if (op.includes('stuck') || op.includes('abandoned')) return true;
  return false;
}

/**
 * Build a per-user title for cron-fired stuck/abandoned alerts so each user
 * gets a distinguishable Notion task instead of 100 lookalikes.
 *
 * Format:
 *   "Onboarding stuck: {email} @ {stage} ({hoursStuck}h)"
 *   "Onboarding abandoned: {email} @ {stage} ({hoursStuck}h)"
 *
 * Falls back to userId or "<unknown user>" when the email is missing, and
 * to the raw operation tail when the stage / hours fields aren't in context.
 */
function buildCronTitle(
  operation: string,
  userId: string | undefined,
  context: Record<string, any> | undefined,
): string {
  const ctx = context ?? {};
  // Prefer enriched email (set by enrichOnboardingContext), fall back to
  // userId. Both are best-effort — if neither is present we still build
  // something useful from the operation tag.
  const identifier =
    (typeof ctx['User Email'] === 'string' && ctx['User Email']) ||
    (typeof userId === 'string' && userId) ||
    '<unknown user>';
  const stage =
    (typeof ctx.Stage === 'string' && ctx.Stage) ||
    (typeof ctx['Onboarding Stage'] === 'string' && ctx['Onboarding Stage']) ||
    'unknown';
  const hoursRaw = ctx['Hours Since Last Event'];
  let hoursLabel = '?h';
  if (typeof hoursRaw === 'string' || typeof hoursRaw === 'number') {
    const n = Number(hoursRaw);
    if (Number.isFinite(n)) hoursLabel = `${n.toFixed(1)}h`;
  }

  // Variant suffix — `onboarding:stuck` / `onboarding:abandoned` / etc.
  let variant = 'stuck';
  const lowerOp = (operation || '').toLowerCase();
  if (lowerOp.includes('abandon')) variant = 'abandoned';
  return `Onboarding ${variant}: ${identifier} @ ${stage} (${hoursLabel})`;
}

/**
 * Report a UI-facing error to Notion as an oncall issue.
 * Deduplicates by (operation + normalized error message) within a 30-minute window
 * to avoid flooding oncall when users repeatedly trigger the same failure.
 */
export async function reportUIError(params: UIErrorReport): Promise<void> {
  const { operation, errorMessage, userId, context } = params;

  const fingerprint = `${operation}:${normalizeError(errorMessage)}`;
  const now = Date.now();
  const lastReported = dedupCache.get(fingerprint);

  if (lastReported !== undefined && now - lastReported < DEDUP_WINDOW_MS) {
    console.log(`[errorReporter] Deduped (${Math.round((now - lastReported) / 1000)}s ago): ${fingerprint}`);
    return;
  }

  dedupCache.set(fingerprint, now);

  let fullContext: Record<string, any> = {
    Operation: operation,
    ...(userId ? { 'User ID': userId } : {}),
    Error: errorMessage,
    ...context,
  };

  // Enrich onboarding-tagged errors with full investigation context — see
  // enrichOnboardingContext doc above. The Notion task becomes the
  // investigation surface; the responder rarely needs to leave it.
  if (userId && operation.startsWith('onboarding:')) {
    fullContext = await enrichOnboardingContext(userId, fullContext);
  }

  // Cron-fired alerts get (a) a per-user title so the sprint board doesn't
  // collapse them visually, and (b) backlog routing so they don't pollute
  // the current sprint. Manual oncall reports keep the legacy "UI Error: …"
  // title and the auto-promote behavior.
  const cron = isCronSource(operation, fullContext);
  const subject = cron
    ? buildCronTitle(operation, userId, fullContext)
    : `UI Error: ${operation}`;

  try {
    const { createOncallItem } = await import('../services/notionService');
    const { notionUrl } = await createOncallItem({
      title: subject,
      description: errorMessage,
      additionalTags: ['UI Error'],
      context: fullContext,
      routeToBacklog: cron,
    });
    // Pass notionUrl so sendOncallAlert sends the slim email (skips re-creating Notion item)
    await emailService.sendOncallAlert(subject, errorMessage, fullContext, notionUrl);
  } catch (err) {
    // Notion creation failed — fall back to full email; catch any email failure too
    console.error('[errorReporter] Notion creation failed, falling back to email:', err);
    try {
      await emailService.sendOncallAlert(subject, errorMessage, fullContext);
    } catch (emailErr) {
      console.error('[errorReporter] Email fallback also failed:', emailErr);
    }
  }
}
