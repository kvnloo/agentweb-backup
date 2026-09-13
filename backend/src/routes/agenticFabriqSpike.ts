/**
 * ENG-1685 spike — Gmail-via-Agentic-Fabriq connect flow.
 *
 * Mounted ONLY when the spike flag is enabled (see app.ts) — when it isn't,
 * these routes don't exist at all, which is the strongest form of "no
 * production traffic routes through Fabriq" (AC5): there's no code path to
 * accidentally hit, not just a runtime check inside one.
 *
 * Deliberately has NO portal UI wiring — the acceptance criteria ask for a
 * flag-gated spike with comparison numbers, not a customer-facing feature.
 * Harsha (or whoever is allow-listed) hits /init directly to get the AF
 * consent URL, per the existing multi-account test-matrix convention of
 * exercising a flow directly rather than always building UI first.
 */

import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { isUserEligibleForAgenticFabriqSpike, agenticFabriqClient, getAgenticFabriqAppCredentials } from '../integrations/agenticFabriq';
import { createPendingConnect, consumePendingConnect } from '../integrations/agenticFabriq/pendingConnectStore';

const router = express.Router();

const PROVIDER = 'gmail';

function eligibilityRefusal(res: express.Response): void {
  res.status(403).json({
    error: 'not_eligible_for_spike',
    message: 'This account is not on the ENG-1685 Agentic Fabriq spike allowlist.',
  });
}

// ── GET /init — authenticated: resolves userId from the session ONLY ───────
router.get('/init', authenticateToken, async (req: any, res) => {
  const userId = req.user?.userId;
  if (!userId) {
    // Should be unreachable — authenticateToken already 401s first — but the
    // vendor's own identity contract asks for a hard fail here regardless.
    return res.status(401).json({ error: 'unauthenticated' });
  }
  if (!isUserEligibleForAgenticFabriqSpike(userId)) {
    return eligibilityRefusal(res);
  }

  try {
    const { appId } = await getAgenticFabriqAppCredentials();
    const pendingId = await createPendingConnect(userId, PROVIDER);
    await agenticFabriqClient.ensureExternalUser(appId, userId); // idempotent — 409 tolerated internally
    const initiated = await agenticFabriqClient.initiateOAuth(appId, userId, PROVIDER, { connectionId: pendingId });
    res.json({ success: true, oauth_url: initiated.oauth_url });
  } catch (error: any) {
    console.error('[ENG-1685 spike] /init error', error?.message ?? error);
    res.status(502).json({ error: 'agentic_fabriq_initiate_failed', message: 'Could not start the Agentic Fabriq connect flow.' });
  }
});

// ── GET /callback — AF's redirect target. UNAUTHENTICATED (browser redirect):
//    identity comes ONLY from the pending-connect record created at /init,
//    keyed by our own opaque connection_id — NEVER from external_user_id or
//    any other query param, which the vendor's own docs mark unsigned. ─────
router.get('/callback', async (req, res) => {
  const { status, tool, connection_id: connectionId } = req.query as Record<string, string | undefined>;

  if (!connectionId) {
    return res.status(400).send('Missing connection_id on Agentic Fabriq callback.');
  }

  const userId = await consumePendingConnect(connectionId);
  if (!userId) {
    // Expired, already consumed, or never issued by us — a forged/replayed
    // callback lands here too. Log and stop; never guess an identity.
    console.warn('[ENG-1685 spike] callback with unknown/expired connection_id', { connectionId, tool });
    return res.status(400).send('This connect link has expired or was already used. Start a new connect from /init.');
  }

  if (status === 'error') {
    console.warn('[ENG-1685 spike] AF callback reported error', { userId, tool, query: req.query });
    return res.status(200).send('Agentic Fabriq reported the connect attempt failed. You can retry from /init.');
  }

  // Never render success from the query string alone, and never report success
  // for a "configured" (not yet "connected") row — re-read the source of truth.
  try {
    const { appId } = await getAgenticFabriqAppCredentials();
    const connections = await agenticFabriqClient.listConnections(appId, userId);
    const gmailConnection = connections.find((c) => c.tool === PROVIDER);
    if (gmailConnection?.status === 'connected') {
      return res.status(200).send('Gmail connected via the Agentic Fabriq spike. You can close this tab.');
    }
    console.warn('[ENG-1685 spike] callback fired but connection is not yet "connected"', {
      userId,
      status: gmailConnection?.status ?? 'no_row',
    });
    return res.status(200).send('Connect did not complete (status is not yet "connected"). Try again from /init.');
  } catch (error: any) {
    console.error('[ENG-1685 spike] /callback verification error', error?.message ?? error);
    return res.status(502).send('Could not verify the Agentic Fabriq connection. Try again from /init.');
  }
});

export default router;
