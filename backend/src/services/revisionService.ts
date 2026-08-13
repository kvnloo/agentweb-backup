import { approvalDb, getAssetTypeFromFilename, AssetApproval } from './approvalDb';
import { sendApprovalRequestWithTracking } from './slackService';
import { batchReviewDb } from './batchReviewDb';
import { isSessionLimitError } from '../utils/agentModeErrors';
import { sendAgentModeOncallAlert } from '../utils/agentModeAlerts';

/**
 * ENG-936: the Agent Mode revision prompt, shared by every entry point (this
 * service and the two Slack interaction handlers) so the three copies cannot drift.
 *
 * The image branch carries `confirm=true` deliberately. Asking the model to edit the
 * original asset makes `inputImages` non-empty, which trips the human-in-the-loop
 * image-edit confirmation gate in `generate_image`. That gate exists to stop the model
 * editing the WRONG source image — but here the user picked this exact asset and asked
 * for this revision, so the approval already happened. Without it the tool returns
 * `awaitingUserConfirmation` and no image, and the revision silently never happens.
 */
export function buildAgentModeRevisionMessage(
  assetType: string | undefined,
  assetUrl: string,
  feedback: string
): string {
  if (assetType === 'image') {
    return `Please use the generate_image function to revise this image: ${assetUrl}\n\nRevision request: ${feedback}\n\nUse the original image as an input image for editing. The user has already approved this exact source image by requesting this revision, so pass confirm=true on that generate_image call — do not stop to ask for confirmation, nobody is waiting to answer.`;
  }
  if (assetType === 'html') {
    return `Please revise this HTML report: ${assetUrl}\n\nRevision request: ${feedback}\n\nFirst, call read_file_content to understand the current HTML structure. Then use update_html_file with update_type="css" and CSS selectors to target the specific elements that need changes. Keep the HTML well-structured and production-ready.`;
  }
  throw new Error(`Unsupported asset type for Agent Mode revision: ${assetType}`);
}

function normalizeInputImages(toolCall: any): string[] {
  const rawInputImages =
    toolCall?.arguments?.inputImages ??
    toolCall?.arguments?.input_images ??
    toolCall?.result?.inputImages ??
    toolCall?.result?.input_images ??
    [];

  if (typeof rawInputImages === 'string') return [rawInputImages];
  if (!Array.isArray(rawInputImages)) return [];
  return rawInputImages.filter((value): value is string => typeof value === 'string');
}

export function isApprovedRevisionSource(toolCall: any, approvedAssetUrl: string): boolean {
  const inputImages = normalizeInputImages(toolCall);
  if (inputImages.length === 0) return true;
  return inputImages.includes(approvedAssetUrl);
}

/**
 * ENG-936: classify why a revision produced no asset, so the oncall alert names the
 * real cause. "Could not extract new asset URL" is the last resort, not the default —
 * a run parked on the image-edit confirmation gate is a different failure with a
 * different fix, and reporting it as an extraction bug is what filed ENG-936.
 */
export function describeRevisionFailure(state: {
  toolCallFailed: boolean;
  toolCallFailureMessage: string;
  awaitingConfirmation: boolean;
}): { subject: string; reason: string } {
  if (state.toolCallFailed) {
    return {
      subject: 'Agent Mode Revision: Tool Call Failed',
      reason: `Tool call failed: ${state.toolCallFailureMessage}`,
    };
  }
  if (state.awaitingConfirmation) {
    return {
      subject: 'Agent Mode Revision: Blocked on Image-Edit Confirmation',
      reason:
        'The revision tool stopped for user confirmation of the source image, but an auto-revision has no user in the loop, so no asset was produced.',
    };
  }
  return {
    subject: 'Agent Mode Revision: Failed to Extract Asset URL',
    reason: 'Could not extract new asset URL from toolCalls',
  };
}

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

  const revisionMessage = buildAgentModeRevisionMessage(
    approval.assetType,
    approval.assetUrl,
    feedback
  );
  const requiredFunctions: Array<{ functionName: string; minCount: number }> =
    approval.assetType === 'image'
      ? [{ functionName: 'generate_image', minCount: 1 }]
      : [{ functionName: 'update_html_file', minCount: 1 }];

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
    let awaitingConfirmation = false;

    if (result.success && result.toolCalls.length > 0) {
      for (const toolCall of result.toolCalls) {
        const toolResult = toolCall?.result || {};

        // ENG-936: a tool that parked for user confirmation produced no asset and
        // never will — nobody is in this loop to answer it.
        if (toolResult.awaitingUserConfirmation === true) {
          awaitingConfirmation = true;
          continue;
        }

        if (approval.assetType === 'image') {
          if (!isApprovedRevisionSource(toolCall, approval.assetUrl)) {
            toolCallFailed = true;
            toolCallFailureMessage = `generate_image used an unapproved source image. Expected "${approval.assetUrl}".`;
            continue;
          }

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
      const failure = describeRevisionFailure({
        toolCallFailed,
        toolCallFailureMessage,
        awaitingConfirmation,
      });
      console.warn(`${failure.reason}. Tool calls: ${JSON.stringify(result.toolCalls)}`);

      try {
        let ishareLink = '';
        try {
          ishareLink = await chatbotDb.createOrReuseInteractiveShare(agentSessionId);
        } catch {
          const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
          ishareLink = `${customerFrontendUrl}/agent-mode/${agentSessionId}`;
        }

        await sendAgentModeOncallAlert({
          subject: failure.subject,
          message: `${failure.reason}\n\nSession: ${agentSessionId}\nAsset Type: ${approval.assetType}\nOriginal Asset URL: ${approval.assetUrl}\nFeedback: ${feedback}`,
          sessionId: agentSessionId,
          context: {
            'iShare Link': ishareLink,
            'Asset Type': approval.assetType || 'unknown',
            'Original Asset URL': approval.assetUrl,
            'Original Filename': approval.filename || 'unknown',
            'Feedback': feedback,
            'Revision Success': result.success,
            'Tool Call Failed': toolCallFailed,
            'Awaiting User Confirmation': awaitingConfirmation,
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
