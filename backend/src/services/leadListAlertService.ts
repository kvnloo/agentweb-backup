import { crmDb, userDb } from './db';
import { emailService } from './emailService';
import { sendLeadNotification } from './slackService';
import {
  bootstrapMessagingChannels,
  getMessagingChannel,
  resolveDestination,
} from './messagingChannelService';
import { TEMPLATES } from './whatsappService';

const normalizeEventType = (eventType: string) => eventType.trim().toLowerCase();

const SYSTEM_EMAIL_PREFIXES = [
  'no-reply@',
  'noreply@',
  'do-not-reply@',
  'donotreply@',
  'mailer-daemon@',
  'postmaster@',
];

const isSystemEmail = (email: string): boolean => {
  const lower = email.toLowerCase();
  return SYSTEM_EMAIL_PREFIXES.some((prefix) => lower.startsWith(prefix));
};
const getAlertEvents = (list: any) => {
  const rawEvents = Array.isArray(list.alertEvents) ? list.alertEvents : ['email.received'];
  return rawEvents.map(normalizeEventType);
};

const formatLeadName = (lead: any) => {
  const firstName = typeof lead.firstName === 'string' ? lead.firstName.trim() : '';
  const lastName = typeof lead.lastName === 'string' ? lead.lastName.trim() : '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  return fullName || lead.email || lead.leadId || 'Unknown lead';
};

const buildEventDetails = (eventType: string, eventData: any) => {
  if (!eventData) {
    return { text: '', html: '' };
  }

  const details: Array<{ label: string; value: string; style?: string }> = [];

  // API event details
  if (eventType === 'api.lead_added' || eventType === 'api.lead_updated') {
    if (eventData.source) details.push({ label: 'Source', value: String(eventData.source) });
    if (eventType === 'api.lead_added' && eventData.forwardedAt) {
      details.push({ label: 'Forwarded At', value: new Date(eventData.forwardedAt).toLocaleString() });
    }
    if (eventType === 'api.lead_updated' && eventData.forwardedAt) {
      details.push({ label: 'Updated At', value: new Date(eventData.forwardedAt).toLocaleString() });
    }
    if (eventData.company) details.push({ label: 'Company', value: String(eventData.company) });
    if (eventData.phone) details.push({ label: 'Phone', value: String(eventData.phone) });
    if (eventData.autoDraftStatus) {
      const draftLabel = eventData.autoDraftStatus === 'created'
        ? 'Created'
        : 'Failed';
      details.push({ label: 'Auto Draft', value: draftLabel });

      if (eventData.autoSendStatus === 'sent') {
        details.push({ label: 'Auto Send', value: 'Email sent to the lead successfully', style: 'color:#15803d;background:#dcfce7;padding:6px 10px;border-radius:4px;margin-top:4px;' });
      } else if (eventData.autoSendStatus === 'skipped_already_sent_today') {
        details.push({ label: 'Auto Send', value: 'Skipped — an email was already sent to this lead today', style: 'color:#b45309;background:#fef3c7;padding:6px 10px;border-radius:4px;margin-top:4px;' });
      } else if (eventData.autoSendStatus === 'skipped_no_sender') {
        details.push({ label: 'Warning', value: 'Auto send skipped — no sender email configured for this lead list. To set one up, select the lead list and click "Senders".', style: 'color:#b45309;background:#fef3c7;padding:6px 10px;border-radius:4px;margin-top:4px;' });
      } else if (eventData.autoSendStatus === 'skipped_no_email') {
        details.push({ label: 'Warning', value: 'Auto send skipped — lead has no email address.', style: 'color:#b45309;background:#fef3c7;padding:6px 10px;border-radius:4px;margin-top:4px;' });
      } else if (eventData.autoSendStatus === 'failed') {
        details.push({ label: 'Warning', value: 'Auto send failed. You could review engagement activities and message draft and decide how to engage with them.', style: 'color:#dc2626;background:#fef2f2;padding:6px 10px;border-radius:4px;margin-top:4px;' });
      } else if (!eventData.autoSendStatus) {
        // Auto-draft only (no auto-send enabled)
        details.push({ label: 'Warning', value: 'An email has not been sent to the lead. You could review engagement activities and message draft and decide how to engage with them.', style: 'color:#b45309;background:#fef3c7;padding:6px 10px;border-radius:4px;margin-top:4px;' });
      }
    }
    if (eventData.autoDraftError) {
      details.push({ label: 'Auto Draft Error', value: String(eventData.autoDraftError) });
    }
  }
  if (eventType === 'api.lead_failed') {
    if (eventData.error) details.push({ label: 'Error', value: String(eventData.error) });
    if (eventData.source) details.push({ label: 'Source', value: String(eventData.source) });
    if (eventData.email) details.push({ label: 'Email', value: String(eventData.email) });
  }

  // Email event details
  if (eventData.subject) details.push({ label: 'Subject', value: String(eventData.subject) });
  if (eventData.from) details.push({ label: 'From', value: String(eventData.from) });
  if (eventData.to) {
    const toValue = Array.isArray(eventData.to) ? eventData.to.join(', ') : String(eventData.to);
    details.push({ label: 'To', value: toValue });
  }
  if (eventType === 'email.clicked' && eventData.click?.link) {
    details.push({ label: 'Clicked Link', value: String(eventData.click.link) });
  }
  if (eventType === 'email.bounced' && eventData.bounce?.reason) {
    details.push({ label: 'Bounce Reason', value: String(eventData.bounce.reason) });
  }
  if (eventType === 'email.complained' && eventData.complaint?.reason) {
    details.push({ label: 'Complaint Reason', value: String(eventData.complaint.reason) });
  }

  if (details.length === 0) {
    const raw = typeof eventData === 'string' ? eventData : JSON.stringify(eventData, null, 2);
    return {
      text: `Event data:\n${raw}`,
      html: `<pre style="background:#f8f9fa;padding:12px;border-radius:6px;">${emailService.escapeHtml(raw)}</pre>`,
    };
  }

  const text = details.map((detail) => `${detail.label}: ${detail.value}`).join('\n');
  const html = details
    .map((detail) => {
      const styleAttr = detail.style ? ` style="${detail.style}"` : '';
      return `<div${styleAttr}><strong>${emailService.escapeHtml(detail.label)}:</strong> ${emailService.escapeHtml(detail.value)}</div>`;
    })
    .join('');

  return { text, html };
};

const sendAlertEmail = async ({
  userEmail,
  listName,
  listId,
  lead,
  eventType,
  eventData,
  createdAt,
  ccEmails,
}: {
  userEmail: string;
  listName: string;
  listId: string;
  lead: any;
  eventType: string;
  eventData: any;
  createdAt: string;
  ccEmails?: string[];
}) => {
  const leadName = formatLeadName(lead);
  const leadEmail = lead.email || 'Unknown email';
  const normalizedLeadName = String(leadName).trim().toLowerCase();
  const normalizedLeadEmail = String(leadEmail).trim().toLowerCase();
  const showLeadEmail = normalizedLeadName !== normalizedLeadEmail;
  const eventTime = createdAt ? new Date(createdAt).toLocaleString() : new Date().toLocaleString();
  const subject = `Lead list alert: ${eventType}`;
  const eventDetails = buildEventDetails(eventType, eventData);
  const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
  const crmUrl = `${customerFrontendUrl}/crm`;
  const leadEngagementUrl = lead?.leadId
    ? `${crmUrl}?listId=${encodeURIComponent(listId)}&leadId=${encodeURIComponent(lead.leadId)}&openEngagement=1`
    : '';

  const text = [
    `A new ${eventType} event was recorded.`,
    `Lead list: ${listName} (${listId})`,
    `Lead: ${leadName}${showLeadEmail ? ` (${leadEmail})` : ''}`,
    `Time: ${eventTime}`,
    `Manage leads: ${crmUrl}`,
    leadEngagementUrl ? `Review lead engagement: ${leadEngagementUrl}` : '',
    eventDetails.text,
  ]
    .filter(Boolean)
    .join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px;">
      <h2 style="margin-bottom: 12px;">Lead list alert</h2>
      <p>A new <strong>${emailService.escapeHtml(eventType)}</strong> event was recorded.</p>
      <div style="margin: 12px 0;">
        <div><strong>Lead list:</strong> ${emailService.escapeHtml(listName)} (${emailService.escapeHtml(listId)})</div>
        <div><strong>Lead:</strong> ${emailService.escapeHtml(leadName)}${showLeadEmail ? ` (${emailService.escapeHtml(leadEmail)})` : ''}</div>
        <div><strong>Time:</strong> ${emailService.escapeHtml(eventTime)}</div>
        <div><strong>Manage leads:</strong> <a href="${emailService.escapeHtml(crmUrl)}">${emailService.escapeHtml(crmUrl)}</a></div>
        ${leadEngagementUrl ? `<div><strong>Review lead engagement:</strong> <a href="${emailService.escapeHtml(leadEngagementUrl)}">${emailService.escapeHtml(leadEngagementUrl)}</a></div>` : ''}
      </div>
      ${eventDetails.html}
    </div>
  `;

  if (Array.isArray(ccEmails) && ccEmails.length > 0) {
    await emailService.sendEmail(userEmail, subject, text, html, ccEmails);
  } else {
    await emailService.sendEmail(userEmail, subject, text, html);
  }
};

export const leadListAlertService = {
  async notifyLinkedInConnectionAccepted(list: any, lead: any) {
    const user = await userDb.getUserById(list.userId);
    if (!user?.email) return;

    const leadName = formatLeadName(lead);
    const leadEmail = lead.email || '';
    const normalizedLeadName = String(leadName).trim().toLowerCase();
    const normalizedLeadEmail = String(leadEmail).trim().toLowerCase();
    const showLeadEmail = leadEmail && normalizedLeadName !== normalizedLeadEmail;
    const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    const crmUrl = `${customerFrontendUrl}/crm`;
    const leadEngagementUrl = lead?.leadId
      ? `${crmUrl}?listId=${encodeURIComponent(list.listId)}&leadId=${encodeURIComponent(lead.leadId)}&openEngagement=1`
      : crmUrl;
    const listName = list.name || 'Lead List';
    const eventTime = new Date().toLocaleString();
    const subject = `${leadName} accepted your LinkedIn invitation`;

    const text = [
      `${leadName} has accepted your LinkedIn connection request.`,
      `Lead list: ${listName} (${list.listId})`,
      `Lead: ${leadName}${showLeadEmail ? ` (${leadEmail})` : ''}`,
      `Time: ${eventTime}`,
      `Review lead engagement: ${leadEngagementUrl}`,
    ].join('\n');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 640px;">
        <h2 style="margin-bottom: 12px;">Lead list alert</h2>
        <p><strong>${emailService.escapeHtml(leadName)}</strong> has accepted your LinkedIn connection request.</p>
        <div style="margin: 12px 0;">
          <div><strong>Lead list:</strong> ${emailService.escapeHtml(listName)} (${emailService.escapeHtml(list.listId)})</div>
          <div><strong>Lead:</strong> ${emailService.escapeHtml(leadName)}${showLeadEmail ? ` (${emailService.escapeHtml(leadEmail)})` : ''}</div>
          <div><strong>Time:</strong> ${emailService.escapeHtml(eventTime)}</div>
          <div style="margin-top:12px;">
            <a href="${emailService.escapeHtml(leadEngagementUrl)}" style="display:inline-block;padding:10px 20px;background:#0077b5;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold;">Send a message on LinkedIn</a>
          </div>
        </div>
      </div>
    `;

    // LinkedIn connection-accepted alerts are email-only by design — no Slack
    // notification (unlike generic lead-list alerts in
    // notifyLeadListOwnerIfConfigured).
    const ccEmails = Array.isArray(list.alertCcEmails) ? list.alertCcEmails.filter((e: string) => typeof e === 'string' && e.trim()) : undefined;
    if (Array.isArray(ccEmails) && ccEmails.length > 0) {
      await emailService.sendEmail(user.email, subject, text, html, ccEmails);
    } else {
      await emailService.sendEmail(user.email, subject, text, html);
    }
  },

  async notifyLeadListOwnerIfConfigured(
    list: any,
    lead: any,
    eventType: string,
    eventData: any,
    createdAt: string,
    emailDomain?: string
  ) {
    const normalizedEventType = normalizeEventType(eventType);
    const alertEvents = getAlertEvents(list);

    if (!alertEvents.includes(normalizedEventType)) {
      return;
    }

    const user = await userDb.getUserById(list.userId);
    if (!user?.email) {
      return;
    }
    if (emailDomain && user.emailDomain && user.emailDomain !== emailDomain) {
      return;
    }

    const ccEmails = Array.isArray(list.alertCcEmails) ? list.alertCcEmails.filter((e: string) => typeof e === 'string' && e.trim()) : undefined;
    await sendAlertEmail({
      userEmail: user.email,
      listName: list.name || 'Lead List',
      listId: list.listId,
      lead,
      eventType: normalizedEventType,
      eventData,
      createdAt,
      ccEmails,
    });

    const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    const crmUrl = `${customerFrontendUrl}/crm?listId=${encodeURIComponent(list.listId)}`;
    const listName = list.name || 'Lead List';

    // Send Slack notification if the user has a slackChannel configured.
    // Deliberately still reading the deprecated singular `slackChannel` rather than
    // the shared resolver: switching to it would newly alert every user who has only
    // `slackChannels` set, which is a delivery change customers did not ask for and
    // is outside ENG-273's scope. Slack behavior here is byte-identical.
    if (user.slackChannel) {
      try {
        await sendLeadNotification(user.slackChannel, {
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          company: lead.company,
          phone: lead.phone,
          linkedin: lead.linkedin,
          listName,
          listId: list.listId,
          crmUrl,
          eventType: normalizedEventType,
          timestamp: createdAt || new Date().toISOString(),
        });
      } catch (slackError) {
        // Log but don't fail — email was already sent successfully
        console.error('Failed to send Slack lead notification:', slackError);
      }
    }

    // WhatsApp is a peer channel, additive to both the email baseline and Slack.
    // The Slack version is Block Kit; WhatsApp has no blocks, so it gets a flat
    // template — name, then what happened plus the CRM link.
    try {
      await bootstrapMessagingChannels();
      const whatsappTo = await resolveDestination(user, 'whatsapp');
      if (whatsappTo) {
        const leadName =
          [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() ||
          lead.email ||
          'A lead';
        await getMessagingChannel('whatsapp').sendMessage({
          destination: whatsappTo,
          text: `${leadName} — ${normalizedEventType} on ${listName}. ${crmUrl}`,
          template: {
            name: TEMPLATES.LEAD_ALERT.name,
            variables: [leadName, `${normalizedEventType} on ${listName}. ${crmUrl}`],
          },
        } as any);
      }
    } catch (whatsappError) {
      // Same contract as the Slack path: email already landed, so a channel failure
      // must never fail the alert.
      console.error('Failed to send WhatsApp lead notification:', whatsappError);
    }
  },

  async notifyForEmailEvent(emailEvent: any) {
    const leadEmail = typeof emailEvent.leadEmail === 'string' ? emailEvent.leadEmail.toLowerCase() : '';
    const eventType = typeof emailEvent.eventType === 'string' ? emailEvent.eventType : '';
    const emailDomain = typeof emailEvent.emailDomain === 'string' ? emailEvent.emailDomain : '';
    if (!leadEmail || !eventType || !emailDomain) {
      return;
    }
    if (isSystemEmail(leadEmail)) {
      return;
    }
    const users = await userDb.getUsersByEmailDomain(emailDomain);
    const normalizedEventType = normalizeEventType(eventType);
    for (const user of users) {
      const lists = await crmDb.getLeadListsByUserId(user.userId);
      const matchingLists = (lists || []).filter((list) => {
        const alertEvents = getAlertEvents(list);
        return alertEvents.includes(normalizedEventType);
      });

      for (const list of matchingLists) {
        const lead = await crmDb.getLeadByEmail(list.listId, leadEmail);
        if (!lead) {
          continue;
        }
        await this.notifyLeadListOwnerIfConfigured(
          list,
          lead,
          eventType,
          emailEvent.data,
          emailEvent.createdAt,
          emailDomain
        );
      }
    }
  },
};
