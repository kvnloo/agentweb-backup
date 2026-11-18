/**
 * ENG-3149: the account owner is emailed once when a share-link visitor first marks one of their scheduled chats.
 *
 * Alert only on a VISITOR write, only when it is the schedule's FIRST mark, only AFTER the write succeeded, only to the owner's own
 * login email, at most a few an hour, and never in a way that delays, changes or fails the visitor's request.
 */
import { Request, Response } from 'express';

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
  getUserSubscriptionResolution: jest.fn(async () => ({ subscriptionType: 'Free', resolved: true })),
  readTierAllowedModels: jest.fn(async () => ({ configured: false })),
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(async () => null) },
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(async () => 'gpt-5-chat-2'),
    getScheduledChatsDefaultModel: jest.fn(async () => 'gpt-5-chat-2'),
    getSupportedModels: jest.fn(async () => ['gpt-5-chat-2']),
    getModelDisplayName: jest.fn(() => 'GPT'),
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    isModelSelectableBy: jest.fn(() => true),
  },
}));
jest.mock('../services/emailService', () => ({
  emailService: {
    sendVisitorScheduleAlertEmail: jest.fn(),
    sendScheduledChatResultEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
  },
}));
jest.mock('../services/db', () => ({
  scheduleDb: {
    getScheduleById: jest.fn(), createSchedule: jest.fn(), updateSchedule: jest.fn(), getSchedulesByUserId: jest.fn(),
    getScheduledChatByVariableAccessTokenHash: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
  scheduleTemplateDb: { getTemplateById: jest.fn(), incrementUsageCount: jest.fn() },
}));

import { scheduleDb, userDb, scheduleTemplateDb } from '../services/db';
import { emailService } from '../services/emailService';
import { agentModeController } from '../controllers/agentModeController';
import { markShareVisitorTurn, clearShareVisitorTurn } from '../services/shareVisitorTurnMarker';
import { shareScheduleAlertThrottle } from '../utils/shareScheduleAlertThrottle';
import * as provenanceUtil from '../utils/scheduleProvenance';

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockTemplateDb = scheduleTemplateDb as jest.Mocked<typeof scheduleTemplateDb>;
const sendAlert = emailService.sendVisitorScheduleAlertEmail as jest.Mock;

const USER = 'owner-1';
const OWNER_EMAIL = 'owner@example.com';

type Caller = {
  selfCall?: boolean;
  profile?: string;
  delegated?: boolean;
  session?: string;
  /** What req.user carries as email (the self-call token carries the owner's). `null` = none at all. */
  email?: string | null;
  userId?: string;
};
const portalOwner: Caller = {};
const emmaInOwnersChat: Caller = { selfCall: true };
const visitorByClaim: Caller = { selfCall: true, profile: 'share_visitor' };
const markedRunByClaim: Caller = { selfCall: true, profile: 'share_visitor_schedule' };
const visitorByMarkerOnly: Caller = { selfCall: true, session: 'visitor-session' };
const delegate: Caller = { delegated: true };

const makeReq = (caller: Caller, extra: { body?: any; params?: any } = {}) => ({
  user: {
    userId: caller.userId ?? USER,
    ...(caller.email === null ? {} : { email: caller.email ?? OWNER_EMAIL }),
    isAdmin: false,
  },
  body: extra.body ?? {},
  params: extra.params ?? {},
  isSelfCall: caller.selfCall,
  restrictionProfile: caller.profile,
  delegateInfo: caller.delegated ? { isDelegated: true, adminEmail: 'admin@example.com', adminUserId: 'admin-1' } : undefined,
  header: (name: string) => (caller.session && name.toLowerCase() === 'x-agentweb-session' ? caller.session : undefined),
}) as unknown as Request;
const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() }) as unknown as Response & { json: jest.Mock; status: jest.Mock };

const stored = (extra: Record<string, unknown> = {}) => ({
  scheduleId: 's1', userId: USER, scheduleName: 'Stored name', startingMessage: 'Hi', frequency: 'daily',
  nextRunTime: '2030-01-01T00:00:00.000Z', llmModel: '', keywords: ['a', 'b'], requiredFunctionCalls: ['t1'],
  functionCallMinCalls: { t1: 1 }, emailNotifications: [OWNER_EMAIL], variables: [], variableValues: {},
  updatedAt: '2026-11-18T08:00:00.000Z', ...extra,
});

/** Let the detached notification run to its end. */
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };

const create = async (caller: Caller, body: Record<string, unknown> = {}) => {
  const res = makeRes();
  await agentModeController.createScheduledChat(makeReq(caller, { body: { scheduleName: 'Visitor schedule', startingMessage: 'Do the thing', scheduleFrequency: 'daily', ...body } }), res);
  await flush();
  return res;
};
const update = async (caller: Caller, body: Record<string, unknown>) => {
  const res = makeRes();
  await agentModeController.updateScheduledChat(makeReq(caller, { body, params: { scheduleId: 's1' } }), res);
  await flush();
  return res;
};
const submit = async (caller: Caller, variableValues: Record<string, string>) => {
  const res = makeRes();
  await agentModeController.submitScheduledChatVariables(
    makeReq(caller, { body: { variableValues, triggerRun: false }, params: { scheduleId: 's1' } }), res);
  await flush();
  return res;
};
const template = {
  templateId: 't1', createdBy: USER, visibility: 'private', name: 'T', startingMessage: 'From template', variables: [], keywords: [],
  requiredFunctionCalls: [], functionCallMinCalls: {}, suggestedFrequency: 'daily', emailNotifications: [OWNER_EMAIL], llmModel: '',
};
const useTemplate = async (caller: Caller, body: Record<string, unknown> = {}) => {
  const res = makeRes();
  await agentModeController.createScheduleFromTemplate(makeReq(caller, { body, params: { templateId: 't1' } }) as any, res);
  await flush();
  return res;
};
const createdSchedule = () => mockScheduleDb.createSchedule.mock.calls[0]?.[0] as any;

beforeEach(() => {
  jest.clearAllMocks();
  shareScheduleAlertThrottle.reset();
  clearShareVisitorTurn('visitor-session');
  markShareVisitorTurn('visitor-session');
  mockUserDb.getUserById.mockResolvedValue({ userId: USER, email: 'looked-up@example.com', isAdmin: false } as any);
  mockScheduleDb.createSchedule.mockResolvedValue(undefined as any);
  mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
  mockTemplateDb.getTemplateById.mockResolvedValue(template as any);
  mockTemplateDb.incrementUsageCount.mockResolvedValue(undefined as any);
  sendAlert.mockResolvedValue(undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  clearShareVisitorTurn('visitor-session');
  shareScheduleAlertThrottle.reset();
  jest.restoreAllMocks();
});

describe('createScheduledChat', () => {
  it.each([
    ['a visitor by claim', visitorByClaim],
    ['a visitor by the turn marker only', visitorByMarkerOnly],
    ['a marked run by claim', markedRunByClaim],
  ])('%s: its schedule is born marked, so the owner is emailed ONCE, at the owner\'s login address, with the new schedule\'s name and id', async (_name, caller) => {
    const res = await create(caller);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(OWNER_EMAIL, 'Visitor schedule', createdSchedule().scheduleId);
    expect(createdSchedule().provenance?.length).toBeGreaterThan(0);
  });

  it.each([
    ['the owner in the portal', portalOwner],
    ['Emma in the owner\'s own chat (a self-call without the claim)', emmaInOwnersChat],
    ['an admin delegate', delegate],
  ])('%s: never an alert', async (_name, caller) => {
    const res = await create(caller);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('only the owner is ever the recipient: not the schedule\'s own notification list, nor anything the visitor typed', async () => {
    await create(visitorByClaim, { emailNotifications: ['victim@elsewhere.example'], scheduleName: 'Hi victim@elsewhere.example' });
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][0]).toBe(OWNER_EMAIL);
  });

  it('a create that FAILS to save sends nothing (the alert follows a successful write)', async () => {
    mockScheduleDb.createSchedule.mockRejectedValue(new Error('dynamo down'));
    const res = await create(visitorByClaim);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('a request refused before the write (missing fields) sends nothing', async () => {
    const res = makeRes();
    await agentModeController.createScheduledChat(makeReq(visitorByClaim, { body: { scheduleName: 'x' } }), res);
    await flush();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('createScheduleFromTemplate', () => {
  it('a visitor using a template: its schedule is born fully marked, so the owner is emailed once', async () => {
    const res = await useTemplate(visitorByClaim);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(OWNER_EMAIL, expect.any(String), createdSchedule().scheduleId);
    expect(createdSchedule().provenance?.length).toBeGreaterThan(0);
  });

  it('the marker-only visitor is alerted too', async () => {
    await useTemplate(visitorByMarkerOnly);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the owner', portalOwner], ['Emma in the owner\'s chat', emmaInOwnersChat], ['a delegate', delegate],
  ])('%s: never', async (_name, caller) => {
    await useTemplate(caller);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('the schedule exists once it is created, so it is alerted even if the usage counter afterwards fails', async () => {
    mockTemplateDb.incrementUsageCount.mockRejectedValue(new Error('counter down'));
    await useTemplate(visitorByClaim);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it('a create that fails to save sends nothing', async () => {
    mockScheduleDb.createSchedule.mockRejectedValue(new Error('dynamo down'));
    await useTemplate(visitorByClaim);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('updateScheduledChat', () => {
  it('a visitor update that CHANGES content on an UNMARKED schedule is its first mark: emailed once, with the schedule\'s name', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    const res = await update(visitorByClaim, { startingMessage: 'visitor wrote this' });
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(OWNER_EMAIL, 'Stored name', 's1');
  });

  it('...and shows the name the schedule has AFTER the edit when the visitor renamed it', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    await update(visitorByClaim, { scheduleName: 'Renamed by visitor', startingMessage: 'visitor wrote this' });
    expect(sendAlert).toHaveBeenCalledWith(OWNER_EMAIL, 'Renamed by visitor', 's1');
  });

  it('the marker-only visitor on an unmarked schedule is alerted too', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    await update(visitorByMarkerOnly, { keywords: ['z'] });
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it('a visitor update of an ALREADY MARKED schedule: no alert (once per marking)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ provenance: ['keywords'] }) as any);
    await update(visitorByClaim, { startingMessage: 'visitor wrote more' });
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('a mark the code cannot read still counts as marked: no alert', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ provenance: { weird: true } }) as any);
    await update(visitorByClaim, { startingMessage: 'visitor wrote more' });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('a NO-OP visitor update (resends what is stored) adds no mark, so: no alert', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    await update(visitorByClaim, {
      startingMessage: 'Hi', keywords: ['a', 'b'], requiredFunctionCalls: ['t1'], functionCallMinCalls: { t1: 1 }, emailNotifications: [OWNER_EMAIL],
    });
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    expect(mockScheduleDb.updateSchedule.mock.calls[0][1]).not.toHaveProperty('provenanceAdd');
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('a visitor change to an UNTRACKED field only (the name) adds no mark, so: no alert', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    await update(visitorByClaim, { scheduleName: 'Just a rename' });
    expect(mockScheduleDb.updateSchedule.mock.calls[0][1]).not.toHaveProperty('provenanceAdd');
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it.each([
    ['the owner in the portal', portalOwner], ['Emma in the owner\'s chat', emmaInOwnersChat], ['an admin delegate', delegate],
  ])('%s editing an unmarked schedule: never an alert', async (_name, caller) => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    await update(caller, { startingMessage: 'owner wrote this', keywords: ['z'] });
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('an update that LOSES the race (nothing written, 409) sends nothing', async () => {
    mockScheduleDb.getScheduleById
      .mockResolvedValueOnce(stored() as any)
      .mockResolvedValue(stored({ updatedAt: '2026-11-18T09:00:00.000Z' }) as any);
    mockScheduleDb.updateSchedule.mockRejectedValue(Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' }));
    const res = await update(visitorByClaim, { keywords: ['z'] });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('an update that fails for any other reason sends nothing', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    mockScheduleDb.updateSchedule.mockRejectedValue(new Error('dynamo down'));
    const res = await update(visitorByClaim, { keywords: ['z'] });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('a schedule that is not the caller\'s (404) sends nothing', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ userId: 'someone-else' }) as any);
    const res = await update(visitorByClaim, { keywords: ['z'] });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('submitScheduledChatVariables (a signed-in visitor\'s variable write)', () => {
  const withVariable = (extra: Record<string, unknown> = {}) =>
    stored({ startingMessage: 'Hello {{who}}', variables: [{ name: 'who' }], variableValues: { who: 'Alice' }, ...extra });

  it('a visitor changing the values on an UNMARKED schedule is its first mark: emailed once', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable() as any);
    await submit(visitorByClaim, { who: 'Mallory' });
    expect(mockScheduleDb.updateSchedule.mock.calls[0][1]).toHaveProperty('provenanceAdd', ['variableValues']);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert).toHaveBeenCalledWith(OWNER_EMAIL, 'Stored name', 's1');
  });

  it('...but not when the schedule was already marked', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable({ provenance: ['keywords'] }) as any);
    await submit(visitorByClaim, { who: 'Mallory' });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('...nor when the visitor re-submits the values already stored (no mark made)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable() as any);
    await submit(visitorByClaim, { who: 'Alice' });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it.each([
    ['the owner', portalOwner], ['Emma in the owner\'s chat', emmaInOwnersChat], ['a delegate', delegate],
  ])('%s: never', async (_name, caller) => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable() as any);
    await submit(caller, { who: 'Bob' });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('a write that fails sends nothing', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable() as any);
    mockScheduleDb.updateSchedule.mockRejectedValue(new Error('dynamo down'));
    await submit(visitorByClaim, { who: 'Mallory' });
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('defence in depth: the alert asks "is this a visitor write?" itself, not only the provenance plan', () => {
  // The plan only ever adds marks for a visitor write today. If that ever regressed, an owner's own save must still not email the owner.
  it('an owner update never alerts even if the plan claimed it added a mark', async () => {
    jest.spyOn(provenanceUtil, 'planProvenanceChange').mockReturnValue({ provenanceAdd: ['keywords'] } as any);
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      await update(caller, { keywords: ['z'] });
    }
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(3);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('an owner variable write never alerts even if the plan claimed it added a mark', async () => {
    jest.spyOn(provenanceUtil, 'planProvenanceChange').mockReturnValue({ provenanceAdd: ['variableValues'] } as any);
    mockScheduleDb.getScheduleById.mockResolvedValue(
      stored({ startingMessage: 'Hello {{who}}', variables: [{ name: 'who' }], variableValues: { who: 'Alice' } }) as any);
    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      await submit(caller, { who: 'Bob' });
    }
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(3);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('the public emailed-variables link', () => {
  it('never alerts: it is unauthenticated, and only ever marks a schedule that is already marked', async () => {
    mockScheduleDb.getScheduledChatByVariableAccessTokenHash.mockResolvedValue(stored({
      variables: [{ name: 'who' }], variableValues: {}, variableRequestStatus: 'pending', provenance: ['keywords'],
    }) as any);
    const res = makeRes();
    await agentModeController.submitScheduledChatVariablesByAccessToken(
      ({ params: { accessToken: 'tok' }, body: { variableValues: { who: 'Bob' } }, headers: {} } as unknown) as Request, res);
    await flush();
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalled(); // the submission itself went through
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('it is only a notification: it never delays, changes or fails the visitor\'s request', () => {
  /** The response with what legitimately differs run to run (the new id, and the run time that is jittered off the clock) blanked. */
  const unwrap = (res: any) => {
    const json = { ...res.json.mock.calls[0]?.[0] };
    for (const key of Object.keys(json)) if (/^(scheduleId|nextRunTime.*)$/i.test(key)) json[key] = '<varies>';
    return { status: res.status.mock.calls.map((c: any[]) => c[0]), json };
  };

  it('a send that REJECTS: the response is the one an alert-free request gets, and the failure is logged under [ENG-3149]', async () => {
    const quiet = await create(visitorByClaim);
    const expected = unwrap(quiet);
    sendAlert.mockClear();
    mockScheduleDb.createSchedule.mockClear();
    (console.error as jest.Mock).mockClear();
    sendAlert.mockRejectedValue(new Error('smtp down'));

    const res = await create(visitorByClaim);
    expect(unwrap(res)).toEqual(expected);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ENG-3149]'), expect.any(Error));
  });

  it('a send that THROWS synchronously: the same', async () => {
    sendAlert.mockImplementation(() => { throw new Error('boom'); });
    const res = await create(visitorByClaim);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ENG-3149]'), expect.any(Error));
  });

  it('a send that never finishes does not hold the request up (the handler does not await it)', async () => {
    sendAlert.mockReturnValue(new Promise(() => undefined));
    const res = makeRes();
    await agentModeController.createScheduledChat(
      makeReq(visitorByClaim, { body: { scheduleName: 'S', startingMessage: 'Hi', scheduleFrequency: 'daily' } }), res);
    expect(res.status).toHaveBeenCalledWith(201); // the handler returned although the send is still pending
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it('the same holds for an update, a variable write and a template use', async () => {
    sendAlert.mockRejectedValue(new Error('smtp down'));
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ startingMessage: 'Hello {{who}}', variables: [{ name: 'who' }], variableValues: { who: 'A' } }) as any);
    const updated = await update(visitorByClaim, { keywords: ['z'] });
    expect(updated.status).not.toHaveBeenCalledWith(500);
    expect(updated.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Scheduled chat updated successfully' }));

    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ startingMessage: 'Hello {{who}}', variables: [{ name: 'who' }], variableValues: { who: 'A' } }) as any);
    const submitted = await submit(visitorByClaim, { who: 'Z' });
    expect(submitted.status).not.toHaveBeenCalledWith(500);

    const used = await useTemplate(visitorByClaim);
    expect(used.status).toHaveBeenCalledWith(201);
    expect(sendAlert).toHaveBeenCalledTimes(3);
  });

  it('a failing recipient lookup (no email on the request, the account read throws) is logged and changes nothing', async () => {
    mockUserDb.getUserById.mockRejectedValue(new Error('db down'));
    const res = await create({ ...visitorByClaim, email: null });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[ENG-3149]'), expect.any(Error));
  });
});

describe('the recipient is the account owner\'s login email', () => {
  it('uses the email the request carries', async () => {
    await create({ ...visitorByClaim, email: 'carried@example.com' });
    expect(sendAlert).toHaveBeenCalledWith('carried@example.com', expect.any(String), expect.any(String));
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
  });

  it('looks the owner up by userId when the request carries none', async () => {
    await create({ ...visitorByClaim, email: null });
    expect(mockUserDb.getUserById).toHaveBeenCalledWith(USER);
    expect(sendAlert).toHaveBeenCalledWith('looked-up@example.com', expect.any(String), expect.any(String));
  });

  it('no email anywhere: skipped silently (no send, no error, the request is untouched)', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: USER, isAdmin: false } as any);
    const res = await create({ ...visitorByClaim, email: null });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('an unknown account (lookup finds nothing) is skipped silently too', async () => {
    mockUserDb.getUserById.mockResolvedValue(undefined as any);
    await create({ ...visitorByClaim, email: null });
    expect(sendAlert).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('at most 5 alerts per owner per hour', () => {
  it('the sixth marked schedule in the hour gets no email (the badge still shows), the refusal is logged once, and another owner is unaffected', async () => {
    for (let i = 0; i < 7; i++) {
      mockScheduleDb.createSchedule.mockClear();
      const res = await create(visitorByClaim);
      expect(res.status).toHaveBeenCalledWith(201); // the visitor's request is never refused for the cap
    }
    expect(sendAlert).toHaveBeenCalledTimes(5);
    const capLogs = (console.warn as jest.Mock).mock.calls.filter((call) => String(call[0]).includes('[ENG-3149]'));
    expect(capLogs).toHaveLength(1);

    await create({ ...visitorByClaim, userId: 'owner-2', email: 'second@example.com' });
    expect(sendAlert).toHaveBeenCalledTimes(6);
    expect(sendAlert).toHaveBeenLastCalledWith('second@example.com', expect.any(String), expect.any(String));
  });

  it('the cap is shared by every trigger (creates, template uses, first-mark updates)', async () => {
    await create(visitorByClaim);
    await create(visitorByClaim);
    await useTemplate(visitorByClaim);
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    await update(visitorByClaim, { keywords: ['z'] });
    await update(visitorByClaim, { keywords: ['y'] });
    expect(sendAlert).toHaveBeenCalledTimes(5);
    await create(visitorByClaim);
    expect(sendAlert).toHaveBeenCalledTimes(5);
  });

  it('an owner\'s own edits and a skipped (no email) request spend no slot', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    for (let i = 0; i < 10; i++) await update(portalOwner, { keywords: [`k${i}`] });
    mockUserDb.getUserById.mockResolvedValue({ userId: USER } as any);
    for (let i = 0; i < 10; i++) await create({ ...visitorByClaim, email: null });
    mockUserDb.getUserById.mockResolvedValue({ userId: USER, email: 'looked-up@example.com' } as any);
    for (let i = 0; i < 5; i++) await create(visitorByClaim);
    expect(sendAlert).toHaveBeenCalledTimes(5);
  });
});
