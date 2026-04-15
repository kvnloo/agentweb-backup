/**
 * Stripe Connect OAuth routes.
 *
 *   GET  /api/stripe/connect/initiate   — start OAuth, redirect to Stripe
 *   GET  /api/stripe/connect/callback   — OAuth redirect target
 *   POST /api/stripe/connect/disconnect — revoke grant + clear user record
 *   GET  /api/stripe/connect/status     — lightweight status for the Settings UI
 *   POST /api/stripe/connect/webhook    — Connect webhook (account-scoped events)
 *
 * The webhook intentionally uses its own signing secret
 * (STRIPE_CONNECT_WEBHOOK_SECRET) distinct from the platform's
 * STRIPE_WEBHOOK_SECRET — Stripe sends Connect events with a separate
 * endpoint + signature.
 */
import express, { Request, Response } from 'express';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { userDb } from '../services/db';
import {
  getStripeConnectConfig,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  deauthorize,
  persistTokensForUser,
  clearConnectFieldsForUser,
} from '../services/stripeConnectService';
import { syncContact } from '../services/contactSyncService';

const router = express.Router();

const CUSTOMER_FRONTEND_URL = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
const STATE_SECRET = process.env.JWT_SECRET;
if (!STATE_SECRET) {
  throw new Error('JWT_SECRET must be set for Stripe Connect OAuth state verification');
}

interface StatePayload {
  userId: string;
  nonce: string;
}

function signState(userId: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ userId, nonce } satisfies StatePayload, STATE_SECRET as string, {
    expiresIn: '15m',
  });
}

function verifyState(state: string): StatePayload | null {
  try {
    return jwt.verify(state, STATE_SECRET as string) as StatePayload;
  } catch {
    return null;
  }
}

/**
 * GET /api/stripe/connect/initiate
 * Authenticated. Builds authorize URL and 302 redirects to Stripe so the
 * user's browser lands directly on connect.stripe.com without a client-side
 * round-trip. Returns JSON `{ url }` if `?format=json` is set (handy for
 * SPAs that want to open in a new window).
 */
router.get('/initiate', authenticateToken, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const state = signState(userId);
    const url = buildAuthorizeUrl(state);
    if (req.query.format === 'json') {
      return res.json({ url });
    }
    return res.redirect(302, url);
  } catch (err: any) {
    console.error('[StripeConnect] /initiate failed:', err.message);
    return res.status(500).json({ error: 'Failed to start Stripe Connect OAuth' });
  }
});

/**
 * GET /api/stripe/connect/callback
 * Public (Stripe redirects the user here). Validates state, exchanges the
 * code, persists tokens, then redirects back to the customer portal's
 * Settings page with a success/error query flag.
 */
router.get('/callback', async (req: Request, res: Response) => {
  const { code, state, error: oauthError, error_description } = req.query as Record<
    string,
    string | undefined
  >;
  const settingsUrl = (flag: string, extra = '') =>
    `${CUSTOMER_FRONTEND_URL}/settings/accounts?stripe_connect=${flag}${extra}`;

  if (oauthError) {
    console.warn(`[StripeConnect] OAuth denied: ${oauthError} — ${error_description || ''}`);
    return res.redirect(settingsUrl('denied', `&reason=${encodeURIComponent(oauthError)}`));
  }
  if (!code || !state) {
    return res.redirect(settingsUrl('missing_params'));
  }
  const payload = verifyState(state);
  if (!payload) {
    console.warn('[StripeConnect] Invalid state (CSRF or expired)');
    return res.redirect(settingsUrl('invalid_state'));
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await persistTokensForUser(payload.userId, tokens);
    return res.redirect(settingsUrl('success'));
  } catch (err: any) {
    const msg = err?.response?.data?.error_description || err?.message || 'unknown';
    console.error('[StripeConnect] Token exchange failed:', msg);
    return res.redirect(settingsUrl('exchange_failed', `&reason=${encodeURIComponent(msg)}`));
  }
});

/**
 * POST /api/stripe/connect/disconnect
 * Authenticated. Revokes the Stripe grant and clears the user record.
 */
router.post('/disconnect', authenticateToken, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const user = await userDb.getUserById(userId);
    if (!user?.stripeConnectedAccountId) {
      return res.json({ success: true, alreadyDisconnected: true });
    }
    await deauthorize(user.stripeConnectedAccountId);
    await clearConnectFieldsForUser(userId);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[StripeConnect] /disconnect failed:', err?.message);
    return res.status(500).json({ error: 'Failed to disconnect Stripe' });
  }
});

/**
 * GET /api/stripe/connect/status
 * Authenticated. Returns whether the user has a connected account and
 * when it was connected — never returns the tokens themselves.
 */
router.get('/status', authenticateToken, async (req: Request, res: Response) => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const user = await userDb.getUserById(userId);
    if (!user?.stripeConnectedAccountId) {
      return res.json({ connected: false });
    }
    return res.json({
      connected: true,
      accountId: user.stripeConnectedAccountId,
      connectedAt: user.stripeConnectedAt || null,
      scope: user.stripeConnectScope || null,
      mode: user.stripeConnectMode || null,
    });
  } catch (err: any) {
    console.error('[StripeConnect] /status failed:', err?.message);
    return res.status(500).json({ error: 'Failed to load Stripe Connect status' });
  }
});

/**
 * POST /api/stripe/connect/webhook
 * Public — Stripe calls this directly. Signature verified against
 * STRIPE_CONNECT_WEBHOOK_SECRET. The raw body middleware is registered in app.ts.
 *
 * We fan the event out to the CRM contact sync (source='stripe') so billing
 * events on customer-connected accounts flow into the same AW-ContactEvents
 * timeline as our own platform billing events.
 */
router.post('/webhook', async (req: Request, res: Response) => {
  // Pick the webhook signing secret that matches the active Connect mode. Stripe
  // signs test-mode events with the test endpoint's secret and live-mode events
  // with the live endpoint's secret — they are NOT interchangeable. To ingest
  // real live-mode events on the test env, set STRIPE_CONNECT_WEBHOOK_SECRET_LIVE
  // AND register a live webhook destination in the Stripe dashboard pointing at
  // this env's public URL.
  const { mode } = getStripeConnectConfig();
  const secret =
    mode === 'live'
      ? process.env.STRIPE_CONNECT_WEBHOOK_SECRET_LIVE || process.env.STRIPE_CONNECT_WEBHOOK_SECRET
      : process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!secret || !stripeKey) {
    console.error(
      `[StripeConnect] webhook: missing signing secret for mode=${mode} or STRIPE_SECRET_KEY`
    );
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  const signature = req.headers['stripe-signature'] as string | undefined;
  if (!signature) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2025-05-28.basil' as any });
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, secret);
  } catch (err: any) {
    console.error('[StripeConnect] webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // account is the connected account ID on Connect events
  const accountId = (event as any).account as string | undefined;
  try {
    if (event.type === 'account.application.deauthorized' && accountId) {
      const user = await userDb.getUserByStripeConnectedAccountId?.(accountId);
      if (user?.userId) {
        await clearConnectFieldsForUser(user.userId);
        console.log(`[StripeConnect] Deauthorized by Stripe, cleared user=${user.userId}`);
      }
      return res.json({ received: true });
    }

    // Route billing events into the CRM timeline. Pull an email from the
    // event object if present. We never block the webhook ack on CRM failures.
    const obj: any = (event.data as any)?.object || {};
    const email: string | null =
      obj.email ||
      obj.customer_email ||
      obj.customer_details?.email ||
      obj.receipt_email ||
      null;

    if (email) {
      const eventTypeMap: Record<string, string> = {
        'customer.subscription.created': 'payment.subscribed',
        'customer.subscription.updated': 'payment.updated',
        'customer.subscription.deleted': 'payment.canceled',
        'invoice.payment_succeeded': 'payment.updated',
        'invoice.payment_failed': 'payment.updated',
      };
      const mapped = eventTypeMap[event.type] || 'payment.updated';
      void syncContact({
        source: 'stripe',
        sourceRecordId: `stripe-connect-${event.id}`,
        identity: { email },
        eventType: mapped as any,
        payload: {
          stripeEventType: event.type,
          connectedAccountId: accountId,
          amount: obj.amount_total ?? obj.amount_paid ?? obj.amount ?? undefined,
          currency: obj.currency,
          status: obj.status,
        },
      }).catch((err) =>
        console.error('[StripeConnect] syncContact failed:', (err as any)?.message)
      );
    }

    return res.json({ received: true });
  } catch (err: any) {
    console.error('[StripeConnect] webhook handler error:', err?.message);
    // Return 200 so Stripe does not hammer us with retries for application bugs.
    return res.status(200).json({ received: true, handlerError: err?.message });
  }
});

export default router;

// Guard export re-used in tests
export { signState, verifyState };
