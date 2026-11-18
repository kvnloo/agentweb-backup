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

/** The caller may read the file but only its owner may change it (a teammate on an org-shared file): said plainly, not as "not found". */
export const TOOL_FILE_READ_ONLY_MESSAGE =
  'You can read this file but only its owner can change it. To make your own version, create a new file with create_html_file.';

/** `allow`; `refuse` (not yours, not placeable); `read_only` (readable by the caller, writable only by the owner); `unavailable` (retry). */
export type ToolFileWriteDecision = 'allow' | 'refuse' | 'read_only' | 'unavailable';

/**
 * May this caller WRITE the object a tool is about to put in our bucket with the server's credentials?
 *
 * `dir` and `filename` are exactly what the tool will pass to the upload (`uploadFileToS3WithPath`): the directory as given and the file
 * name AFTER the upload's own rewriting (`sanitizeS3Filename`), so the key that is authorised is the key that is written, not something
 * near it. The directory gets the same clean-up the upload applies (surrounding and repeated slashes). Anything the rule cannot place, a
 * blank caller, and a failed lookup never answer `allow`. Only the owner writes; a tool never carries admin power.
 */
export async function checkOurBucketPathWrite(
  tool: string,
  userId: string | undefined | null,
  dir: string,
  filename: string,
  lookups: StorageAccessLookups = new StorageAccessLookups(),
): Promise<ToolFileWriteDecision> {
  const cleanDir = typeof dir === 'string' ? dir.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/') : '';
  const key = canonicalStorageKey(cleanDir ? `${cleanDir}/${filename}` : filename, 'decoded');
  if (!key || typeof userId !== 'string' || userId.trim() === '') return 'refuse';
  // An anonymous visitor's own folder. The rule lets only an admin change files under `users/anon_*` (after sign-up nobody can be shown to own
  // them), but while the caller IS that anonymous visitor (the id is assigned by the server to its session, never taken from a request) the
  // files in its own folder are its own, exactly like a registered user's: the same "the owner's own keys" rule, and the visitor's own page
  // must stay editable by its own session.
  const [top, owner, ...rest] = key.split('/');
  if (top === 'users' && typeof owner === 'string' && owner.startsWith('anon_') && owner === userId && rest.length >= 1) return 'allow';
  try {
    const caller = { userId, isRealAdmin: false };
    const decision = await decideStorageAccess(caller, key, 'write', lookups);
    if (decision.allow) return 'allow';
    if (decision.reason === 'lookup_failed') return 'unavailable';
    console.warn(JSON.stringify({ event: 'storage_access_denied', route: `tool:${tool}`, access: 'write', shape: decision.shape, reason: decision.reason, userId }));
    // Same split as the REST route: a teammate who may open the file is told it is read-only; anyone else gets the generic refusal.
    const read = await decideStorageAccess(caller, key, 'read', lookups);
    return read.allow ? 'read_only' : 'refuse';
  } catch (error: any) {
    console.error(JSON.stringify({ event: 'storage_access_check_failed', route: `tool:${tool}`, error: String(error?.message || error).slice(0, 200) }));
    return 'unavailable';
  }
}

/** What a tool holds for one call: the caller, one lookup cache, and the questions it needs to ask. */
export function createToolFileAccess(tool: string, userId: string | undefined | null) {
  const lookups = new StorageAccessLookups();
  return {
    isOurBucket,
    check: (rawKey: string): Promise<ToolFileDecision> => checkOurBucketKeyRead(tool, userId, rawKey, lookups),
    checkWrite: (dir: string, filename: string): Promise<ToolFileWriteDecision> => checkOurBucketPathWrite(tool, userId, dir, filename, lookups),
  };
}
