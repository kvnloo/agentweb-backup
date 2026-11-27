/**
 * ENG-2103 (F2) — shared, stateless Google Drive query-escaping and
 * error-classification helpers.
 *
 * Extracted verbatim from `AgentModeService`'s module-level `escapeDriveQueryValue`
 * function and its `private static driveErrorReasons/isDriveThrottle/driveErrorCode/
 * driveThrottleRefusal` methods. All five are pure functions of their arguments.
 *
 * Shared by three call sites, only one of which is moving in this pass:
 * `emma/impl/googleDrive.ts` (listGoogleDriveFolder, createGoogleDriveFolder,
 * searchGoogleDrive — this extraction), the knowledge-base cluster
 * (searchKnowledgeBase, listKnowledgeBaseFiles, readKnowledgeBaseFiles,
 * materializeKnowledgeBaseAsset, via `AgentModeService.prototype.classifyDriveError`),
 * and the not-yet-extracted Google Docs/Sheets cluster (createGoogleDoc,
 * updateGoogleDoc, createGoogleSheet, updateGoogleSheet). `AgentModeService`'s
 * own copies now delegate here so all three share one implementation.
 */

/**
 * Escape a value for interpolation into a Drive API `q` query string.
 *
 * An unescaped single quote or backslash lets a crafted value terminate the
 * quoted literal early and manipulate the query — the same class of bug as SQL
 * injection, scoped to Drive's query grammar. Backslash MUST be replaced first:
 * doing the quote first would then double-escape the backslashes it just
 * introduced.
 */
export function escapeDriveQueryValue(value: string): string {
  // A non-string reaching here used to throw on `.replace`; `String(...)` would instead embed the
  // literal `undefined` and run a confidently wrong query. Refuse loudly rather than search for a
  // file named "undefined" and report it missing.
  if (typeof value !== 'string') {
    throw new Error(`Drive query value must be a string, received ${value === null ? 'null' : typeof value}`);
  }
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Drive answers 403 for THROTTLING as well as for permission denial.
 *
 * `userRateLimitExceeded`, `rateLimitExceeded`, `dailyLimitExceeded` and
 * `sharingRateLimitExceeded` all arrive as HTTP 403 with the real cause in
 * `error.errors[].reason`. Reads both shapes googleapis surfaces: `err.errors`
 * on the GaxiosError itself, and the raw `err.response.data.error.errors` when
 * the error crossed a module boundary un-normalised.
 */
export function driveErrorReasons(err: any): string[] {
  const raw = [
    ...(Array.isArray(err?.errors) ? err.errors : []),
    ...(Array.isArray(err?.response?.data?.error?.errors) ? err.response.data.error.errors : []),
  ];
  return raw.map((e: any) => String(e?.reason ?? '')).filter(Boolean);
}

/**
 * ENG-2840: a Drive download requested as a stream (`responseType: 'stream'`) gets its error body back as TEXT (gaxios reads it into a
 * string), and google-auth-library only unpacks an object body, so `err.errors`, `err.code` and Google's own message were lost: a throttle
 * read as a plain 403 and the caller saw raw JSON. This gives such an error the shape a buffered request's error has. Anything else is
 * returned unchanged.
 */
export function normalizeStreamedDriveError(err: any): any {
  const data = err?.response?.data;
  if (typeof data !== 'string') return err;
  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return err;
  }
  const e = parsed?.error;
  if (!e || typeof e !== 'object') return err;
  err.response.data = parsed;
  if (!Array.isArray(err.errors) && Array.isArray(e.errors)) err.errors = e.errors;
  if (typeof e.code === 'number') err.code = e.code;
  if (typeof e.message === 'string' && e.message) err.message = e.message;
  return err;
}

/** True when a 401/403 is really a quota/throttle answer, not an access decision. */
export function isDriveThrottle(err: any): boolean {
  return driveErrorReasons(err).some(r => /ratelimitexceeded|dailylimitexceeded/i.test(r));
}

/**
 * The HTTP status of a Drive error, as a NUMBER.
 *
 * gaxios surfaces `code` as a string in some shapes (notably when the response body carries no
 * `error.code`), and every `code === 403` comparison in this file is strict — so a string
 * `'403'` silently matched nothing and fell through to the generic "temporary Drive error"
 * branch. Coercing once, in one place, is what stops each new handler from inheriting that.
 */
export function driveErrorCode(err: any): number | undefined {
  const raw = err?.code ?? err?.status;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The refusal a THROTTLED Drive call should return, or null when it is not a throttle.
 *
 * Drive answers 403 for quota exhaustion as well as for permission denial, and every handler
 * in this file read the status alone — so a rate-limited user was told their connection had
 * expired, or that Emma lacks access to a folder she can see, or that a Sheet "was not created
 * by Emma". All false, and all pointing at a fix that cannot work. One sentence, one place, so
 * the next handler cannot reintroduce it.
 */
export function driveThrottleRefusal(err: any): { success: false; message: string } | null {
  const code = driveErrorCode(err);
  if ((code !== 403 && code !== 401) || !isDriveThrottle(err)) return null;
  return {
    success: false,
    message:
      'Google Drive is rate-limiting this account right now — this is a temporary quota answer, '
      + 'NOT a permissions problem, so nothing needs to be shared or reconnected. Wait a minute and retry.',
  };
}
