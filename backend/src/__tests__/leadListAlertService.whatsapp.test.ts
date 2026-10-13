/**
 * Lead-list alerts over WhatsApp (ENG-273).
 *
 * The Slack path here is Block Kit and is deliberately left byte-identical — the
 * existing leadListAlertService suites are the proof. This covers the additive
 * WhatsApp path and, importantly, that neither channel can break the email baseline
 * that already landed before either is attempted.
 */

import { leadListAlertService } from '../services/leadListAlertService';

jest.mock('../services/db', () => ({
  crmDb: {},
  userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn(), escapeHtml: (s: string) => s },
}));
jest.mock('../services/slackService', () => ({ sendLeadNotification: jest.fn() }));
jest.mock('../services/whatsappService', () => ({
  TEMPLATES: jest.requireActual('../services/whatsappService').TEMPLATES,
  sendMessage: jest.fn(),
}));

const { sendLeadNotification } = require('../services/slackService');
const { userDb } = require('../services/db');
const whatsapp = require('../services/whatsappService');

// A verified entry: the person proved they control the number by messaging us a code.
const WA = {
  channel: 'whatsapp' as const,
  destination: '+14155550123',
  enabled: true,
  optIn: { at: '2026-08-01T00:00:00.000Z', source: 'inbound_verification', verifiedAt: '2026-08-01T00:00:00.000Z' },
};

const lead = {
  leadId: 'l1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  company: 'Analytical',
};
const list = {
  listId: 'list-1',
  name: 'Q3 Inbound',
  userId: 'u1',
  alertEvents: ['email.received'],
};

/** Drive the notifier the same way the production callers do. */
const notify = (user: any, theLead: any = lead) => {
  userDb.getUserById.mockResolvedValue(user);
  return leadListAlertService.notifyLeadListOwnerIfConfigured(
    list,
    theLead,
    'email.received',
    { subject: 'Hello' },
    '2026-08-04T00:00:00.000Z',
  );
};

beforeEach(() => {
  jest.resetAllMocks();
  whatsapp.sendMessage.mockResolvedValue({ messageId: 'wamid.1' });
});

describe('one platform per customer', () => {
  it('does not also post to Slack for an account that is on WhatsApp', async () => {
    // This path reads the deprecated slackChannel field directly, so it bypasses the
    // resolver that enforces the rule everywhere else.
    await notify({ userId: 'u1', email: 'u@e.com', slackChannel: 'C0LEGACY', messagingChannels: [WA] });
    expect(sendLeadNotification).not.toHaveBeenCalled();
    expect(whatsapp.sendMessage).toHaveBeenCalled();
  });

  it('still posts to Slack for an account that is only on Slack', async () => {
    await notify({ userId: 'u1', email: 'u@e.com', slackChannel: 'C0LEGACY' });
    expect(sendLeadNotification).toHaveBeenCalled();
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });
});

// ENG-2082: lead capture accepts phone-only submissions, so the owner alert is now the
// most-seen artifact of a lead with no address — one email per captured lead.
describe('owner alert for a lead with no email address', () => {
  const { emailService } = require('../services/emailService');
  const phoneOnly = { leadId: 'lead_ph_4d4be7fa83dae4aa5996c2a3', firstName: '', lastName: '', phone: '2125559876' };

  // sendEmail is positional: (to, subject, text, html). Assert on BOTH bodies, and prove
  // the body is non-empty first — reading the wrong arg makes every `not.toContain` pass
  // against an empty string, which is how a vacuous test gets written.
  const bodies = () => {
    const call = emailService.sendEmail.mock.calls[0];
    expect(call).toBeDefined();
    const [, , text, html] = call;
    expect(String(text).length).toBeGreaterThan(50);
    expect(String(html).length).toBeGreaterThan(50);
    return `${text}\n${html}`;
  };

  it('never announces the lead as "(Unknown email)"', async () => {
    await notify({ userId: 'u1', email: 'u@e.com' }, phoneOnly);
    expect(bodies()).not.toContain('Unknown email');
  });

  it('identifies the lead by phone, not by its database key', async () => {
    await notify({ userId: 'u1', email: 'u@e.com' }, phoneOnly);
    const [, , text] = emailService.sendEmail.mock.calls[0];
    // Only the NAME line matters. The leadId legitimately appears further down in the
    // engagement deep-link, so asserting against the whole body would be wrong.
    const leadLine = String(text).split('\n').find((l: string) => l.startsWith('Lead:'));
    expect(leadLine).toBe('Lead: 2125559876');
  });

  it('still shows the address when there is one', async () => {
    await notify({ userId: 'u1', email: 'u@e.com' }, lead);
    expect(bodies()).toContain('ada@example.com');
  });
});

// ENG-2082: "nothing to draft" is not a failure. The renderer mapped every non-'created'
// status to "Failed", so changing the status upstream to 'skipped_no_email' changed nothing
// the owner actually reads — a phone-only capture still mailed them a failure notice.
describe('owner alert — auto-draft status wording', () => {
  const { emailService } = require('../services/emailService');
  const bodies = () => {
    const call = emailService.sendEmail.mock.calls[0];
    expect(call).toBeDefined();
    const [, , text, html] = call;
    expect(String(text).length).toBeGreaterThan(50);
    return `${text}\n${html}`;
  };
  const notifyWith = (eventData: any) => {
    userDb.getUserById.mockResolvedValue({ userId: 'u1', email: 'u@e.com' });
    // autoDraftStatus is rendered only under the api.lead_* branch of buildEventDetails.
    return leadListAlertService.notifyLeadListOwnerIfConfigured(
      { ...list, alertEvents: ['api.lead_added'] }, lead, 'api.lead_added', eventData,
      '2026-08-04T00:00:00.000Z',
    );
  };

  it('a skipped draft does not read as a failure', async () => {
    await notifyWith({ source: 'api', autoDraftStatus: 'skipped_no_email' });
    const body = bodies();
    expect(body).not.toContain('Auto Draft: Failed');
    expect(body).toContain('Skipped');
  });

  it('a real failure still reads as one', async () => {
    await notifyWith({ source: 'api', autoDraftStatus: 'failed' });
    expect(bodies()).toContain('Failed');
  });

  it('a created draft still reads as created', async () => {
    await notifyWith({ source: 'api', autoDraftStatus: 'created' });
    expect(bodies()).toContain('Created');
  });
});

describe('WhatsApp lead alerts', () => {
  it('sends to WhatsApp when the user has it configured', async () => {
    await notify({ userId: 'u1', email: 'u@e.com', messagingChannels: [WA] });
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    expect(whatsapp.sendMessage.mock.calls[0][0].destination).toBe('+14155550123');
  });

  it('does not send to WhatsApp when the user has not configured it', async () => {
    await notify({ userId: 'u1', email: 'u@e.com', slackChannel: 'C1' });
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  // Replaced the earlier "sends to Slack and WhatsApp independently when both are
  // configured" (ENG-273). A customer is on ONE messaging platform and the two features
  // do not run side by side for one account; that test asserted the double delivery the
  // product rule now forbids. An account that has both — from before the rule — is on
  // WhatsApp, and Slack is not also posted to.
  it('delivers an account that has both on WhatsApp only', async () => {
    await notify({ userId: 'u1', email: 'u@e.com', slackChannel: 'C1', messagingChannels: [WA] });
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    expect(sendLeadNotification).not.toHaveBeenCalled();
  });

  it('carries the LEAD_ALERT template with its full declared variable count', async () => {
    await notify({ userId: 'u1', email: 'u@e.com', messagingChannels: [WA] });
    const sent = whatsapp.sendMessage.mock.calls[0][0];
    expect(sent.template.name).toBe('agentweb_lead_alert');
    expect(sent.template.variables).toHaveLength(2);
    expect(sent.template.variables[0]).toBe('Ada Lovelace');
  });

  it('falls back to the lead email when the lead has no name', async () => {
    await notify(
      { userId: 'u1', email: 'u@e.com', messagingChannels: [WA] },
      { ...lead, firstName: undefined, lastName: undefined },
    );
    expect(whatsapp.sendMessage.mock.calls[0][0].template.variables[0]).toBe('ada@example.com');
  });

  it('a WhatsApp failure never propagates — the email baseline already landed', async () => {
    whatsapp.sendMessage.mockRejectedValue(new Error('131047 window closed'));
    await expect(
      notify({ userId: 'u1', email: 'u@e.com', messagingChannels: [WA] }),
    ).resolves.not.toThrow();
  });

  it('a Slack failure does not prevent the WhatsApp send', async () => {
    sendLeadNotification.mockRejectedValue(new Error('channel_not_found'));
    await notify({ userId: 'u1', email: 'u@e.com', slackChannel: 'C1', messagingChannels: [WA] });
    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('unverified WhatsApp entry', () => {
  it('is never messaged, even though it is enabled', async () => {
    // A number someone merely typed in may be a typo or a stranger's; the shared
    // business number is not used on it until the person has proven control.
    await notify({
      userId: 'u1',
      email: 'u@e.com',
      messagingChannels: [{ channel: 'whatsapp', destination: '+14155550123', enabled: true }],
    });
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  it('is not rescued by an opt-in record that lacks verifiedAt', async () => {
    await notify({
      userId: 'u1',
      email: 'u@e.com',
      messagingChannels: [
        {
          channel: 'whatsapp',
          destination: '+14155550123',
          enabled: true,
          optIn: { at: '2026-08-01T00:00:00.000Z', source: 'settings_ui' },
        },
      ],
    });
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });
});
