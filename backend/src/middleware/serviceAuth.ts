import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { getSecret } from '../utils/secretsManager';

/**
 * Shared-secret authentication for internal service-to-service endpoints.
 *
 * POST /api/agent-mode/run-scheduled-chats is called by the Python
 * agent-engine (agent-engine/task_monitor.py), which has no user JWT. Auth is
 * a shared secret sent in the `x-service-secret` header and compared in
 * constant time (same helper pattern as routes/apolloWebhook.ts).
 *
 * Secret resolution precedence (ENG-359):
 *   (a) process.env.SCHEDULED_CHATS_SERVICE_SECRET — kept as an override for
 *       tests / local dev and as an emergency lever. Resolved synchronously.
 *   (b) AWS Secrets Manager secret `prod/AgentWeb/ScheduledChatsServiceSecret`,
 *       JSON key `SCHEDULED_CHATS_SERVICE_SECRET`. Cached in-process for
 *       SM_CACHE_TTL_MS so we don't call SM on every request (the agent-engine
 *       polls this endpoint every ~5s) and re-read after the TTL.
 *
 * Why SM instead of an EB env var (Harsha's "keep it in SM, not EB env"):
 *   the secret can be created / rotated / deleted without an EB config change
 *   or redeploy, and deleting the SM secret rolls enforcement back to fail-open
 *   within one TTL window (~5 min) — a no-redeploy rollback lever.
 *
 * Rollout safety (ENG-347): enforcement is gated on a secret being resolvable.
 * If NEITHER the env var NOR the SM secret resolves, requests pass through
 * unauthenticated (pre-ENG-347 behavior) and a warning is logged once per
 * process. This keeps the deploy additive: the backend auto-deploys daily at
 * 02:00 UTC while the agent-engine is manually deployed on a GCP VM — a hard
 * requirement would break every customer's scheduled chats at the next backend
 * deploy until someone touched the VM. On any SM read error we also fail open
 * (never hard-fail the endpoint) so a transient Secrets Manager blip cannot
 * 401 the entire scheduled-chats system.
 */

export const SERVICE_SECRET_HEADER = 'x-service-secret';
export const SCHEDULED_CHATS_SERVICE_SECRET_ENV = 'SCHEDULED_CHATS_SERVICE_SECRET';

/**
 * Secrets Manager secret id + JSON key holding the shared secret when the env
 * override is unset. The backend EB instance role already has SM read for
 * `prod/AgentWeb/*`.
 */
export const SCHEDULED_CHATS_SERVICE_SECRET_SM_ID = 'prod/AgentWeb/ScheduledChatsServiceSecret';
export const SCHEDULED_CHATS_SERVICE_SECRET_SM_KEY = SCHEDULED_CHATS_SERVICE_SECRET_ENV;

/**
 * How long a Secrets Manager read is cached in-process. Short by design: keeps
 * SM out of the per-request hot path (engine polls every ~5s) while bounding
 * how long a rotation or deletion takes to take effect (~5 min).
 */
export const SM_CACHE_TTL_MS = 300_000; // 300s

/**
 * Constant-time secret check. Returns false for length mismatches without
 * leaking that information through compare timing — the compare still runs
 * (against `expected` twice) so both paths cost roughly the same.
 */
function safeSecretEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Spend ~the same time as the success path — the result is discarded.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// The agent-engine polls run-scheduled-chats continuously; warn once per
// process, not once per request, so the rollout mode doesn't flood logs.
let warnedSecretUnset = false;

function warnScheduledChatsSecretUnset() {
  if (warnedSecretUnset) return;
  console.warn(
    `[serviceAuth] No shared secret resolved for run-scheduled-chats — neither ` +
      `the ${SCHEDULED_CHATS_SERVICE_SECRET_ENV} env var nor Secrets Manager ` +
      `(${SCHEDULED_CHATS_SERVICE_SECRET_SM_ID}) provided one. The endpoint is ` +
      `accepting unauthenticated requests (pre-ENG-347 rollout mode). Create the ` +
      `SM secret (JSON key ${SCHEDULED_CHATS_SERVICE_SECRET_SM_KEY}) after the ` +
      `agent-engine has the same value to enforce.`
  );
  warnedSecretUnset = true;
}

// In-process cache of the Secrets-Manager-resolved secret. `value: undefined`
// is a real cached outcome ("SM had no usable secret") — distinct from
// `smCache === null` ("never fetched"). We serve the cached value while it is
// fresh and re-read once it ages past SM_CACHE_TTL_MS.
let smCache: { value: string | undefined; fetchedAt: number } | null = null;
// De-dupes concurrent SM reads so a burst of requests triggers at most one
// getSecret call per TTL window.
let smInFlight: Promise<string | undefined> | null = null;

/**
 * Pull the shared secret out of the SM payload. The secret is stored as JSON
 * `{"SCHEDULED_CHATS_SERVICE_SECRET":"<value>"}`. Anything else (empty,
 * non-JSON, missing / blank key) resolves to undefined → fail-open.
 */
function extractSecretFromPayload(raw: string | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const value = (parsed as Record<string, unknown>)[SCHEDULED_CHATS_SERVICE_SECRET_SM_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the expected secret from Secrets Manager with a short TTL cache.
 * Never throws: on any read / parse failure it logs and resolves to undefined
 * so the caller fails open.
 */
async function resolveSecretFromSecretsManager(): Promise<string | undefined> {
  const now = Date.now();
  if (smCache && now - smCache.fetchedAt < SM_CACHE_TTL_MS) {
    return smCache.value;
  }
  if (smInFlight) {
    return smInFlight;
  }
  smInFlight = (async () => {
    try {
      const raw = await getSecret(SCHEDULED_CHATS_SERVICE_SECRET_SM_ID);
      const value = extractSecretFromPayload(raw);
      smCache = { value, fetchedAt: Date.now() };
      return value;
    } catch {
      // Fail open on SM errors — a Secrets Manager blip must not 401 the entire
      // scheduled-chats system. getSecret() already logs the underlying AWS
      // cause, and the once-per-process warn (when no secret resolves) records
      // the fail-open impact, so we don't emit a duplicate error line here.
      // Cache the miss so we don't hammer SM.
      smCache = { value: undefined, fetchedAt: Date.now() };
      return undefined;
    } finally {
      smInFlight = null;
    }
  })();
  return smInFlight;
}

/**
 * Enforce the shared secret once an expected value has been resolved. Missing
 * or mismatched header → 401 (constant-time compare); match → next().
 */
function enforceServiceSecret(
  req: Request,
  res: Response,
  next: NextFunction,
  expected: string
) {
  const provided = req.header(SERVICE_SECRET_HEADER);
  if (!provided || !safeSecretEquals(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

async function resolveFromSecretsManagerThenEnforce(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // resolveSecretFromSecretsManager never rejects (it swallows every read /
  // parse error and resolves undefined), so a missing/failed secret can only
  // ever fail open here — never bubble a 500.
  const expected = await resolveSecretFromSecretsManager();

  if (!expected) {
    warnScheduledChatsSecretUnset();
    return next();
  }
  return enforceServiceSecret(req, res, next, expected);
}

export function requireScheduledChatsServiceSecret(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // (a) Env override wins and resolves synchronously — preserves the original
  //     behavior exactly (tests / local set the env var).
  const fromEnv = process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV];
  if (fromEnv) {
    return enforceServiceSecret(req, res, next, fromEnv);
  }

  // (b) No env override — resolve from Secrets Manager (cached, async).
  //     resolveFromSecretsManagerThenEnforce never rejects today, but Express 4
  //     does not await a middleware's returned promise nor forward its
  //     rejections — so .catch(next) guarantees any future regression surfaces
  //     as a normal Express error instead of an unhandled rejection / hung
  //     request.
  return resolveFromSecretsManagerThenEnforce(req, res, next).catch(next);
}

/**
 * Test-only: reset the in-process SM cache + warn flag so cache-behavior tests
 * are order-independent. Not referenced by any production code path.
 */
export function __resetScheduledChatsSecretCacheForTests() {
  smCache = null;
  smInFlight = null;
  warnedSecretUnset = false;
}
