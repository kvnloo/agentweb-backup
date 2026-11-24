import { resendService } from './resendService';
import { userDb } from './db';
import type { StatusReportResult } from './gtmStatusReportOutcome';
import { isSuppressedSendResult } from '../utils/nonProdEmailGuard';
import { escapeHtml as escapeText } from '../emma/impl/shared/htmlEscaping';

/**
 * Escapes text a person (or an agent) wrote before it goes into the HTML part of an email. Plan, phase and work item titles, descriptions,
 * notes, contacts, statuses and the optional message are all caller text; without this a title such as `<a href="https://x">reset your
 * password</a>` arrives as a live link in a message from AgentWeb's system sender. The plain-text part of each email is not HTML and is left as written.
 * The escaping itself is the shared helper's (emma/impl/shared/htmlEscaping.ts); this only makes it total (null and undefined are empty text).
 */
const esc = (value: unknown): string => escapeText(String(value ?? ''));

interface NotificationOptions {
  notifyUser?: boolean;
  notifyItemPoc?: boolean;
  notifyPhasePoc?: boolean;
  notifyPlanPoc?: boolean;
  message?: string;
}

interface StatusReportNotificationOptions {
  notifyUser?: boolean;
  notifyPlanPoc?: boolean;
  notifyPhasePoc?: boolean;   // For phase reports
  notifyPhasePocs?: boolean;  // For plan reports (all phase PoCs)
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
  dueDate?: string | null;
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
    if (changes.dueDate !== undefined) {
      if (changes.dueDate) {
        // Format the due date nicely
        const [year, month, day] = changes.dueDate.split('-').map(Number);
        const dueDateObj = new Date(year, month - 1, day);
        const formattedDate = dueDateObj.toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        });
        changeDescription.push(`Due date set to: ${formattedDate}`);
      } else {
        changeDescription.push(`Due date removed`);
      }
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
        <p>This is to notify you that a work item in the GTM Plan "<strong>${esc(plan.title)}</strong>" has been updated.</p>
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Plan:</strong> ${esc(plan.title)}</p>
          ${phase ? `<p style="margin: 5px 0;"><strong>Phase:</strong> ${esc(phase.title)}</p>` : ''}
          ${workItem ? `<p style="margin: 5px 0;"><strong>Work Item:</strong> ${esc(workItem.title)}</p>` : ''}
          <p style="margin: 5px 0;"><strong>Change:</strong> ${esc(changeText)}</p>
        </div>
        ${updatedNotes ? `
        <div style="background-color: #fff9e6; padding: 15px; border-left: 4px solid #ffc107; margin: 20px 0; border-radius: 4px;">
          <p style="margin: 0; font-weight: 600; color: #f57c00;">Updated Notes:</p>
          <p style="margin: 10px 0 0 0; white-space: pre-wrap;">${esc(updatedNotes).replace(/\n/g, '<br>')}</p>
        </div>
        ` : ''}
        ${customMessage ? `
        <div style="background-color: #e3f2fd; padding: 15px; border-left: 4px solid #2196f3; margin: 20px 0; border-radius: 4px;">
          <p style="margin: 0; font-weight: 600; color: #1976d2;">Additional Message:</p>
          <p style="margin: 10px 0 0 0; white-space: pre-wrap;">${esc(customMessage).replace(/\n/g, '<br>')}</p>
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

/**
 * Send phase status report to selected recipients
 * @param plan The GTM plan containing the phase
 * @param phaseId The ID of the phase to report on
 * @param notifications Notification preferences
 * @param customerFrontendUrl The customer portal frontend URL
 */
export async function sendPhaseStatusReport(
  plan: GTMPlan,
  phaseId: string,
  notifications: StatusReportNotificationOptions,
  customerFrontendUrl: string = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'
): Promise<StatusReportResult> {
  const result: StatusReportResult = { recipients: 0, sent: 0, failed: 0 };

  // Check if any notifications are requested
  if (!notifications || (!notifications.notifyUser && !notifications.notifyPlanPoc && !notifications.notifyPhasePoc)) {
    return result;
  }

  try {
    const phase = plan.phases?.find((p: Phase) => p.id === phaseId);

    if (!phase) {
      console.error("Phase not found for status report");
      return result;
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
        console.error("Error fetching user for status report:", err);
      }
    }

    if (notifications.notifyPlanPoc && plan.dri) {
      recipients.push(plan.dri);
    }

    if (notifications.notifyPhasePoc && phase.dri) {
      recipients.push(phase.dri);
    }

    // Remove duplicates
    const uniqueRecipients = Array.from(new Set(recipients));

    result.recipients = uniqueRecipients.length;
    if (uniqueRecipients.length === 0) {
      return result;
    }

    // Get optional message from notifications
    const customMessage = notifications.message && notifications.message.trim()
      ? notifications.message.trim()
      : null;

    // Get customer portal URL
    const gtmPlanUrl = `${customerFrontendUrl}/gtm-plan`;

    // Generate work items table HTML
    const workItems = phase.workItems || [];
    const workItemsTableRows = workItems.map((item: WorkItem) => {
      const statusColor = item.status === 'completed' ? '#4caf50' :
                          item.status === 'skipped' ? '#9e9e9e' : '#ff9800';
      const dueDateText = item.dueDate
        ? (() => {
            const [year, month, day] = item.dueDate.split('-').map(Number);
            const dueDateObj = new Date(year, month - 1, day);
            return dueDateObj.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric'
            });
          })()
        : '-';
      const completedAtText = item.completedAt
        ? new Date(item.completedAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          })
        : '';

      return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${esc(item.title)}${item.description ? `<div style="color: #666; font-size: 12px; margin-top: 4px;">${esc(item.description)}</div>` : ''}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">
            <span style="background-color: ${statusColor}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">
              ${esc(item.status)}
            </span>
            ${completedAtText ? `<div style="color: #666; font-size: 11px; margin-top: 4px;">${completedAtText}</div>` : ''}
          </td>
          <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${dueDateText}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${esc(item.dri || '-')}</td>
          <td style="padding: 8px; border-bottom: 1px solid #e0e0e0; font-size: 13px; color: #555; white-space: pre-wrap;">${esc(item.notes || '-')}</td>
        </tr>
      `;
    }).join('');

    const subject = `GTM Plan Phase Status Report: ${phase.title}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
        <h2 style="color: #333;">Phase Status Report</h2>
        <p>Hello,</p>
        ${customMessage ? `
        <div style="background-color: #e3f2fd; padding: 15px; border-left: 4px solid #2196f3; margin: 20px 0; border-radius: 4px;">
          <p style="margin: 0; font-weight: 600; color: #1976d2;">Message:</p>
          <p style="margin: 10px 0 0 0; white-space: pre-wrap;">${esc(customMessage).replace(/\n/g, '<br>')}</p>
        </div>
        ` : ''}
        <p>This is a status report for the phase "<strong>${esc(phase.title)}</strong>" in the GTM Plan "<strong>${esc(plan.title)}</strong>".</p>
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Plan:</strong> ${esc(plan.title)}</p>
          <p style="margin: 5px 0;"><strong>Phase:</strong> ${esc(phase.title)}</p>
          <p style="margin: 5px 0;"><strong>Phase Status:</strong> ${esc(phase.status)}</p>
          ${phase.dri ? `<p style="margin: 5px 0;"><strong>Phase PoC:</strong> ${esc(phase.dri)}</p>` : ''}
          ${phase.dueDate ? `<p style="margin: 5px 0;"><strong>Phase Due Date:</strong> ${(() => {
            const [year, month, day] = phase.dueDate.split('-').map(Number);
            const dueDateObj = new Date(year, month - 1, day);
            return dueDateObj.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            });
          })()}</p>` : ''}
        </div>
        <h3 style="color: #333; margin-top: 30px;">Work Items Summary</h3>
        ${workItems.length > 0 ? `
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <thead>
            <tr style="background-color: #643B7E; color: white;">
              <th style="padding: 12px; text-align: left;">Title</th>
              <th style="padding: 12px; text-align: left;">Status</th>
              <th style="padding: 12px; text-align: left;">Due Date</th>
              <th style="padding: 12px; text-align: left;">PoC</th>
              <th style="padding: 12px; text-align: left;">Notes</th>
            </tr>
          </thead>
          <tbody>
            ${workItemsTableRows}
          </tbody>
        </table>
        ` : `
        <p style="color: #666;">No work items in this phase.</p>
        `}
        <div style="text-align: center; margin: 30px 0;">
          <a href="${gtmPlanUrl}" style="display: inline-block; background-color: #643B7E; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: 600;">View GTM Plan</a>
        </div>
        <p style="color: #666; font-size: 12px; margin-top: 30px;">This is an automated status report from AgentWeb.</p>
      </div>
    `;

    const text = `
Phase Status Report

${customMessage ? `Message:\n${customMessage}\n\n` : ''}
This is a status report for the phase "${phase.title}" in the GTM Plan "${plan.title}".

Plan: ${plan.title}
Phase: ${phase.title}
Phase Status: ${phase.status}
${phase.dri ? `Phase PoC: ${phase.dri}\n` : ''}${phase.dueDate ? `Phase Due Date: ${(() => {
  const [year, month, day] = phase.dueDate.split('-').map(Number);
  const dueDateObj = new Date(year, month - 1, day);
  return dueDateObj.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
})()}\n` : ''}

Work Items Summary:
${workItems.length > 0
  ? workItems.map((item: WorkItem) => {
      const dueDateText = item.dueDate
        ? (() => {
            const [year, month, day] = item.dueDate.split('-').map(Number);
            const dueDateObj = new Date(year, month - 1, day);
            return dueDateObj.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric'
            });
          })()
        : '-';
      const completedAtText = item.completedAt
        ? new Date(item.completedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : '';
      return `- ${item.title}${item.description ? ` | Description: ${item.description}` : ''} | Status: ${item.status}${completedAtText ? ` (${completedAtText})` : ''} | Due Date: ${dueDateText} | PoC: ${item.dri || '-'}${item.notes ? `\n  Notes: ${item.notes}` : ''}`;
    }).join('\n')
  : 'No work items in this phase.'}

View your GTM Plan: ${gtmPlanUrl}

This is an automated status report from AgentWeb.
    `.trim();

    // Send emails to all recipients using system email
    for (const recipient of uniqueRecipients) {
      try {
        const delivery = await resendService.sendSystemEmail({
          to: recipient,
          subject,
          html,
          text,
        });
        // outside production the email guard resolves a send it held back: that is not a delivery
        if (isSuppressedSendResult(delivery)) result.suppressed = (result.suppressed ?? 0) + 1;
        else result.sent += 1;
      } catch (emailError: any) {
        console.error(`Failed to send phase status report to ${recipient}:`, emailError);
        // Don't fail the entire request if email fails: the caller reads `failed`
        result.failed += 1;
      }
    }
  } catch (statusReportError: any) {
    console.error("Error sending phase status report:", statusReportError);
    // Don't throw error, just log it: whatever was not sent is counted as failed
    result.failed = result.recipients - result.sent - (result.suppressed ?? 0);
  }
  return result;
}

/**
 * Send plan status report to selected recipients
 * @param plan The GTM plan to report on
 * @param notifications Notification preferences
 * @param customerFrontendUrl The customer portal frontend URL
 */
export async function sendPlanStatusReport(
  plan: GTMPlan,
  notifications: StatusReportNotificationOptions,
  customerFrontendUrl: string = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'
): Promise<StatusReportResult> {
  const result: StatusReportResult = { recipients: 0, sent: 0, failed: 0 };

  // Check if any notifications are requested
  if (!notifications || (!notifications.notifyUser && !notifications.notifyPlanPoc && !notifications.notifyPhasePocs)) {
    return result;
  }

  try {
    const recipients: string[] = [];

    // Collect recipients based on preferences
    if (notifications.notifyUser && plan.userId) {
      try {
        const user = await userDb.getUserById(plan.userId);
        if (user?.email) {
          recipients.push(user.email);
        }
      } catch (err) {
        console.error("Error fetching user for status report:", err);
      }
    }

    if (notifications.notifyPlanPoc && plan.dri) {
      recipients.push(plan.dri);
    }

    if (notifications.notifyPhasePocs && plan.phases) {
      // Collect all unique phase PoCs
      const phasePocs = plan.phases
        .map((p: Phase) => p.dri)
        .filter((dri): dri is string => Boolean(dri));
      recipients.push(...phasePocs);
    }

    // Remove duplicates
    const uniqueRecipients = Array.from(new Set(recipients));

    result.recipients = uniqueRecipients.length;
    if (uniqueRecipients.length === 0) {
      return result;
    }

    // Get optional message from notifications
    const customMessage = notifications.message && notifications.message.trim()
      ? notifications.message.trim()
      : null;

    // Get customer portal URL
    const gtmPlanUrl = `${customerFrontendUrl}/gtm-plan`;

    // Generate phases summary HTML with nested work items
    const phases = plan.phases || [];
    const phasesSummaryHtml = phases.map((phase: Phase) => {
      const phaseStatusColor = phase.status === 'completed' ? '#4caf50' : '#ff9800';
      const workItems = phase.workItems || [];

      const workItemsRows = workItems.map((item: WorkItem) => {
        const statusColor = item.status === 'completed' ? '#4caf50' :
                            item.status === 'skipped' ? '#9e9e9e' : '#ff9800';
        const dueDateText = item.dueDate
          ? (() => {
              const [year, month, day] = item.dueDate.split('-').map(Number);
              const dueDateObj = new Date(year, month - 1, day);
              return dueDateObj.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
              });
            })()
          : '-';
        const completedAtText = item.completedAt
          ? new Date(item.completedAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric'
            })
          : '';

        return `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0; padding-left: 24px;">${esc(item.title)}${item.description ? `<div style="color: #666; font-size: 12px; margin-top: 4px;">${esc(item.description)}</div>` : ''}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">
              <span style="background-color: ${statusColor}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">
                ${esc(item.status)}
              </span>
              ${completedAtText ? `<div style="color: #666; font-size: 11px; margin-top: 4px;">${completedAtText}</div>` : ''}
            </td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${dueDateText}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0;">${esc(item.dri || '-')}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e0e0e0; font-size: 13px; color: #555; white-space: pre-wrap;">${esc(item.notes || '-')}</td>
          </tr>
        `;
      }).join('');

      const phaseDueDateText = phase.dueDate
        ? (() => {
            const [year, month, day] = phase.dueDate.split('-').map(Number);
            const dueDateObj = new Date(year, month - 1, day);
            return dueDateObj.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric'
            });
          })()
        : '-';

      return `
        <div style="margin-bottom: 30px;">
          <div style="background-color: #f5f5f5; padding: 12px; border-radius: 5px; margin-bottom: 10px;">
            <h4 style="margin: 0; color: #333;">
              ${esc(phase.title)}
              <span style="background-color: ${phaseStatusColor}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-left: 10px;">
                ${esc(phase.status)}
              </span>
            </h4>
            ${phase.dri || phase.dueDate ? `
            <p style="margin: 5px 0 0 0; font-size: 14px; color: #666;">
              ${phase.dri ? `PoC: ${esc(phase.dri)}` : ''}
              ${phase.dri && phase.dueDate ? ' | ' : ''}
              ${phase.dueDate ? `Due Date: ${phaseDueDateText}` : ''}
            </p>
            ` : ''}
          </div>
          ${workItems.length > 0 ? `
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 10px;">
            <thead>
              <tr style="background-color: #e0e0e0;">
                <th style="padding: 10px; text-align: left; padding-left: 24px;">Work Item</th>
                <th style="padding: 10px; text-align: left;">Status</th>
                <th style="padding: 10px; text-align: left;">Due Date</th>
                <th style="padding: 10px; text-align: left;">PoC</th>
                <th style="padding: 10px; text-align: left;">Notes</th>
              </tr>
            </thead>
            <tbody>
              ${workItemsRows}
            </tbody>
          </table>
          ` : `
          <p style="color: #666; font-style: italic; margin-left: 24px;">No work items</p>
          `}
        </div>
      `;
    }).join('');

    const subject = `GTM Plan Status Report: ${plan.title}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
        <h2 style="color: #333;">GTM Plan Status Report</h2>
        <p>Hello,</p>
        ${customMessage ? `
        <div style="background-color: #e3f2fd; padding: 15px; border-left: 4px solid #2196f3; margin: 20px 0; border-radius: 4px;">
          <p style="margin: 0; font-weight: 600; color: #1976d2;">Message:</p>
          <p style="margin: 10px 0 0 0; white-space: pre-wrap;">${esc(customMessage).replace(/\n/g, '<br>')}</p>
        </div>
        ` : ''}
        <p>This is a comprehensive status report for the GTM Plan "<strong>${esc(plan.title)}</strong>".</p>
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 0;"><strong>Plan:</strong> ${esc(plan.title)}</p>
          <p style="margin: 5px 0;"><strong>Plan Status:</strong> ${esc(plan.status)}</p>
          ${plan.dri ? `<p style="margin: 5px 0;"><strong>Plan PoC:</strong> ${esc(plan.dri)}</p>` : ''}
          ${plan.dueDate ? `<p style="margin: 5px 0;"><strong>Plan Due Date:</strong> ${(() => {
            const [year, month, day] = plan.dueDate.split('-').map(Number);
            const dueDateObj = new Date(year, month - 1, day);
            return dueDateObj.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            });
          })()}</p>` : ''}
          <p style="margin: 5px 0;"><strong>Total Phases:</strong> ${phases.length}</p>
        </div>
        <h3 style="color: #333; margin-top: 30px;">Phases & Work Items Summary</h3>
        ${phases.length > 0 ? phasesSummaryHtml : `
        <p style="color: #666;">No phases in this plan.</p>
        `}
        <div style="text-align: center; margin: 30px 0;">
          <a href="${gtmPlanUrl}" style="display: inline-block; background-color: #643B7E; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: 600;">View GTM Plan</a>
        </div>
        <p style="color: #666; font-size: 12px; margin-top: 30px;">This is an automated status report from AgentWeb.</p>
      </div>
    `;

    const text = `
GTM Plan Status Report

${customMessage ? `Message:\n${customMessage}\n\n` : ''}
This is a comprehensive status report for the GTM Plan "${plan.title}".

Plan: ${plan.title}
Plan Status: ${plan.status}
${plan.dri ? `Plan PoC: ${plan.dri}\n` : ''}${plan.dueDate ? `Plan Due Date: ${(() => {
  const [year, month, day] = plan.dueDate.split('-').map(Number);
  const dueDateObj = new Date(year, month - 1, day);
  return dueDateObj.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
})()}\n` : ''}Total Phases: ${phases.length}

Phases & Work Items Summary:
${phases.length > 0
  ? phases.map((phase: Phase) => {
      const phaseDueDateText = phase.dueDate
        ? (() => {
            const [year, month, day] = phase.dueDate.split('-').map(Number);
            const dueDateObj = new Date(year, month - 1, day);
            return dueDateObj.toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric'
            });
          })()
        : '-';
      const workItems = phase.workItems || [];
      const phaseInfo = `Phase: ${phase.title} | Status: ${phase.status}${phase.dri ? ` | PoC: ${phase.dri}` : ''}${phase.dueDate ? ` | Due Date: ${phaseDueDateText}` : ''}`;
      const workItemsText = workItems.length > 0
        ? workItems.map((item: WorkItem) => {
            const dueDateText = item.dueDate
              ? (() => {
                  const [year, month, day] = item.dueDate.split('-').map(Number);
                  const dueDateObj = new Date(year, month - 1, day);
                  return dueDateObj.toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                  });
                })()
              : '-';
            const completedAtText = item.completedAt
              ? new Date(item.completedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
              : '';
            return `  - ${item.title}${item.description ? ` | Description: ${item.description}` : ''} | Status: ${item.status}${completedAtText ? ` (${completedAtText})` : ''} | Due Date: ${dueDateText} | PoC: ${item.dri || '-'}${item.notes ? `\n    Notes: ${item.notes}` : ''}`;
          }).join('\n')
        : '  (No work items)';
      return `${phaseInfo}\n${workItemsText}`;
    }).join('\n\n')
  : 'No phases in this plan.'}

View your GTM Plan: ${gtmPlanUrl}

This is an automated status report from AgentWeb.
    `.trim();

    // Send emails to all recipients using system email
    for (const recipient of uniqueRecipients) {
      try {
        const delivery = await resendService.sendSystemEmail({
          to: recipient,
          subject,
          html,
          text,
        });
        // outside production the email guard resolves a send it held back: that is not a delivery
        if (isSuppressedSendResult(delivery)) result.suppressed = (result.suppressed ?? 0) + 1;
        else result.sent += 1;
      } catch (emailError: any) {
        console.error(`Failed to send plan status report to ${recipient}:`, emailError);
        // Don't fail the entire request if email fails: the caller reads `failed`
        result.failed += 1;
      }
    }
  } catch (statusReportError: any) {
    console.error("Error sending plan status report:", statusReportError);
    // Don't throw error, just log it: whatever was not sent is counted as failed
    result.failed = result.recipients - result.sent - (result.suppressed ?? 0);
  }
  return result;
}
