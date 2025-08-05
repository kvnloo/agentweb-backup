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
           executionId: request.executionId,
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
               : `<${request.imageUrl}|View ${request.assetType.charAt(0).toUpperCase() + request.assetType.slice(1)}>`,
           },
           ...(request.assetType !== 'video' && {
             accessory: {
               type: "image",
               image_url: request.imageUrl,
               alt_text: request.filename,
             },
           }),
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
                text: "🔶 Needs Changes",
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
  decision: "approved" | "needs_changes",
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

    // Find the section block with the submission details to update it
    const statusBlockIndex = newBlocks.findIndex(
      (block: any) =>
        block.type === "section" &&
        block.text &&
        block.text.text.includes("*Status:*")
    );

    const decisionText = decision === "approved" ? "✅ Approved" : "🔶 Needs Changes";
    let statusUpdateText = `*Status:* ${decisionText} by @${reviewedBy}`;
    if (decision === "needs_changes" && feedback) {
      statusUpdateText += `\n*Feedback:* ${feedback}`;
    }

    const newStatusBlock = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: statusUpdateText,
      },
    };

    if (statusBlockIndex !== -1) {
      // If a status block already exists, replace it
      newBlocks[statusBlockIndex] = newStatusBlock;
    } else {
      // Otherwise, add it after the main content, before the actions
      const actionsBlockIndex = newBlocks.findIndex(
        (block: any) => block.type === "actions"
      );
      if (actionsBlockIndex !== -1) {
        newBlocks.splice(actionsBlockIndex, 0, newStatusBlock);
      } else {
        newBlocks.push(newStatusBlock);
      }
    }

    // Remove the action buttons
    const finalBlocks = newBlocks.filter(
      (block: any) => block.type !== "actions"
    );

          const assetDisplayName = assetType ? assetType.charAt(0).toUpperCase() + assetType.slice(1) : 'Asset';
      await slackClient.chat.update({
        channel,
        ts: messageTs,
        text: `${assetDisplayName} ${decision}: ${decision === "approved" ? "Approved" : "Needs Changes"}`,
        blocks: finalBlocks,
      });

    console.log("✅ Approval message updated successfully");
  } catch (error) {
    console.error("Error updating approval message:", error);
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
  executionId?: string
): Promise<void> {
  if (!slackClient) {
    throw new Error("Slack client not initialized. Check SLACK_BOT_TOKEN environment variable.");
  }

  try {
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
          text: "Submit Changes",
        },
        close: {
          type: "plain_text",
          text: "Cancel",
        },
        private_metadata: JSON.stringify({
          assetUrl,
          filename,
          executionId,
        }),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Asset:* ${filename}\n*Action:* Request Changes`,
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
                text: "Please provide specific feedback about what changes are needed...",
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
 * Verify Slack webhook signature for security
 */
export function verifySlackSignature(
  body: string,
  signature: string,
  timestamp: string
): boolean {
  if (!process.env.SLACK_SIGNING_SECRET) {
    console.warn("⚠️ SLACK_SIGNING_SECRET not found. Skipping signature verification.");
    return true; // Allow in development, but should be required in production
  }

  // In a real implementation, you would verify the signature using crypto
  // For now, we'll do a basic check
  const expectedSignature = `v0=${process.env.SLACK_SIGNING_SECRET}`;
  return signature === expectedSignature;
}