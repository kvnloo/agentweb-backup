import express, { Request, Response } from "express";
import { authenticateToken } from "../middleware/auth";
import { AuthenticatedRequest } from "../middleware/auth";
import { 
  getSlackChannels, 
  sendApprovalRequest, 
  sendApprovalRequestWithTracking,
  updateApprovalMessage,
  openFeedbackModal,
  openRejectModal,
  openTestEmailModal
} from "../services/slackService";
import { approvalDb, getAssetTypeFromFilename } from "../services/approvalDb";
import { taskDb, subscriberDb } from "../services/db";
import { emailService } from "../services/emailService";
import { createRevisionExecutionFromSlack } from "../controllers/tasks";
import { isSessionLimitError } from "../utils/agentModeErrors";
import { sendAgentModeOncallAlert } from "../utils/agentModeAlerts";

const router = express.Router();

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
      
      if (user?.slackChannel) {
        const filteredChannels = channels.filter(channel => 
          channel.id === user.slackChannel
        );
        console.log(`✅ Filtered to ${filteredChannels.length} channels based on user's account-level Slack channel`);
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
                  revisionMessage = `Please revise this HTML report: ${originalApproval.assetUrl}\n\nRevision request: ${feedbackValue}\n\nFirst, call read_file_content to get the current content and content_hash. Then use update_html_file to apply the requested changes based on the current content. Keep the HTML well-structured and production-ready.`;
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
                  
                  if (result.success && result.toolCalls.length > 0) {
                    // Find the tool call that created the asset
                    for (const toolCall of result.toolCalls) {
                      const toolResult = toolCall?.result || {};
                      
                      if (originalApproval.assetType === 'image') {
                        // For images, look for imageUrl, image_url, s3_url, or url in generate_image result
                        const imageUrl = toolResult.imageUrl || toolResult.image_url || toolResult.s3_url || toolResult.url;
                        if (imageUrl) {
                          newAssetUrl = imageUrl;
                          newAssetFilename = toolResult.filename || toolResult.file_name || `revised_${originalApproval.filename || 'image'}`;
                          break;
                        }
                      } else if (originalApproval.assetType === 'html') {
                        // For HTML, look for file_url, s3_url, or htmlUrl in update_html_file result
                        const htmlUrl = toolResult.file_url || toolResult.s3_url || toolResult.htmlUrl;
                        if (htmlUrl) {
                          newAssetUrl = htmlUrl;
                          newAssetFilename = toolResult.filename || toolResult.file_name || toolResult.versioned_filename || `revised_${originalApproval.filename || 'report.html'}`;
                          break;
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
                    console.warn(`⚠️ Could not extract new asset URL from toolCalls. Tool calls: ${JSON.stringify(result.toolCalls)}`);
                    
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
                        subject: 'Agent Mode Revision: Failed to Extract Asset URL',
                        message: `Failed to extract new asset URL from toolCalls after Agent Mode revision.\n\nSession: ${agentSessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}`,
                        sessionId: agentSessionId,
                        context: {
                          'iShare Link': ishareLink,
                          'Asset Type': originalApproval.assetType || 'unknown',
                          'Original Asset URL': originalApproval.assetUrl,
                          'Original Filename': originalApproval.filename || 'unknown',
                          'Feedback': feedbackValue,
                          'Revision Success': result.success,
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
                      revisionMessage = `Please revise this HTML report: ${originalApproval.assetUrl}\n\nRevision request: ${feedbackValue}\n\nFirst, call read_file_content to get the current content and content_hash. Then use update_html_file to apply the requested changes based on the current content. Keep the HTML well-structured and production-ready.`;
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
                      
                      if (result.success && result.toolCalls.length > 0) {
                        // Find the tool call that created the asset
                        for (const toolCall of result.toolCalls) {
                          const toolResult = toolCall?.result || {};
                          
                          if (originalApproval.assetType === 'image') {
                            // For images, look for imageUrl, image_url, s3_url, or url in generate_image result
                            const imageUrl = toolResult.imageUrl || toolResult.image_url || toolResult.s3_url || toolResult.url;
                            if (imageUrl) {
                              newAssetUrl = imageUrl;
                              newAssetFilename = toolResult.filename || toolResult.file_name || `revised_${originalApproval.filename || 'image'}`;
                              break;
                            }
                          } else if (originalApproval.assetType === 'html') {
                            // For HTML, look for file_url, s3_url, or htmlUrl in update_html_file result
                            const htmlUrl = toolResult.file_url || toolResult.s3_url || toolResult.htmlUrl;
                            if (htmlUrl) {
                              newAssetUrl = htmlUrl;
                              newAssetFilename = toolResult.filename || toolResult.file_name || toolResult.versioned_filename || `revised_${originalApproval.filename || 'report.html'}`;
                              break;
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
                        console.warn(`⚠️ Could not extract new asset URL from toolCalls. Tool calls: ${JSON.stringify(result.toolCalls)}`);
                        
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
                            subject: 'Agent Mode Revision: Failed to Extract Asset URL',
                            message: `Failed to extract new asset URL from toolCalls after Agent Mode revision.\n\nSession: ${task.sessionId}\nAsset Type: ${originalApproval.assetType}\nOriginal Asset URL: ${originalApproval.assetUrl}\nFeedback: ${feedbackValue}`,
                            sessionId: task.sessionId,
                            context: {
                              'iShare Link': ishareLink,
                              'Asset Type': originalApproval.assetType || 'unknown',
                              'Original Asset URL': originalApproval.assetUrl,
                              'Original Filename': originalApproval.filename || 'unknown',
                              'Feedback': feedbackValue,
                              'Revision Success': result.success,
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
