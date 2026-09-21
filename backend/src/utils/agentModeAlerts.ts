import { chatbotDb } from '../services/chatbotService';
import { emailService } from '../services/emailService';
import { isEvaluationUser } from '../services/evaluationPolicy';

type AgentModeOncallAlertParams = {
  subject: string;
  message: string;
  sessionId?: string;
  /**
   * The principal the alert is about. Sandbox (eval_) principals never page the
   * on-call (ENG-1907). When omitted, the owner of `sessionId` is looked up instead,
   * so the existing call sites need no change.
   */
  userId?: string;
  context?: Record<string, any>;
  /**
   * Optional dedupe key (e.g. `context_limit:<userId>`). When provided, at most one
   * alert is sent per key per `dedupeWindowMs`; further calls inside the window are
   * suppressed. When omitted, every call fires (backwards compatible).
   */
  dedupeKey?: string;
  /** Dedupe window in ms. Defaults to 10 minutes. Only used when `dedupeKey` is set. */
  dedupeWindowMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now()`. */
  now?: number;
};

const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// In-memory last-alert timestamp per dedupe key. Bounded by the number of distinct
// (user, errorClass) keys in a window — pruned lazily to avoid unbounded growth.
const lastAlertAtByKey = new Map<string, number>();

/**
 * Returns true if an alert for `dedupeKey` should be suppressed (already sent within
 * the window), false if it should fire. Records the firing time when it fires.
 */
function shouldSuppressAlert(dedupeKey: string, windowMs: number, now: number): boolean {
  const last = lastAlertAtByKey.get(dedupeKey);
  if (last !== undefined && now - last < windowMs) {
    return true;
  }
  lastAlertAtByKey.set(dedupeKey, now);
  // Lazy prune: drop entries whose window has fully elapsed so the map can't grow forever.
  if (lastAlertAtByKey.size > 1000) {
    for (const [key, ts] of lastAlertAtByKey) {
      if (now - ts >= windowMs) lastAlertAtByKey.delete(key);
    }
  }
  return false;
}

/** Test-only: clears the dedupe state so each test starts from a clean slate. */
export function __resetAgentModeAlertDedupeForTests(): void {
  lastAlertAtByKey.clear();
}

function hasKey(obj: Record<string, any> | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * ENG-1907: a take-home candidate deliberately breaking Emma in a sandbox account
 * must not page anyone. Keyed on identity, never on a caller flag. Fails open: if
 * the owner cannot be resolved, a real customer's alert still goes out.
 */
async function isSandboxPrincipalAlert(userId?: string, sessionId?: string): Promise<boolean> {
  if (userId) return isEvaluationUser(userId);
  if (!sessionId) return false;
  try {
    // Record-only read (ENG-521): the owner is all this decision needs. getChatSession would
    // paginate the whole message history and can trigger the legacy migration write.
    const session = await chatbotDb.getChatSessionRecord(sessionId);
    return isEvaluationUser(session?.userId);
  } catch {
    return false;
  }
}

/**
 * Returns true if the alert was actually delivered, false if it was
 * suppressed by dedupe. Callers that only care about "did I fire and
 * forget" can ignore the return value (existing behavior, unchanged);
 * a caller that needs to know whether a specific call was the one that
 * fired (e.g. reporting an accurate "was a digest sent" summary) should
 * use it instead of assuming every call that didn't throw delivered.
 */
export async function sendAgentModeOncallAlert(
  params: AgentModeOncallAlertParams
): Promise<boolean> {
  const { subject, message, sessionId, context, dedupeKey, dedupeWindowMs, now, userId } = params;

  // Checked before the dedupe reservation so a suppressed sandbox alert can never
  // consume a real customer's window on a shared key.
  if (await isSandboxPrincipalAlert(userId, sessionId)) {
    console.info('[agentModeAlerts] suppressed oncall alert for sandbox principal');
    return false;
  }

  // Rate-limit/dedupe: when a dedupeKey is supplied, only the first alert per
  // (user, errorClass) window goes out — prevents Notion/oncall flooding on
  // high-concurrency days when the same user repeatedly hits the context limit.
  if (dedupeKey) {
    const windowMs = dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    if (shouldSuppressAlert(dedupeKey, windowMs, now ?? Date.now())) {
      return false;
    }
  }

  let ishareLink = '';
  if (sessionId) {
    try {
      ishareLink = await chatbotDb.createOrReuseInteractiveShare(sessionId);
    } catch (shareError) {
      console.error('Error creating ishare link for oncall alert:', shareError);
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
      ishareLink = `${customerFrontendUrl}/agent-mode/${sessionId}`;
    }
  }

  const baseContext: Record<string, any> = { ...context };
  if (!hasKey(baseContext, 'Session ID')) {
    baseContext['Session ID'] = sessionId || 'unknown';
  }
  if (!hasKey(baseContext, 'iShare Link')) {
    baseContext['iShare Link'] = ishareLink || 'N/A';
  }

  try {
    await emailService.sendOncallAlert(subject, message, baseContext);
  } catch (error) {
    // The dedupe window was reserved before this send was attempted (so a
    // flood of near-simultaneous callers only tries once). If the send
    // itself failed, nothing was actually delivered — release the
    // reservation so the next call in the window can retry, instead of
    // silently suppressing every alert on this key until the window expires.
    if (dedupeKey) {
      lastAlertAtByKey.delete(dedupeKey);
    }
    throw error;
  }
  return true;
}
