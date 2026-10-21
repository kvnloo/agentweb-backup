import express, { Request, Response } from "express"; // slack-triggered-session v2
import { createHmac, timingSafeEqual } from "crypto";
import { authenticateToken, isRealAdmin } from "../middleware/auth";
import { AuthenticatedRequest } from "../middleware/auth";
import { getSecret } from "../utils/secretsManager";
import {
  getSlackChannels,
  sendApprovalRequest,
  sendApprovalRequestWithTracking,
  updateApprovalMessage,
  openFeedbackModal,
  openRejectModal,
  openTestEmailModal,
  postThreadResponse,
  setSlackAssistantStatus,
  getSlackUserDisplayName,
  getSlackUserEmail,
  getSlackUserTeamId,
  getOwnSlackTeamId,
  resolveSlackMentionsInText,
  downloadSlackFile,
  resolveSlackFileUrl,
  postSlackMessage,
  getEffectiveAllowedChannels
} from "../services/slackService";
import {
  APPROVAL_DECISION_ACTION_IDS,
  isAuthorizedApprover,
  openDecisionVerdictModal,
  resolveApprovalDecision,
} from "../services/approvalInboxSlack";
import { approvalInboxService } from "../services/approvalInboxService";
import { approvalDb, getAssetTypeFromFilename } from "../services/approvalDb";
import { taskDb, userDb } from "../services/db";
import { emailService } from "../services/emailService";
import { notifySubscribersOfApproval } from "../services/approvalSubscriberNotify";
import { hasWhatsApp } from "../services/customerChannelPolicy";
import { createRevisionExecutionFromSlack } from "../controllers/tasks";
import { isSessionLimitError } from "../utils/agentModeErrors";
import { sendAgentModeOncallAlert } from "../utils/agentModeAlerts";
import { getEmmaBotUserId, handleLoopApprovalReaction } from "../services/loopSlackApprovalDispatcher";
import { agentModeService } from '../services/agentModeService';
import { handleSessionResponse } from "../services/conversation/sessionResponder";
import { slackChannelAdapter, renderOutboundForSlack } from "../services/conversation/slackChannelAdapter";
import type { ConversationRef } from "../services/conversation/channelPort";
import { isModelUnavailableError } from "../services/agentMode/modelUnavailable";

// ENG-351 citation rendering now lives with the Slack channel adapter (ENG-272 extraction);
// aliased here for the other Slack reply paths in this file.
const citeForSlack = renderOutboundForSlack;

const router = express.Router();

const activeSlackTurns = new Map<string, number>();
const SLACK_REQUEST_MAX_AGE_SECONDS = 60 * 5;
const SLACK_ASSISTANT_STATUS_TIMEOUT_MS = 1_500;

async function setSlackAssistantStatusWithDeadline(
  channel: string,
  threadTs: string,
  status: string,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      setSlackAssistantStatus(channel, threadTs, status),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Slack assistant status request timed out')),
          SLACK_ASSISTANT_STATUS_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function verifySlackRequest(req: Request): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  // Existing route-level tests intentionally omit Slack credentials. Runtime
  // deployments fail closed if the signing secret is absent.
  if (!signingSecret) return process.env.NODE_ENV === 'test';

  const timestampHeader = req.header('x-slack-request-timestamp');
  const signature = req.header('x-slack-signature');
  const timestamp = Number(timestampHeader);
  if (!timestampHeader || !signature || !Number.isFinite(timestamp)
    || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > SLACK_REQUEST_MAX_AGE_SECONDS) return false;

  const rawBody = (req as any).rawBody instanceof Buffer
    ? (req as any).rawBody
    : Buffer.isBuffer(req.body) ? req.body : null;
  if (!rawBody) return false;
  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${timestampHeader}:${rawBody.toString('utf8')}`)
    .digest('hex')}`;
  const suppliedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

async function claimSlackAssistantStatus(channel: string, threadTs: string): Promise<void> {
  const key = `${channel}:${threadTs}`;
  const activeTurns = activeSlackTurns.get(key) || 0;
  // Claim synchronously before awaiting Slack so concurrent turns cannot both
  // observe the thread as idle while the first status request is in flight.
  activeSlackTurns.set(key, activeTurns + 1);
  if (activeTurns === 0) {
    try {
      await setSlackAssistantStatusWithDeadline(channel, threadTs, 'is working...');
    } catch (error) {
      console.error('Non-blocking: failed to set Slack assistant thread status:', error);
    }
  }
}

async function releaseSlackAssistantStatus(channel: string, threadTs: string): Promise<void> {
  const key = `${channel}:${threadTs}`;
  const remainingTurns = Math.max((activeSlackTurns.get(key) || 1) - 1, 0);
  if (remainingTurns > 0) {
    activeSlackTurns.set(key, remainingTurns);
    return;
  }
  activeSlackTurns.delete(key);
  try {
    await setSlackAssistantStatusWithDeadline(channel, threadTs, '');
  } catch (error) {
    console.error('Non-blocking: failed to clear Slack assistant thread status:', error);
  }
}

// ENG-1294: Slack Connect guests (e.g. Argusoft engineers, who work directly in this codebase)
// can never share our own workspace's team_id — that's what Slack Connect means — so neither the
// email-domain check nor the own-team_id fallback below can ever authorize them, even though
// they're legitimately trusted. Slack reliably includes the author's home team on Connect-shared
// app_mention events via user_team/source_team, delivered directly on the event payload — no
// extra API call, and no dependency on users.info resolving anything (confirmed empirically:
// Manan's own test in #agentweb-argusoft on 2026-09-03 got the profile-email field silently
// omitted exactly as it did for Harsha/Fangfang, but user_team/source_team carried his real home
// team, T093CUE1WGP, without incident). Comma-separated env override; defaults to Argusoft's team.
const TRUSTED_EXTERNAL_SLACK_TEAM_IDS = new Set(
  (process.env.AGENTWEB_TRUSTED_EXTERNAL_SLACK_TEAM_IDS || 'T093CUE1WGP') // Argusoft
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

function userMatchesChannel(u: any, channel: string): boolean {
  // Skip tombstoned (deleted) users
  if (u.userId?.startsWith('deleted_')) return false;
  return (u.slackChannels && u.slackChannels.includes(channel)) || u.slackChannel === channel;
}

function extractChannelLinkIntent(rawMessage: string): { targetEmail: string } | null {
  const match = rawMessage.match(
    /\bfor\s+(?:user|account)\s+([^\s<>|]+@[^\s<>|]+)\s+(?:please\s+)?(?:link|connect)\s+(?:to\s+)?this\s+channel\b/i
  );
  const targetEmail = match?.[1]?.toLowerCase();
  return targetEmail ? { targetEmail } : null;
}

function getUserSlackChannels(user: any): string[] {
  return [...new Set([
    ...((Array.isArray(user.slackChannels) ? user.slackChannels : []) as string[]),
    ...(user.slackChannel ? [user.slackChannel] : []),
  ].map(channel => String(channel).trim()).filter(Boolean))];
}

/**
 * Use Gemini to extract the target user email and task description from a
 * free-form admin channel message. Returns null if no email is found.
 */
async function extractAdminMessageIntent(
  rawMessage: string
): Promise<{ targetEmail: string; taskMessage: string } | null> {
  try {
    const prompt = `Extract the target user email address and task description from this admin Slack message.

Message: "${rawMessage}"

Rules:
- targetEmail: the email address of the user the admin wants to run a task FOR (not the admin's own email). Return null if no email is present.
- taskMessage: the actual task or request to run for that user. Remove the email and any surrounding words like "for", "regarding", "about" that were just part of directing the task to that user. Keep the core task intact.

Respond with JSON only, no explanation:
{"targetEmail": "user@example.com", "taskMessage": "the task description"}
or if no email found:
{"targetEmail": null, "taskMessage": null}`;

    const response = await agentModeService.callLLM('gemini-3.1-flash-lite', [
      { role: 'user', content: prompt },
    ], {
      response_format: { type: 'json_object' },
      // ENG-1858: platform-funded admin-channel parsing — deliberately no userId
      // (the target user is not known until this call returns).
      usageContext: { feature: 'platform:slack_admin_intent' },
      taskClass: 'mcp_api',
    });

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

    const parsed = JSON.parse(text);
    if (!parsed.targetEmail || !parsed.taskMessage) return null;

    return {
      targetEmail: parsed.targetEmail.toLowerCase(),
      taskMessage: parsed.taskMessage.trim(),
    };
  } catch (err) {
    console.error('⚠️ Failed to extract admin message intent via LLM:', err);
    return null;
  }
}

/**
 * Slack entry point into the transport-agnostic session response pipeline.
 *
 * The pipeline lives in services/conversation/sessionResponder.ts (ENG-272). This
 * translates Slack's (channel, ts, threadTs) addressing into a ConversationRef and
 * keeps the assistant-status claim on this side of the port on purpose: the
 * activeSlackTurns ref-count is shared with handleMappedSlackThreadResponse below,
 * so moving it behind the port would either duplicate the counter or make one path
 * clear a status while the other is still working.
 */
async function handleSlackSessionResponse(params: {
  session: any;
  user: any;
  channel: string;
  ts: string;
  rawMessage: string;
  userMessage: string;
  adminEmail?: string;
  isAdminChannel?: boolean;
  files?: any[];
  threadTs?: string;
}) {
  const { channel, ts, threadTs, ...rest } = params;
  const responseThreadTs = threadTs || ts;
  const ref: ConversationRef = {
    transport: 'slack',
    conversationId: channel,
    threadId: responseThreadTs,
  };

  await claimSlackAssistantStatus(channel, responseThreadTs);
  try {
    await handleSessionResponse({ ...rest, ref }, slackChannelAdapter);
  } finally {
    await releaseSlackAssistantStatus(channel, responseThreadTs);
  }
}

async function handleMappedSlackThreadResponse(params: {
  channel: string;
  threadTs: string;
  slackUserId: string;
  text: string;
  files?: any[];
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  const { channel, threadTs, slackUserId, text, files, sessionId, userId } = params;
  const { chatbotDb } = await import('../services/chatbotService');
  const { generateSessionResponse, modelUnavailableBody } = await import('../controllers/agentModeController');
  const { agentModeService } = await import('../services/agentModeService');
  const { cronJobRegistry } = await import('../utils/cronJobRegistry');
  const session = await chatbotDb.getChatSession(sessionId);
  if (!session || session.userId !== userId) {
    console.warn('Slack mapped thread rejected: session owner mismatch', {
      channel, threadTs, slackUserId, sessionId, mappedUserId: userId,
      actualUserId: session?.userId,
    });
    return false;
  }

  const attachments: any[] = [];
  for (const file of files || []) {
    try {
      const fileUrl = await resolveSlackFileUrl(file);
      const fileBuffer = await downloadSlackFile(fileUrl);
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const uploadResult = await uploadFileToS3(fileBuffer, file.name || 'attachment', userId, file.mimetype || 'application/octet-stream');
      if (uploadResult.success && uploadResult.url) {
        attachments.push({ url: uploadResult.url, filename: file.name || 'attachment', size: file.size, mimetype: file.mimetype || 'application/octet-stream' });
      }
    } catch (fileError) {
      console.error('❌ Error downloading Slack file:', fileError);
    }
  }

  let messageText = text;
  if (!messageText && files?.length) messageText = attachments.length ? '[attached file]' : '[attachment could not be read]';
  const displayName = await getSlackUserDisplayName(slackUserId);
  const formattedMessage = `${displayName}: ${messageText || ''}`.trim();
  const llmModel = session.llmModel || await agentModeService.getDefaultModel();
  await claimSlackAssistantStatus(channel, threadTs);
  try {
    const response = await cronJobRegistry.track('slackThreadAgentTurn', generateSessionResponse(sessionId, formattedMessage, userId, llmModel, attachments));
    if (response.content) await postThreadResponse(channel, threadTs, citeForSlack(response));
    else await postThreadResponse(channel, threadTs, 'I completed the task but was unable to format a response. Please check the portal for results or try again.');
  } catch (genError) {
    console.error('❌ Error generating thread response:', genError);
    // ENG-669: the session's model is outside the owner's plan: say so (nothing ran on another model).
    const modelRefusal = isModelUnavailableError(genError) ? modelUnavailableBody(genError).error : undefined;
    await postThreadResponse(channel, threadTs, modelRefusal ?? 'Sorry, I encountered an error. Please try again.');
    try {
      await chatbotDb.addMessageToSession(sessionId, {
        role: 'assistant',
        content: modelRefusal ?? 'Sorry, I encountered an error processing your request. Please try again.',
        timestamp: new Date().toISOString(),
        metadata: { timestamp: new Date().toISOString(), isErrorMessage: true },
      });
    } catch (saveError) {
      console.error('❌ Error saving error message to session:', saveError);
    }
  } finally {
    await releaseSlackAssistantStatus(channel, threadTs);
  }
  return true;
}

/**
 * @route GET /api/slack/channels
 * @desc Get available Slack channels
 * @access Private (requires authentication)
 */
router.get("/channels", authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    console.log("📡 Fetching Slack channels...");
    
    const channels = await getSlackChannels();
    
    // If user has an account-level Slack channel configured, filter to only show that channel
    if (authReq.user?.userId) {
      const { userDb } = await import("../services/db");
      const user = await userDb.getUserById(authReq.user.userId);
      
      const allowedChannels = user?.slackChannels && user.slackChannels.length > 0
        ? user.slackChannels
        : user?.slackChannel ? [user.slackChannel] : null;
      if (allowedChannels) {
        const filteredChannels = channels.filter(channel => allowedChannels.includes(channel.id));
        console.log(`✅ Filtered to ${filteredChannels.length} channels based on user's configured Slack channels`);
        res.json(filteredChannels);
        return;
      }
    }
    
    console.log(`✅ Successfully fetched ${channels.length} Slack channels`);
    res.json(channels);
  } catch (error: any) {
    console.error("❌ Error fetching Slack channels:", error.message);
    
    if (error.message.includes("Slack client not initialized")) {
      res.status(503).json({ 
        error: "Slack integration not configured", 
        details: "SLACK_BOT_TOKEN environment variable is missing" 
      });
    } else {
      res.status(500).json({ 
        error: "Failed to fetch Slack channels", 
        details: error.message 
      });
    }
  }
});

/**
 * @route POST /api/slack/send-approval
 * @desc Send approval request to Slack channel
 * @access Private (requires authentication)
 */
router.post("/send-approval", authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { channel, channelName, assetUrl, filename, executionId, note } = authReq.body;
    const userId = authReq.user?.userId;

    if (!channel || !assetUrl || !filename) {
      return res.status(400).json({ 
        error: "Missing required fields: channel, assetUrl, filename" 
      });
    }

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    if (typeof channel !== "string") {
      return res.status(400).json({ error: "channel must be a string" });
    }

    // ENG-2413 (ENG-2407 pattern): the bot posts with the workspace token, so the caller
    // may only target a channel configured for their user/org (or be a real, non-delegated
    // admin). Checked before any Slack call or approvalDb write.
    //
    // Not applied to a customer on WhatsApp: they are entitled to no Slack channel by
    // design, and requestApproval ignores the channel it is given for them (nothing is
    // posted to Slack), so refusing here would only stop a task that still names an old
    // Slack channel from ever asking them on WhatsApp — and hold their output.
    let targetChannel: string = channel;
    if (!isRealAdmin(req)) {
      const user = await userDb.getUserById(userId);
      const allowed = await getEffectiveAllowedChannels(user);
      if (hasWhatsApp(user)) {
        // Hand requestApproval NO channel. It re-reads the account itself; if that read
        // disagrees (a blip, or a disconnect between the two reads) an empty channel makes
        // it fail closed instead of posting to whatever channel the caller named.
        targetChannel = "";
      } else if (!allowed.includes(channel)) {
        return res.status(403).json({ error: "Not allowed to post to this Slack channel" });
      }
    }

    // Determine asset type from filename
    const assetType = getAssetTypeFromFilename(filename);

    console.log("📨 Sending approval request to Slack...");
    console.log("📝 Request details:", { channel, filename, assetUrl, assetType, userId });

    const result = await sendApprovalRequestWithTracking({
      executionId: executionId || '', // Keep for backward compatibility
      imageUrl: assetUrl,
      filename,
      assetType,
      userId,
      channel: targetChannel,
      channelName: authReq.body.channelName || channel, // Use channel name if provided, fallback to channel ID
      note: note // Pass the note to Slack
    });

    console.log("✅ Approval request sent successfully to Slack and stored in database");
    
    res.json({ 
      success: true, 
      message: "Approval request sent successfully",
      messageTs: result.messageTs,
      approvalId: result.approvalId
    });
  } catch (error: any) {
    console.error("❌ Error sending approval request:", error.message);
    
    if (error?.name === "ApprovalForbiddenError" || error?.constructor?.name === "ApprovalForbiddenError") {
      return res.status(403).json({ error: error.message });
    }
    if (error.message.includes("Slack client not initialized")) {
      res.status(503).json({ 
        error: "Slack integration not configured", 
        details: "SLACK_BOT_TOKEN environment variable is missing" 
      });
    } else {
      res.status(500).json({ 
        error: "Failed to send approval request", 
        details: error.message 
      });
    }
  }
});

/**
 * @route POST /api/slack/events
 * @desc Handle Slack events (app mentions, etc.)
 * @access Public (Slack webhook)
 */
router.post("/events", express.raw({ type: 'application/json', limit: '1mb' }), async (req: Request, res: Response) => {
  try {
    if (!verifySlackRequest(req)) return res.status(401).json({ error: 'Unauthorized Slack request' });
    if (Buffer.isBuffer(req.body)) req.body = JSON.parse(req.body.toString('utf8'));
    const { type, challenge, event } = req.body;

    // Handle URL verification challenge
    if (type === 'url_verification') {
      console.log('✅ Slack URL verification challenge received');
      return res.status(200).json({ challenge });
    }

    // Handle event callbacks
    if (type === 'event_callback' && event) {
      console.log('🔔 Event callback received, event type:', event.type);
      // Acknowledge the event immediately (Slack requires response within 3 seconds)
      res.status(200).send();

      // Import shared services for event handling
      const { settingsService } = await import('../services/settingsService');

      // Shared loop approval contract: any Emma DM digest with the standard
      // "React ✅ to dispatch all to cloud-dev" footer uses the same path.
      if (event.type === 'reaction_added') {
        await handleLoopApprovalReaction(event).catch((err) => {
          console.error('❌ Error in loop approval reaction handler:', err);
        });
      }

      // Handle app mention events
      if (event.type === 'app_mention') {
        const { text, user: slackUserId, channel, ts, thread_ts: threadTs, files, user_team: userTeam, source_team: sourceTeam } = event;
        const responseThreadTs = threadTs ?? ts;

        const emmaBotUserId = process.env.SLACK_BOT_USER_ID || await getEmmaBotUserId();
        if (!emmaBotUserId) {
          console.warn('Ignoring Slack app_mention because Emma bot identity is unavailable', {
            channel, threadTs: responseThreadTs, slackUserId,
          });
          return;
        }
        if (slackUserId && slackUserId === emmaBotUserId) {
          console.warn('Ignoring Slack app_mention emitted by Emma', { channel, threadTs: responseThreadTs, slackUserId });
          return;
        }

        console.log('👋 Emma bot mentioned in Slack:', {
          channel,
          user: slackUserId,
          ts
        });

        try {
          const { userDb } = await import('../services/db');
          const { chatbotDb } = await import('../services/chatbotService');
          const { WebClient } = await import('@slack/web-api');
          const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

          // Extract the message (remove bot mention, resolve other user mentions, normalize Slack formatting)
          const textWithoutBotMention = text.replace(/<@[A-Z0-9]+>/, ''); // strip the first mention (the bot)
          let rawMessage = (await resolveSlackMentionsInText(textWithoutBotMention))
            .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1') // <mailto:email|email> → email
            .replace(/<mailto:([^|>]+)>/g, '$1')         // <mailto:email> → email
            .trim();

          if (!rawMessage && files?.length) rawMessage = '[attached file]';
          if (!rawMessage) {
            await slackClient.chat.postMessage({
              channel,
              text: '👋 Hi! Please include a message after mentioning me. For example: @Emma help me create a social media post',
              thread_ts: responseThreadTs
            });
            return;
          }

          // An explicit mention inside an existing Emma thread continues that
          // thread's mapped session and always replies at the root thread.
          if (threadTs) {
            const mapping = await settingsService.getSetting(`slack_thread_${channel}_${threadTs}`);
            if (mapping?.settingValue) {
              let mappedSession: { sessionId: string; userId: string } | null = null;
              try {
                const parsed = JSON.parse(mapping.settingValue);
                if (typeof parsed?.sessionId === 'string' && parsed.sessionId
                  && typeof parsed?.userId === 'string' && parsed.userId) {
                  mappedSession = parsed;
                }
              } catch {
                // A malformed/stale mapping must not consume an explicit mention.
              }
              if (mappedSession) {
                const handled = await handleMappedSlackThreadResponse({
                  channel,
                  threadTs,
                  slackUserId,
                  text: rawMessage,
                  files,
                  sessionId: mappedSession.sessionId,
                  userId: mappedSession.userId,
                });
                if (handled) return;
              }
            }
          }

          // Check if this is an admin Slack channel (supports multiple channels via slack_admin_channels JSON array)
          const adminChannelsSetting = await settingsService.getSetting('slack_admin_channels');
          let adminChannelIds: string[] = [];
          if (adminChannelsSetting?.settingValue) {
            try {
              adminChannelIds = JSON.parse(adminChannelsSetting.settingValue);
            } catch {
              adminChannelIds = [];
            }
          }
          // Legacy fallback: single-channel setting
          if (adminChannelIds.length === 0) {
            const legacySetting = await settingsService.getSetting('slack_admin_channel');
            if (legacySetting?.settingValue) adminChannelIds = [legacySetting.settingValue];
          }
          const isAdminChannel = adminChannelIds.includes(channel);

          let user = null;
          let delegateInfo: { adminUserId: string; adminEmail: string; isDelegated: boolean } | undefined;
          let actualMessage = rawMessage;
          let pageIdentifier = 'slack-bot';

          const channelLinkIntent = extractChannelLinkIntent(rawMessage);
          if (channelLinkIntent) {
            const requesterEmail = (await getSlackUserEmail(slackUserId))?.toLowerCase();
            const targetEmail = channelLinkIntent.targetEmail;
            let canLinkChannel = requesterEmail === targetEmail
              || requesterEmail?.endsWith('@agentweb.pro')
              || requesterEmail?.endsWith('@argusoft.com');

            // ENG-1294: requesterEmail depends on Slack's profile.email resolving, which needs the
            // users:read.email bot scope and has empirically failed for verified AgentWeb admins
            // (ENG-1263 — Fangfang's own email failed to resolve even though the rest of her
            // profile did). Without this, nobody whose email fails to resolve can ever use the
            // remedy this very handler tells them to run. Fall back to team_id: it rides the same
            // users.info response but doesn't need that scope. It only proves "this Slack user
            // belongs to our own workspace" — never enough to pick which AgentWeb account a
            // mention resolves to, but that's not the question here: targetEmail is typed
            // explicitly by the requester, so this only decides whether an AgentWeb workspace
            // member is allowed to run the link command at all — the same authorization the
            // trusted-domain checks above already grant to any internal admin, just via a
            // signal that doesn't depend on the broken field.
            if (!canLinkChannel) {
              const [senderTeamId, ownTeamId] = await Promise.all([
                getSlackUserTeamId(slackUserId),
                getOwnSlackTeamId(),
              ]);
              canLinkChannel = !!senderTeamId && !!ownTeamId && senderTeamId === ownTeamId;
            }

            // ENG-1294: the own-team_id check above only ever proves "same workspace as us" — a
            // real Slack Connect guest can never pass it, no matter who they are. Trust a small,
            // explicit allowlist of partner teams via user_team/source_team instead, which Slack
            // hands us directly rather than requiring a lookup that may silently omit data for an
            // external profile. Same authorization question as every check above (may this Slack
            // user run the link command at all), never used to pick which AgentWeb account a
            // mention resolves to.
            if (!canLinkChannel) {
              const externalTeamId = userTeam || sourceTeam;
              canLinkChannel = !!externalTeamId && TRUSTED_EXTERNAL_SLACK_TEAM_IDS.has(externalTeamId);
            }

            if (!canLinkChannel) {
              await slackClient.chat.postMessage({
                channel,
                text: 'Only AgentWeb admins or the target account owner can link this channel.',
                thread_ts: responseThreadTs
              });
              return;
            }

            const targetUser = await userDb.getUserByEmail(targetEmail);
            if (!targetUser) {
              await slackClient.chat.postMessage({
                channel,
                text: `User not found: ${targetEmail}`,
                thread_ts: responseThreadTs
              });
              return;
            }

            // One platform per customer: an account on WhatsApp cannot also be linked
            // to a Slack channel.
            if (hasWhatsApp(targetUser)) {
              await slackClient.chat.postMessage({
                channel,
                text: `${targetEmail} is already connected to WhatsApp. An account can use one messaging platform, so disconnect WhatsApp before linking a Slack channel.`,
                thread_ts: responseThreadTs
              });
              return;
            }

            const existingChannels = getUserSlackChannels(targetUser);
            const nextChannels = [...new Set([...existingChannels, channel])];
            await settingsService.invalidateSlackChannelMappings(targetUser.userId, nextChannels);
            await userDb.updateUser(targetUser.userId, { slackChannels: nextChannels });
            await settingsService.setSetting(
              `slack_channel_mapping_${channel}`,
              targetUser.userId,
              `Slack channel to userId mapping for channel ${channel}`,
              'system'
            );

            await slackClient.chat.postMessage({
              channel,
              text: `✅ Linked this channel to ${targetEmail}.`,
              thread_ts: responseThreadTs
            });
            return;
          }

          if (isAdminChannel) {
            // Admin channel: use LLM to flexibly extract target email and task from any phrasing
            const extracted = await extractAdminMessageIntent(rawMessage);

            if (extracted) {
              const targetEmail = extracted.targetEmail;
              actualMessage = extracted.taskMessage;

              // Look up the target user
              user = await userDb.getUserByEmail(targetEmail);
              if (!user) {
                await slackClient.chat.postMessage({
                  channel,
                  text: `User not found: ${targetEmail}`,
                  thread_ts: responseThreadTs
                });
                return;
              }

              // Resolve admin identity from Slack
              const adminEmail = await getSlackUserEmail(slackUserId);
              let adminUserId = slackUserId;
              if (adminEmail) {
                const adminUser = await userDb.getUserByEmail(adminEmail);
                if (adminUser) {
                  adminUserId = adminUser.userId;
                }
              }

              delegateInfo = {
                adminUserId,
                adminEmail: adminEmail || `slack:${slackUserId}`,
                isDelegated: true
              };
              pageIdentifier = 'slack-bot-admin';

              // Post confirmation
              await postThreadResponse(channel, responseThreadTs, `Starting session for ${targetEmail}`);
              console.log(`📝 Admin channel: creating delegated session for ${targetEmail} (admin: ${delegateInfo.adminEmail})`);
            } else {
              // No "for email" prefix — fall through to regular user lookup below
              console.log(`📝 Admin channel: no "for email" prefix, treating as regular user session`);
            }
          }

          // If user not yet resolved (regular channel OR admin channel without "for email"),
          // look up user by channel mapping or slackChannel field
          if (!user) {
            const mappingKey = `slack_channel_mapping_${channel}`;

            const cachedMapping = await settingsService.getSetting(mappingKey);
            if (cachedMapping?.settingValue) {
              const cachedUser = await userDb.getUserById(cachedMapping.settingValue);
              // Skip tombstoned (deleted) users — their userId starts with "deleted_"
              if (cachedUser && !cachedUser.userId?.startsWith('deleted_')) {
                user = cachedUser;
              }
            }

            if (!user) {
              const allUsers = await userDb.getAllUsers();
              user = allUsers.find((u: any) => userMatchesChannel(u, channel));

              if (user) {
                await settingsService.setSetting(
                  mappingKey,
                  user.userId,
                  `Slack channel to userId mapping for channel ${channel}`,
                  'system'
                );
              }
            }

            // ENG-1292: no channel binding — fall back to the mentioning Slack
            // user's own verified identity instead of failing outright. Only
            // an exact match on Slack's verified profile email resolves a
            // user (never a fuzzy/partial match), so a Slack user with no
            // matching AgentWeb account can never resolve to someone else's
            // account (no cross-tenant leak). Deliberately NOT cached as a
            // channel mapping: an internal channel can have several different
            // AgentWeb users mention Emma, and caching the first one would
            // silently misroute everyone else who mentions Emma there.
            let requesterEmail: string | null = null;
            if (!user) {
              requesterEmail = await getSlackUserEmail(slackUserId);
              if (requesterEmail) {
                const identityUser = await userDb.getUserByEmail(requesterEmail);
                // Skip tombstoned (deleted) users — mirrors the explicit guard on every
                // other resolution path above, even though getUserByEmail already filters
                // deleted_* userIds at the DB layer (belt-and-suspenders, not load-bearing).
                if (identityUser && !identityUser.userId?.startsWith('deleted_')) {
                  user = identityUser;
                  console.log(`📝 [app-mention] no channel binding for ${channel}, resolved via Slack identity (${requesterEmail})`);
                }
              }
            }

            if (!user) {
              const remedy = 'An AgentWeb admin or the account owner can link it by posting ' +
                '`@Emma for user <their-agentweb-email> link this channel` in this channel.';
              const text = requesterEmail
                ? `❌ Sorry, this channel isn't linked to an AgentWeb account, and there's no AgentWeb user with the email ${requesterEmail}. ${remedy}`
                : `❌ Sorry, this channel isn't linked to an AgentWeb account, and I couldn't verify a Slack email for you to match one. ${remedy}`;
              await slackClient.chat.postMessage({
                channel,
                text,
                thread_ts: responseThreadTs
              });
              return;
            }
          }

          // Prefix message with sender's display name
          const displayName = await getSlackUserDisplayName(slackUserId);
          const userMessage = `${displayName}: ${actualMessage}`;

          console.log('📝 Creating Agent Mode session for user:', user.userId);

          // Create Agent Mode session
          const session = await chatbotDb.createChatSession(
            user.userId,
            undefined, // pageContent
            'agent', // portalType
            pageIdentifier,
            undefined, // selectedStartupId
            undefined, // workflowId
            undefined, // executionId
            undefined, // emailCampaignTaskId
            'regular', // sessionType
            delegateInfo
          );

          console.log('✅ Agent Mode session created:', session.sessionId);

          // Handle the rest: title, thread mapping, response generation, posting
          await handleSlackSessionResponse({
            session,
            user,
            channel,
            ts,
            rawMessage: actualMessage,
            userMessage,
            adminEmail: delegateInfo?.adminEmail,
            isAdminChannel,
            files: event.files,
            threadTs,
          });

          console.log('✅ Emma bot mention handled successfully');
        } catch (error) {
          console.error('❌ Error handling Emma bot mention:', error);
          try {
            const { WebClient } = await import('@slack/web-api');
            const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
            await slackClient.chat.postMessage({
              channel,
              text: '❌ Sorry, something went wrong while processing your request. Please try again or contact support.',
              thread_ts: responseThreadTs
            });
          } catch (slackError) {
            console.error('❌ Error sending error message to Slack:', slackError);
          }
        }
      }

      // ENG-1613: top-level untagged messages no longer trigger anything. The auto-listen pipeline
      // (handleSlackTriggeredSession) was removed entirely — Emma's Slack behavior is exclusively
      // tag-gated via the app_mention handler above. A customer never saw the auto-drafted reply
      // (it only emailed founders@, never posted to Slack), so an account-level opt-in still left
      // them with no visibility that their message had triggered an LLM session at all.

      // Handle message events in threads (follow-up messages to Emma sessions, or non-Emma threads)
      // Filter: must be a plain message in a thread, not a bot message or message_changed/deleted event
      // Allow file_share subtype so that Slack file uploads are also processed
      // Skip messages that @mention Emma — those trigger an app_mention event that Emma handles
      // directly, so processing them here too would cause Emma to answer twice.
      // Direct-message handling: a 1:1 DM to Emma (channel_type 'im', no
      // thread) starts/continues a conversation without requiring an
      // @mention — Slack never emits app_mention for DM text, so without
      // this branch DMs were silently ignored. Threaded DM replies ride the
      // thread handler below via the saved thread mapping.
      if (event.type === 'message' && !event.thread_ts && !event.bot_id
        && (!event.subtype || event.subtype === 'file_share')
        && (event.channel_type === 'im' || String(event.channel || '').startsWith('D'))) {
        const { text, user: slackUserId, channel, ts: messageTs, files } = event;
        try {
          const { userDb } = await import('../services/db');
          const { chatbotDb } = await import('../services/chatbotService');
          const { WebClient } = await import('@slack/web-api');
          const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

          const botId = await getEmmaBotUserId();
          const textWithoutBotMention = botId
            ? String(text || '').replace(new RegExp(`<@${botId}>`, 'g'), '')
            : String(text || '');
          const rawMessage = (await resolveSlackMentionsInText(textWithoutBotMention))
            .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1')
            .replace(/<mailto:([^|>]+)>/g, '$1')
            .trim();

          if (!rawMessage && !(files && files.length > 0)) {
            await slackClient.chat.postMessage({
              channel,
              text: '👋 Hi! Send me a message and I\'ll get started.',
            });
            return;
          }

          // DM identity: resolve the sender's verified Slack email to an
          // AgentWeb user (exact email match only — never fuzzy, so a DM
          // sender can never resolve to someone else's account). Cache the
          // DM-channel mapping: a 1:1 DM channel has exactly one human side.
          let user = null;
          const mappingKey = `slack_channel_mapping_${channel}`;
          const cachedMapping = await settingsService.getSetting(mappingKey);
          if (cachedMapping?.settingValue) {
            const cachedUser = await userDb.getUserById(cachedMapping.settingValue);
            if (cachedUser && !cachedUser.userId?.startsWith('deleted_')) {
              user = cachedUser;
            }
          }
          let requesterEmail: string | null = null;
          if (!user) {
            requesterEmail = await getSlackUserEmail(slackUserId);
            if (requesterEmail) {
              const identityUser = await userDb.getUserByEmail(requesterEmail);
              if (identityUser && !identityUser.userId?.startsWith('deleted_')) {
                user = identityUser;
                await settingsService.setSetting(
                  mappingKey,
                  user.userId,
                  `Slack DM channel to userId mapping for channel ${channel}`,
                  'system'
                );
                console.log(`📝 [slack-dm] resolved via Slack identity (${requesterEmail})`);
              }
            }
          }

          if (!user) {
            const text = requesterEmail
              ? `❌ Sorry, there's no AgentWeb user with the email ${requesterEmail}. Ask an AgentWeb admin to create/link your account, then DM me again.`
              : `❌ Sorry, I couldn't verify a Slack email for you to match an AgentWeb account. Ask an AgentWeb admin for help.`;
            await slackClient.chat.postMessage({ channel, text });
            return;
          }

          const displayName = await getSlackUserDisplayName(slackUserId);
          const userMessage = `${displayName}: ${rawMessage}`;
          console.log('📝 Creating Agent Mode session for DM user:', user.userId);
          const session = await chatbotDb.createChatSession(
            user.userId,
            undefined, // pageContent
            'agent', // portalType
            'slack-dm', // pageIdentifier
            undefined, // selectedStartupId
            undefined, // workflowId
            undefined, // executionId
            undefined, // emailCampaignTaskId
            'regular', // sessionType
            undefined // delegateInfo
          );
          console.log('✅ Agent Mode DM session created:', session.sessionId);
          await handleSlackSessionResponse({
            session,
            user,
            channel,
            ts: messageTs,
            rawMessage,
            userMessage,
            files,
          });
          console.log('✅ Emma Slack DM handled successfully');
        } catch (error) {
          console.error('❌ Error handling Emma Slack DM:', error);
          try {
            const { WebClient } = await import('@slack/web-api');
            const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
            await slackClient.chat.postMessage({
              channel,
              text: '❌ Sorry, something went wrong while processing your request. Please try again or contact support.',
            });
          } catch (slackError) {
            console.error('❌ Error sending DM error message to Slack:', slackError);
          }
        }
        return;
      }

      if (event.type === 'message' && event.thread_ts && !event.bot_id && (!event.subtype || event.subtype === 'file_share')) {
        const { text, user: slackUserId, channel, thread_ts: threadTs, ts: messageTs } = event;

        if (text) {
          const botId = await getEmmaBotUserId();
          if (botId && text.includes(`<@${botId}>`)) return;
        }

        if (text) {
          const { humanEvalService } = await import('../services/humanEvalService');
          const handledHumanEvalReply = await humanEvalService.handleSlackThreadReply({
            channel,
            threadTs,
            messageTs,
            slackUserId,
            text,
          });
          if (handledHumanEvalReply) {
            console.log('🧪 [human-eval] captured Slack thread feedback:', { channel, threadTs, messageTs, slackUserId });
            return;
          }
        }

        // Human-eval replies are captured silently above. All other message
        // events are ignored; Emma turns are driven only by app_mention.
        return;
      }

      return;
    }

    // Unknown event type
    console.log('⚠️ Unknown Slack event type:', type);
    res.status(200).send();
  } catch (error: any) {
    console.error('❌ Error handling Slack event:', error);
    res.status(500).json({ error: 'Failed to handle Slack event' });
  }
});

/**
 * @route POST /api/slack/interactions
 * @desc Handle Slack button interactions and modal submissions
 * @access Public (Slack webhook)
 */
router.post("/interactions", express.urlencoded({ extended: true }), async (req: Request, res: Response) => {
  try {
    // Parse the payload from Slack (Express has already parsed it)
    if (!req.body.payload) {
      console.error("❌ No payload found in request body");
      return res.status(400).json({ error: "Missing payload" });
    }

    const payload = JSON.parse(req.body.payload);
    
    // 🔒 SECURITY: Verify request is actually from Slack using verification token
    if (!process.env.SLACK_VERIFICATION_TOKEN) {
      console.error("❌ SLACK_VERIFICATION_TOKEN not configured");
      return res.status(500).json({ error: "Server configuration error: Missing verification token" });
    }

    if (!payload.token || payload.token !== process.env.SLACK_VERIFICATION_TOKEN) {
      console.error("❌ Invalid Slack verification token");
      return res.status(401).json({ error: "Unauthorized: Invalid verification token" });
    }
    
    console.log("✅ Slack verification token validated successfully");
    
    // 🔒 SECURITY: Validate Slack workspace/team
    if (!payload.team || !payload.team.id) {
      console.error("❌ Missing team information in Slack payload");
      return res.status(401).json({ error: "Unauthorized: Invalid team" });
    }

    // Optional: Add team ID validation if you want to restrict to specific workspaces
    // const allowedTeamIds = process.env.ALLOWED_SLACK_TEAM_IDS?.split(',') || [];
    // if (allowedTeamIds.length > 0 && !allowedTeamIds.includes(payload.team.id)) {
    //   console.error(`❌ Unauthorized Slack team: ${payload.team.id}`);
    //   return res.status(401).json({ error: "Unauthorized: Team not allowed" });
    // }

    console.log(`✅ Validated request from Slack team: ${payload.team.domain} (${payload.team.id})`);
    
    // Handle button clicks
    if (payload.type === 'block_actions') {
      const action = payload.actions[0];
      const user = payload.user;
      const channel = payload.channel;
      const message = payload.message;
      
      if (!action || !action.action_id) {
        return res.status(200).json({ text: "Invalid action" });
      }

      console.log("🔘 Slack button interaction received:", {
        action_id: action.action_id,
        user: user.username,
        channel: channel.id
      });

      // ENG-1644 Phase C: approval-inbox decisions carry a { decisionId }
      // value, not the asset-approval { assetUrl, filename, executionId }
      // shape everything below this handles — intercepted first, own
      // self-contained branch, never falls through to the asset-approval
      // logic.
      if (APPROVAL_DECISION_ACTION_IDS.includes(action.action_id as any)) {
        let decisionData: any;
        try {
          decisionData = JSON.parse(action.value);
        } catch (error) {
          console.error("❌ Error parsing approval-decision action value:", error);
          return res.status(200).json({ text: "Invalid action data" });
        }
        const { decisionId } = decisionData;
        const decision = await approvalInboxService.getDecision(decisionId);
        if (!decision) {
          return res.status(200).json({ response_type: "ephemeral", text: "This decision no longer exists." });
        }
        const authorized = await isAuthorizedApprover(decision, user.id);
        if (!authorized) {
          return res.status(200).json({
            response_type: "ephemeral",
            text: `Only ${decision.approver} (or a configured fallback approver) can act on this decision.`,
          });
        }

        if (action.action_id === 'approve_decision') {
          const result = await resolveApprovalDecision(decisionId, 'approve', user.username || user.id);
          if (!result.claimed) {
            return res.status(200).json({ response_type: "ephemeral", text: `Could not approve — ${result.reason}.` });
          }
          return res.status(200).json({ response_type: "ephemeral", text: `✅ Approved by @${user.username}.` });
        } else if (action.action_id === 'reject_decision') {
          await openDecisionVerdictModal(payload.trigger_id, decisionId, 'reject');
          return res.status(200).json({});
        } else if (action.action_id === 'edit_decision') {
          await openDecisionVerdictModal(payload.trigger_id, decisionId, 'edit');
          return res.status(200).json({});
        }
      }

      // Parse the action data
      let assetData;
      try {
        assetData = JSON.parse(action.value);
      } catch (error) {
        console.error("❌ Error parsing action value:", error);
        return res.status(200).json({ text: "Invalid action data" });
      }

      const { assetUrl, filename, executionId } = assetData;

      if (action.action_id === 'approve_asset') {
        // Get asset type for proper display
        const approval = await approvalDb.getApproval(assetUrl);
        const assetType = approval?.assetType || 'asset';
        
        // Handle approval directly
        await updateApprovalMessage(
          channel.id,
          message.ts,
          'approved',
          user.username || user.id,
          undefined,
          assetType
        );

        await approvalDb.updateApprovalStatus(
          assetUrl,
          'approved',
          user.username || user.id
        );

        // Email the task's subscribers. Shared with the WhatsApp approval path (ENG-273)
        // so 'approved' has one consequence whichever channel it came from.
        await notifySubscribersOfApproval(approval);

        console.log(`✅ Approved: ${assetUrl} by ${user.username}`);
        res.status(200).json({
          response_type: "in_channel",
          text: `✅ Approved by @${user.username}`
        });

      } else if (action.action_id === 'needs_changes_asset') {
        // Get asset type for proper display and revision hint
        const approval = await approvalDb.getApproval(assetUrl);
        const assetType = approval?.assetType || 'asset';
        
        // Open feedback modal instead of direct rejection
        await openFeedbackModal(
          payload.trigger_id,
          assetUrl,
          filename,
          executionId,
          assetType
        );

        console.log(`📝 Opened feedback modal for: ${assetUrl}`);
        res.status(200).json({}); // Empty response for modal trigger

      } else if (action.action_id === 'reject_asset') {
        // Get asset type for proper display
        const approval = await approvalDb.getApproval(assetUrl);
        const assetType = approval?.assetType || 'asset';
        
        // Open rejection modal to get rejection reason
        await openRejectModal(
          payload.trigger_id,
          assetUrl,
          filename,
          executionId,
          assetType
        );

        console.log(`📝 Opened reject modal for: ${assetUrl}`);
        res.status(200).json({}); // Empty response for modal trigger

      } else if (action.action_id === 'test_email') {
        // Get asset type for proper display
        const approval = await approvalDb.getApproval(assetUrl);
        const assetType = approval?.assetType || 'asset';
        
        // Only allow test email for HTML assets
        if (assetType !== 'html') {
          console.log(`❌ Test email not allowed for asset type: ${assetType}`);
          res.status(200).json({
            response_type: "ephemeral",
            text: "❌ Test email is only available for HTML reports."
          });
          return;
        }
        
        // Open test email modal
        await openTestEmailModal(
          payload.trigger_id,
          assetUrl,
          filename,
          executionId,
          assetType
        );

        console.log(`📧 Opened test email modal for: ${assetUrl}`);
        res.status(200).json({}); // Empty response for modal trigger

      } else {
        return res.status(200).json({ text: "Unknown action" });
      }
    }
    
    // Handle modal submission
    else if (payload.type === 'view_submission') {
      const user = payload.user;
      const view = payload.view;

      if (view.callback_id === 'approval_decision_verdict_modal') {
        const metadata = JSON.parse(view.private_metadata);
        const { decisionId, verdict } = metadata as { decisionId: string; verdict: 'reject' | 'edit' };
        const freeText: string | undefined =
          view.state.values.decision_free_text_input?.decision_free_text?.value || undefined;

        if (verdict === 'edit' && !freeText?.trim()) {
          return res.status(200).json({
            response_action: 'errors',
            errors: { decision_free_text_input: 'A correction is required.' },
          });
        }

        const decision = await approvalInboxService.getDecision(decisionId);
        if (!decision) {
          return res.status(200).json({ response_action: 'clear' });
        }
        const authorized = await isAuthorizedApprover(decision, user.id);
        if (!authorized) {
          return res.status(200).json({ response_action: 'clear' });
        }

        // Review fix: the sibling approve_decision button path already
        // checks result.claimed and surfaces a real error — this modal
        // path was discarding the result and always clearing, silently
        // closing as if it succeeded even when the claim genuinely failed
        // (already resolved, expired, etc).
        const result = await resolveApprovalDecision(decisionId, verdict, user.username || user.id, freeText);
        if (!result.claimed) {
          return res.status(200).json({
            response_action: 'errors',
            errors: { decision_free_text_input: `Could not submit — ${result.reason}.` },
          });
        }
        return res.status(200).json({ response_action: 'clear' });
      }

      if (view.callback_id === 'feedback_modal') {
        const metadata = JSON.parse(view.private_metadata);
        const { assetUrl, filename, executionId, assetType } = metadata;
        
        // Get feedback from the modal
        const feedbackValue = view.state.values.feedback_input.feedback_text.value;
        
        console.log("📝 Feedback submission received:", {
          assetUrl,
          feedback: feedbackValue,
          user: user.username
        });

        // Update approval status with feedback
        await approvalDb.updateApprovalStatus(
          assetUrl,
          'needs_changes',
          user.username || user.id,
          feedbackValue
        );

        // Update the original message to show the feedback
        const originalApproval = await approvalDb.getApproval(assetUrl);
        if (originalApproval && originalApproval.slackChannel && originalApproval.slackMessageTs) {
          await updateApprovalMessage(
            originalApproval.slackChannel,
            originalApproval.slackMessageTs,
            'needs_changes',
            user.username || user.id,
            feedbackValue,
            originalApproval.assetType || 'asset'
          );
        }

        // Automatically start a new revision execution with the feedback
        if (originalApproval && originalApproval.executionId) {
          try {
            // Check if this is an Agent Mode asset (executionId pattern: ${sessionId}-images, -videos, or -html)
            const isAgentModeImage = originalApproval.executionId.endsWith('-images');
            const isAgentModeVideo = originalApproval.executionId.endsWith('-videos');
            const isAgentModeHtml = originalApproval.executionId.endsWith('-html');
            const isAgentModeAsset = isAgentModeImage || isAgentModeVideo || isAgentModeHtml;
            const agentSessionId = isAgentModeAsset 
              ? (isAgentModeImage
                ? originalApproval.executionId.replace('-images', '')
                : isAgentModeVideo
                  ? originalApproval.executionId.replace('-videos', '')
                  : originalApproval.executionId.replace('-html', ''))
              : null;
            
            if (agentSessionId) {
              // This is an Agent Mode asset - use the sessionId directly
              console.log(`🤖 Agent Mode asset detected. Session ID: ${agentSessionId}`);
              
              try {
                // Get the session
                const { chatbotDb } = await import('../services/chatbotService');
                const session = await chatbotDb.getChatSession(agentSessionId);
                if (!session) {
                  throw new Error('Session not found');
                }
                
                // ENG-936: one shared prompt for every revision entry point (see revisionService).
                const { buildAgentModeRevisionMessage, isApprovedRevisionSource } = await import(
                  '../services/revisionService'
                );
                const revisionMessage = buildAgentModeRevisionMessage(
                  originalApproval.assetType,
                  originalApproval.assetUrl,
                  feedbackValue
                );
                const requiredFunctions: Array<{ functionName: string; minCount: number }> =
                  originalApproval.assetType === 'image'
                    ? [{ functionName: 'generate_image', minCount: 1 }]
                    : [{ functionName: 'update_html_file', minCount: 1 }];
                
                // Use runVerifiedChat function (same as verified-generate endpoint)
                const { runVerifiedChat } = await import('../controllers/agentModeController');
                
                // Call runVerifiedChat and wait for completion to get the new asset
                // Run this asynchronously so we don't block the Slack response
                runVerifiedChat({
                  sessionId: agentSessionId,
                  userId: session.userId,
                  startingMessage: revisionMessage,
                  requiredFunctions,
                  keywords: [],
                  attachments: [],
                  maxAttempts: 5,
                  approvedRevisionImageSources:
                    originalApproval.assetType === 'image' ? [originalApproval.assetUrl] : undefined,
                }).then(async (result) => {
                  console.log(`✅ Agent Mode revision completed. Success: ${result.success}, Tool calls: ${result.toolCalls.length}`);

                  // Extract the new asset URL from toolCalls
                  let newAssetUrl: string | null = null;
                  let newAssetFilename: string | null = null;
                  let toolCallFailed = false;
                  let awaitingConfirmation = false;
                  let toolCallFailureMessage = '';

                  if (result.success && result.toolCalls.length > 0) {
                    // Find the tool call that created the asset
                    for (const toolCall of result.toolCalls) {
                      const toolResult = toolCall?.result || {};

                      // ENG-936: a tool parked on the human-in-the-loop confirmation gate produced no
                      // asset and never will — no user is watching this auto-revision.
                      if (toolResult.awaitingUserConfirmation === true) {
                        awaitingConfirmation = true;
                        continue;
                      }

                      if (originalApproval.assetType === 'image') {
                        // For images, look for imageUrl, image_url, s3_url, url, or file_url (save_file fallback)
                        // Only extract if the tool call succeeded
                        if (toolResult.success) {
                          if (!isApprovedRevisionSource(toolCall, originalApproval.assetUrl)) {
                            toolCallFailed = true;
                            toolCallFailureMessage = `generate_image used an unapproved source image. Expected "${originalApproval.assetUrl}".`;
                            continue;
                          }

                          const imageUrl = toolResult.imageUrl || toolResult.image_url || toolResult.s3_url || toolResult.url || toolResult.file_url;
                          if (imageUrl) {
                            newAssetUrl = imageUrl;
                            newAssetFilename = toolResult.filename || toolResult.file_name || `revised_${originalApproval.filename || 'image'}`;
                            break;
                          }
                        } else if (toolCall.name === 'generate_image') {
                          // Tool call failed
                          toolCallFailed = true;
                          toolCallFailureMessage = toolResult.message || toolCall.error || 'Unknown error';
                          console.error(`❌ generate_image tool call failed: ${toolCallFailureMessage}`);
                        }
                      } else if (originalApproval.assetType === 'html') {
                        // For HTML, look for file_url, s3_url, or htmlUrl in update_html_file/save_file result
                        // Only extract if the tool call succeeded
                        if (toolResult.success) {
                          const htmlUrl = toolResult.file_url || toolResult.s3_url || toolResult.htmlUrl;
                          if (htmlUrl) {
                            newAssetUrl = htmlUrl;
                            newAssetFilename = toolResult.filename || toolResult.file_name || toolResult.versioned_filename || `revised_${originalApproval.filename || 'report.html'}`;
                            break;
                          } else {
                            // Tool succeeded but no URL in result - this shouldn't happen
                            console.error(`❌ ${toolCall.name} succeeded but no URL in result. Result:`, JSON.stringify(toolResult));
                          }
                        } else if (toolCall.name === 'update_html_file') {
                          // Tool call failed
                          toolCallFailed = true;
                          toolCallFailureMessage = toolResult.message || toolCall.error || 'Unknown error';
                          console.error(`❌ update_html_file tool call failed: ${toolCallFailureMessage}`);
                        }
                      }
                    }
                  }

                  // If we found a new asset, send it to Slack for review
                  if (newAssetUrl && newAssetFilename) {
                    console.log(`📤 Sending new revision asset to Slack: ${newAssetUrl}`);

                    try {
                      // Get the asset type from filename
                      const assetType = getAssetTypeFromFilename(newAssetFilename);

                      // Send approval request to the same Slack channel
                      const approvalResult = await sendApprovalRequestWithTracking({
                        executionId: originalApproval.executionId, // Keep the same executionId format
                        imageUrl: newAssetUrl,
                        filename: newAssetFilename,
                        assetType,
                        userId: originalApproval.userId,
                        channel: originalApproval.slackChannel,
                        channelName: originalApproval.slackChannelName,
                        note: `Revision based on feedback: ${feedbackValue}`
                      });

                      console.log(`✅ New revision asset sent to Slack for review: ${approvalResult.approvalId}`);
                    } catch (error) {
                      console.error('❌ Error sending revision asset to Slack:', error);
                    }
                  } else {
                    // Determine the failure reason for better logging
                    const { describeRevisionFailure } = await import('../services/revisionService');
                    const failure = describeRevisionFailure({ toolCallFailed, toolCallFailureMessage, awaitingConfirmation });
                    const failureReason = failure.reason;

                    console.warn(`⚠️ ${failureReason}. Tool calls: ${JSON.stringify(result.toolCalls)}`);

                    // Send oncall alert with session ishare link and context
                    try {
                      const { chatbotDb } = await import('../services/chatbotService');
                      const { emailService } = await import('../services/emailService');

                      // Get or create ishare link for the session
                      let ishareLink = '';
                      try {
                        ishareLink = await chatbotDb.createOrReuseInteractiveShare(agentSessionId);
                      } catch (shareError) {
                        console.error('Error creating ishare link for oncall alert:', shareError);
                        const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
                        ishareLink = `${customerFrontendUrl}/agent-mode/${agentSessionId}`;
                      }

                      await sendAgentModeOncallAlert({
                        subject: failure.subject,
                        message: `${failure.reason}\n\nSession: ${agentSessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}`,
                        sessionId: agentSessionId,
                        context: {
                          'iShare Link': ishareLink,
                          'Asset Type': originalApproval.assetType || 'unknown',
                          'Original Asset URL': originalApproval.assetUrl,
                          'Original Filename': originalApproval.filename || 'unknown',
                          'Feedback': feedbackValue,
                          'Revision Success': result.success,
                          'Tool Call Failed': toolCallFailed,
                          'Awaiting User Confirmation': awaitingConfirmation,
                          'Tool Call Failure Message': toolCallFailed ? toolCallFailureMessage : 'N/A',
                          'Tool Calls Count': result.toolCalls.length,
                          'Tool Calls': JSON.stringify(result.toolCalls, null, 2),
                          'Execution ID': originalApproval.executionId,
                          'Slack Channel': originalApproval.slackChannel || 'N/A',
                          'User ID': originalApproval.userId || 'N/A'
                        }
                      });
                    } catch (alertError) {
                      console.error('❌ Error sending oncall alert:', alertError);
                    }
                    // ENG-1741: the internal oncall alert above told nobody the reviewer is
                    // actually waiting on — from their side, the revision just never came
                    // back. Tell them directly, in addition to (not instead of) oncall.
                    if (originalApproval.slackChannel) {
                      await postSlackMessage(
                        originalApproval.slackChannel,
                        ':warning: This revision didn\'t go through — please retry the feedback, or check the app for details.',
                        originalApproval.slackMessageTs || undefined,
                      ).catch((slackErr: any) =>
                        console.warn('❌ Failed to post revision-failure notice to Slack:', slackErr?.message || slackErr),
                      );
                    }
                  }
                }).catch(async (error) => {
                  // ENG-1719: expected, benign lock contention (a live chat turn or another
                  // revision on the same session), not a real failure — paging on-call for
                  // it was the exact false alarm this fix exists to stop.
                  const { isSessionBusyError } = await import('../controllers/agentModeController');
                  if (isSessionBusyError(error)) {
                    console.warn(`⏳ Agent Mode revision for session ${agentSessionId} skipped — session was busy with another generation in progress.`);
                    // ENG-1741: previously silent to the reviewer — only this log line existed.
                    if (originalApproval.slackChannel) {
                      await postSlackMessage(
                        originalApproval.slackChannel,
                        ':hourglass_flowing_sand: This session was busy with another generation in progress, ' +
                        'so the auto-revision couldn\'t run just now. Please retry the feedback in a moment.',
                        originalApproval.slackMessageTs || undefined,
                      ).catch((slackErr: any) =>
                        console.warn('❌ Failed to post session-busy notice to Slack:', slackErr?.message || slackErr),
                      );
                    }
                    return;
                  }
                  // ENG-669 PR-C: the chat's model was refused (runVerifiedChat saved the refusal to the chat). Only the
                  // owner can fix it: tell the reviewer what to do, and do not page on-call (not an outage).
                  const { isModelUnavailableError } = await import('../services/agentMode/modelUnavailable');
                  if (isModelUnavailableError(error)) {
                    console.warn(`Agent Mode revision for session ${agentSessionId} refused: model_unavailable (${error.reason}).`);
                    if (originalApproval.slackChannel) {
                      const { modelRefusalReviewerNotice } = await import('../utils/modelRefusalReviewerNotice');
                      await postSlackMessage(
                        originalApproval.slackChannel,
                        await modelRefusalReviewerNotice(error),
                        originalApproval.slackMessageTs || undefined,
                      ).catch((slackErr: any) =>
                        console.warn('❌ Failed to post model-refusal notice to Slack:', slackErr?.message || slackErr),
                      );
                    }
                    return;
                  }
                  console.error('❌ Error in Agent Mode verified-generate:', error);
                  try {
                    const isSessionLimit = isSessionLimitError(error);
                    await sendAgentModeOncallAlert({
                      subject: isSessionLimit
                        ? 'Agent Mode Verified Generate: Session limit exceeded'
                        : 'Agent Mode Verified Generate: Failed',
                      message: isSessionLimit
                        ? `Verified generation failed because the session reached its limit.\n\nSession: ${agentSessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}`
                        : `Verified generation failed.\n\nSession: ${agentSessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}`,
                      sessionId: agentSessionId,
                      context: {
                        'Asset Type': originalApproval.assetType || 'unknown',
                        'Original Asset URL': originalApproval.assetUrl,
                        'Original Filename': originalApproval.filename || 'unknown',
                        'Feedback': feedbackValue,
                        'Execution ID': originalApproval.executionId,
                        'Slack Channel': originalApproval.slackChannel || 'N/A',
                        'User ID': originalApproval.userId || 'N/A',
                        'Error': error.message || String(error)
                      }
                    });
                  } catch (alertError) {
                    console.error('❌ Error sending oncall alert:', alertError);
                  }
                  // ENG-1741: notify the reviewer directly too, in addition to oncall.
                  if (originalApproval.slackChannel) {
                    await postSlackMessage(
                      originalApproval.slackChannel,
                      ':warning: This revision didn\'t go through — please retry the feedback, or check the app for details.',
                      originalApproval.slackMessageTs || undefined,
                    ).catch((slackErr: any) =>
                      console.warn('❌ Failed to post revision-failure notice to Slack:', slackErr?.message || slackErr),
                    );
                  }
                });

                console.log(`✅ Submitted feedback to Agent Mode session via verified-generate: ${agentSessionId}`);
              } catch (agentModeError) {
                console.error('❌ Error submitting feedback to Agent Mode session:', agentModeError);
                // Don't fail the feedback submission if revision start fails
              }
            } else {
              // This is a regular browser task - try to get the execution
              const execution = await taskDb.getTaskExecutionById(originalApproval.executionId);
              if (execution) {
                // Get the task to check if it's from Agent Mode
                const task = await taskDb.getTaskById(execution.taskId);
                const isAgentMode = task?.sessionId;
                
                if (isAgentMode) {
                  // For Agent Mode sessions, use verified-generate approach like Images/Reports pages
                  console.log(`🤖 Agent Mode session detected. Using verified-generate for session: ${task.sessionId}`);
                  
                  try {
                    // Update task with Slack channel info so revision gets sent to Slack
                    if (originalApproval.slackChannel) {
                      await taskDb.updateTask(execution.taskId, {
                        slackChannel: originalApproval.slackChannel
                      });
                    }
                    
                    // Get session to find userId
                    const { chatbotDb } = await import('../services/chatbotService');
                    const session = await chatbotDb.getChatSession(task.sessionId);
                    if (!session) {
                      throw new Error('Session not found');
                    }
                    
                    // ENG-936: one shared prompt for every revision entry point (see revisionService).
                    const { buildAgentModeRevisionMessage, isApprovedRevisionSource } = await import(
                      '../services/revisionService'
                    );
                    const revisionMessage = buildAgentModeRevisionMessage(
                      originalApproval.assetType,
                      originalApproval.assetUrl,
                      feedbackValue
                    );
                    const requiredFunctions: Array<{ functionName: string; minCount: number }> =
                      originalApproval.assetType === 'image'
                        ? [{ functionName: 'generate_image', minCount: 1 }]
                        : [{ functionName: 'update_html_file', minCount: 1 }];
                    
                    // Use runVerifiedChat function (same as verified-generate endpoint)
                    const { runVerifiedChat } = await import('../controllers/agentModeController');
                    
                    // Call runVerifiedChat and wait for completion to get the new asset
                    // Run this asynchronously so we don't block the Slack response
                    runVerifiedChat({
                      sessionId: task.sessionId,
                      userId: session.userId,
                      startingMessage: revisionMessage,
                      requiredFunctions,
                      keywords: [],
                      attachments: [],
                      maxAttempts: 5,
                      approvedRevisionImageSources:
                        originalApproval.assetType === 'image' ? [originalApproval.assetUrl] : undefined,
                    }).then(async (result) => {
                      console.log(`✅ Agent Mode revision completed. Success: ${result.success}, Tool calls: ${result.toolCalls.length}`);

                      // Extract the new asset URL from toolCalls
                      let newAssetUrl: string | null = null;
                      let newAssetFilename: string | null = null;
                      let toolCallFailed = false;
                      let awaitingConfirmation = false;
                      let toolCallFailureMessage = '';

                      if (result.success && result.toolCalls.length > 0) {
                        // Find the tool call that created the asset
                        for (const toolCall of result.toolCalls) {
                          const toolResult = toolCall?.result || {};

                          // ENG-936: a tool parked on the human-in-the-loop confirmation gate produced no
                          // asset and never will — no user is watching this auto-revision.
                          if (toolResult.awaitingUserConfirmation === true) {
                            awaitingConfirmation = true;
                            continue;
                          }

                          if (originalApproval.assetType === 'image') {
                            // For images, look for imageUrl, image_url, s3_url, url, or file_url (save_file fallback)
                            // Only extract if the tool call succeeded
                            if (toolResult.success) {
                              if (!isApprovedRevisionSource(toolCall, originalApproval.assetUrl)) {
                                toolCallFailed = true;
                                toolCallFailureMessage = `generate_image used an unapproved source image. Expected "${originalApproval.assetUrl}".`;
                                continue;
                              }

                              const imageUrl = toolResult.imageUrl || toolResult.image_url || toolResult.s3_url || toolResult.url || toolResult.file_url;
                              if (imageUrl) {
                                newAssetUrl = imageUrl;
                                newAssetFilename = toolResult.filename || toolResult.file_name || `revised_${originalApproval.filename || 'image'}`;
                                break;
                              }
                            } else if (toolCall.name === 'generate_image') {
                              // Tool call failed
                              toolCallFailed = true;
                              toolCallFailureMessage = toolResult.message || toolCall.error || 'Unknown error';
                              console.error(`❌ generate_image tool call failed: ${toolCallFailureMessage}`);
                            }
                          } else if (originalApproval.assetType === 'html') {
                            // For HTML, look for file_url, s3_url, or htmlUrl in update_html_file/save_file result
                            // Only extract if the tool call succeeded
                            if (toolResult.success) {
                              const htmlUrl = toolResult.file_url || toolResult.s3_url || toolResult.htmlUrl;
                              if (htmlUrl) {
                                newAssetUrl = htmlUrl;
                                newAssetFilename = toolResult.filename || toolResult.file_name || toolResult.versioned_filename || `revised_${originalApproval.filename || 'report.html'}`;
                                break;
                              } else {
                                // Tool succeeded but no URL in result - this shouldn't happen
                                console.error(`❌ ${toolCall.name} succeeded but no URL in result. Result:`, JSON.stringify(toolResult));
                              }
                            } else if (toolCall.name === 'update_html_file') {
                              // Tool call failed
                              toolCallFailed = true;
                              toolCallFailureMessage = toolResult.message || toolCall.error || 'Unknown error';
                              console.error(`❌ update_html_file tool call failed: ${toolCallFailureMessage}`);
                            }
                          }
                        }
                      }
                      
                      // If we found a new asset, send it to Slack for review
                      if (newAssetUrl && newAssetFilename) {
                        console.log(`📤 Sending new revision asset to Slack: ${newAssetUrl}`);
                        
                        try {
                          // Get the asset type from filename
                          const assetType = getAssetTypeFromFilename(newAssetFilename);
                          
                          // Send approval request to the same Slack channel
                          const approvalResult = await sendApprovalRequestWithTracking({
                            executionId: originalApproval.executionId,
                            imageUrl: newAssetUrl,
                            filename: newAssetFilename,
                            assetType,
                            userId: originalApproval.userId,
                            channel: originalApproval.slackChannel,
                            channelName: originalApproval.slackChannelName,
                            note: `Revision based on feedback: ${feedbackValue}`
                          });
                          
                          console.log(`✅ New revision asset sent to Slack for review: ${approvalResult.approvalId}`);
                        } catch (error) {
                          console.error('❌ Error sending revision asset to Slack:', error);
                        }
                      } else {
                        // Determine the failure reason for better logging
                        const { describeRevisionFailure } = await import('../services/revisionService');
                        const failure = describeRevisionFailure({ toolCallFailed, toolCallFailureMessage, awaitingConfirmation });
                        const failureReason = failure.reason;

                        console.warn(`⚠️ ${failureReason}. Tool calls: ${JSON.stringify(result.toolCalls)}`);

                        // Send oncall alert with session ishare link and context
                        try {
                          const { chatbotDb } = await import('../services/chatbotService');
                          const { emailService } = await import('../services/emailService');

                          // Get or create ishare link for the session
                          let ishareLink = '';
                          try {
                            ishareLink = await chatbotDb.createOrReuseInteractiveShare(task.sessionId);
                          } catch (shareError) {
                            console.error('Error creating ishare link for oncall alert:', shareError);
                            const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
                            ishareLink = `${customerFrontendUrl}/agent-mode/${task.sessionId}`;
                          }

                          await sendAgentModeOncallAlert({
                            subject: failure.subject,
                            message: `${failure.reason}\n\nSession: ${task.sessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}`,
                            sessionId: task.sessionId,
                            context: {
                              'iShare Link': ishareLink,
                              'Asset Type': originalApproval.assetType || 'unknown',
                              'Original Asset URL': originalApproval.assetUrl,
                              'Original Filename': originalApproval.filename || 'unknown',
                              'Feedback': feedbackValue,
                              'Revision Success': result.success,
                              'Tool Call Failed': toolCallFailed,
                          'Awaiting User Confirmation': awaitingConfirmation,
                              'Tool Call Failure Message': toolCallFailed ? toolCallFailureMessage : 'N/A',
                              'Tool Calls Count': result.toolCalls.length,
                              'Tool Calls': JSON.stringify(result.toolCalls, null, 2),
                              'Execution ID': originalApproval.executionId,
                              'Task ID': execution.taskId,
                              'Slack Channel': originalApproval.slackChannel || 'N/A',
                              'User ID': originalApproval.userId || 'N/A'
                            }
                          });
                        } catch (alertError) {
                          console.error('❌ Error sending oncall alert:', alertError);
                        }
                        // ENG-1741: notify the reviewer directly too, not just internal oncall.
                        if (originalApproval.slackChannel) {
                          await postSlackMessage(
                            originalApproval.slackChannel,
                            ':warning: This revision didn\'t go through — please retry the feedback, or check the app for details.',
                            originalApproval.slackMessageTs || undefined,
                          ).catch((slackErr: any) =>
                            console.warn('❌ Failed to post revision-failure notice to Slack:', slackErr?.message || slackErr),
                          );
                        }
                      }
                    }).catch(async (error) => {
                      // ENG-1719: expected, benign lock contention, not a real failure —
                      // paging on-call for it was the exact false alarm this fix exists
                      // to stop.
                      const { isSessionBusyError } = await import('../controllers/agentModeController');
                      if (isSessionBusyError(error)) {
                        console.warn(`⏳ Agent Mode revision for session ${task.sessionId} skipped — session was busy with another generation in progress.`);
                        // ENG-1741: previously silent to the reviewer — only this log line existed.
                        if (originalApproval.slackChannel) {
                          await postSlackMessage(
                            originalApproval.slackChannel,
                            ':hourglass_flowing_sand: This session was busy with another generation in progress, ' +
                            'so the auto-revision couldn\'t run just now. Please retry the feedback in a moment.',
                            originalApproval.slackMessageTs || undefined,
                          ).catch((slackErr: any) =>
                            console.warn('❌ Failed to post session-busy notice to Slack:', slackErr?.message || slackErr),
                          );
                        }
                        return;
                      }
                      // ENG-669 PR-C: the chat's model was refused (runVerifiedChat saved the refusal to the chat). Only the
                      // owner can fix it: tell the reviewer what to do, and do not page on-call (not an outage).
                      const { isModelUnavailableError } = await import('../services/agentMode/modelUnavailable');
                      if (isModelUnavailableError(error)) {
                        console.warn(`Agent Mode revision for session ${task.sessionId} refused: model_unavailable (${error.reason}).`);
                        if (originalApproval.slackChannel) {
                          const { modelRefusalReviewerNotice } = await import('../utils/modelRefusalReviewerNotice');
                          await postSlackMessage(
                            originalApproval.slackChannel,
                            await modelRefusalReviewerNotice(error),
                            originalApproval.slackMessageTs || undefined,
                          ).catch((slackErr: any) =>
                            console.warn('❌ Failed to post model-refusal notice to Slack:', slackErr?.message || slackErr),
                          );
                        }
                        return;
                      }
                      console.error('❌ Error in Agent Mode verified-generate:', error);
                      try {
                        const isSessionLimit = isSessionLimitError(error);
                        await sendAgentModeOncallAlert({
                          subject: isSessionLimit
                            ? 'Agent Mode Verified Generate: Session limit exceeded'
                            : 'Agent Mode Verified Generate: Failed',
                          message: isSessionLimit
                            ? `Verified generation failed because the session reached its limit.\n\nSession: ${task.sessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}`
                            : `Verified generation failed.\n\nSession: ${task.sessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}`,
                          sessionId: task.sessionId,
                          context: {
                            'Asset Type': originalApproval.assetType || 'unknown',
                            'Original Asset URL': originalApproval.assetUrl,
                            'Original Filename': originalApproval.filename || 'unknown',
                            'Feedback': feedbackValue,
                            'Execution ID': originalApproval.executionId,
                            'Task ID': execution.taskId,
                            'Slack Channel': originalApproval.slackChannel || 'N/A',
                            'User ID': originalApproval.userId || 'N/A',
                            'Error': error.message || String(error)
                          }
                        });
                      } catch (alertError) {
                        console.error('❌ Error sending oncall alert:', alertError);
                      }
                      // ENG-1741: notify the reviewer directly too, in addition to oncall.
                      if (originalApproval.slackChannel) {
                        await postSlackMessage(
                          originalApproval.slackChannel,
                          ':warning: This revision didn\'t go through — please retry the feedback, or check the app for details.',
                          originalApproval.slackMessageTs || undefined,
                        ).catch((slackErr: any) =>
                          console.warn('❌ Failed to post revision-failure notice to Slack:', slackErr?.message || slackErr),
                        );
                      }
                    });

                    console.log(`✅ Submitted feedback to Agent Mode session via verified-generate: ${task.sessionId}`);
                  } catch (agentModeError) {
                    console.error('❌ Error submitting feedback to Agent Mode session:', agentModeError);
                    // Fall back to regular revision creation
                    console.log('🔄 Falling back to regular revision creation');
                    throw agentModeError; // Will be caught by outer catch
                  }
                } else {
                  // For browser tasks, use the existing revision creation flow
                  console.log(`🚀 Starting feedback-based revision for task: ${execution.taskId}`);
                  
                  // Use the common function to create revision execution
                  const revisionResult = await createRevisionExecutionFromSlack(
                    execution.taskId,
                    `Please revise this ${originalApproval.assetType || 'asset'} based on the following feedback: ${feedbackValue}`,
                    originalApproval.assetUrl,
                    originalApproval.executionId,
                    originalApproval.assetType || 'asset',
                    user.username || user.id,
                    1,
                    originalApproval.slackChannel,
                    originalApproval.slackChannelName
                  );
                  
                  if (revisionResult.success && revisionResult.execution) {
                    console.log(`✅ Feedback-based revision started: ${revisionResult.execution.executionId}`);
                  } else {
                    console.error(`❌ Failed to start feedback-based revision`);
                  }
                }
              } else {
                console.error(`❌ Could not find execution for ID: ${originalApproval.executionId}`);
              }
            }
          } catch (error) {
            console.error('❌ Error starting feedback-based revision:', error);
            // Don't fail the feedback submission if revision start fails
          }
        }

        console.log(`🔶 Changes requested for: ${assetUrl} by ${user.username}`);
        res.status(200).json({}); // Empty response for successful submission
      } else if (view.callback_id === 'reject_modal') {
        const metadata = JSON.parse(view.private_metadata);
        const { assetUrl, filename, executionId, assetType } = metadata;
        
        // Get rejection reason from the modal
        const rejectReasonValue = view.state.values.reject_reason_input.reject_reason_text.value;
        
        console.log("❌ Rejection submission received:", {
          assetUrl,
          rejectReason: rejectReasonValue,
          user: user.username
        });

        // Update approval status with rejection reason (stored as feedback)
        await approvalDb.updateApprovalStatus(
          assetUrl,
          'rejected',
          user.username || user.id,
          rejectReasonValue
        );

        // Update the original message to show the rejection reason
        const originalApproval = await approvalDb.getApproval(assetUrl);
        if (originalApproval && originalApproval.slackChannel && originalApproval.slackMessageTs) {
          await updateApprovalMessage(
            originalApproval.slackChannel,
            originalApproval.slackMessageTs,
            'rejected',
            user.username || user.id,
            rejectReasonValue,
            originalApproval.assetType || 'asset'
          );
        }

        console.log(`❌ Rejected: ${assetUrl} by ${user.username} with reason: ${rejectReasonValue}`);
        res.status(200).json({}); // Empty response for successful submission
      } else if (view.callback_id === 'test_email_modal') {
        const metadata = JSON.parse(view.private_metadata);
        const { assetUrl, filename, executionId, assetType } = metadata;
        
        // Get email from the modal
        const emailValue = view.state.values.email_input.email_text.value;
        
        console.log("📧 Test email submission received:", {
          assetUrl,
          email: emailValue,
          user: user.username
        });

        // Send test email using the existing email service
        try {
          if (executionId) {
            // Use the existing sendTaskExecutionEmail function
            await emailService.sendTaskExecutionEmail(
              emailValue,
              executionId
            );
            console.log(`✅ Test email sent successfully to: ${emailValue}`);
          } else {
            // If no executionId, send a simple notification email
            const subject = `Test Email - ${filename}`;
            const text = `This is a test email for the asset: ${filename}\nAsset URL: ${assetUrl}`;
            const html = `
              <h2>Test Email - ${filename}</h2>
              <p>This is a test email for the asset: <strong>${filename}</strong></p>
              <p><a href="${assetUrl}" target="_blank">View Asset</a></p>
            `;
            
            await emailService.sendEmail(emailValue, subject, text, html);
            console.log(`✅ Test email sent successfully to: ${emailValue}`);
          }
        } catch (error) {
          console.error('❌ Error sending test email:', error);
          // Return an error response to Slack
          res.status(200).json({
            response_action: "errors",
            errors: {
              email_input: "Failed to send test email. Please try again."
            }
          });
          return;
        }

        console.log(`📧 Test email sent for: ${assetUrl} by ${user.username}`);
        res.status(200).json({}); // Empty response for successful submission
      } else {
        return res.status(200).json({ text: "Unknown modal" });
      }
    }
    
    else {
      return res.status(200).json({ text: "Unknown interaction type" });
    }

  } catch (error: any) {
    console.error("❌ Error handling Slack interaction:", error.message);
    res.status(200).json({ text: "Error processing request" });
  }
});

/**
 * @route POST /api/slack/approvals
 * @desc Get approval status for multiple assets by URLs
 * @access Private (requires authentication)
 */
router.post("/approvals", authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { assetUrls } = authReq.body;
    
    if (!assetUrls || !Array.isArray(assetUrls)) {
      return res.status(400).json({ error: "Asset URLs array is required" });
    }

    console.log(`📋 Getting approval status for ${assetUrls.length} assets`);

    const approvals = await approvalDb.getApprovalsByAssetUrls(assetUrls);
    
    // Transform to a format that's easy for the frontend to use
    const approvalMap: Record<string, any> = {};
    approvals.forEach(approval => {
      approvalMap[approval.assetUrl] = {
        status: approval.status,
        reviewedBy: approval.reviewedBy,
        feedback: approval.feedback,
        createdAt: approval.createdAt,
        updatedAt: approval.updatedAt,
        slackChannel: approval.slackChannel,
        slackMessageTs: approval.slackMessageTs,
      };
    });

    console.log(`✅ Found ${approvals.length} approval(s) for requested assets`);
    
    res.json({ 
      success: true, 
      approvals: approvalMap
    });
  } catch (error: any) {
    console.error("❌ Error getting approval status:", error.message);
    res.status(500).json({ 
      error: "Failed to get approval status", 
      details: error.message 
    });
  }
});

/**
 * @route GET /api/slack/approvals
 * @desc Get all approval status for the authenticated user
 * @access Private (requires authentication)
 */
router.get("/approvals", authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    console.log(`📋 Getting all approval status for user ${authReq.user.userId}`);

    const approvals = await approvalDb.getApprovalsByUserId(authReq.user.userId);
    
    // Transform to a format that's easy for the frontend to use
    const approvalMap: Record<string, any> = {};
    approvals.forEach(approval => {
      approvalMap[approval.assetUrl] = {
        status: approval.status,
        reviewedBy: approval.reviewedBy,
        feedback: approval.feedback,
        createdAt: approval.createdAt,
        updatedAt: approval.updatedAt,
        slackChannel: approval.slackChannel,
        slackMessageTs: approval.slackMessageTs,
      };
    });

    console.log(`✅ Found ${approvals.length} approval(s) for user`);
    
    res.json({ 
      success: true, 
      approvals: approvalMap
    });
  } catch (error: any) {
    console.error("❌ Error getting approval status:", error.message);
    res.status(500).json({ 
      error: "Failed to get approval status", 
      details: error.message 
    });
  }
});

// Polling removed - real-time webhook interactions handle approval updates

// parseApprovalStatus function removed - no longer needed with real-time webhook interactions

/**
 * @route GET /api/slack/status
 * @desc Check Slack integration status
 * @access Private (requires authentication)
 */
router.get("/status", authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const hasToken = !!process.env.SLACK_BOT_TOKEN;
    const hasSigningSecret = !!process.env.SLACK_SIGNING_SECRET;
    
    if (!hasToken) {
      return res.json({
        status: "not_configured",
        message: "SLACK_BOT_TOKEN is not configured",
        hasToken: false,
        hasSigningSecret
      });
    }

    // Try to make a simple API call to verify the token works
    try {
      const channels = await getSlackChannels();
      res.json({
        status: "connected",
        message: "Slack integration is working",
        hasToken: true,
        hasSigningSecret,
        channelCount: channels.length
      });
    } catch (error) {
      res.json({
        status: "error",
        message: "Slack token is configured but connection failed",
        hasToken: true,
        hasSigningSecret,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  } catch (error: any) {
    console.error("❌ Error checking Slack status:", error);
    res.status(500).json({ 
      error: "Failed to check Slack status", 
      details: error.message 
    });
  }
});

/**
 * @route GET /api/slack/test
 * @desc Test endpoint for verifying Slack integration setup
 * @access Public
 */
router.get("/test", (req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Slack integration endpoints are working",
    interactionUrl: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/slack/interactions`,
    endpoints: {
      interactions: "/api/slack/interactions (for Slack button clicks)",
      channels: "/api/slack/channels",
      sendApproval: "/api/slack/send-approval",
      pollUpdates: "/api/slack/poll-updates",
      status: "/api/slack/status"
    },
    setup: {
      slackBotToken: !!process.env.SLACK_BOT_TOKEN,
      slackSigningSecret: !!process.env.SLACK_SIGNING_SECRET,
      backendUrl: process.env.BACKEND_URL || 'http://localhost:3001'
    }
  });
});

/**
 * @route POST /api/slack/submit-revision
 * @desc Submit a revision for an approved asset and send new approval request
 * @access Private (requires authentication)
 */
router.post("/submit-revision", authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const { executionId, originalAssetUrl, originalFilename, selectedAssetUrl, note } = authReq.body;
    const userId = authReq.user?.userId;

    if (!executionId || !originalAssetUrl || !originalFilename || !selectedAssetUrl) {
      return res.status(400).json({ 
        error: "Missing required fields: executionId, originalAssetUrl, originalFilename, selectedAssetUrl" 
      });
    }

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated" });
    }

    // Get the original approval to find the channel and asset info
    const originalApproval = await approvalDb.getApproval(originalAssetUrl);
    if (!originalApproval) {
      return res.status(404).json({ error: "Original approval not found" });
    }

    // Update the original approval status to "revision_submitted"
    await approvalDb.updateApprovalStatus(
      originalAssetUrl, 
      'revision_submitted' as any, 
      userId,
      `Revision submitted by user - selected image: ${selectedAssetUrl}`
    );

    // Extract filename from selectedAssetUrl
    const selectedFilename = selectedAssetUrl.split('/').pop() || 'revised_asset';
    const assetType = getAssetTypeFromFilename(selectedFilename);

    // Send new approval request for the selected revision asset
    const result = await sendApprovalRequest({
      executionId,
      imageUrl: selectedAssetUrl, // Using selectedAssetUrl as the new asset to review
      filename: selectedFilename,
      assetType,
      userId,
      channel: originalApproval.slackChannel, // Send to same channel as original
      note: note, // Include the updated note
    });

    // Create new approval record for the revision
    const newApproval = await approvalDb.createApproval({
      assetUrl: selectedAssetUrl,
      filename: selectedFilename,
      assetType,
      executionId,
      userId,
      slackChannel: originalApproval.slackChannel,
      slackChannelName: originalApproval.slackChannelName,
      slackMessageTs: result.messageTs,
      note: note, // Store the updated note
    });

    console.log("✅ Revision submitted and new approval request sent:", {
      originalAsset: originalAssetUrl,
      revisionAsset: selectedAssetUrl,
      channel: originalApproval.slackChannel
    });
    
    res.json({ 
      success: true, 
      message: "Revision submitted and new approval request sent to Slack",
      selectedAssetUrl,
      newApprovalId: newApproval.assetUrl
    });
  } catch (error: any) {
    console.error("❌ Error submitting revision:", error.message);
    res.status(500).json({ 
      error: "Failed to submit revision", 
      details: error.message 
    });
  }
});

export default router;
