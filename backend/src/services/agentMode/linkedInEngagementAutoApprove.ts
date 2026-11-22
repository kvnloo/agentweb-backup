/**
 * ENG-707: class-based auto-approve for low-judgment LinkedIn engagement writes.
 *
 * Pure decision module (no I/O). Callers supply the user's per-class settings,
 * the current per-class daily usage, and the clock; this module decides whether
 * a single write may skip the per-item confirmation gate and, if so, how long to
 * wait before executing it (human-like jitter).
 *
 * Safety contract:
 *  - The whole feature is behind LINKEDIN_SUPPORT_AUTO_APPROVE_ENABLED, which
 *    ships OFF. Flag off => every write keeps the gate (current behaviour).
 *  - Every class defaults to autoApprove=false; only an explicit opt-in counts.
 *  - Only SUPPORT classes (likes and short support comments) are eligible.
 *    SME comments, connection requests, DMs/InMail, reposts and posts ALWAYS
 *    keep the gate, regardless of settings.
 *  - Each class has a hard server-side daily ceiling; a user-configured cap is
 *    clamped to it, and an exhausted cap falls back to the gate (never errors,
 *    never executes silently).
 *
 * Turning the flag on for a real account is a LinkedIn account-safety posture
 * decision owned by Harsha (see ENG-707 comments).
 */

export type EngagementActionClass = 'support_like' | 'support_comment';

export const AUTO_APPROVE_ELIGIBLE_CLASSES: ReadonlySet<EngagementActionClass> = new Set([
  'support_like',
  'support_comment',
]);

/** Hard per-class daily ceilings. A user cap above this is clamped down. */
export const HARD_DAILY_CEILING: Readonly<Record<EngagementActionClass, number>> = {
  support_like: 40,
  support_comment: 15,
};

/** Conservative default when the user opted in but configured no cap. */
export const DEFAULT_DAILY_CAP: Readonly<Record<EngagementActionClass, number>> = {
  support_like: 20,
  support_comment: 5,
};

/** Max characters for a comment to still qualify as a low-judgment SUPPORT comment. */
export const SUPPORT_COMMENT_MAX_CHARS = 120;

export const JITTER_MIN_MS = 45_000;
export const JITTER_MAX_MS = 240_000;

export interface ClassSetting {
  autoApprove?: boolean;
  dailyCap?: number | null;
}

export type AutoApproveSettings = Partial<Record<EngagementActionClass, ClassSetting>>;

export interface EngagementWrite {
  /** e.g. 'react' | 'comment' | 'send-invite' | 'send-message' | 'repost' | 'post'. */
  action: string;
  /** Caller's tier tag for the item; only 'support' is ever eligible. */
  tier?: string | null;
  commentText?: string | null;
  /** Nested replies are conversations, not drive-by support — always gated. */
  parentCommentUrn?: string | null;
}

export type AutoApproveDecision =
  | { autoApprove: true; actionClass: EngagementActionClass; delayMs: number; remainingAfter: number }
  | { autoApprove: false; reason: 'flag_off' | 'not_eligible' | 'not_opted_in' | 'cap_exhausted'; actionClass?: EngagementActionClass };

export function isAutoApproveFlagEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LINKEDIN_SUPPORT_AUTO_APPROVE_ENABLED === 'true';
}

/** Classify a write; null = never eligible (SME comment, connect, DM, repost, post, ...). */
export function classifyEngagementWrite(write: EngagementWrite): EngagementActionClass | null {
  if (String(write.tier ?? '').trim().toLowerCase() !== 'support') return null;
  const action = String(write.action ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (action === 'react' || action === 'like') return 'support_like';
  if (action === 'comment') {
    if (write.parentCommentUrn) return null;
    const text = String(write.commentText ?? '').trim();
    if (!text || text.length > SUPPORT_COMMENT_MAX_CHARS) return null;
    return 'support_comment';
  }
  return null;
}

export function effectiveDailyCap(actionClass: EngagementActionClass, setting: ClassSetting | undefined): number {
  const hard = HARD_DAILY_CEILING[actionClass];
  const raw = setting?.dailyCap;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return Math.min(DEFAULT_DAILY_CAP[actionClass], hard);
  return Math.max(0, Math.min(Math.floor(raw), hard));
}

export function jitterDelayMs(random: () => number = Math.random): number {
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(JITTER_MIN_MS + r * (JITTER_MAX_MS - JITTER_MIN_MS));
}

export interface DecideOptions {
  env?: NodeJS.ProcessEnv;
  random?: () => number;
}

/**
 * @param usedToday per-class count of auto-approved writes already executed in
 *   the current day window (the caller owns durable counting).
 */
export function decideAutoApprove(
  write: EngagementWrite,
  settings: AutoApproveSettings | null | undefined,
  usedToday: Partial<Record<EngagementActionClass, number>>,
  options: DecideOptions = {},
): AutoApproveDecision {
  if (!isAutoApproveFlagEnabled(options.env)) return { autoApprove: false, reason: 'flag_off' };
  const actionClass = classifyEngagementWrite(write);
  if (!actionClass || !AUTO_APPROVE_ELIGIBLE_CLASSES.has(actionClass)) {
    return { autoApprove: false, reason: 'not_eligible' };
  }
  const setting = settings?.[actionClass];
  if (setting?.autoApprove !== true) return { autoApprove: false, reason: 'not_opted_in', actionClass };
  const cap = effectiveDailyCap(actionClass, setting);
  const rawUsed = usedToday[actionClass] ?? 0;
  // Fail closed: unknown/corrupt usage (NaN, Infinity) counts as cap exhausted.
  const used = Number.isFinite(rawUsed) ? Math.max(0, Math.floor(rawUsed)) : cap;
  if (used >= cap) return { autoApprove: false, reason: 'cap_exhausted', actionClass };
  return { autoApprove: true, actionClass, delayMs: jitterDelayMs(options.random), remainingAfter: cap - used - 1 };
}
