export interface UIErrorReport {
  operation: string;
  errorMessage: string;
  userId?: string;
  context?: Record<string, any>;
}

/**
 * Enrich the log context for onboarding-tagged errors so the structured log
 * line carries enough state to investigate without leaving the logs:
 *   - User identity
 *   - Current onboardingStage
 *   - Per-step status table (icp / competitor / creativeDir / adImage / adCopy)
 *   - Last 20 onboarding events
 *   - A delegate-as-user URL for one-click manual UI inspection
 *
 * Best-effort and silent on failure — the base reportUIError flow must never
 * be blocked by an enrichment-fetch hiccup.
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
 * Report a UI-facing error as a structured log line.
 *
 * Previously this function also created a Notion oncall task and emailed
 * oncall — both were removed 2026-05-07 because the Notion side was flooding
 * the sprint board and the email side was burning bandwidth on signal we
 * rarely acted on. Logs are sufficient for post-hoc investigation; if we
 * need a louder alert in the future, wire it in selectively at the call site.
 *
 * Deduplicates by (operation + normalized error message) within a 30-minute
 * window so a single failing user can't spam the log either.
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

  const isOnboarding = operation.startsWith('onboarding:');
  const subject = isOnboarding ? `Onboarding Error: ${operation}` : `UI Error: ${operation}`;
  let fullContext: Record<string, any> = {
    Operation: operation,
    ...(userId ? { 'User ID': userId } : {}),
    Error: errorMessage,
    ...context,
  };

  if (userId && isOnboarding) {
    fullContext = await enrichOnboardingContext(userId, fullContext);
  }

  console.error('[uiError]', JSON.stringify({ subject, errorMessage, context: fullContext }));
}
