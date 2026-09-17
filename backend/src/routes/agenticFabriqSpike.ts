/**
 * ENG-1685 spike — Gmail-via-Agentic-Fabriq connect flow.
 *
 * The callback landing route is always mounted so completed vendor OAuth cannot
 * end at a 404. It accepts only a process-local, single-use binding issued by
 * the flag-gated /init route; /init and tool traffic remain absent while off.
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
import { beginPendingConnectVerification, createPendingConnect, deletePendingConnect, finishPendingConnectVerification, PendingConnectChallenge } from '../integrations/agenticFabriq/pendingConnectStore';
import { bootstrapEmailProviders, resolveEmailAccount } from '../services/emailProviderService';

const router = express.Router();
export const agenticFabriqCallbackRouter = express.Router();

const PROVIDER = 'gmail';
const INIT_WINDOW_MS = 10 * 60 * 1000;
const INIT_LIMIT = 5;
const initAttempts = new Map<string, number[]>();

class InvalidMailboxError extends Error {}

async function resolveRequestedEmailAccount(userId: string, accountId: string) {
  try {
    const resolved = await resolveEmailAccount(userId, accountId, 'read');
    if (resolved.platform !== 'gmail' || resolved.ownerUserId !== userId || resolved.accountId !== accountId) {
      throw new InvalidMailboxError();
    }
    return resolved;
  } catch (error) {
    if (error instanceof InvalidMailboxError) throw error;
    if (error instanceof Error && /connected account .* not found|not an email account/i.test(error.message)) {
      throw new InvalidMailboxError();
    }
    throw error;
  }
}

/** Applies a small process-local limit; the allowlist already bounds key cardinality. */
function consumeInitAllowance(userId: string, nowMs = Date.now()): boolean {
  const recent = (initAttempts.get(userId) ?? []).filter((at) => nowMs - at < INIT_WINDOW_MS);
  if (recent.length >= INIT_LIMIT) return false;
  recent.push(nowMs);
  initAttempts.set(userId, recent);
  return true;
}

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
  const accountId = typeof req.query?.account_id === 'string' ? req.query.account_id : '';
  if (!accountId || accountId.length > 200) return res.status(400).json({ error: 'invalid_account_id' });
  if (!consumeInitAllowance(userId)) return res.status(429).json({ error: 'rate_limited' });

  let challenge: PendingConnectChallenge | undefined;
  try {
    await bootstrapEmailProviders();
    await resolveRequestedEmailAccount(userId, accountId);
    const { appId } = await getAgenticFabriqAppCredentials();
    challenge = await createPendingConnect(userId, accountId, PROVIDER);
    await agenticFabriqClient.ensureExternalUser(appId, userId); // idempotent — 409 tolerated internally
    const initiated = await agenticFabriqClient.initiateOAuth(appId, userId, PROVIDER, challenge);
    res.json({ success: true, oauth_url: initiated.oauth_url });
  } catch (error) {
    if (challenge) await deletePendingConnect(challenge.connectionId, challenge.state);
    if (error instanceof InvalidMailboxError) {
      return res.status(400).json({ error: 'unsupported_mailbox' });
    }
    console.error('[ENG-1685 spike] initiation failed');
    res.status(502).json({ error: 'agentic_fabriq_initiate_failed', message: 'Could not start the Agentic Fabriq connect flow.' });
  }
});

// ── GET /callback — AF's redirect target. UNAUTHENTICATED (browser redirect):
//    identity comes ONLY from the pending-connect record created at /init,
//    bound to our random, single-use connection_id — NEVER from external_user_id or
//    any other query param, which the vendor's own docs mark unsigned. ─────
const callbackHandler: express.RequestHandler = async (req, res) => {
  const connectionId = req.query.connection_id;
  const status = req.query.status;
  const tool = req.query.tool;
  if (typeof connectionId !== 'string' || !/^[a-f0-9]{32}$/.test(connectionId) ||
      (status !== 'success' && status !== 'error') || tool !== PROVIDER) {
    return res.status(400).send('Invalid Agentic Fabriq callback.');
  }

  let verification;
  try {
    verification = await beginPendingConnectVerification(connectionId);
  } catch {
    console.error('[ENG-1685 spike] callback state lookup failed');
    return res.status(502).send('Could not verify the Agentic Fabriq callback.');
  }
  if (!verification) {
    // Expired, already terminal, forged, replayed, or currently being verified.
    console.warn('[ENG-1685 spike] callback state was unknown or expired');
    return res.status(400).send('This connect link has expired or was already used. Start a new connect.');
  }
  const pending = verification.binding;
  const finish = (outcome: 'terminal' | 'retry' | 'connected') =>
    finishPendingConnectVerification(connectionId, verification.verificationId, outcome);

  if (status === 'error') {
    await finish('terminal');
    console.warn('[ENG-1685 spike] provider callback reported failure');
    return res.status(200).send('Agentic Fabriq reported the connect attempt failed. You can retry the connect.');
  }

  // Never render success from the query string alone, and never report success
  // for a "configured" (not yet "connected") row — re-read the source of truth.
  try {
    if (!isUserEligibleForAgenticFabriqSpike(pending.userId)) {
      await finish('terminal');
      return eligibilityRefusal(res);
    }
    await bootstrapEmailProviders();
    const resolved = await resolveEmailAccount(pending.userId, pending.accountId, 'read');
    if (resolved.platform !== PROVIDER || resolved.ownerUserId !== pending.userId || resolved.accountId !== pending.accountId) {
      await finish('terminal');
      return res.status(403).send('Could not verify the Agentic Fabriq connection.');
    }
    const { appId } = await getAgenticFabriqAppCredentials();
    const connections = await agenticFabriqClient.listConnections(appId, pending.userId);
    const gmailConnections = connections.filter((c) => c.tool === PROVIDER && c.connection_id === pending.connectionId);
    if (gmailConnections.length === 1 && gmailConnections[0].status === 'connected') {
      if (!await finish('connected')) return res.status(400).send('This connect link has expired or was already used. Start a new connect.');
      return res.status(200).send('Gmail connected via the Agentic Fabriq spike. You can close this tab.');
    }
    await finish('retry');
    console.warn('[ENG-1685 spike] callback connection was not connected');
    return res.status(200).send('Connect did not complete (status is not yet "connected"). Try connecting again.');
  } catch {
    await finish('retry');
    console.error('[ENG-1685 spike] callback verification failed');
    return res.status(502).send('Could not verify the Agentic Fabriq connection. Try connecting again.');
  }
};

router.get('/callback', callbackHandler);
agenticFabriqCallbackRouter.get('/callback', callbackHandler);

export default router;
