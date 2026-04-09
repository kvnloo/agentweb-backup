import { emailService } from '../services/emailService';

export interface UIErrorReport {
  operation: string;
  errorMessage: string;
  userId?: string;
  context?: Record<string, any>;
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

  const subject = `UI Error: ${operation}`;
  const fullContext: Record<string, any> = {
    Operation: operation,
    ...(userId ? { 'User ID': userId } : {}),
    Error: errorMessage,
    ...context,
  };

  try {
    const { createOncallItem } = await import('../services/notionService');
    const { notionUrl } = await createOncallItem({
      title: subject,
      description: errorMessage,
      additionalTags: ['UI Error'],
      context: fullContext,
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
