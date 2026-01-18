import { crmDb, userDb } from './db';
import { emailService } from './emailService';

const normalizeEventType = (eventType: string) => eventType.trim().toLowerCase();
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

  const details: Array<{ label: string; value: string }> = [];

  // API event details
  if (eventType === 'api.lead_added') {
    if (eventData.source) details.push({ label: 'Source', value: String(eventData.source) });
    if (eventData.forwardedAt) details.push({ label: 'Forwarded At', value: new Date(eventData.forwardedAt).toLocaleString() });
    if (eventData.company) details.push({ label: 'Company', value: String(eventData.company) });
    if (eventData.phone) details.push({ label: 'Phone', value: String(eventData.phone) });
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
      return `<div><strong>${emailService.escapeHtml(detail.label)}:</strong> ${emailService.escapeHtml(detail.value)}</div>`;
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
}: {
  userEmail: string;
  listName: string;
  listId: string;
  lead: any;
  eventType: string;
  eventData: any;
  createdAt: string;
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

  const text = [
    `A new ${eventType} event was recorded.`,
    `Lead list: ${listName} (${listId})`,
    `Lead: ${leadName}${showLeadEmail ? ` (${leadEmail})` : ''}`,
    `Time: ${eventTime}`,
    `Manage leads: ${crmUrl}`,
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
      </div>
      ${eventDetails.html}
    </div>
  `;

  await emailService.sendEmail(userEmail, subject, text, html);
};

export const leadListAlertService = {
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

    await sendAlertEmail({
      userEmail: user.email,
      listName: list.name || 'Lead List',
      listId: list.listId,
      lead,
      eventType: normalizedEventType,
      eventData,
      createdAt,
    });
  },

  async notifyForEmailEvent(emailEvent: any) {
    const leadEmail = typeof emailEvent.leadEmail === 'string' ? emailEvent.leadEmail.toLowerCase() : '';
    const eventType = typeof emailEvent.eventType === 'string' ? emailEvent.eventType : '';
    const emailDomain = typeof emailEvent.emailDomain === 'string' ? emailEvent.emailDomain : '';
    if (!leadEmail || !eventType || !emailDomain) {
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
