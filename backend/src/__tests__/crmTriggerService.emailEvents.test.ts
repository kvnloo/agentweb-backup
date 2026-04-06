// Mock dotenv and aws-sdk before any imports
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  S3: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));

jest.mock('../services/crmTriggerDb', () => ({
  crmTriggerDb: {
    writeTriggerLog: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../services/crmTriggerActionRunner', () => ({
  runTriggerAction: jest.fn().mockResolvedValue({ actionTaken: 'send_email to owner@example.com' }),
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadListsByUserId: jest.fn(),
    getLeadByEmail: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
    getUsersByEmailDomain: jest.fn(),
  },
}));

jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: {
    notifyLeadListOwnerIfConfigured: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }) },
}), { virtual: true });

import { fireTriggers, fireTriggersByEmailEvent } from '../services/crmTriggerService';
import { runTriggerAction } from '../services/crmTriggerActionRunner';
import { crmDb, userDb } from '../services/db';
import { leadListAlertService } from '../services/leadListAlertService';

const baseLead = {
  leadId: 'lead_1',
  listId: 'list_1',
  email: 'lead@example.com',
  firstName: 'John',
  lastName: 'Smith',
  status: 'new',
};

const baseList = {
  listId: 'list_1',
  userId: 'user_1',
  name: 'Test List',
  alertEvents: ['email.received'],
  triggers: [],
};

const baseUser = {
  userId: 'user_1',
  email: 'owner@example.com',
};

const makeTrigger = (overrides: Record<string, any> = {}) => ({
  triggerId: 'trig_1',
  listId: 'list_1',
  userId: 'user_1',
  event: 'email.clicked',
  name: 'Test Trigger',
  enabled: true,
  conditionExpression: 'true',
  action: { type: 'send_email', toType: 'list_owner', subjectTemplate: 'Alert', bodyTemplate: 'Body' },
  createdAt: '',
  updatedAt: '',
  ...overrides,
});

describe('fireTriggers — email and api events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(baseList);
    (userDb.getUserById as jest.Mock).mockResolvedValue(baseUser);
  });

  // Test 1: fires for email.clicked when condition accesses event.click.link and matches
  it('fires trigger for email.clicked when event.click.link condition matches', async () => {
    const trigger = makeTrigger({
      event: 'email.clicked',
      conditionExpression: 'contains(event.click.link, "pricing")',
    });
    const list = { ...baseList, triggers: [trigger] };

    await fireTriggers(
      'email.clicked',
      'list_1',
      'user_1',
      baseLead,
      undefined,
      { click: { link: 'https://example.com/pricing' } },
      list
    );

    expect(runTriggerAction).toHaveBeenCalledTimes(1);
  });

  // Test 2: skips trigger when event.click.link condition does not match
  it('skips trigger for email.clicked when event.click.link condition does not match', async () => {
    const trigger = makeTrigger({
      event: 'email.clicked',
      conditionExpression: 'contains(event.click.link, "pricing")',
    });
    const list = { ...baseList, triggers: [trigger] };

    await fireTriggers(
      'email.clicked',
      'list_1',
      'user_1',
      baseLead,
      undefined,
      { click: { link: 'https://example.com/home' } },
      list
    );

    expect(runTriggerAction).not.toHaveBeenCalled();
  });

  // Test 3: legacy fallback fires when alertEvents includes event and no explicit trigger exists
  it('calls legacy alert when event is in alertEvents and no explicit trigger exists', async () => {
    const list = { ...baseList, triggers: [], alertEvents: ['email.received'] };

    await fireTriggers(
      'email.received',
      'list_1',
      'user_1',
      baseLead,
      undefined,
      { subject: 'Hello' },
      list
    );

    expect(leadListAlertService.notifyLeadListOwnerIfConfigured).toHaveBeenCalledTimes(1);
    expect(leadListAlertService.notifyLeadListOwnerIfConfigured).toHaveBeenCalledWith(
      list,
      baseLead,
      'email.received',
      { subject: 'Hello' },
      expect.any(String)
    );
  });

  // Test 4: legacy fallback skipped when an explicit trigger exists for the event
  it('skips legacy alert when an explicit trigger exists for the event', async () => {
    const trigger = makeTrigger({ event: 'email.received', conditionExpression: 'true' });
    const list = { ...baseList, triggers: [trigger], alertEvents: ['email.received'] };

    await fireTriggers(
      'email.received',
      'list_1',
      'user_1',
      baseLead,
      undefined,
      { subject: 'Hello' },
      list
    );

    expect(leadListAlertService.notifyLeadListOwnerIfConfigured).not.toHaveBeenCalled();
    expect(runTriggerAction).toHaveBeenCalledTimes(1);
  });

  // Test 5: fireTriggersByEmailEvent fan-out finds list + lead by domain and invokes trigger flow
  it('fireTriggersByEmailEvent resolves lead by domain and processes triggers', async () => {
    (userDb.getUsersByEmailDomain as jest.Mock).mockResolvedValue([baseUser]);
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([
      { ...baseList, triggers: [], alertEvents: ['email.received'] },
    ]);
    (crmDb.getLeadByEmail as jest.Mock).mockResolvedValue(baseLead);

    await fireTriggersByEmailEvent({
      eventType: 'email.received',
      leadEmail: 'lead@example.com',
      emailDomain: 'example.com',
      data: { subject: 'Test' },
      createdAt: new Date().toISOString(),
    });

    expect(userDb.getUsersByEmailDomain).toHaveBeenCalledWith('example.com');
    expect(crmDb.getLeadListsByUserId).toHaveBeenCalledWith('user_1');
    expect(crmDb.getLeadByEmail).toHaveBeenCalledWith('list_1', 'lead@example.com');
  });

  // Test 6: custom event custom.linkedin fires trigger
  it('fires trigger for custom event type custom.linkedin', async () => {
    const trigger = makeTrigger({ event: 'custom.linkedin', conditionExpression: 'true' });
    const list = { ...baseList, triggers: [trigger] };

    await fireTriggers(
      'custom.linkedin',
      'list_1',
      'user_1',
      baseLead,
      undefined,
      {},
      list
    );

    expect(runTriggerAction).toHaveBeenCalledTimes(1);
  });

  // Test 7: api.lead_added trigger fires when event.source condition matches
  it('fires trigger for api.lead_added when event.source condition matches', async () => {
    const trigger = makeTrigger({
      event: 'api.lead_added',
      conditionExpression: 'event.source == "hubspot"',
    });
    const list = { ...baseList, triggers: [trigger] };

    await fireTriggers(
      'api.lead_added',
      'list_1',
      'user_1',
      baseLead,
      undefined,
      { source: 'hubspot' },
      list
    );

    expect(runTriggerAction).toHaveBeenCalledTimes(1);
  });
});
