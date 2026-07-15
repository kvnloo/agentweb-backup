import { WebClient } from "@slack/web-api";

// Initialize Slack Web API client
let slackClient: WebClient | null = null;

if (process.env.SLACK_BOT_TOKEN) {
  slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
} else {
  console.warn("⚠️ SLACK_BOT_TOKEN not found in environment variables. Slack integration will not work.");
}

export const APPROVAL_CHANNEL = process.env.SLACK_APPROVAL_CHANNEL || "#approvals";

export interface SlackChannel {
  id: string;
  name: string;
  displayName: string;
  isPrivate: boolean;
}

export interface ApprovalRequest {
  executionId?: string; // Optional for backward compatibility
  imageUrl: string; // This is actually the assetUrl
  filename: string;
  assetType: string; // Asset type (image, video, etc.)
  userId: string;
  channel: string;
  note?: string; // Optional note for context
}

/**
 * Get channel info by ID
 */
export async function getSlackChannelInfo(channelId: string): Promise<SlackChannel | null> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  try {
    console.log(`🔍 Fetching Slack channel info for: ${channelId}`);

    const result = await slackClient.conversations.info({
      channel: channelId,
    });

    if (!result.ok || !result.channel) {
      console.log(`❌ Could not fetch channel info for: ${channelId}`);
      return null;
    }

    const channel = result.channel;
    return {
      id: channel.id!,
      name: channel.name!,
      displayName: `#${channel.name}`,
      isPrivate: channel.is_private || false,
    };
  } catch (error) {
    console.error(`❌ Error fetching Slack channel info for ${channelId}:`, error);
    return null;
  }
}

/**
 * Get list of Slack channels the bot is a member of
 */
export async function getSlackChannels(): Promise<SlackChannel[]> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  try {
    console.log("🔍 Fetching Slack channels...");

    const allChannels: SlackChannel[] = [];
    let cursor: string | undefined;

    do {
      const result = await slackClient.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });

      if (!result.channels) break;

      for (const channel of result.channels) {
        if (channel.is_member === true) {
          allChannels.push({
            id: channel.id!,
            name: channel.name!,
            displayName: `#${channel.name}`,
            isPrivate: channel.is_private || false,
          });
        }
      }

      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    allChannels.sort((a, b) => a.name.localeCompare(b.name));
    console.log("✅ Filtered channels:", allChannels);
    return allChannels;
  } catch (error) {
    console.error("❌ Error fetching Slack channels:", error);
    throw error;
  }
}

/**
 * Send approval request to Slack channel
 */
export async function sendApprovalRequest(
  request: ApprovalRequest
): Promise<{ messageTs: string | null }> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  try {
    console.log("📨 Sending approval request to Slack...");
    console.log("📝 Request details:", {
      channel: request.channel,
      filename: request.filename,
      executionId: request.executionId,
    });

    const result = await slackClient.chat.postMessage({
      channel: request.channel,
      text: `New ${request.assetType.charAt(0).toUpperCase() + request.assetType.slice(1)} Approval Request: ${request.filename}`,
             metadata: {
         event_type: "asset_approval_request",
                 event_payload: {
          executionId: request.executionId || '',
          assetUrl: request.imageUrl,
          assetType: request.assetType,
          userId: request.userId,
        },
       },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*New ${request.assetType.charAt(0).toUpperCase() + request.assetType.slice(1)} Approval Request*\n\n*Filename:* ${request.filename}\n*Asset Type:* ${request.assetType.toUpperCase()}${request.note ? `\n*Note:* ${request.note}` : ''}`,
          },
        },
                         {
          type: "section",
          text: {
            type: "mrkdwn",
            text: request.assetType === 'video' 
              ? `📹 *Video File* (Click to download)\n<${request.imageUrl}|${request.filename}>`
              : request.assetType === 'html'
                ? `📄 *HTML Report* (Click to view)\n<${request.imageUrl}|${request.filename}>`
                : `<${request.imageUrl}|View ${request.assetType.charAt(0).toUpperCase() + request.assetType.slice(1)}>`,
          },
          ...(request.assetType !== 'video' && request.assetType !== 'html' && {
            accessory: {
              type: "image",
              image_url: request.imageUrl,
              alt_text: request.filename,
            },
          }),
        },
        {
          type: "divider"
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: " " // Empty space for better mobile spacing
          }
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "✅ Approve",
                emoji: true,
              },
              style: "primary",
              action_id: "approve_asset",
              value: JSON.stringify({
                assetUrl: request.imageUrl,
                filename: request.filename,
                executionId: request.executionId,
              }),
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🔶 Request Changes",
                emoji: true,
              },
              style: "danger",
              action_id: "needs_changes_asset",
              value: JSON.stringify({
                assetUrl: request.imageUrl,
                filename: request.filename,
                executionId: request.executionId,
              }),
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "❌ Reject",
                emoji: true,
              },
              style: "danger",
              action_id: "reject_asset",
              value: JSON.stringify({
                assetUrl: request.imageUrl,
                filename: request.filename,
                executionId: request.executionId,
              }),
            },
            // Only show Test Email button for HTML assets
            ...(request.assetType === 'html' ? [{
              type: "button" as const,
              text: {
                type: "plain_text" as const,
                text: "📧 Test Email",
                emoji: true,
              },
              action_id: "test_email",
              value: JSON.stringify({
                assetUrl: request.imageUrl,
                filename: request.filename,
                executionId: request.executionId,
              }),
            }] : []),
          ],
        },
      ],
    });

    if (!result.ok) {
      console.error("❌ Slack API Error:", result.error);
      throw new Error(`Failed to send message to Slack: ${result.error}`);
    }

    console.log("✅ Approval request sent successfully to channel:", request.channel);
    return { messageTs: result.ts || null };
  } catch (error) {
    console.error("💥 Error sending approval request:", error);
    throw error;
  }
}

/**
 * Update approval message after decision
 */
export async function updateApprovalMessage(
  channel: string,
  messageTs: string,
  decision: "approved" | "needs_changes" | "rejected",
  reviewedBy: string,
  feedback?: string,
  assetType?: string
): Promise<void> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  try {
    // Get the original message
    const historyResult = await slackClient.conversations.history({
      channel: channel,
      latest: messageTs,
      limit: 1,
      inclusive: true,
    });

    if (
      !historyResult.ok ||
      !historyResult.messages ||
      historyResult.messages.length === 0
    ) {
      console.error("Could not fetch original message", historyResult.error);
      throw new Error("Could not fetch original message");
    }

    const originalMessage = historyResult.messages[0];
    const originalBlocks = originalMessage.blocks || [];
    const newBlocks = [...originalBlocks];

    // Find all status blocks (there might be multiple if history is being tracked)
    const statusBlockIndices: number[] = [];
    newBlocks.forEach((block: any, index: number) => {
      if (
        block.type === "section" &&
        block.text &&
        block.text.text &&
        (block.text.text.includes("*Status:*") || block.text.text.includes("*History:*"))
      ) {
        statusBlockIndices.push(index);
      }
    });

    // Create new status update with timestamp
    const timestamp = new Date().toLocaleString();
    let newStatusUpdate = `${decision === "approved" ? "✅ Approved" : decision === "needs_changes" ? "🔶 Request Changes" : "❌ Rejected"} by @${reviewedBy} at ${timestamp}`;
    if (decision === "needs_changes" && feedback) {
      newStatusUpdate += `\n  • Feedback: ${feedback}`;
    }
    if (decision === "rejected" && feedback) {
      newStatusUpdate += `\n  • Feedback: ${feedback}`;
    }

    // If status blocks exist, append to the first one (which contains the history)
    if (statusBlockIndices.length > 0) {
      const firstStatusBlockIndex = statusBlockIndices[0];
      const existingStatusBlock = newBlocks[firstStatusBlockIndex];
      const existingText = existingStatusBlock.text?.text;
      
      if (existingText) {
        // Check if it already has a History section, otherwise convert Status to History
        let updatedText: string;
        if (existingText.includes("*History:*")) {
          // Append to existing history
          updatedText = existingText + `\n\n${newStatusUpdate}`;
        } else {
          // Convert Status to History and add new entry
          updatedText = existingText.replace("*Status:*", "*History:*") + `\n\n${newStatusUpdate}`;
        }
        
        newBlocks[firstStatusBlockIndex] = {
          ...existingStatusBlock,
          text: {
            ...existingStatusBlock.text,
            text: updatedText,
          },
        };
      }
      
      // Remove any additional status blocks (they were duplicates)
      for (let i = statusBlockIndices.length - 1; i > 0; i--) {
        newBlocks.splice(statusBlockIndices[i], 1);
      }
    } else {
      // No status block exists, create a new one with History header
      const newStatusBlock: any = {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*History:*\n${newStatusUpdate}`,
        },
      };
      
      // Add it after the main content, before the actions
      const actionsBlockIndex = newBlocks.findIndex(
        (block: any) => block.type === "actions"
      );
      if (actionsBlockIndex !== -1) {
        newBlocks.splice(actionsBlockIndex, 0, newStatusBlock);
      } else {
        newBlocks.push(newStatusBlock);
      }
    }

    // Remove the action buttons only for final decisions (approved or rejected)
    // Keep buttons for needs_changes so users can approve or reject later
    const finalBlocks = decision === "needs_changes" 
      ? newBlocks 
      : newBlocks.filter((block: any) => block.type !== "actions");

          const assetDisplayName = assetType ? assetType.charAt(0).toUpperCase() + assetType.slice(1) : 'Asset';
      await slackClient.chat.update({
        channel,
        ts: messageTs,
        text: `${assetDisplayName} ${decision}: ${decision === "approved" ? "Approved" : decision === "needs_changes" ? "Request Changes" : "Rejected"}`,
        blocks: finalBlocks as any,
      });

    console.log("✅ Approval message updated successfully");
  } catch (error) {
    console.error("Error updating approval message:", error);
    throw error;
  }
}

/**
 * Open modal dialog for test email input
 */
export async function openTestEmailModal(
  triggerId: string,
  assetUrl: string,
  filename: string,
  executionId?: string,
  assetType?: string
): Promise<void> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  try {
    await slackClient.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "test_email_modal",
        title: {
          type: "plain_text",
          text: "Send Test Email",
        },
        submit: {
          type: "plain_text",
          text: "Send Test Email",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        private_metadata: JSON.stringify({
          assetUrl,
          filename,
          executionId,
          assetType,
        }),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Asset:* ${filename}\n*Type:* ${assetType ? assetType.charAt(0).toUpperCase() + assetType.slice(1) : 'Unknown'}\n*Action:* Send Test Email`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "📧 Enter the email address where you want to send a test email with this asset.",
            },
          },
          {
            type: "input",
            block_id: "email_input",
            element: {
              type: "email_text_input",
              action_id: "email_text",
              placeholder: {
                type: "plain_text",
                text: "Enter email address (e.g., test@example.com)",
              },
            },
            label: {
              type: "plain_text",
              text: "Email Address",
            },
          },
        ],
      },
    });

    console.log("✅ Test email modal opened successfully");
  } catch (error) {
    console.error("❌ Error opening test email modal:", error);
    throw error;
  }
}

/**
 * Open modal dialog for feedback input
 */
export async function openFeedbackModal(
  triggerId: string,
  assetUrl: string,
  filename: string,
  executionId?: string,
  assetType?: string
): Promise<void> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  try {
    // Determine if this asset type supports automated revision
    const supportsAutomatedRevision = assetType === 'image' || assetType === 'html';
    const revisionHint = supportsAutomatedRevision 
      ? "✅ Your feedback will automatically trigger our AI Agent to create a revision. You will receive a new approval request once the revision is complete."
      : "⚠️ This asset type does not support automated revision. Your feedback will be recorded for manual review.";

    // Customize placeholder text based on asset type
    let placeholderText = "Please provide specific feedback about what changes are needed...";
    
    if (assetType === 'image') {
      placeholderText = "e.g., 'Change background from white to dark blue', 'Move the text to the left side', 'Add a drop shadow to the main element'";
    } else if (assetType === 'html') {
      placeholderText = "e.g., 'Remove section about the product', 'Change button color to blue', 'Add 20px margin between sections'";
    }

    await slackClient.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "feedback_modal",
        title: {
          type: "plain_text",
          text: "Provide Feedback",
        },
        submit: {
          type: "plain_text",
          text: "Request Changes",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        private_metadata: JSON.stringify({
          assetUrl,
          filename,
          executionId,
          assetType,
        }),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Asset:* ${filename}\n*Type:* ${assetType ? assetType.charAt(0).toUpperCase() + assetType.slice(1) : 'Unknown'}\n*Action:* Request Changes`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: revisionHint,
            },
          },
          {
            type: "input",
            block_id: "feedback_input",
            element: {
              type: "plain_text_input",
              action_id: "feedback_text",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: placeholderText,
              },
            },
            label: {
              type: "plain_text",
              text: "Feedback",
            },
          },
        ],
      },
    });

    console.log("✅ Feedback modal opened successfully");
  } catch (error) {
    console.error("❌ Error opening feedback modal:", error);
    throw error;
  }
}

/**
 * Open modal dialog for rejection reason input
 */
export async function openRejectModal(
  triggerId: string,
  assetUrl: string,
  filename: string,
  executionId?: string,
  assetType?: string
): Promise<void> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  try {
    // Customize placeholder text based on asset type
    let placeholderText = "Please provide a reason for rejecting this asset...";
    
    if (assetType === 'image') {
      placeholderText = "e.g., 'Does not match brand guidelines', 'Quality is too low', 'Wrong dimensions'";
    } else if (assetType === 'html') {
      placeholderText = "e.g., 'Layout is broken', 'Missing required sections', 'Does not meet accessibility standards'";
    } else if (assetType === 'video') {
      placeholderText = "e.g., 'Video quality is poor', 'Wrong duration', 'Audio issues'";
    }

    await slackClient.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "reject_modal",
        title: {
          type: "plain_text",
          text: "Reject Asset",
        },
        submit: {
          type: "plain_text",
          text: "Reject",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        private_metadata: JSON.stringify({
          assetUrl,
          filename,
          executionId,
          assetType,
        }),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Asset:* ${filename}\n*Type:* ${assetType ? assetType.charAt(0).toUpperCase() + assetType.slice(1) : 'Unknown'}\n*Action:* Reject Asset`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Please provide feedback why you want to reject it so we can improve.",
            },
          },
          {
            type: "input",
            block_id: "reject_reason_input",
            element: {
              type: "plain_text_input",
              action_id: "reject_reason_text",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: placeholderText,
              },
            },
            label: {
              type: "plain_text",
              text: "Feedback",
            },
          },
        ],
      },
    });

    console.log("✅ Reject modal opened successfully");
  } catch (error) {
    console.error("❌ Error opening reject modal:", error);
    throw error;
  }
}

/**
 * Send approval request to Slack and store in database
 */
export async function sendApprovalRequestWithTracking(
  request: ApprovalRequest & { channelName?: string }
): Promise<{ messageTs: string | null; approvalId: string }> {
  // Send to Slack
  const result = await sendApprovalRequest(request);

  // Store in database for tracking
  const { approvalDb } = await import('./approvalDb');
  const approval = await approvalDb.createApproval({
    assetUrl: request.imageUrl,
    filename: request.filename,
    assetType: request.assetType as any, // Cast to any to handle string to AssetType
    executionId: request.executionId || '',
    userId: request.userId,
    slackChannel: request.channel,
    slackChannelName: request.channelName || request.channel,
    slackMessageTs: result.messageTs,
    note: request.note,
  });

  console.log("✅ Approval request sent to Slack and stored in database");
  
  return {
    messageTs: result.messageTs,
    approvalId: approval.assetUrl // Use assetUrl as the ID since that's the primary key
  };
}

/**
 * Send a single Slack message for a batch of assets with a link to the review page
 */
export async function sendBatchApprovalRequest(params: {
  channel: string;
  batchId: string;
  assets: Array<{ filename: string; assetType: string }>;
  note?: string;
  reviewPageUrl: string;
}): Promise<{ messageTs: string | null }> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  const assetCount = params.assets.length;
  const typeCounts: Record<string, number> = {};
  for (const a of params.assets) {
    typeCounts[a.assetType] = (typeCounts[a.assetType] || 0) + 1;
  }
  const typeSummary = Object.entries(typeCounts)
    .map(([type, count]) => `${count} ${type}${count !== 1 ? 's' : ''}`)
    .join(', ');

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Batch Review Request (${assetCount} asset${assetCount !== 1 ? 's' : ''})*\n\n*Assets:* ${typeSummary}${params.note ? `\n*Note:* ${params.note}` : ''}`,
      },
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: `Review ${assetCount} Asset${assetCount !== 1 ? 's' : ''}`,
            emoji: true,
          },
          style: "primary",
          url: params.reviewPageUrl,
          action_id: "open_batch_review",
        },
      ],
    },
  ];

  const result = await slackClient.chat.postMessage({
    channel: params.channel,
    text: `Batch Review Request: ${assetCount} asset${assetCount !== 1 ? 's' : ''} ready for review`,
    blocks,
  });

  if (!result.ok) {
    throw new Error(`Failed to send batch review message to Slack: ${result.error}`);
  }

  return { messageTs: result.ts || null };
}

/**
 * Update the batch review Slack message with review progress
 */
export async function updateBatchReviewMessage(params: {
  channel: string;
  messageTs: string;
  totalAssets: number;
  reviewed: number;
  approved: number;
  needsChanges: number;
  rejected: number;
  reviewPageUrl: string;
  isComplete: boolean;
}): Promise<void> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  const { totalAssets, reviewed, approved, needsChanges, rejected, reviewPageUrl, isComplete } = params;
  const pending = totalAssets - reviewed;

  let statusText = `*Progress:* ${reviewed}/${totalAssets} reviewed`;
  const details: string[] = [];
  if (approved > 0) details.push(`${approved} approved`);
  if (needsChanges > 0) details.push(`${needsChanges} needs changes`);
  if (rejected > 0) details.push(`${rejected} rejected`);
  if (pending > 0) details.push(`${pending} pending`);
  if (details.length > 0) statusText += ` (${details.join(', ')})`;

  const headerText = isComplete
    ? `*Batch Review Complete (${totalAssets} asset${totalAssets !== 1 ? 's' : ''})*`
    : `*Batch Review Request (${totalAssets} asset${totalAssets !== 1 ? 's' : ''})*`;

  const blocks: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: headerText,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: statusText,
      },
    },
  ];

  blocks.push(
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: isComplete ? `View Results` : `Review Remaining (${pending})`,
            emoji: true,
          },
          style: isComplete ? undefined : "primary",
          url: reviewPageUrl,
          action_id: "open_batch_review",
        },
      ],
    }
  );

  await slackClient.chat.update({
    channel: params.channel,
    ts: params.messageTs,
    text: `Batch Review: ${reviewed}/${totalAssets} reviewed`,
    blocks,
  });
}

/**
 * Lead notification payload for Slack bot messages
 */
export interface LeadNotificationPayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  company?: string;
  phone?: string;
  linkedin?: string;
  listName: string;
  listId: string;
  crmUrl?: string;
  eventType?: string;
  timestamp?: string;
}

/**
 * Format a Slack Block Kit message for a new lead notification.
 * Exported separately so it can be unit-tested without HTTP calls.
 */
export function formatLeadNotificationPayload(lead: LeadNotificationPayload): {
  text: string;
  blocks: any[];
} {
  const fullName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Unknown';
  const timestamp = lead.timestamp || new Date().toISOString();
  const eventLabel = lead.eventType || 'New lead added';

  const fields: Array<{ type: string; text: string }> = [];

  fields.push({ type: 'mrkdwn', text: `*Name:*\n${fullName}` });

  if (lead.email) {
    fields.push({ type: 'mrkdwn', text: `*Email:*\n${lead.email}` });
  }

  if (lead.company) {
    fields.push({ type: 'mrkdwn', text: `*Company:*\n${lead.company}` });
  }

  if (lead.phone) {
    fields.push({ type: 'mrkdwn', text: `*Phone:*\n${lead.phone}` });
  }

  if (lead.linkedin) {
    fields.push({ type: 'mrkdwn', text: `*LinkedIn:*\n<${lead.linkedin}|Profile>` });
  }

  fields.push({ type: 'mrkdwn', text: `*List:*\n${lead.listName}` });

  const blocks: any[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: eventLabel,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields,
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Received at ${timestamp}`,
        },
      ],
    },
  ];

  if (lead.crmUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open CRM', emoji: true },
          url: lead.crmUrl,
          action_id: 'open_crm',
        },
      ],
    });
  }

  const fallbackText = `${eventLabel}: ${fullName}${lead.email ? ` (${lead.email})` : ''} — ${lead.listName}`;

  return { text: fallbackText, blocks };
}

/**
 * Send a lead notification to a Slack channel using the internal bot token.
 * Uses the same slackClient (WebClient) as the approval flow.
 * The channelId comes from the user's slackChannel field in DynamoDB.
 */
export async function sendLeadNotification(
  channelId: string,
  lead: LeadNotificationPayload
): Promise<void> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  const payload = formatLeadNotificationPayload(lead);

  const result = await slackClient.chat.postMessage({
    channel: channelId,
    text: payload.text,
    blocks: payload.blocks,
  });

  if (!result.ok) {
    throw new Error(`Slack API error: ${result.error}`);
  }
}

/**
 * Convert markdown to Slack mrkdwn format
 */
function markdownToMrkdwn(markdown: string): string {
  let text = markdown;

  // Handle markdown tables BEFORE other processing
  // Detect tables: lines with | separators
  const lines = text.split('\n');
  const processedLines: string[] = [];
  let inTable = false;
  let tableLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isTableLine = line.includes('|') && line.split('|').length >= 3;

    if (isTableLine) {
      if (!inTable) {
        inTable = true;
        tableLines = [];
      }
      tableLines.push(line);
    } else {
      if (inTable) {
        // Process accumulated table
        processedLines.push(formatTableForSlack(tableLines));
        inTable = false;
        tableLines = [];
      }
      processedLines.push(line);
    }
  }

  // Handle table at end of content
  if (inTable && tableLines.length > 0) {
    processedLines.push(formatTableForSlack(tableLines));
  }

  text = processedLines.join('\n');

  // Strip HTML tags but preserve content
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');
  text = text.replace(/<(p|div|h[1-6]|ul|ol|table|thead|tbody)(\s[^>]*)?>/gi, '');
  text = text.replace(/<li(\s[^>]*)?>/gi, '- ');
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi, '<$1|$2>');
  text = text.replace(/<(strong|b)(\s[^>]*)?>/gi, '*');
  text = text.replace(/<\/(strong|b)>/gi, '*');
  text = text.replace(/<(em|i)(\s[^>]*)?>/gi, '_');
  text = text.replace(/<\/(em|i)>/gi, '_');
  text = text.replace(/<code(\s[^>]*)?>/gi, '`');
  text = text.replace(/<\/code>/gi, '`');
  text = text.replace(/<(?!https?:\/\/)[^>]+>/g, '');
  // Decode HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  // Convert markdown bold: **text** -> *text*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  // Convert markdown links: [text](url) -> <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
  // Convert headers: ### text -> *text*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Clean up excessive newlines
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

/**
 * Format a markdown table for Slack using plain text with proper spacing
 */
function formatTableForSlack(tableLines: string[]): string {
  if (tableLines.length === 0) return '';

  // Parse table rows
  const rows = tableLines.map(line => {
    return line.split('|')
      .map(cell => cell.trim())
      .filter(cell => cell.length > 0);
  });

  if (rows.length === 0) return '';

  // Skip separator line (usually second line with dashes)
  const dataRows = rows.filter(row => !row.every(cell => /^[-:]+$/.test(cell)));

  if (dataRows.length === 0) return '';

  // Calculate column widths
  const numCols = Math.max(...dataRows.map(row => row.length));
  const colWidths: number[] = new Array(numCols).fill(0);

  for (const row of dataRows) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i], row[i].length);
    }
  }

  // Format rows with proper spacing
  const formattedRows = dataRows.map((row, rowIndex) => {
    const cells = row.map((cell, colIndex) => {
      return cell.padEnd(colWidths[colIndex], ' ');
    });
    return cells.join(' | ');
  });

  // Add separator after header row
  if (formattedRows.length > 1) {
    const separator = colWidths.map(width => '-'.repeat(width)).join('-+-');
    formattedRows.splice(1, 0, separator);
  }

  // Wrap in code block for monospaced font
  return '```\n' + formattedRows.join('\n') + '\n```';
}

const SLACK_MESSAGE_LIMIT = 3900; // Leave room for safety margin under 4000 char limit

/**
 * Post Emma's response to a Slack thread, splitting long messages if needed
 */
export async function postThreadResponse(
  channel: string,
  threadTs: string,
  markdownContent: string
): Promise<void> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  const mrkdwnContent = markdownToMrkdwn(markdownContent);

  // Split into chunks if too long
  const chunks: string[] = [];
  let remaining = mrkdwnContent;
  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MESSAGE_LIMIT) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitIndex = remaining.lastIndexOf('\n', SLACK_MESSAGE_LIMIT);
    if (splitIndex < SLACK_MESSAGE_LIMIT * 0.5) {
      // No good newline found, split at space
      splitIndex = remaining.lastIndexOf(' ', SLACK_MESSAGE_LIMIT);
    }
    if (splitIndex <= 0) {
      splitIndex = SLACK_MESSAGE_LIMIT;
    }
    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  for (const chunk of chunks) {
    await slackClient.chat.postMessage({
      channel,
      text: chunk,
      thread_ts: threadTs,
    });
  }
}

// Cache display name lookups for the lifetime of the process — user names rarely change
// and the bot serves a single workspace, so unbounded growth is not a concern.
const displayNameCache = new Map<string, Promise<string>>();

/**
 * Get a Slack user's display name
 */
export async function getSlackUserDisplayName(slackUserId: string): Promise<string> {
  if (!slackClient) {
    return slackUserId;
  }

  const cached = displayNameCache.get(slackUserId);
  if (cached) return cached;

  const promise = (async () => {
    try {
      const result = await slackClient!.users.info({ user: slackUserId });
      if (result.ok && result.user) {
        return (result.user as any).profile?.display_name
          || (result.user as any).profile?.real_name
          || (result.user as any).real_name
          || slackUserId;
      }
    } catch (error) {
      console.error(`Failed to get Slack user display name for ${slackUserId}:`, error);
    }
    return slackUserId;
  })();

  displayNameCache.set(slackUserId, promise);
  return promise;
}

/**
 * Replace all <@USERID> mentions in a Slack message text with the user's display name.
 * Falls back to the raw ID if the lookup fails or Slack client is unavailable.
 */
export async function resolveSlackMentionsInText(text: string): Promise<string> {
  const mentionPattern = /<@([A-Z0-9]+)>/g;
  const userIds = [...new Set([...text.matchAll(mentionPattern)].map((m) => m[1]))];
  if (userIds.length === 0) return text;

  const nameMap = new Map(
    await Promise.all(
      userIds.map(async (id) => [id, await getSlackUserDisplayName(id)] as const)
    )
  );

  return text.replace(mentionPattern, (_, id) => `@${nameMap.get(id) ?? id}`);
}

/**
 * Resolve display names for a list of Slack messages, deduplicating user ID lookups.
 */
async function resolveDisplayNames(messages: any[]): Promise<Map<string, string>> {
  const uniqueUserIds = [...new Set(messages.map((m) => m.user).filter((id): id is string => !!id))];
  const nameEntries = await Promise.all(
    uniqueUserIds.map(async (id) => {
      try {
        return [id, await getSlackUserDisplayName(id)] as const;
      } catch {
        return [id, id] as const;
      }
    })
  );
  return new Map(nameEntries);
}

export async function getSlackUserEmail(slackUserId: string): Promise<string | null> {
  if (!slackClient) {
    return null;
  }

  try {
    const result = await slackClient.users.info({ user: slackUserId });
    if (result.ok && result.user) {
      return (result.user as any).profile?.email || null;
    }
  } catch (error) {
    console.error(`Failed to get Slack user email for ${slackUserId}:`, error);
  }
  return null;
}

/**
 * Post a temporary "thinking" message to a Slack thread
 * Returns the message timestamp so it can be updated/deleted later
 */
export async function postThinkingMessage(
  channel: string,
  threadTs: string
): Promise<string | undefined> {
  if (!slackClient) {
    return undefined;
  }

  try {
    const result = await slackClient.chat.postMessage({
      channel,
      text: ':hourglass_flowing_sand: Thinking...',
      thread_ts: threadTs,
    });
    return result.ts;
  } catch (error) {
    console.error('Failed to post thinking message:', error);
    return undefined;
  }
}

/**
 * Delete a Slack message (used to remove "thinking" message after response is ready)
 */
export async function deleteSlackMessage(
  channel: string,
  messageTs: string
): Promise<void> {
  if (!slackClient) return;

  try {
    await slackClient.chat.delete({ channel, ts: messageTs });
  } catch (error) {
    console.error('Failed to delete Slack message:', error);
  }
}

/**
 * Download a file from Slack using the bot token for auth
 * Returns the file content as a Buffer
 */
export interface SlackMessage {
  ts: string;
  user: string;
  displayName: string;
  text: string;
  threadTs?: string;
  replyCount?: number;
}

/**
 * Fetch messages from a Slack channel, with user display names resolved.
 * Supports count-based limit and/or Unix timestamp bounds (oldest/latest).
 */
export async function getRecentChannelMessages(
  channelId: string,
  oldest?: string,
  latest?: string
): Promise<SlackMessage[]> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  const result = await slackClient.conversations.history({
    channel: channelId,
    ...(oldest ? { oldest } : {}),
    ...(latest ? { latest } : {}),
  });

  const messages = result.messages ?? [];
  const displayNameMap = await resolveDisplayNames(messages);

  return Promise.all(messages.map(async (msg) => {
    const userId = msg.user ?? msg.bot_id ?? 'unknown';
    return {
      ts: msg.ts ?? '',
      user: userId,
      displayName: msg.user ? (displayNameMap.get(msg.user) ?? userId) : userId,
      text: await resolveSlackMentionsInText(msg.text ?? ''),
      threadTs: msg.thread_ts,
      replyCount: msg.reply_count,
    } as SlackMessage;
  }));
}

/**
 * Fetch all replies in a Slack thread (conversations.replies).
 * Returns every message in the thread including the parent, with display names resolved.
 */
export async function getThreadReplies(
  channelId: string,
  threadTs: string
): Promise<SlackMessage[]> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  const result = await slackClient.conversations.replies({
    channel: channelId,
    ts: threadTs,
  });

  const messages = result.messages ?? [];
  const displayNameMap = await resolveDisplayNames(messages);

  return Promise.all(messages.map(async (msg) => {
    const userId = msg.user ?? msg.bot_id ?? 'unknown';
    return {
      ts: msg.ts ?? '',
      user: userId,
      displayName: msg.user ? (displayNameMap.get(msg.user) ?? userId) : userId,
      text: await resolveSlackMentionsInText(msg.text ?? ''),
      threadTs: msg.thread_ts,
    } as SlackMessage;
  }));
}

/**
 * Post a message to a Slack channel (or reply to a thread).
 * Returns the message timestamp which can be used as a thread anchor.
 */
export async function postSlackMessage(
  channelId: string,
  text: string,
  threadTs?: string
): Promise<{ ts: string; channel: string }> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  const result = await slackClient.chat.postMessage({
    channel: channelId,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });

  return {
    ts: result.ts ?? '',
    channel: result.channel ?? channelId,
  };
}

/**
 * A file reference as it arrives on a Slack `file_share` event.
 *
 * In a normal channel Slack includes `url_private`. In a Slack Connect /
 * externally-shared channel (`is_ext_shared_channel: true`) it instead sends a
 * stub with `file_access: 'check_file_info'` and NO `url_private`, expecting the
 * app to call files.info to hydrate it.
 */
export interface SlackFileRef {
  id?: string;
  url_private?: string;
  url_private_download?: string;
  file_access?: string;
}

/**
 * Resolve a downloadable Slack file URL from a `file_share` file object.
 *
 * If the file already carries a `url_private` (normal channels) it is returned
 * as-is. If it is a Slack Connect stub (`file_access: 'check_file_info'`, no
 * `url_private`), we hydrate it via files.info (requires the `files:read` scope)
 * to obtain the real URL. Without this, `url_private` is undefined and
 * downloadSlackFile → axios throws `TypeError: Invalid URL`, silently dropping
 * the attachment (ENG-323).
 */
export async function resolveSlackFileUrl(file: SlackFileRef): Promise<string> {
  if (file.url_private) {
    return file.url_private;
  }
  if (!file.id) {
    throw new Error('Slack file has no id or url_private; cannot resolve a download URL');
  }
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  const info = await slackClient.files.info({ file: file.id });
  const url = info.file?.url_private_download || info.file?.url_private;
  if (!url) {
    throw new Error(`Slack files.info returned no url_private for file ${file.id}`);
  }
  return url;
}

export async function downloadSlackFile(urlPrivate: string): Promise<Buffer> {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN not set');
  }

  // Use axios instead of fetch: axios preserves the Authorization header through ALL
  // redirects by default, while Node's fetch strips it on cross-origin redirects.
  // Slack's url_private redirects through multiple slack.com subdomains before returning
  // the file bytes, and all hops require the Bearer token.
  const axios = (await import('axios')).default;
  const response = await axios.get<ArrayBuffer>(urlPrivate, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  const buffer = Buffer.from(response.data);
  // Slack serves an HTML sign-in/error page (not the file bytes) when the bot can't
  // access the file. Detect a real HTML document specifically — matching a bare "<!"
  // prefix wrongly rejected valid SVG/XML uploads that legitimately begin with
  // "<!DOCTYPE svg", "<!--", or "<!ENTITY" (ENG-323), leaving the attachment empty.
  const prefix = buffer.slice(0, 64).toString('utf8').trimStart().toLowerCase();
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) {
    throw new Error(`Slack file download returned HTML for URL: ${urlPrivate}`);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// User → channel resolution (moved from emma/slackMessageTools.ts so non-Emma
// callers — e.g. shipNotifyService — can resolve "the customer's channel"
// without pulling in the Emma tool registry).
// ---------------------------------------------------------------------------

/** The channels configured for a user (supports slackChannels array + legacy slackChannel). */
export function getUserAllowedChannels(user: { slackChannels?: string[]; slackChannel?: string }): string[] {
  if (user.slackChannels && user.slackChannels.length > 0) return user.slackChannels;
  if (user.slackChannel) return [user.slackChannel];
  return [];
}

/**
 * Allowed channels for a user, falling back to the org's channel config for org members.
 * Priority: personal channels → org.slackChannel (if set on org record) → org owner's user channels.
 */
export async function getEffectiveAllowedChannels(
  user: { slackChannels?: string[]; slackChannel?: string; orgId?: string } | null | undefined,
): Promise<string[]> {
  const { userDb, orgDb } = await import('./db');
  const personal = getUserAllowedChannels(user ?? {});
  if (personal.length > 0) return personal;
  if (user?.orgId) {
    const org = await orgDb.getOrgById(user.orgId);
    if (org?.slackChannel) return [org.slackChannel];
    // Channels are typically stored on the org owner's user record, not the org record itself
    if (org?.ownerUserId) {
      const owner = await userDb.getUserById(org.ownerUserId);
      const ownerChannels = getUserAllowedChannels(owner ?? {});
      if (ownerChannels.length > 0) return ownerChannels;
    }
  }
  return [];
}
