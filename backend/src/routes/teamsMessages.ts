/**
 * Microsoft Teams inbound messaging endpoint (ENG-272).
 *
 * This is the endpoint both Azure Bots (`agentweb-teams-dev`, `agentweb-teams-prod`) are
 * configured to call. Everything about authenticating that traffic is delegated to the
 * Bot Framework SDK — see services/teams/teamsBotAdapter.ts for why.
 *
 * Scope of this slice: authenticate the activity, record that it arrived, and answer it.
 * Session creation and the Teams adapter over the conversation port are the next change, so
 * this file deliberately imports nothing that can start a session; a test asserts that, the
 * same way whatsappWebhook.test.ts does.
 *
 * Unlike /api/slack/events and /api/webhooks/whatsapp, this route needs the PARSED body and
 * must be mounted after express.json(). Those two verify an HMAC computed over the exact
 * received bytes; Bot Framework authenticates with a bearer JWT in the Authorization header,
 * and CloudAdapter reads req.body. Putting this in app.ts's raw-body block would break it.
 */

import express, { Request, Response } from 'express';
import { getTeamsBotAdapter } from '../services/teams/teamsBotAdapter';

const router = express.Router();

/**
 * What this slice replies while the conversation pipeline is still landing.
 *
 * Sending something rather than silently acking is the only exercise of the OUTBOUND path in
 * this change — acquiring a tenant-scoped Connector token and posting back to the activity's
 * own serviceUrl. Without it, outbound auth stays unverified until session wiring lands, and
 * a silent bot is indistinguishable from a broken one while testing.
 */
const ACK_TEXT = 'AgentWeb received your message. Conversation support is landing shortly.';

/**
 * Log that an activity arrived, with no message content.
 *
 * ENG-2054 removed raw message text and request bodies from the Slack route's logs; there is
 * no reason to reintroduce the same exposure for Teams. Identifiers only — enough to confirm
 * delivery, correlate a tenant, and see which conversation type we are dealing with.
 */
function logActivity(activity: any): void {
  console.log('🔔 [teams] activity received:', {
    type: activity?.type,
    channelId: activity?.channelId,
    conversationType: activity?.conversation?.conversationType,
    conversationId: activity?.conversation?.id,
    tenantId: activity?.channelData?.tenant?.id,
    fromAadObjectId: activity?.from?.aadObjectId,
    hasAttachments: Array.isArray(activity?.attachments) && activity.attachments.length > 0,
  });
}

/**
 * @route POST /api/teams/messages
 * @desc Bot Framework messaging endpoint for the Teams channel
 * @access Bot Connector only — the SDK validates the bearer token on every request
 */
router.post('/messages', async (req: Request, res: Response) => {
  let adapter;
  try {
    adapter = await getTeamsBotAdapter();
  } catch (error) {
    // Fail closed. Without credentials the SDK cannot validate the caller, and answering
    // 200 to an unauthenticated request would mean anyone who finds this URL can drive the
    // bot. 401 is also the honest status: we could not authenticate this request.
    console.error('❌ [teams] cannot authenticate inbound activity — credentials unavailable:', error);
    res.status(401).json({ error: 'Teams bot is not configured' });
    return;
  }

  try {
    await adapter.process(req, res, async (context) => {
      logActivity(context.activity);

      if (context.activity.type === 'message') {
        await context.sendActivity(ACK_TEXT);
      }
    });
  } catch (error) {
    // CloudAdapter validates the activity's shape BEFORE it authenticates, and a body it
    // cannot parse (e.g. no `type`) rejects without writing a response. Left uncaught that is
    // an unhandled rejection and the request hangs until the client gives up — reachable by
    // anyone who can POST here, no token required. Authentication failures are different:
    // the SDK writes its own 401 and resolves, so they never land here.
    console.error('❌ [teams] rejected malformed activity:', error);
    if (!res.headersSent) {
      res.status(400).json({ error: 'Invalid activity' });
    }
  }
});

export default router;
