// Mock dotenv and aws-sdk before any imports
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  S3: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../config', () => ({
  RESEND_SYSTEM_EMAIL: 'noreply@agentweb.pro',
  RESEND_SYSTEM_NAME: 'AgentWeb',
}));

import { runTriggerAction } from '../services/crmTriggerActionRunner';
import { resendService } from '../services/resendService';
import { CRMTrigger } from '../types/crmTriggers';

const mockSendEmail = resendService.sendEmail as jest.Mock;

const makeTrigger = (overrides: Partial<CRMTrigger> = {}): CRMTrigger => ({
  triggerId: 'trig_1',
  listId: 'list_1',
  userId: 'user_1',
  event: 'email.opened',
  name: 'Notify Lead',
  enabled: true,
  conditionExpression: 'true',
  action: {
    type: 'send_email',
    toType: 'lead',
    subjectTemplate: 'Hi {{firstName}}',
    bodyTemplate: '<p>Hello {{firstName}} {{lastName}}</p>',
  },
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('crmTriggerActionRunner — toType: lead', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns error when lead has no email and toType is lead', async () => {
    const trigger = makeTrigger();
    const lead = { leadId: 'l1', firstName: 'Jane' }; // no email field

    const result = await runTriggerAction(trigger, lead, {}, {});

    expect(result.error).toBe('Lead email not available');
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends email to lead.email when toType is lead', async () => {
    const trigger = makeTrigger();
    const lead = { leadId: 'l1', email: 'lead@acme.com', firstName: 'Jane', lastName: 'Doe' };

    const result = await runTriggerAction(trigger, lead, {}, {});

    expect(result.error).toBeUndefined();
    expect(result.actionTaken).toContain('lead@acme.com');
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['lead@acme.com'] })
    );
  });

  it('substitutes lead variables in subject and body when sending to lead', async () => {
    const trigger = makeTrigger();
    const lead = { leadId: 'l1', email: 'lead@acme.com', firstName: 'Jane', lastName: 'Doe' };

    await runTriggerAction(trigger, lead, {}, {});

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Hi Jane',
        html: '<p>Hello Jane Doe</p>',
      })
    );
  });

  it('still sends to list_owner when toType is list_owner', async () => {
    const trigger = makeTrigger({
      action: {
        type: 'send_email',
        toType: 'list_owner',
        subjectTemplate: 'Alert',
        bodyTemplate: 'Body',
      },
    });
    const lead = { leadId: 'l1', email: 'lead@acme.com' };
    const user = { userId: 'u1', email: 'owner@company.com' };

    const result = await runTriggerAction(trigger, lead, {}, user);

    expect(result.error).toBeUndefined();
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['owner@company.com'] })
    );
  });
});

describe('crmTriggerActionRunner — {{event}} variable substitution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('substitutes {{event}} in subject with trigger.event', async () => {
    const trigger = makeTrigger({
      event: 'email.opened',
      action: {
        type: 'send_email',
        toType: 'list_owner',
        subjectTemplate: 'Alert: {{event}} for {{firstName}}',
        bodyTemplate: '<p>Body</p>',
      },
    });
    const lead = { leadId: 'l1', firstName: 'Jane' };
    const user = { userId: 'u1', email: 'owner@company.com' };

    await runTriggerAction(trigger, lead, {}, user);

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Alert: email.opened for Jane' })
    );
  });

  it('substitutes {{event}} in body with trigger.event', async () => {
    const trigger = makeTrigger({
      event: 'lead.created',
      action: {
        type: 'send_email',
        toType: 'list_owner',
        subjectTemplate: 'Alert',
        bodyTemplate: '<p>Event {{event}} triggered for {{firstName}}</p>',
      },
    });
    const lead = { leadId: 'l1', firstName: 'Bob' };
    const user = { userId: 'u1', email: 'owner@company.com' };

    await runTriggerAction(trigger, lead, {}, user);

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ html: '<p>Event lead.created triggered for Bob</p>' })
    );
  });

  it('does not leave {{event}} literal in output', async () => {
    const trigger = makeTrigger({
      event: 'api.lead_added',
      action: {
        type: 'send_email',
        toType: 'list_owner',
        subjectTemplate: '{{event}}',
        bodyTemplate: '{{event}}',
      },
    });
    const lead = { leadId: 'l1' };
    const user = { userId: 'u1', email: 'owner@company.com' };

    await runTriggerAction(trigger, lead, {}, user);

    const call = mockSendEmail.mock.calls[0][0];
    expect(call.subject).not.toContain('{{event}}');
    expect(call.html).not.toContain('{{event}}');
    expect(call.subject).toBe('api.lead_added');
    expect(call.html).toBe('api.lead_added');
  });
});
