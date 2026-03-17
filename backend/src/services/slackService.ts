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

    const result = await slackClient.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 100,
    });

    if (!result.channels) {
      console.log("❌ No channels found in response");
      return [];
    }

    // Filter channels where bot is a member and format them
    const channels = result.channels
      .filter((channel) => {
        const shouldInclude = channel.is_member === true;
        console.log(
          `🔍 Channel ${channel.name}: is_member=${channel.is_member}, including=${shouldInclude}`,
        );
        return shouldInclude;
      })
      .map((channel) => ({
        id: channel.id!,
        name: channel.name!,
        displayName: `#${channel.name}`,
        isPrivate: channel.is_private || false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log("✅ Filtered channels:", channels);
    return channels;
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

