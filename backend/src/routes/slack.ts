import express, { Request, Response } from "express";
import { authenticateToken } from "../middleware/auth";
import { AuthenticatedRequest } from "../middleware/auth";
import { 
  getSlackChannels, 
  sendApprovalRequest, 
  updateApprovalMessage,
  verifySlackSignature 
} from "../services/slackService";
import { approvalDb, getAssetTypeFromFilename } from "../services/approvalDb";

const router = express.Router();

/**
 * @route GET /api/slack/channels
 * @desc Get available Slack channels
 * @access Private (requires authentication)
 */
router.get("/channels", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log("📡 Fetching Slack channels...");
    
    const channels = await getSlackChannels();
    
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
router.post("/send-approval", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { channel, assetUrl, filename, executionId } = req.body;
    const userId = req.user?.userId;

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

    const result = await sendApprovalRequest({
      executionId: executionId || '', // Keep for backward compatibility
      imageUrl: assetUrl,
      filename,
      assetType,
      userId,
      channel
    });

    // Store approval request in database for tracking
    const approval = await approvalDb.createApproval({
      assetUrl,
      filename,
      assetType,
      executionId,
      userId,
      slackChannel: channel,
      slackMessageTs: result.messageTs,
    });

    console.log("✅ Approval request sent successfully to Slack and stored in database");
    
    res.json({ 
      success: true, 
      message: "Approval request sent successfully",
      messageTs: result.messageTs
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
 * @route POST /api/slack/interactions
 * @desc Handle Slack button interactions (approve/reject)
 * @access Public (Slack webhook)
 */
router.post("/interactions", express.urlencoded({ extended: true }), async (req: Request, res: Response) => {
  try {
    // Parse the payload from Slack
    const payload = JSON.parse(req.body.payload);
    
    if (payload.type !== 'block_actions') {
      return res.status(200).json({ text: "Unknown interaction type" });
    }

    const action = payload.actions[0];
    const user = payload.user;
    const channel = payload.channel;
    const message = payload.message;
    
    if (!action || !action.action_id) {
      return res.status(200).json({ text: "Invalid action" });
    }

    console.log("🔘 Slack interaction received:", {
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

    const { assetUrl, filename } = assetData;
    let status: 'approved' | 'needs_changes';
    let statusText: string;
    let statusEmoji: string;

    if (action.action_id === 'approve_image') {
      status = 'approved';
      statusText = 'Approved';
      statusEmoji = '✅';
    } else if (action.action_id === 'needs_changes_image') {
      status = 'needs_changes';
      statusText = 'Needs Changes';
      statusEmoji = '🔶';
    } else {
      return res.status(200).json({ text: "Unknown action" });
    }

    // Update the message in Slack to show the decision
    await updateApprovalMessage(
      channel.id,
      message.ts,
      status,
      user.username || user.id
    );

    // Update the approval status in our database
    try {
      await approvalDb.updateApprovalStatus(
        assetUrl,
        status,
        user.username || user.id
      );
      console.log(`✅ Updated approval status: ${assetUrl} -> ${status} by ${user.username}`);
    } catch (error) {
      console.error("❌ Error updating approval in database:", error);
      // Still respond OK to Slack so the interaction doesn't fail
    }

    // Respond to Slack immediately to acknowledge the interaction
    res.status(200).json({
      response_type: "in_channel",
      text: `${statusEmoji} ${statusText} by @${user.username}`
    });

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
router.post("/approvals", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { assetUrls } = req.body;
    
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
 * @route POST /api/slack/poll-updates
 * @desc Poll Slack message history to check for approval status updates
 * @access Private (requires authentication)
 */
router.post("/poll-updates", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log("🔄 Polling Slack for approval status updates...");

    // Get all pending approvals from database
    const pendingApprovals = await approvalDb.getApprovalsByStatus('pending');
    
    if (pendingApprovals.length === 0) {
      return res.json({ 
        success: true, 
        message: "No pending approvals to check",
        updatedCount: 0
      });
    }

    console.log(`📋 Found ${pendingApprovals.length} pending approvals to check`);
    
    let updatedCount = 0;
    
    // Group approvals by channel for efficient polling
    const approvalsByChannel: Record<string, typeof pendingApprovals> = {};
    pendingApprovals.forEach(approval => {
      if (!approvalsByChannel[approval.slackChannel]) {
        approvalsByChannel[approval.slackChannel] = [];
      }
      approvalsByChannel[approval.slackChannel].push(approval);
    });

    // Poll each channel for updates
    for (const [channelId, channelApprovals] of Object.entries(approvalsByChannel)) {
      try {
        // Get slack client from the service
        const { WebClient } = require('@slack/web-api');
        const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
        
        if (!process.env.SLACK_BOT_TOKEN) {
          console.warn(`⚠️ Slack token not available, skipping channel ${channelId}`);
          continue;
        }

        const historyResult = await slackClient.conversations.history({
          channel: channelId,
          limit: 50, // Check recent messages
          include_all_metadata: true
        });

        if (!historyResult.ok) {
          console.error(`❌ Failed to get history for channel ${channelId}:`, historyResult.error);
          continue;
        }

        const messages = historyResult.messages || [];
        
        // Check each approval against the messages
        for (const approval of channelApprovals) {
          if (!approval.slackMessageTs) continue;
          
          // Find the specific message by timestamp
          const message = messages.find((msg: any) => msg.ts === approval.slackMessageTs);
          if (!message) continue;

          // Parse the message to check for status updates
          const statusUpdate = parseApprovalStatus(message);
          if (statusUpdate && statusUpdate.status !== 'pending') {
            // Update the approval in database using assetUrl
            await approvalDb.updateApprovalStatus(
              approval.assetUrl,
              statusUpdate.status,
              statusUpdate.reviewedBy || 'Unknown',
              statusUpdate.feedback
            );
            
            updatedCount++;
            console.log(`✅ Updated approval ${approval.assetUrl}: ${statusUpdate.status}`);
          }
        }
      } catch (error) {
        console.error(`❌ Error polling channel ${channelId}:`, error);
      }
    }

    console.log(`🔄 Polling complete: ${updatedCount} approvals updated`);
    
    res.json({ 
      success: true, 
      message: `Checked ${pendingApprovals.length} pending approvals`,
      updatedCount
    });
  } catch (error: any) {
    console.error("❌ Error polling Slack updates:", error.message);
    res.status(500).json({ 
      error: "Failed to poll Slack updates", 
      details: error.message 
    });
  }
});

/**
 * Parse a Slack message to extract approval status
 */
function parseApprovalStatus(message: any): { status: 'approved' | 'needs_changes' | 'pending', reviewedBy?: string, feedback?: string } | null {
  try {
    if (!message.blocks) {
      return null;
    }

    // Look for status block (added when approval/rejection happens)
    const statusBlock = message.blocks.find(
      (block: any) => 
        block.type === "section" && 
        block.text && 
        block.text.text.includes("*Status:*")
    );

    if (!statusBlock) {
      return { status: 'pending' }; // No status block means still pending
    }

    const statusText = statusBlock.text.text;
    
    if (statusText.includes("✅ Approved")) {
      const reviewedByMatch = statusText.match(/by @(\w+)/);
      return {
        status: 'approved',
        reviewedBy: reviewedByMatch ? reviewedByMatch[1] : undefined
      };
    } else if (statusText.includes("🔶 Needs Changes")) {
      const reviewedByMatch = statusText.match(/by @(\w+)/);
      const feedbackMatch = statusText.match(/\*Feedback:\* (.*)/);
      return {
        status: 'needs_changes',
        reviewedBy: reviewedByMatch ? reviewedByMatch[1] : undefined,
        feedback: feedbackMatch ? feedbackMatch[1] : undefined
      };
    }

    return { status: 'pending' };
  } catch (error) {
    console.error('Error parsing approval status:', error);
    return null;
  }
}

/**
 * @route GET /api/slack/status
 * @desc Check Slack integration status
 * @access Private (requires authentication)
 */
router.get("/status", authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
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

export default router;