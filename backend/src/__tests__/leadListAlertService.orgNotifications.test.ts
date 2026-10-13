jest.mock('../services/db', () => ({
  crmDb: {}, userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/emailService', () => ({ emailService: {
  sendEmail: jest.fn(), escapeHtml: (s: string) => s,
} }));
jest.mock('../services/slackService', () => ({ sendLeadNotification: jest.fn() }));
jest.mock('../services/messagingChannelService', () => ({
  bootstrapMessagingChannels: jest.fn(), resolveDestination: jest.fn(),
  // These accounts are Slack customers; a real answer to "is this one on WhatsApp" is false.
  hasVerifiedWhatsApp: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/whatsappService', () => ({ TEMPLATES: {} }));
import { userDb, orgDb } from '../services/db';
import { sendLeadNotification } from '../services/slackService';
import { emailService } from '../services/emailService';
import { leadListAlertService } from '../services/leadListAlertService';

it.each([true, false])('org enabled=%s controls legacy Slack duplication without changing email', async enabled => {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ email: 'owner@example.com', orgId: 'org-a', slackChannel: 'C123' });
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ leadNotifications: { enabled } });
  await leadListAlertService.notifyLeadListOwnerIfConfigured(
    { listId: 'list-a', userId: 'owner-a', alertEvents: ['api.lead_added'] },
    { leadId: 'lead-a', email: 'lead@example.com' }, 'api.lead_added', {}, '2026-09-23T12:00:00Z',
  );
  expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  expect(sendLeadNotification).toHaveBeenCalledTimes(enabled ? 0 : 1);
});

it.each([true, false])('repeat LP submission uses org Slack only when enabled=%s', async enabled => {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ email: 'owner@example.com', orgId: 'org-a', slackChannel: 'C123' });
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ leadNotifications: { enabled } });
  await leadListAlertService.notifyLeadListOwnerIfConfigured(
    { listId: 'list-a', userId: 'owner-a', alertEvents: ['api.lead_updated'] },
    { leadId: 'lead-a', email: 'lead@example.com' }, 'api.lead_updated', { orgLeadSubmission: true }, '2026-09-23T12:00:00Z',
  );
  expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  expect(sendLeadNotification).toHaveBeenCalledTimes(enabled ? 0 : 1);
});
