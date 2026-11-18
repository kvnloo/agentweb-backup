/**
 * Who may an agent tool read, with the server's own credentials, from our file bucket?
 *
 * ENG-2988 closed this on the REST file routes (`controllers/filesController.ts`): a key named by the caller used to be
 * signed, read or overwritten for any signed-in user. The agent tools that reach the bucket through the SDK were not
 * covered, so a tool argument naming a key (or, for `perform_data_analysis`, a whole `s3://<bucket>/<key>`) was read
 * with the backend's credentials whoever the caller was. Those credentials can read every bucket in the account.
 *
 * This module is the one place a tool asks the question, using the same rule as the REST routes
 * (`decideStorageAccess`), so a tool does not grow its own ownership check.
 *
 * Only use it where the SERVER reads with ITS OWN credentials (SDK reads, presigning, writes). A plain HTTP GET of a
 * public object uses no server privilege and needs no check here; that is a separate (SSRF) concern.
 *
 * LOAD IT LAZILY: `await import('./toolStorageAccess')` inside the tool function, never a static import. The policy
 * reaches the database layer and `chatbotService`, which tool modules such as `searchResearch.ts` must not load when
 * they are merely required (their `*.moduleIsolation.test.ts` enforces it).
 */
import {
  canonicalStorageKey,
  decideStorageAccess,
  StorageAccessLookups,
} from '../../services/storageAccessPolicy';

/** One answer for "not there", "not yours" and "not placeable", so a refusal cannot be used to probe for keys. */
export const TOOL_FILE_REFUSAL_MESSAGE = 'File not found or you do not have access to it.';

/** The access check itself could not run (a lookup failed): not a verdict on the caller, so the model is told to retry. */
export const TOOL_FILE_UNAVAILABLE_MESSAGE = 'Could not check access to the file right now. Please try again in a moment.';

/** `allow`; `refuse` (not ours, not yours, not placeable); `unavailable` (could not decide: retry, never a pass). */
export type ToolFileDecision = 'allow' | 'refuse' | 'unavailable';

/** Same expression as `utils/s3Utils.ts` and `controllers/filesController.ts`, read per call. */
const ourBucket = (): string => process.env.AWS_S3_BUCKET || 'agentweb-user-files';

/** Is `bucket` the bucket this backend stores user files in? Any other bucket is never read on a caller's say-so. */
export function isOurBucket(bucket: string): boolean {
  return typeof bucket === 'string' && bucket === ourBucket();
}

/**
 * May this caller read `rawKey` (a key of OUR bucket, as the caller wrote it) with the server's credentials?
 * Fails closed: no caller, an unusable key, a shape the policy cannot place, or a failed lookup never answer `allow`.
 * Pass one `lookups` per tool call so a batch of keys from the same session or owner costs one read.
 */
export async function checkOurBucketKeyRead(
  tool: string,
  userId: string | undefined | null,
  rawKey: string,
  lookups: StorageAccessLookups = new StorageAccessLookups(),
): Promise<ToolFileDecision> {
  const key = canonicalStorageKey(rawKey, 'key');
  // The tool reads `rawKey`, so the key that is checked must be that very string: a key the policy would rewrite (for example
  // one with a leading `s3:`) is refused, not checked as something else and then read as something different.
  if (!key || key !== rawKey || typeof userId !== 'string' || userId.trim() === '') return 'refuse';
  try {
    // A tool runs in-process for its caller: it never carries admin power (same as the REST routes' delegated and self calls).
    const decision = await decideStorageAccess({ userId, isRealAdmin: false }, key, 'read', lookups);
    if (decision.allow) return 'allow';
    // The REST routes answer "try again" for a failed lookup; here a database blip must not read as "the file is gone".
    if (decision.reason === 'lookup_failed') return 'unavailable';
    console.warn(JSON.stringify({ event: 'storage_access_denied', route: `tool:${tool}`, access: 'read', shape: decision.shape, reason: decision.reason, userId }));
    return 'refuse';
  } catch (error: any) {
    // Anything unexpected while deciding is never a pass.
    console.error(JSON.stringify({ event: 'storage_access_check_failed', route: `tool:${tool}`, error: String(error?.message || error).slice(0, 200) }));
    return 'unavailable';
  }
}

/** What a tool holds for one call: the caller, one lookup cache, and the two questions it needs to ask. */
export function createToolFileAccess(tool: string, userId: string | undefined | null) {
  const lookups = new StorageAccessLookups();
  return {
    isOurBucket,
    check: (rawKey: string): Promise<ToolFileDecision> => checkOurBucketKeyRead(tool, userId, rawKey, lookups),
  };
}
