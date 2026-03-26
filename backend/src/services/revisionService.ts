import { approvalDb, getAssetTypeFromFilename, AssetApproval } from './approvalDb';
import { sendApprovalRequestWithTracking } from './slackService';
import { batchReviewDb } from './batchReviewDb';
import { isSessionLimitError } from '../utils/agentModeErrors';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';

/**
 * Trigger auto-revision for an asset based on reviewer feedback.
 * Extracted from slack.ts feedback_modal handler so it can be reused
 * from both Slack interactions and the batch review page.
 *
 * If batchId is provided, the revised asset is added to the batch review page
 * instead of being sent as a new individual Slack message.
 *
 * This runs asynchronously (fire-and-forget) — callers should not await it.
 */
export async function triggerAutoRevision(
  approval: AssetApproval,
  feedback: string,
  batchId?: string
): Promise<void> {
  if (!approval.executionId) {
    console.log('No executionId on approval, skipping auto-revision');
    return;
  }

  const isAgentModeImage = approval.executionId.endsWith('-images');
  const isAgentModeVideo = approval.executionId.endsWith('-videos');
  const isAgentModeHtml = approval.executionId.endsWith('-html');
  const isAgentModeAsset = isAgentModeImage || isAgentModeVideo || isAgentModeHtml;

  const agentSessionId = isAgentModeAsset
    ? (isAgentModeImage
      ? approval.executionId.replace('-images', '')
      : isAgentModeVideo
        ? approval.executionId.replace('-videos', '')
        : approval.executionId.replace('-html', ''))
    : null;

  if (agentSessionId) {
    await runAgentModeRevision(approval, feedback, agentSessionId, batchId);
  } else {
    await runTaskBasedRevision(approval, feedback, batchId);
  }
}

async function runAgentModeRevision(
  approval: AssetApproval,
  feedback: string,
  agentSessionId: string,
  batchId?: string
): Promise<void> {
  const { chatbotDb } = await import('./chatbotService');
  const session = await chatbotDb.getChatSession(agentSessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  let revisionMessage: string;
  let requiredFunctions: Array<{ functionName: string; minCount: number }>;

  if (approval.assetType === 'image') {
    revisionMessage = `Please use the generate_image function to revise this image: ${approval.assetUrl}\n\nRevision request: ${feedback}\n\nUse the original image as an input image for editing.`;
    requiredFunctions = [{ functionName: 'generate_image', minCount: 1 }];
  } else if (approval.assetType === 'html') {
    revisionMessage = `Please revise this HTML report: ${approval.assetUrl}\n\nRevision request: ${feedback}\n\nFirst, call read_file_content to understand the current HTML structure. Then use update_html_file with update_type="css" and CSS selectors to target the specific elements that need changes. Keep the HTML well-structured and production-ready.`;
    requiredFunctions = [{ functionName: 'update_html_file', minCount: 1 }];
  } else {
    throw new Error(`Unsupported asset type for Agent Mode revision: ${approval.assetType}`);
  }

  const { runVerifiedChat } = await import('../controllers/agentModeController');

  try {
    const result = await runVerifiedChat({
      sessionId: agentSessionId,
      userId: session.userId,
      startingMessage: revisionMessage,
      requiredFunctions,
      keywords: [],
      attachments: [],
      maxAttempts: 5,
    });

    console.log(`Agent Mode revision completed. Success: ${result.success}, Tool calls: ${result.toolCalls.length}`);

    let newAssetUrl: string | null = null;
    let newAssetFilename: string | null = null;
    let toolCallFailed = false;
    let toolCallFailureMessage = '';

    if (result.success && result.toolCalls.length > 0) {
      for (const toolCall of result.toolCalls) {
        const toolResult = toolCall?.result || {};

        if (approval.assetType === 'image') {
          if (toolResult.success) {
            const imageUrl = toolResult.imageUrl || toolResult.image_url || toolResult.s3_url || toolResult.url || toolResult.file_url;
            if (imageUrl) {
              newAssetUrl = imageUrl;
              newAssetFilename = toolResult.filename || toolResult.file_name || `revised_${approval.filename || 'image'}`;
              break;
            }
          } else if (toolCall.name === 'generate_image') {
            toolCallFailed = true;
            toolCallFailureMessage = toolResult.message || toolCall.error || 'Unknown error';
          }
        } else if (approval.assetType === 'html') {
          if (toolResult.success) {
            const htmlUrl = toolResult.file_url || toolResult.s3_url || toolResult.htmlUrl;
            if (htmlUrl) {
              newAssetUrl = htmlUrl;
              newAssetFilename = toolResult.filename || toolResult.file_name || toolResult.versioned_filename || `revised_${approval.filename || 'report.html'}`;
              break;
            }
          } else if (toolCall.name === 'update_html_file') {
            toolCallFailed = true;
            toolCallFailureMessage = toolResult.message || toolCall.error || 'Unknown error';
          }
        }
      }
    }

    if (newAssetUrl && newAssetFilename) {
      const assetType = getAssetTypeFromFilename(newAssetFilename);

      if (batchId) {
        // Add revised asset to the batch review page instead of Slack
        await batchReviewDb.addAssetToBatch(batchId, {
          assetUrl: newAssetUrl,
          filename: newAssetFilename,
          assetType,
          executionId: approval.executionId,
        });
        // Create an individual approval record for the new asset
        await approvalDb.createApproval({
          assetUrl: newAssetUrl,
          filename: newAssetFilename,
          assetType,
          executionId: approval.executionId,
          userId: approval.userId,
          slackChannel: approval.slackChannel,
          slackChannelName: approval.slackChannelName,
          slackMessageTs: null,
          note: `Revision based on feedback: ${feedback}`,
          batchId,
        });
        // Mark the original asset as revision_submitted
        await approvalDb.updateApprovalStatus(approval.assetUrl, 'revision_submitted', 'Auto-revision');
        console.log(`Revised asset added to batch ${batchId} for review`);
      } else {
        await sendApprovalRequestWithTracking({
          executionId: approval.executionId,
          imageUrl: newAssetUrl,
          filename: newAssetFilename,
          assetType,
          userId: approval.userId,
          channel: approval.slackChannel,
          channelName: approval.slackChannelName,
          note: `Revision based on feedback: ${feedback}`,
        });
        console.log(`New revision asset sent to Slack for review`);
      }
    } else {
      const failureReason = toolCallFailed
        ? `Tool call failed: ${toolCallFailureMessage}`
        : 'Could not extract new asset URL from toolCalls';
      console.warn(`${failureReason}. Tool calls: ${JSON.stringify(result.toolCalls)}`);

      try {
        let ishareLink = '';
        try {
          ishareLink = await chatbotDb.createOrReuseInteractiveShare(agentSessionId);
        } catch {
          const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
          ishareLink = `${customerFrontendUrl}/agent-mode/${agentSessionId}`;
        }

        await sendAgentModeOncallAlert({
          subject: toolCallFailed
            ? 'Agent Mode Revision: Tool Call Failed'
            : 'Agent Mode Revision: Failed to Extract Asset URL',
          message: toolCallFailed
            ? `The revision tool call failed during Agent Mode revision.\n\nSession: ${agentSessionId}\nAsset Type: ${approval.assetType}\nOriginal Asset URL: ${approval.assetUrl}\nFeedback: ${feedback}\nError: ${toolCallFailureMessage}`
            : `Failed to extract new asset URL from toolCalls after Agent Mode revision.\n\nSession: ${agentSessionId}\nAsset Type: ${approval.assetType}\nOriginal Asset URL: ${approval.assetUrl}\nFeedback: ${feedback}`,
          sessionId: agentSessionId,
          context: {
            'iShare Link': ishareLink,
            'Asset Type': approval.assetType || 'unknown',
            'Original Asset URL': approval.assetUrl,
            'Original Filename': approval.filename || 'unknown',
            'Feedback': feedback,
            'Revision Success': result.success,
            'Tool Call Failed': toolCallFailed,
            'Tool Call Failure Message': toolCallFailed ? toolCallFailureMessage : 'N/A',
            'Tool Calls Count': result.toolCalls.length,
            'Tool Calls': JSON.stringify(result.toolCalls, null, 2),
            'Execution ID': approval.executionId,
            'Slack Channel': approval.slackChannel || 'N/A',
            'User ID': approval.userId || 'N/A',
          },
        });
      } catch (alertError) {
        console.error('Error sending oncall alert:', alertError);
      }
    }
  } catch (error: any) {
    console.error('Error in Agent Mode verified-generate:', error);
    try {
      const isLimit = isSessionLimitError(error);
      await sendAgentModeOncallAlert({
        subject: isLimit
          ? 'Agent Mode Verified Generate: Session limit exceeded'
          : 'Agent Mode Verified Generate: Failed',
        message: isLimit
          ? `Verified generation failed because the session reached its limit.\n\nSession: ${agentSessionId}\nAsset Type: ${approval.assetType}\nOriginal Asset URL: ${approval.assetUrl}\nFeedback: ${feedback}`
          : `Verified generation failed.\n\nSession: ${agentSessionId}\nAsset Type: ${approval.assetType}\nOriginal Asset URL: ${approval.assetUrl}\nFeedback: ${feedback}`,
        sessionId: agentSessionId,
        context: {
          'Asset Type': approval.assetType || 'unknown',
          'Original Asset URL': approval.assetUrl,
          'Original Filename': approval.filename || 'unknown',
          'Feedback': feedback,
          'Execution ID': approval.executionId,
          'Slack Channel': approval.slackChannel || 'N/A',
          'User ID': approval.userId || 'N/A',
          'Error': error.message || String(error),
        },
      });
    } catch (alertError) {
      console.error('Error sending oncall alert:', alertError);
    }
  }
}

async function runTaskBasedRevision(
  approval: AssetApproval,
  feedback: string,
  batchId?: string
): Promise<void> {
  const { taskDb } = await import('./db');
  const execution = await taskDb.getTaskExecutionById(approval.executionId!);
  if (!execution) return;

  const task = await taskDb.getTaskById(execution.taskId);
  if (!task?.sessionId) {
    // Regular browser task — use createRevisionExecutionFromSlack
    const { createRevisionExecutionFromSlack } = await import('../controllers/tasks');
    await createRevisionExecutionFromSlack(
      execution.taskId,
      feedback,
      approval.assetUrl,
      approval.executionId!,
      approval.assetType,
      approval.userId,
      1,
      approval.slackChannel,
      approval.slackChannelName
    );
    return;
  }

  // Agent Mode session via task — delegate to runAgentModeRevision
  if (approval.slackChannel) {
    await taskDb.updateTask(execution.taskId, {
      slackChannel: approval.slackChannel,
    });
  }

  await runAgentModeRevision(approval, feedback, task.sessionId, batchId);
}
