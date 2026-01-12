import { resendService } from './resendService';
import { userDb } from './db';

interface NotificationOptions {
  notifyUser?: boolean;
  notifyItemPoc?: boolean;
  notifyPhasePoc?: boolean;
  notifyPlanPoc?: boolean;
  message?: string;
}

interface GTMPlan {
  planId: string;
  userId: string;
  title: string;
  description?: string;
  dri?: string;
  status: string;
  phases?: Phase[];
  [key: string]: any;
}

interface Phase {
  id: string;
  title: string;
  description?: string;
  dri?: string;
  status: string;
  workItems?: WorkItem[];
  [key: string]: any;
}

interface WorkItem {
  id: string;
  title: string;
  description?: string;
  status: string;
  dri?: string;
  notes?: string;
  [key: string]: any;
}

interface UpdateChanges {
  status?: string;
  notes?: string;
  dri?: string;
}

/**
 * Send GTM plan update notifications to selected recipients
 * @param plan The updated GTM plan
 * @param phaseId The ID of the phase containing the updated work item
 * @param workItemId The ID of the updated work item
 * @param changes The changes made (status, notes, dri)
 * @param notifications Notification preferences
 * @param customerFrontendUrl The customer portal frontend URL
 */
export async function sendGTMPlanUpdateNotifications(
  plan: GTMPlan,
  phaseId: string,
  workItemId: string,
  changes: UpdateChanges,
  notifications: NotificationOptions,
  customerFrontendUrl: string = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'
): Promise<void> {
  // Check if any notifications are requested
  if (!notifications || (!notifications.notifyUser && !notifications.notifyItemPoc && !notifications.notifyPhasePoc && !notifications.notifyPlanPoc)) {
    return;
  }

  try {
    const phase = plan.phases?.find((p: Phase) => p.id === phaseId);
    const workItem = phase?.workItems?.find((item: WorkItem) => item.id === workItemId);

    if (!phase || !workItem) {
      console.error("Phase or work item not found for notification");
      return;
    }

    const recipients: string[] = [];

    // Collect recipients based on preferences
    if (notifications.notifyUser && plan.userId) {
      try {
        const user = await userDb.getUserById(plan.userId);
        if (user?.email) {
          recipients.push(user.email);
        }
      } catch (err) {
        console.error("Error fetching user for notification:", err);
      }
    }

    if (notifications.notifyPlanPoc && plan.dri) {
      recipients.push(plan.dri);
    }

    if (notifications.notifyPhasePoc && phase.dri) {
      recipients.push(phase.dri);
    }

    if (notifications.notifyItemPoc && workItem.dri) {
      recipients.push(workItem.dri);
    }

    // Remove duplicates
    const uniqueRecipients = Array.from(new Set(recipients));

    if (uniqueRecipients.length === 0) {
      return;
    }

    // Determine what was changed
    const changeDescription: string[] = [];
    if (changes.status !== undefined) {
      changeDescription.push(`Status changed to: ${changes.status}`);
    }
    if (changes.notes !== undefined) {
      changeDescription.push(`Notes updated`);
    }
    if (changes.dri !== undefined) {
      changeDescription.push(`PoC ${changes.dri ? `assigned to: ${changes.dri}` : 'removed'}`);
    }

    const changeText = changeDescription.length > 0
      ? changeDescription.join(", ")
      : "Work item updated";

    // Get updated notes if they were changed
    const updatedNotes = changes.notes !== undefined ? workItem.notes : null;

    // Get optional message from notifications
    const customMessage = notifications.message && notifications.message.trim()
      ? notifications.message.trim()
      : null;

    // Get customer portal URL
    const gtmPlanUrl = `${customerFrontendUrl}/gtm-plan`;

    const subject = `GTM Plan Update: ${plan.title}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">GTM Plan Update Notification</h2>
        <p>Hello,</p>
        <p>This is to notify you that a work item in the GTM Plan "<strong>${plan.title}</strong>" has been updated.</p>
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Plan:</strong> ${plan.title}</p>
          ${phase ? `<p style="margin: 5px 0;"><strong>Phase:</strong> ${phase.title}</p>` : ''}
          ${workItem ? `<p style="margin: 5px 0;"><strong>Work Item:</strong> ${workItem.title}</p>` : ''}
          <p style="margin: 5px 0;"><strong>Change:</strong> ${changeText}</p>
        </div>
        ${updatedNotes ? `
        <div style="background-color: #fff9e6; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0; border-radius: 4px;">
          <p style="margin: 0; font-weight: 600; color: #f57c00;">Updated Notes:</p>
          <p style="margin: 10px 0 0 0; white-space: pre-wrap;">${updatedNotes.replace(/\n/g, '<br>')}</p>
        </div>
        ` : ''}
        ${customMessage ? `
        <div style="background-color: #e3f2fd; padding: 15px; border-left: 4px solid #2196f3; margin: 20px 0; border-radius: 4px;">
          <p style="margin: 0; font-weight: 600; color: #1976d2;">Additional Message:</p>
          <p style="margin: 10px 0 0 0; white-space: pre-wrap;">${customMessage.replace(/\n/g, '<br>')}</p>
        </div>
        ` : ''}
        <div style="text-align: center; margin: 30px 0;">
          <a href="${gtmPlanUrl}" style="display: inline-block; background-color: #643B7E; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: 600;">View GTM Plan</a>
        </div>
        <p style="color: #666; font-size: 12px; margin-top: 30px;">This is an automated notification from AgentWeb.</p>
      </div>
    `;

    const text = `
GTM Plan Update Notification

Hello,

This is to notify you that a work item in the GTM Plan "${plan.title}" has been updated.

Plan: ${plan.title}
${phase ? `Phase: ${phase.title}\n` : ''}${workItem ? `Work Item: ${workItem.title}\n` : ''}Change: ${changeText}
${updatedNotes ? `\nUpdated Notes:\n${updatedNotes}\n` : ''}${customMessage ? `\nAdditional Message:\n${customMessage}\n` : ''}
View your GTM Plan: ${gtmPlanUrl}

This is an automated notification from AgentWeb.
    `.trim();

    // Send emails to all recipients using system email
    for (const recipient of uniqueRecipients) {
      try {
        await resendService.sendSystemEmail({
          to: recipient,
          subject,
          html,
          text,
        });
        console.log(`GTM Plan update notification sent to ${recipient}`);
      } catch (emailError: any) {
        console.error(`Failed to send notification to ${recipient}:`, emailError);
        // Don't fail the entire request if email fails
      }
    }
  } catch (notificationError: any) {
    console.error("Error sending GTM plan notifications:", notificationError);
    // Don't throw error, just log it
  }
}
