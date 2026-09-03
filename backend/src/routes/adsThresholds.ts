/**
 * ENG-918 — per-account ads-threshold config API.
 *
 * Four routes over the store in `services/adsThresholds*`: read the resolved set, read one
 * parameter with its history, set a value, revert to default.
 *
 * ─── Authorisation ──────────────────────────────────────────────────────────────────────────
 *
 * Every route is scoped to an AD ACCOUNT, and the caller must own it. Ownership is re-derived
 * from the caller's own `connected_accounts` on each request via `getConnectedMetaAccountsList`
 * — never taken from the path, and never inferred from the value having been written before.
 * These thresholds govern when a live campaign is flagged (and, once ENG-87 consumes them, what
 * gets alerted on), so a caller who could write another tenant's parameters could suppress that
 * tenant's alerting.
 *
 * ⚠ **Non-Meta platforms are REFUSED rather than allowed through.** The store is keyed
 * platform-generally on purpose, but `getConnectedMetaAccountsList` only answers ownership for
 * Meta — there is no equivalent resolver wired for Google Ads or LinkedIn yet. Accepting
 * `google_ads` here would mean serving a platform whose ownership we cannot actually check,
 * which is the fail-OPEN direction. The refusal is what keeps the schema's generality from
 * silently becoming an authorisation hole ahead of the resolver that closes it.
 */

import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { userDb } from '../services/db';
import { cleanAccountId, getConnectedMetaAccountsList } from '../services/metaAccountCredentials';
import {
  THRESHOLD_REGISTRY,
  applyThresholdWrite,
  buildThresholdRevert,
  evaluateThresholdWrite,
  getThresholdDefinition,
  resolveThresholds,
  type AdsPlatform,
} from '../services/adsThresholds';
import {
  ThresholdConflictError,
  getThreshold,
  getThresholdsForAccount,
  putThreshold,
} from '../services/adsThresholdsDb';

const router = express.Router();

/** Platforms the store accepts. Only `meta` has an ownership resolver today — see the header. */
const OWNERSHIP_RESOLVABLE_PLATFORMS: readonly AdsPlatform[] = ['meta'];

/**
 * Refusal reasons that describe the REQUEST rather than the system.
 *
 * Mapped to 4xx so a caller can tell "you asked for something impossible" from "we could not do
 * it". `learned_would_override_user` and `revert_cooldown` are deliberately 409 rather than 400:
 * the request is well-formed and would be valid against different state, which is exactly what a
 * conflict is.
 */
const REFUSAL_STATUS: Record<string, number> = {
  unknown_parameter: 400,
  not_finite: 400,
  out_of_bounds: 400,
  insufficient_sample: 400,
  no_change: 409,
  learned_would_override_user: 409,
  revert_cooldown: 409,
};

async function resolveOwnedAccount(
  userId: string,
  platform: string,
  accountId: string,
): Promise<{ ok: true; accountId: string; platform: AdsPlatform } | { ok: false; status: number; error: string }> {
  if (!OWNERSHIP_RESOLVABLE_PLATFORMS.includes(platform as AdsPlatform)) {
    return {
      ok: false,
      status: 400,
      error: `platform '${platform}' is not supported yet — only 'meta' has a connected-account ownership check`,
    };
  }

  const user = await userDb.getUserById(userId);
  if (!user) return { ok: false, status: 404, error: 'User not found' };

  const cleaned = cleanAccountId(accountId);
  const owned = getConnectedMetaAccountsList(user).some((acc: any) => acc.accountId === cleaned);
  if (!owned) {
    // Deliberately does NOT say whether the account exists elsewhere. A refusal that
    // distinguishes "not yours" from "no such account" is an existence oracle for anyone
    // enumerating ids — the same disclosure ENG-1476's cross-account guard had to close.
    return { ok: false, status: 403, error: 'Ad account is not one of your connected accounts' };
  }

  return { ok: true, accountId: cleaned, platform: platform as AdsPlatform };
}

/**
 * GET /api/ads-thresholds/:platform/:accountId
 *
 * The resolved set — every registry parameter with its effective value and where that value came
 * from. Returns the whole registry rather than only what is stored, so a consumer never has to
 * carry its own copy of the defaults.
 */
router.get('/:platform/:accountId', authenticateToken, async (req: any, res) => {
  try {
    const owned = await resolveOwnedAccount(req.user.userId, req.params.platform, req.params.accountId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

    const stored = await getThresholdsForAccount(owned.platform, owned.accountId);
    const resolved = resolveThresholds(stored);

    res.json({
      platform: owned.platform,
      accountId: owned.accountId,
      parameters: Object.entries(resolved).map(([key, value]) => {
        const definition = THRESHOLD_REGISTRY[key];
        return {
          key,
          value: value.value,
          source: value.source,
          defaultValue: definition.defaultValue,
          min: definition.min,
          max: definition.max,
          unit: definition.unit,
          description: definition.description,
        };
      }),
    });
  } catch (error: any) {
    console.error('[ENG-918] resolve parameters failed:', error);
    res.status(500).json({ error: 'Failed to read parameters' });
  }
});

/**
 * GET /api/ads-thresholds/:platform/:accountId/:paramKey
 *
 * One parameter with its full revision history — the audit view. A parameter that has never been
 * written returns its registry default with an empty history rather than 404: "never changed" is
 * a real answer to "what is this set to", and a 404 would read as "no such parameter".
 */
router.get('/:platform/:accountId/:paramKey', authenticateToken, async (req: any, res) => {
  try {
    const owned = await resolveOwnedAccount(req.user.userId, req.params.platform, req.params.accountId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

    const definition = getThresholdDefinition(req.params.paramKey);
    if (!definition) return res.status(404).json({ error: `Unknown parameter '${req.params.paramKey}'` });

    const stored = await getThreshold(owned.platform, owned.accountId, req.params.paramKey);

    res.json({
      key: definition.key,
      value: stored ? stored.currentValue : definition.defaultValue,
      source: stored ? stored.source : 'default',
      defaultValue: definition.defaultValue,
      min: definition.min,
      max: definition.max,
      unit: definition.unit,
      description: definition.description,
      learnedCooldownUntil: stored?.learnedCooldownUntil ?? null,
      revisions: stored?.revisions ?? [],
    });
  } catch (error: any) {
    console.error('[ENG-918] read parameter failed:', error);
    res.status(500).json({ error: 'Failed to read parameter' });
  }
});

/**
 * PUT /api/ads-thresholds/:platform/:accountId/:paramKey
 *
 * Set a value as a human.
 *
 * ⚠ `source` is NOT accepted from the body. Every write through this route is `user`, because
 * the caller is a person — letting a client declare `source: 'learned'` would hand it the one
 * thing the precedence rule exists to restrict, and letting it declare `sampleSize` would let it
 * walk straight through the gate meant for fitted values. A loop writes through the service
 * directly, not through an authenticated HTTP route.
 */
router.put('/:platform/:accountId/:paramKey', authenticateToken, async (req: any, res) => {
  try {
    const owned = await resolveOwnedAccount(req.user.userId, req.params.platform, req.params.accountId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

    const { value, evidence } = req.body ?? {};
    if (typeof value !== 'number') {
      return res.status(400).json({ error: 'value must be a number' });
    }
    if (typeof evidence !== 'string' || !evidence.trim()) {
      // Required rather than defaulted: a stored value whose reason is blank cannot be reviewed
      // later, and the audit trail is most of what this card is for.
      return res.status(400).json({ error: 'evidence is required — state why this value was set' });
    }

    const existing = await getThreshold(owned.platform, owned.accountId, req.params.paramKey);
    const verdict = evaluateThresholdWrite({
      paramKey: req.params.paramKey,
      requestedValue: value,
      source: 'user',
      existing,
    });

    if (!verdict.allowed) {
      return res
        .status(REFUSAL_STATUS[verdict.reason] ?? 400)
        .json({ error: verdict.detail, reason: verdict.reason });
    }

    const next = applyThresholdWrite({
      accountId: owned.accountId,
      platform: owned.platform,
      paramKey: req.params.paramKey,
      value: verdict.value,
      source: 'user',
      evidence: evidence.trim(),
      changedBy: req.user.userId,
      changedAt: new Date().toISOString(),
      existing,
    });

    await putThreshold(next, existing?.updatedAt ?? null);

    res.json({
      key: next.paramKey,
      value: next.currentValue,
      source: next.source,
      updatedAt: next.updatedAt,
    });
  } catch (error: any) {
    if (error instanceof ThresholdConflictError) {
      // 409 with a re-read instruction rather than a silent retry: the losing value was computed
      // against a baseline that no longer holds.
      return res.status(409).json({ error: error.message, reason: 'concurrent_modification' });
    }
    console.error('[ENG-918] write parameter failed:', error);
    res.status(500).json({ error: 'Failed to write parameter' });
  }
});

/**
 * POST /api/ads-thresholds/:platform/:accountId/:paramKey/revert
 *
 * Restore the registry default and start the learned-write cooldown. Idempotent-ish: reverting a
 * parameter that was never written is a no-op 200 rather than an error, because the caller's
 * intent ("put this back to default") is already satisfied.
 */
router.post('/:platform/:accountId/:paramKey/revert', authenticateToken, async (req: any, res) => {
  try {
    const owned = await resolveOwnedAccount(req.user.userId, req.params.platform, req.params.accountId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

    const definition = getThresholdDefinition(req.params.paramKey);
    if (!definition) return res.status(404).json({ error: `Unknown parameter '${req.params.paramKey}'` });

    const existing = await getThreshold(owned.platform, owned.accountId, req.params.paramKey);
    if (!existing) {
      return res.json({
        key: definition.key,
        value: definition.defaultValue,
        source: 'default',
        reverted: false,
      });
    }

    const next = buildThresholdRevert({
      existing,
      changedBy: req.user.userId,
      changedAt: new Date().toISOString(),
      evidence: typeof req.body?.evidence === 'string' && req.body.evidence.trim()
        ? req.body.evidence.trim()
        : undefined,
    });

    await putThreshold(next, existing.updatedAt);

    res.json({
      key: next.paramKey,
      value: next.currentValue,
      source: next.source,
      learnedCooldownUntil: next.learnedCooldownUntil,
      reverted: true,
    });
  } catch (error: any) {
    if (error instanceof ThresholdConflictError) {
      return res.status(409).json({ error: error.message, reason: 'concurrent_modification' });
    }
    console.error('[ENG-918] revert parameter failed:', error);
    res.status(500).json({ error: 'Failed to revert parameter' });
  }
});

export default router;
