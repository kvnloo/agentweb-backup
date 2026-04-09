import express, { Request, Response } from "express"; // slack-triggered-session v2
import { authenticateToken } from "../middleware/auth";
import { AuthenticatedRequest } from "../middleware/auth";
import {
  getSlackChannels,
  sendApprovalRequest,
  sendApprovalRequestWithTracking,
  updateApprovalMessage,
  openFeedbackModal,
  openRejectModal,
  openTestEmailModal,
  postThreadResponse,
  postThinkingMessage,
  deleteSlackMessage,
  getSlackUserDisplayName,
  getSlackUserEmail,
  downloadSlackFile
} from "../services/slackService";
import { approvalDb, getAssetTypeFromFilename } from "../services/approvalDb";
import { taskDb, subscriberDb } from "../services/db";
import { emailService } from "../services/emailService";
import { createRevisionExecutionFromSlack } from "../controllers/tasks";
import { isSessionLimitError } from "../utils/agentModeErrors";
import { sendAgentModeOncallAlert } from "../utils/agentModeAlerts";

const router = express.Router();

function userMatchesChannel(u: any, channel: string): boolean {
  return (u.slackChannels && u.slackChannels.includes(channel)) || u.slackChannel === channel;
}

/**
 * Helper: handles the full slack triggered session flow for non-Emma messages.
 * Triages message, creates session, generates Emma response, emails founders.
 * Does NOT post to Slack — email only, so the team can decide how to respond.
 * @param ts For top-level messages: the message's own ts. For thread replies: the thread_ts (root).
 */
async function handleSlackTriggeredSession(params: {
  text: string;
  slackUserId: string;
  channel: string;
  ts: string;
}) {
  const { text, slackUserId, channel, ts } = params;
  try {
    const { userDb } = await import('../services/db');
    const { chatbotDb } = await import('../services/chatbotService');
    const { agentModeService } = await import('../services/agentModeService');
    const { settingsService } = await import('../services/settingsService');

    // Normalize Slack formatting
    const rawMessage = text
      .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1')
      .replace(/<mailto:([^|>]+)>/g, '$1')
      .trim();

    if (!rawMessage) return;

    // Look up user by slackChannel field (with cache)
    const mappingKey = `slack_channel_mapping_${channel}`;
    let user = null;

    const cachedMapping = await settingsService.getSetting(mappingKey);
    if (cachedMapping?.settingValue) {
      user = await userDb.getUserById(cachedMapping.settingValue);
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

    if (!user) {
      console.log(`📨 [slack-triggered] channel ${channel} not connected to any user, ignoring`);
      return;
    }

    // Triage: does this message need handling?
    console.log(`📨 [slack-triggered] user found (${user.email}), starting triage...`);
    const needsHandling = await agentModeService.triageSlackMessage(rawMessage);
    if (!needsHandling) {
      console.log(`📨 [slack-triggered] triage: skipping message in channel ${channel}`);
      return;
    }

    console.log(`📨 [slack-triggered] triage passed, creating session for user ${user.userId}`);

    const displayName = await getSlackUserDisplayName(slackUserId);
    const userMessage = `${displayName}: ${rawMessage}`;

    const session = await chatbotDb.createChatSession(
      user.userId,
      undefined,
      'agent',
      'slack-triggered',
      undefined,
      undefined,
      undefined,
      undefined,
      'regular'
    );

    const sessionTitle = rawMessage.length > 50 ? rawMessage.substring(0, 47) + '...' : rawMessage;
    await chatbotDb.updateSessionTitle(session.sessionId, sessionTitle);

    // Save thread-to-session mapping so thread replies continue the session
    const threadMappingKey = `slack_thread_${channel}_${ts}`;
    await settingsService.setSetting(
      threadMappingKey,
      JSON.stringify({ sessionId: session.sessionId, userId: user.userId, type: 'triggered' }),
      `Slack thread to session mapping`,
      'system'
    );
    await chatbotDb.updateSessionSlackThread(session.sessionId, { channel, threadTs: ts });

    // Generate Emma's response
    const { generateSessionResponse } = await import('../controllers/agentModeController');
    const llmModel = session.llmModel || await agentModeService.getDefaultModel();
    let emmaResponse = '';
    try {
      const result = await generateSessionResponse(session.sessionId, userMessage, user.userId, llmModel);
      emmaResponse = result.content;
    } catch (genError) {
      console.error('❌ Error generating Emma response for slack triggered session:', genError);
      emmaResponse = '(Emma was unable to generate a response for this message.)';
    }

    // Resolve channel name
    let channelName = channel;
    try {
      const { WebClient } = await import('@slack/web-api');
      const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
      const info = await slackClient.conversations.info({ channel });
      channelName = (info.channel as any)?.name || channel;
    } catch { /* non-blocking */ }

    await emailService.sendSlackTriggeredSessionEmail('founders@agentweb.pro', {
      sessionId: session.sessionId,
      userEmail: user.email,
      channelName,
      originalMessage: rawMessage,
      emmaResponse,
      receivedAt: new Date().toISOString(),
    });

    console.log(`✅ [slack-triggered] session handled: ${session.sessionId}`);
  } catch (error) {
    console.error('❌ Error in handleSlackTriggeredSession:', error);
  }
}

/**
 * Helper: handles the shared post-session-creation flow for Slack sessions.
 * Sets title, associates thread, saves mapping, generates response, posts to Slack.
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
}) {
  const { session, user, channel, ts, rawMessage, userMessage, adminEmail, isAdminChannel } = params;
  const { chatbotDb } = await import('../services/chatbotService');
  const { settingsService } = await import('../services/settingsService');
  const { ensureGtmWorkItemForSlackSession } = await import('../services/gtmPlanService');

  // Set session title based on raw message (without username prefix)
  const sessionTitle = rawMessage.length > 50
    ? rawMessage.substring(0, 47) + '...'
    : rawMessage;
  await chatbotDb.updateSessionTitle(session.sessionId, sessionTitle);

  // Track this Slack session as a GTM Tracker work item
  let gtmTrackerLink: string | null = null;
  try {
    const gtmResult = await ensureGtmWorkItemForSlackSession({
      userId: user.userId,
      sessionId: session.sessionId,
      rawMessage,
      adminEmail,
    });
    if (gtmResult) {
      await chatbotDb.updateSessionGtmWorkItem(session.sessionId, gtmResult);
      const deepLinkParams = `?planId=${gtmResult.planId}&phaseId=${gtmResult.phaseId}`;
      if (isAdminChannel) {
        // Admin-channel sessions: link to partner portal GTM ops page
        const partnerPortalUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        gtmTrackerLink = `${partnerPortalUrl}/gtm-ops${deepLinkParams}`;
      } else {
        // Regular user sessions: link to customer portal GTM plan page
        const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
        gtmTrackerLink = `${customerFrontendUrl}/gtm-plan${deepLinkParams}`;
      }
      console.log(`📊 Slack session ${session.sessionId} tracked in GTM plan ${gtmResult.planId}`);
    }
  } catch (gtmError) {
    console.error('⚠️ Non-blocking: Failed to track Slack session in GTM Tracker:', gtmError);
  }

  // Associate the session with this Slack thread
  const slackThread = { channel, threadTs: ts };
  await chatbotDb.updateSessionSlackThread(session.sessionId, slackThread);

  // Save thread-to-session mapping for future thread replies
  const threadMappingKey = `slack_thread_${channel}_${ts}`;
  await settingsService.setSetting(
    threadMappingKey,
    JSON.stringify({ sessionId: session.sessionId, userId: user.userId }),
    `Slack thread to session mapping`,
    'system'
  );

  // Create interactive share link so user can optionally continue in the portal
  const ishareLink = await chatbotDb.createOrReuseInteractiveShare(session.sessionId);
  console.log('🔗 iShare link created for Slack session:', ishareLink);

  // Post a "thinking" message while we generate the response
  const thinkingTs = await postThinkingMessage(channel, ts);

  // Generate the response
  const { generateSessionResponse } = await import('../controllers/agentModeController');
  const { agentModeService } = await import('../services/agentModeService');

  const llmModel = session.llmModel || await agentModeService.getDefaultModel();

  try {
    const response = await generateSessionResponse(
      session.sessionId,
      userMessage,
      user.userId,
      llmModel,
      [] // attachments
    );

    // Remove the thinking message
    if (thinkingTs) {
      await deleteSlackMessage(channel, thinkingTs);
    }

    // Post Emma's response to the Slack thread
    if (response.content) {
      await postThreadResponse(channel, ts, response.content);
    }

    // Post iShare link and GTM Tracker link as a separate follow-up message
    if (ishareLink) {
      const { WebClient } = await import('@slack/web-api');
      const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

      const contextElements: any[] = [
        {
          type: 'mrkdwn',
          text: `:speech_balloon: Continue chat by simply reply or <${ishareLink}|click to chat in AgentWeb portal>`
        }
      ];
      if (gtmTrackerLink) {
        contextElements.push({
          type: 'mrkdwn',
          text: `:bar_chart: <${gtmTrackerLink}|Manage all sessions in GTM Tracker>`
        });
      }

      await slackClient.chat.postMessage({
        channel,
        thread_ts: ts,
        text: `Continue chat by simply reply or click to chat in AgentWeb portal: ${ishareLink}`,
        blocks: [
          {
            type: 'context',
            elements: contextElements
          }
        ]
      });
    }
  } catch (genError) {
    console.error('❌ Error generating agent response for Slack session:', genError);

    // Persist partial token usage from messages accumulated before the error
    if ((genError as any)?.partialUsageMessages?.length) {
      try {
        const { chatbotDb } = await import('../services/chatbotService');
        await chatbotDb.addMessagesToSession(session.sessionId, (genError as any).partialUsageMessages);
        console.log(`Slack session: Persisted partial usage from ${(genError as any).partialUsageMessages.length} messages for failed session ${session.sessionId}`);
      } catch (usageErr) {
        console.error('Failed to persist partial usage for Slack session:', usageErr);
      }
    }

    if (thinkingTs) {
      await deleteSlackMessage(channel, thinkingTs);
    }
    await postThreadResponse(channel, ts, 'Sorry, I encountered an error while processing your request. Please try again.');
  }
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
      channel,
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
router.post("/events", express.json(), async (req: Request, res: Response) => {
  try {
    console.log('📥 Slack event received:', JSON.stringify(req.body, null, 2));
    console.log('📥 Request headers:', JSON.stringify(req.headers, null, 2));
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

      // Handle app mention events
      if (event.type === 'app_mention') {
        const { text, user: slackUserId, channel, ts } = event;

        console.log('👋 Emma bot mentioned in Slack:', {
          channel,
          user: slackUserId,
          text
        });

        try {
          const { userDb } = await import('../services/db');
          const { chatbotDb } = await import('../services/chatbotService');
          const { WebClient } = await import('@slack/web-api');
          const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

          // Extract the message (remove bot mention and normalize Slack formatting)
          const botMentionPattern = /<@[A-Z0-9]+>/g;
          const rawMessage = text
            .replace(botMentionPattern, '')
            .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1') // <mailto:email|email> → email
            .replace(/<mailto:([^|>]+)>/g, '$1')         // <mailto:email> → email
            .trim();

          if (!rawMessage) {
            await slackClient.chat.postMessage({
              channel,
              text: '👋 Hi! Please include a message after mentioning me. For example: @Emma help me create a social media post',
              thread_ts: ts
            });
            return;
          }

          // Check if this is the admin Slack channel
          const adminChannelSetting = await settingsService.getSetting('slack_admin_channel');
          const isAdminChannel = !!(adminChannelSetting?.settingValue && adminChannelSetting.settingValue === channel);

          let user = null;
          let delegateInfo: { adminUserId: string; adminEmail: string; isDelegated: boolean } | undefined;
          let actualMessage = rawMessage;
          let pageIdentifier = 'slack-bot';

          if (isAdminChannel) {
            // Admin channel: parse "for user@email.com <message>" syntax
            // Allow optional comma/colon after email: "for user@email.com, say hello"
            const forMatch = rawMessage.match(/^for\s+(\S+@\S+?)[,:\s]\s*([\s\S]+)$/i);

            if (forMatch) {
              const targetEmail = forMatch[1].toLowerCase();
              actualMessage = forMatch[2].trim();

              // Look up the target user
              user = await userDb.getUserByEmail(targetEmail);
              if (!user) {
                await slackClient.chat.postMessage({
                  channel,
                  text: `User not found: ${targetEmail}`,
                  thread_ts: ts
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
              await postThreadResponse(channel, ts, `Starting session for ${targetEmail}`);
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
              user = await userDb.getUserById(cachedMapping.settingValue);
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

            if (!user) {
              await slackClient.chat.postMessage({
                channel,
                text: '❌ Sorry, I couldn\'t find a user account linked to this Slack channel. Please contact support.',
                thread_ts: ts
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
              thread_ts: ts
            });
          } catch (slackError) {
            console.error('❌ Error sending error message to Slack:', slackError);
          }
        }
      }

      // Handle top-level message events in user-connected Slack channels (slack triggered session)
      // Filter: plain message, NOT a thread reply, NOT a bot message, NOT a message_changed/deleted event
      if (event.type === 'message' && !event.thread_ts && !event.bot_id && !event.subtype) {
        const { text, user: slackUserId, channel, ts } = event;
        if (text) {
          console.log('📨 Top-level Slack message received:', { channel, user: slackUserId });
          // Fire-and-forget: triage + session + email
          handleSlackTriggeredSession({ text, slackUserId, channel, ts });
        }
      }

      // Handle message events in threads (follow-up messages to Emma sessions, or non-Emma threads)
      // Filter: must be a plain message in a thread, not a bot message or message_changed/deleted event
      if (event.type === 'message' && event.thread_ts && !event.bot_id && !event.subtype) {
        const { text, user: slackUserId, channel, thread_ts: threadTs, files } = event;

        // Look up if this thread is associated with an Emma session
        const threadMappingKey = `slack_thread_${channel}_${threadTs}`;
        const mapping = await settingsService.getSetting(threadMappingKey);

        if (mapping?.settingValue) {
          try {
            const parsed = JSON.parse(mapping.settingValue);
            const { sessionId, userId } = parsed;
            const isTriggered = parsed.type === 'triggered';

            if (isTriggered) {
              // Monitored (email-only) session — continue it and send email, do NOT post to Slack
              if (text) {
                console.log('📨 Thread reply in monitored session (email-only):', { channel, threadTs, slackUserId });
                const { chatbotDb } = await import('../services/chatbotService');
                const { generateSessionResponse } = await import('../controllers/agentModeController');
                const { agentModeService } = await import('../services/agentModeService');
                const { userDb } = await import('../services/db');

                const session = await chatbotDb.getChatSession(sessionId);
                if (!session) {
                  console.log('❌ Session not found for monitored Slack thread:', sessionId);
                  return;
                }

                const displayName = await getSlackUserDisplayName(slackUserId);
                const formattedMessage = `${displayName}: ${text}`.trim();

                const llmModel = session.llmModel || await agentModeService.getDefaultModel();
                let emmaResponse = '';
                try {
                  const result = await generateSessionResponse(sessionId, formattedMessage, userId, llmModel);
                  emmaResponse = result.content;
                } catch (genError) {
                  console.error('❌ Error generating response for monitored thread:', genError);
                  emmaResponse = '(Emma was unable to generate a response for this message.)';
                }

                let channelName = channel;
                try {
                  const { WebClient } = await import('@slack/web-api');
                  const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
                  const info = await slackClient.conversations.info({ channel });
                  channelName = (info.channel as any)?.name || channel;
                } catch { /* non-blocking */ }

                const user = await userDb.getUserById(userId);
                await emailService.sendSlackTriggeredSessionEmail('founders@agentweb.pro', {
                  sessionId,
                  userEmail: user?.email || userId,
                  channelName,
                  originalMessage: text,
                  emmaResponse,
                  receivedAt: new Date().toISOString(),
                });
              }
            } else {
              // Emma @mention session — existing behavior: post response directly to Slack
              console.log('💬 Thread reply in Emma session:', { channel, threadTs, slackUserId });
              const { chatbotDb } = await import('../services/chatbotService');
              const { generateSessionResponse } = await import('../controllers/agentModeController');
              const { agentModeService } = await import('../services/agentModeService');

              const session = await chatbotDb.getChatSession(sessionId);
              if (!session) {
                console.log('❌ Session not found for Slack thread:', sessionId);
                return;
              }

              const displayName = await getSlackUserDisplayName(slackUserId);
              const formattedMessage = `${displayName}: ${text || ''}`.trim();

              const attachments: any[] = [];
              if (files && files.length > 0) {
                for (const file of files) {
                  try {
                    const fileBuffer = await downloadSlackFile(file.url_private);
                    const { uploadFileToS3 } = await import('../utils/s3Utils');
                    const uploadResult = await uploadFileToS3(
                      fileBuffer,
                      file.name || 'attachment',
                      userId,
                      file.mimetype || 'application/octet-stream'
                    );
                    if (!uploadResult.success || !uploadResult.url) {
                      console.error('❌ Failed to upload Slack file to S3');
                      continue;
                    }
                    attachments.push({
                      url: uploadResult.url,
                      filename: file.name || 'attachment',
                      size: file.size,
                      mimetype: file.mimetype || 'application/octet-stream',
                    });
                  } catch (fileError) {
                    console.error('❌ Error downloading Slack file:', fileError);
                  }
                }
              }

              const thinkingTs = await postThinkingMessage(channel, threadTs);
              const llmModel = session.llmModel || await agentModeService.getDefaultModel();

              try {
                const response = await generateSessionResponse(sessionId, formattedMessage, userId, llmModel, attachments);
                if (thinkingTs) await deleteSlackMessage(channel, thinkingTs);
                if (response.content) await postThreadResponse(channel, threadTs, response.content);
              } catch (genError) {
                console.error('❌ Error generating thread response:', genError);
                if (thinkingTs) await deleteSlackMessage(channel, thinkingTs);
                await postThreadResponse(channel, threadTs, 'Sorry, I encountered an error. Please try again.');
              }
            }
          } catch (parseError) {
            console.error('❌ Error processing thread reply:', parseError);
          }
        } else if (text) {
          // Thread not mapped to anything — treat as a new monitored conversation.
          // Pass thread_ts as ts so subsequent replies in this thread continue the same session.
          console.log('📨 Thread reply in untracked thread, triggering monitoring:', { channel, threadTs, slackUserId });
          handleSlackTriggeredSession({ text, slackUserId, channel, ts: threadTs });
        }
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

        // Send email notifications to subscribers after approval
        try {
          if (approval && approval.executionId) {
            console.log(`🔍 Looking up execution details for executionId: ${approval.executionId}`);
            
            // Get task information from the execution
            const execution = await taskDb.getTaskExecutionById(approval.executionId);
            if (execution) {
              console.log(`✅ Found execution for taskId: ${execution.taskId}`);
              
              // Get task details
              const task = await taskDb.getTaskById(execution.taskId);
              if (task) {
                console.log(`✅ Found task: ${task.name}`);
                
                // Get task subscribers
                const subscribers = await subscriberDb.getTaskSubscribers(execution.taskId);
                const activeSubscribers = subscribers ? subscribers.filter(sub => !sub.unsubscribed) : [];
                const subscriberEmails = activeSubscribers.map(sub => sub.email);
                
                // Apply subscriber email limit
                const emailLimit = parseInt(process.env.SUBSCRIBER_EMAIL_LIMIT || '1000');
                const limitedSubscriberEmails = subscriberEmails.slice(0, emailLimit);
                
                console.log(`📧 Found ${subscriberEmails.length} active subscribers for task: ${execution.taskId}`);
                if (subscriberEmails.length > emailLimit) {
                  console.log(`⚠️ Subscriber count (${subscriberEmails.length}) exceeds limit (${emailLimit}). Sending to first ${emailLimit} subscribers only.`);
                }
                
                if (limitedSubscriberEmails.length > 0) {
                  // Send task results to subscribers using common function
                  for (const email of limitedSubscriberEmails) {
                    try {
                      await emailService.sendTaskExecutionEmail(
                        email,
                        approval.executionId
                      );
                      console.log(`📧 Task results sent to subscriber: ${email}`);
                    } catch (error) {
                      console.error(`Failed to send task results to ${email}:`, error);
                      // Continue with other subscribers even if one fails
                    }
                  }
                  console.log(`📧 Task results sent to ${limitedSubscriberEmails.length} subscribers for task: ${execution.taskId}`);
                } else {
                  console.log(`No subscribers to notify for task: ${execution.taskId}`);
                }
              } else {
                console.log(`❌ Task not found for taskId: ${execution.taskId}`);
              }
            } else {
              console.log(`❌ Execution not found for executionId: ${approval.executionId}`);
            }
          } else {
            console.log(`❌ No executionId found in approval:`, approval);
          }
        } catch (error) {
          console.error('Error sending approval notifications to subscribers:', error);
          // Don't fail the approval if email notifications fail
        }

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
                
                // Format revision message based on asset type (similar to Images/Reports pages)
                let revisionMessage: string;
                let requiredFunctions: Array<{ functionName: string; minCount: number }>;
                
                if (originalApproval.assetType === 'image') {
                  // For images, use generate_image function
                  revisionMessage = `Please use the generate_image function to revise this image: ${originalApproval.assetUrl}\n\nRevision request: ${feedbackValue}\n\nUse the original image as an input image for editing.`;
                  requiredFunctions = [
                    {
                      functionName: 'generate_image',
                      minCount: 1
                    }
                  ];
                } else if (originalApproval.assetType === 'html') {
                  // For HTML reports, use update_html_file function
                  revisionMessage = `Please revise this HTML report: ${originalApproval.assetUrl}\n\nRevision request: ${feedbackValue}\n\nFirst, call read_file_content to understand the current HTML structure. Then use update_html_file with update_type="css" and CSS selectors to target the specific elements that need changes. Keep the HTML well-structured and production-ready.`;
                  requiredFunctions = [
                    {
                      functionName: 'update_html_file',
                      minCount: 1
                    }
                  ];
                } else {
                  throw new Error(`Unsupported asset type for Agent Mode revision: ${originalApproval.assetType}`);
                }
                
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
                  maxAttempts: 5
                }).then(async (result) => {
                  console.log(`✅ Agent Mode revision completed. Success: ${result.success}, Tool calls: ${result.toolCalls.length}`);

                  // Extract the new asset URL from toolCalls
                  let newAssetUrl: string | null = null;
                  let newAssetFilename: string | null = null;
                  let toolCallFailed = false;
                  let toolCallFailureMessage = '';

                  if (result.success && result.toolCalls.length > 0) {
                    // Find the tool call that created the asset
                    for (const toolCall of result.toolCalls) {
                      const toolResult = toolCall?.result || {};

                      if (originalApproval.assetType === 'image') {
                        // For images, look for imageUrl, image_url, s3_url, url, or file_url (save_file fallback)
                        // Only extract if the tool call succeeded
                        if (toolResult.success) {
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
                    const failureReason = toolCallFailed
                      ? `Tool call failed: ${toolCallFailureMessage}`
                      : 'Could not extract new asset URL from toolCalls';

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
                        subject: toolCallFailed
                          ? 'Agent Mode Revision: Tool Call Failed'
                          : 'Agent Mode Revision: Failed to Extract Asset URL',
                        message: toolCallFailed
                          ? `The revision tool call failed during Agent Mode revision.\n\nSession: ${agentSessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}\nError: ${toolCallFailureMessage}`
                          : `Failed to extract new asset URL from toolCalls after Agent Mode revision.\n\nSession: ${agentSessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}`,
                        sessionId: agentSessionId,
                        context: {
                          'iShare Link': ishareLink,
                          'Asset Type': originalApproval.assetType || 'unknown',
                          'Original Asset URL': originalApproval.assetUrl,
                          'Original Filename': originalApproval.filename || 'unknown',
                          'Feedback': feedbackValue,
                          'Revision Success': result.success,
                          'Tool Call Failed': toolCallFailed,
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
                  }
                }).catch(async (error) => {
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
                    
                    // Format revision message based on asset type (similar to Images/Reports pages)
                    let revisionMessage: string;
                    let requiredFunctions: Array<{ functionName: string; minCount: number }>;
                    
                    if (originalApproval.assetType === 'image') {
                      // For images, use generate_image function
                      revisionMessage = `Please use the generate_image function to revise this image: ${originalApproval.assetUrl}\n\nRevision request: ${feedbackValue}\n\nUse the original image as an input image for editing.`;
                      requiredFunctions = [
                        {
                          functionName: 'generate_image',
                          minCount: 1
                        }
                      ];
                    } else if (originalApproval.assetType === 'html') {
                      // For HTML reports, use update_html_file function
                      revisionMessage = `Please revise this HTML report: ${originalApproval.assetUrl}\n\nRevision request: ${feedbackValue}\n\nFirst, call read_file_content to understand the current HTML structure. Then use update_html_file with update_type="css" and CSS selectors to target the specific elements that need changes. Keep the HTML well-structured and production-ready.`;
                      requiredFunctions = [
                        {
                          functionName: 'update_html_file',
                          minCount: 1
                        }
                      ];
                    } else {
                      throw new Error(`Unsupported asset type for Agent Mode revision: ${originalApproval.assetType}`);
                    }
                    
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
                      maxAttempts: 5
                    }).then(async (result) => {
                      console.log(`✅ Agent Mode revision completed. Success: ${result.success}, Tool calls: ${result.toolCalls.length}`);

                      // Extract the new asset URL from toolCalls
                      let newAssetUrl: string | null = null;
                      let newAssetFilename: string | null = null;
                      let toolCallFailed = false;
                      let toolCallFailureMessage = '';

                      if (result.success && result.toolCalls.length > 0) {
                        // Find the tool call that created the asset
                        for (const toolCall of result.toolCalls) {
                          const toolResult = toolCall?.result || {};

                          if (originalApproval.assetType === 'image') {
                            // For images, look for imageUrl, image_url, s3_url, url, or file_url (save_file fallback)
                            // Only extract if the tool call succeeded
                            if (toolResult.success) {
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
                        const failureReason = toolCallFailed
                          ? `Tool call failed: ${toolCallFailureMessage}`
                          : 'Could not extract new asset URL from toolCalls';

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
                            subject: toolCallFailed
                              ? 'Agent Mode Revision: Tool Call Failed'
                              : 'Agent Mode Revision: Failed to Extract Asset URL',
                            message: toolCallFailed
                              ? `The revision tool call failed during Agent Mode revision.\n\nSession: ${task.sessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}\nError: ${toolCallFailureMessage}`
                              : `Failed to extract new asset URL from toolCalls after Agent Mode revision.\n\nSession: ${task.sessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}`,
                            sessionId: task.sessionId,
                            context: {
                              'iShare Link': ishareLink,
                              'Asset Type': originalApproval.assetType || 'unknown',
                              'Original Asset URL': originalApproval.assetUrl,
                              'Original Filename': originalApproval.filename || 'unknown',
                              'Feedback': feedbackValue,
                              'Revision Success': result.success,
                              'Tool Call Failed': toolCallFailed,
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
                      }
                    }).catch(async (error) => {
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
