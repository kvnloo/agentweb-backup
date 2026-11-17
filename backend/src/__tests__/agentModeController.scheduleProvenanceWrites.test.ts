/**
 * ENG-2816 (step 3): who wrote a schedule's content, recorded where the schedule is written.
 *
 * A share-link visitor acts under the owner's userId. Every schedule write handler asks "is this write a visitor's?" (the self-call
 * carries a restriction claim, OR the session it names is running a share route's visitor turn) and, if so, marks the tracked
 * content fields it carries IN THE SAME WRITE. Nothing an owner does to the schedule's content takes a mark off (an owner who
 * changes a list has not thereby reviewed the visitor's part of it): the only way is the adopt route, a portal login saying so.
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
jest.mock('../services/db', () => ({
  scheduleDb: { getScheduleById: jest.fn(), createSchedule: jest.fn(), updateSchedule: jest.fn(), getSchedulesByUserId: jest.fn() },
  userDb: { getUserById: jest.fn() },
  scheduleTemplateDb: { getTemplateById: jest.fn(), updateTemplate: jest.fn(), incrementUsageCount: jest.fn(), createTemplate: jest.fn() },
}));

import { scheduleDb, userDb, scheduleTemplateDb } from '../services/db';
import { agentModeController } from '../controllers/agentModeController';
import { isSubscriptionFeatureEnabled } from '../services/subscriptionService';
import { markShareVisitorTurn, clearShareVisitorTurn } from '../services/shareVisitorTurnMarker';
import { SCHEDULE_PROVENANCE_FIELDS, scheduleContentVersion } from '../utils/scheduleProvenance';
import { resolveSchedulePublishAuthorization, describePublishAuthorizationWithholdReason } from '../utils/schedulePublishAuthorization';

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockTemplateDb = scheduleTemplateDb as jest.Mocked<typeof scheduleTemplateDb>;

const USER = 'owner-1';
const OWNER_EMAIL = 'owner@example.com';

/** Who is behind the request. */
type Caller = {
  /** An MCP self-call (Emma in a chat, a visitor's turn, a scheduled run). Absent = a person in the portal. */
  selfCall?: boolean;
  /** The restriction claim the self-call token carries. */
  profile?: string;
  /** An admin acting as the owner. */
  delegated?: boolean;
  /** X-AgentWeb-Session of the self-call. */
  session?: string;
};
const portalOwner: Caller = {};
const emmaInOwnersChat: Caller = { selfCall: true };
const visitorByClaim: Caller = { selfCall: true, profile: 'share_visitor' };
const markedRunByClaim: Caller = { selfCall: true, profile: 'share_visitor_schedule' };
const visitorByMarkerOnly: Caller = { selfCall: true, session: 'visitor-session' };
const delegate: Caller = { delegated: true };

const makeReq = (caller: Caller, extra: { body?: any; params?: any } = {}) => ({
  user: { userId: USER, email: OWNER_EMAIL, isAdmin: false },
  body: extra.body ?? {},
  params: extra.params ?? {},
  isSelfCall: caller.selfCall,
  restrictionProfile: caller.profile,
  delegateInfo: caller.delegated ? { isDelegated: true, adminEmail: 'admin@example.com', adminUserId: 'admin-1' } : undefined,
  header: (name: string) => (caller.session && name.toLowerCase() === 'x-agentweb-session' ? caller.session : undefined),
}) as unknown as Request;
const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() }) as unknown as Response & { json: jest.Mock; status: jest.Mock };

const stored = (extra: Record<string, unknown> = {}) => ({
  scheduleId: 's1', userId: USER, scheduleName: 'S', startingMessage: 'Hi', frequency: 'daily',
  nextRunTime: '2030-01-01T00:00:00.000Z', llmModel: '', keywords: ['a', 'b'], requiredFunctionCalls: ['t1'],
  functionCallMinCalls: { t1: 1 }, emailNotifications: [OWNER_EMAIL], variables: [], variableValues: {},
  updatedAt: '2026-11-17T08:00:00.000Z', ...extra,
});
/** What the portal posts on a plain save: the whole form, unchanged. */
const wholeForm = () => ({
  scheduleName: 'S', startingMessage: 'Hi', scheduleFrequency: 'daily', keywords: ['a', 'b'], requiredFunctionCalls: ['t1'],
  functionCallMinCalls: { t1: 1 }, emailNotifications: [OWNER_EMAIL], variables: [], variableValues: {},
});

const create = async (caller: Caller, body: Record<string, unknown>) => {
  const res = makeRes();
  await agentModeController.createScheduledChat(makeReq(caller, { body: { scheduleName: 'S', scheduleFrequency: 'daily', ...body } }), res);
  return res;
};
const update = async (caller: Caller, body: Record<string, unknown>) => {
  const res = makeRes();
  await agentModeController.updateScheduledChat(makeReq(caller, { body, params: { scheduleId: 's1' } }), res);
  return res;
};
const created = () => mockScheduleDb.createSchedule.mock.calls[0]?.[0] as any;
const updatedWith = () => mockScheduleDb.updateSchedule.mock.calls[0]?.[1] as any;

beforeEach(() => {
  jest.clearAllMocks();
  clearShareVisitorTurn('visitor-session');
  markShareVisitorTurn('visitor-session');
  mockUserDb.getUserById.mockResolvedValue({ userId: USER, isAdmin: false } as any);
  mockScheduleDb.createSchedule.mockResolvedValue(undefined as any);
  mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  clearShareVisitorTurn('visitor-session');
  jest.restoreAllMocks();
});

describe('createScheduledChat', () => {
  const content = { startingMessage: 'Do the thing', keywords: ['k'], requiredFunctionCalls: ['save_memory'], emailNotifications: ['x@example.com'] };

  it.each([
    ['a visitor (restriction claim)', visitorByClaim],
    ['a marked run\'s own write (restriction claim)', markedRunByClaim],
    ['a visitor (claim dropped, session marker only)', visitorByMarkerOnly],
  ])('marks every tracked field the request carries, in the create itself: %s', async (_name, caller) => {
    await create(caller, content);
    expect(mockScheduleDb.createSchedule).toHaveBeenCalledTimes(1);
    expect(created().provenance).toEqual(['startingMessage', 'keywords', 'requiredFunctionCalls', 'emailNotifications']);
  });

  it('marks only what the request carried (a field left out is not the visitor\'s)', async () => {
    await create(visitorByClaim, { startingMessage: 'Hi' });
    expect(created().provenance).toEqual(['startingMessage']);
  });

  it('does not track session_id, timing, model, name or description', async () => {
    await create(visitorByClaim, { startingMessage: 'Hi', nextRunTime: '2030-01-01T09:00:00Z', timezone: 'UTC', description: 'd', runCount: 3, scheduleName: 'Renamed' });
    expect(created().provenance).toEqual(['startingMessage']);
  });

  it('tracks selfImprove on a create that carries it (the next run\'s owner-powered reflection turn would rewrite the prompt)', async () => {
    await create(visitorByClaim, { startingMessage: 'Hi', selfImprove: true });
    expect(created().provenance).toEqual(['startingMessage', 'selfImprove']);
    mockScheduleDb.createSchedule.mockClear();
    await create(visitorByClaim, { startingMessage: 'Hi', selfImprove: false });
    expect(created().provenance).toEqual(['startingMessage', 'selfImprove']);
  });

  it('an owner create that carries selfImprove marks nothing', async () => {
    await create(portalOwner, { startingMessage: 'Hi', selfImprove: true });
    expect(created()).not.toHaveProperty('provenance');
  });

  it.each([
    ['a person in the portal', portalOwner],
    ['Emma in the owner\'s own chat (a self-call with no claim and no visitor turn)', emmaInOwnersChat],
    ['a delegated admin', delegate],
  ])('does NOT mark an owner write: %s', async (_name, caller) => {
    await create(caller, content);
    expect(created()).not.toHaveProperty('provenance');
  });

  it('a visitor-turn session marker means nothing to a PERSON (only a self-call can be a visitor)', async () => {
    await create({ session: 'visitor-session' }, content);
    expect(created()).not.toHaveProperty('provenance');
  });

  it('a marker for a DIFFERENT session does not mark this self-call', async () => {
    await create({ selfCall: true, session: 'some-other-session' }, content);
    expect(created()).not.toHaveProperty('provenance');
  });

  it('a visitor create still creates the schedule (nothing is refused, only marked)', async () => {
    const res = await create(visitorByClaim, content);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('updateScheduledChat: marking', () => {
  beforeEach(() => mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any));

  it('a visitor edit marks the fields it carries, in the SAME write as the content', async () => {
    await update(visitorByClaim, { startingMessage: 'Do something else', keywords: ['z'] });
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    const payload = updatedWith();
    expect(payload.startingMessage).toBe('Do something else');
    expect(payload.provenanceAdd).toEqual(['startingMessage', 'keywords']);
    expect(payload).not.toHaveProperty('provenanceRemove');
  });

  it.each([
    ['startingMessage', { startingMessage: 'new text' }],
    ['keywords', { keywords: ['new'] }],
    ['requiredFunctionCalls', { requiredFunctionCalls: ['save_memory'] }],
    ['functionCallMinCalls', { functionCallMinCalls: { t1: 5 } }],
    ['emailNotifications', { emailNotifications: ['attacker@example.com'] }],
    ['selfImprove', { selfImprove: true }],
  ])('tracks %s on its own', async (field, body) => {
    await update(visitorByClaim, body);
    expect(updatedWith().provenanceAdd).toEqual([field]);
  });

  it('selfImprove: a visitor CHANGING it marks it (either way); re-sending the stored value, or an absent one as false, marks nothing', async () => {
    await update(visitorByClaim, { selfImprove: true });
    expect(updatedWith().provenanceAdd).toEqual(['selfImprove']);

    mockScheduleDb.updateSchedule.mockClear();
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ selfImprove: true }) as any);
    await update(visitorByClaim, { selfImprove: false });
    expect(updatedWith().provenanceAdd).toEqual(['selfImprove']);

    for (const storedValue of [true, false, undefined]) {
      mockScheduleDb.updateSchedule.mockClear();
      mockScheduleDb.getScheduleById.mockResolvedValue(stored(storedValue === undefined ? {} : { selfImprove: storedValue }) as any);
      await update(visitorByClaim, { selfImprove: storedValue === true });
      expect(updatedWith()).not.toHaveProperty('provenanceAdd');
    }
  });

  it('selfImprove: an owner turning it on or off marks nothing', async () => {
    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      mockScheduleDb.updateSchedule.mockClear();
      await update(caller, { selfImprove: true });
      expect(updatedWith()).not.toHaveProperty('provenanceAdd');
    }
  });

  it('tracks variables and variableValues (values are substituted into the run\'s prompt)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ startingMessage: 'Hello {{who}}', variables: [{ name: 'who' }] }) as any);
    await update(visitorByClaim, { variables: [{ name: 'who', description: 'a person' }], variableValues: { who: 'Mallory' } });
    expect(updatedWith().provenanceAdd).toEqual(['variables', 'variableValues']);
  });

  it('a visitor edit of only the name, timing or model marks nothing and writes no provenance at all', async () => {
    await update(visitorByClaim, { scheduleName: 'Renamed', nextRunTime: '2030-02-01T09:00:00Z', timezone: 'UTC' });
    const payload = updatedWith();
    expect(payload).not.toHaveProperty('provenanceAdd');
    expect(payload).not.toHaveProperty('provenanceRemove');
  });

  it('a visitor edit does NOT mark a field it merely re-sends unchanged (it wrote nothing)', async () => {
    await update(visitorByClaim, { keywords: ['a', 'b'] });
    expect(updatedWith()).not.toHaveProperty('provenanceAdd');
  });

  it('marks through the session marker alone, when the claim was dropped on the way', async () => {
    await update(visitorByMarkerOnly, { startingMessage: 'x' });
    expect(updatedWith().provenanceAdd).toEqual(['startingMessage']);
  });

  it('a marked run\'s own edit (its reflection turn) re-marks what it writes, and never lifts', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ provenance: ['startingMessage'] }) as any);
    await update(markedRunByClaim, { startingMessage: 'self-improved prompt' });
    expect(updatedWith().provenanceAdd).toEqual(['startingMessage']);
    expect(updatedWith()).not.toHaveProperty('provenanceRemove');
  });

  it('an owner write marks nothing', async () => {
    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      mockScheduleDb.updateSchedule.mockClear();
      await update(caller, { startingMessage: 'owner text', keywords: ['z'] });
      expect(updatedWith()).not.toHaveProperty('provenanceAdd');
    }
  });
});

describe('updateScheduledChat: no edit ever takes a mark off', () => {
  const marked = (provenance: string[]) => mockScheduleDb.getScheduleById.mockResolvedValue(stored({ provenance }) as any);
  const callers: Array<[string, Caller]> = [
    ['a person in the portal', portalOwner],
    ['Emma in the owner\'s own chat (a self-call)', emmaInOwnersChat],
    ['a delegated admin', delegate],
    ['a visitor', visitorByClaim],
    ['a marked run', markedRunByClaim],
    ['a visitor by session marker only', visitorByMarkerOnly],
  ];

  it.each(callers)('%s: a whole-form save changes no marks', async (_name, caller) => {
    marked(['startingMessage', 'keywords', 'requiredFunctionCalls', 'emailNotifications']);
    await update(caller, { ...wholeForm(), scheduleName: 'Just a rename' });
    expect(updatedWith()).not.toHaveProperty('provenanceRemove');
    expect(updatedWith()).not.toHaveProperty('provenanceDelete');
    // (A visitor's whole-form save only ever ADDS, covered above.)
  });

  it.each(callers)('%s: changing a marked field does not unmark it', async (_name, caller) => {
    marked(['startingMessage', 'keywords']);
    await update(caller, { ...wholeForm(), startingMessage: 'a completely different prompt', keywords: ['changed'], emailNotifications: ['x@example.com', OWNER_EMAIL] });
    expect(updatedWith()).not.toHaveProperty('provenanceRemove');
  });

  it('an OWNER write (portal, Emma in their chat, a delegate) never adds either: provenance is untouched', async () => {
    marked(['startingMessage']);
    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      mockScheduleDb.updateSchedule.mockClear();
      await update(caller, { ...wholeForm(), startingMessage: 'owner wrote this', keywords: ['k'] });
      expect(updatedWith()).not.toHaveProperty('provenanceAdd');
      expect(updatedWith()).not.toHaveProperty('provenanceRemove');
    }
  });

  it('no other handler removes a mark either: the variables submission, and the create from a template', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ startingMessage: 'Hello {{who}}', variables: [{ name: 'who' }], variableValues: { who: 'Alice' }, provenance: ['variableValues'] }) as any);
    const res = makeRes();
    await agentModeController.submitScheduledChatVariables(
      makeReq(portalOwner, { body: { variableValues: { who: 'Bob' }, triggerRun: false }, params: { scheduleId: 's1' } }), res);
    expect(updatedWith()).not.toHaveProperty('provenanceRemove');
    expect(updatedWith()).not.toHaveProperty('provenanceAdd');
  });
});

describe('marking precision: a visitor marks only what it actually changes (ENG-2816 step 3)', () => {
  beforeEach(() => mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any));

  it('a whole-form save whose values are all unchanged marks NOTHING and writes no provenance at all', async () => {
    await update(visitorByClaim, { ...wholeForm(), scheduleName: 'Just a rename' });
    const payload = updatedWith();
    expect(payload).not.toHaveProperty('provenanceAdd');
    expect(payload.scheduleName).toBe('Just a rename');
  });

  it('a real change among no-ops marks only that field', async () => {
    await update(visitorByClaim, { ...wholeForm(), startingMessage: 'Hi, and also do this' });
    expect(updatedWith().provenanceAdd).toEqual(['startingMessage']);
  });

  it('is strict: a reordered list or a different address list is a change (an edit it cannot show to be a no-op is marked)', async () => {
    await update(visitorByClaim, { ...wholeForm(), keywords: ['b', 'a'] });
    expect(updatedWith().provenanceAdd).toEqual(['keywords']);
    mockScheduleDb.updateSchedule.mockClear();
    await update(visitorByClaim, { ...wholeForm(), emailNotifications: [OWNER_EMAIL, 'attacker@example.com'] });
    expect(updatedWith().provenanceAdd).toEqual(['emailNotifications']);
  });

  it('an unexpected stored shape reads as "differs" and is marked (fail safe)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ keywords: 'not-a-list', functionCallMinCalls: [1] }) as any);
    await update(visitorByClaim, { keywords: ['a'], functionCallMinCalls: { t1: 1 } });
    expect(updatedWith().provenanceAdd).toEqual(['keywords', 'functionCallMinCalls']);
  });

  it('cannot be used to degrade an owner\'s schedule: a no-op visitor write leaves a publish-granted schedule unmarked and its grant intact', async () => {
    const grantedSchedule = stored({ requiredFunctionCalls: ['post_on_connected_account'], autopublishAuthorized: true, autopublishAuthorizedTools: ['post_on_connected_account'] });
    mockScheduleDb.getScheduleById.mockResolvedValue(grantedSchedule as any);
    await update(visitorByClaim, { requiredFunctionCalls: ['post_on_connected_account'], keywords: ['a', 'b'], startingMessage: 'Hi' });
    expect(updatedWith()).not.toHaveProperty('provenanceAdd');
  });

  it('compares with a CONSISTENT read (never a stale replica), only for a visitor; every other caller reads exactly as before', async () => {
    await update(visitorByClaim, { keywords: ['z'] });
    expect(mockScheduleDb.getScheduleById).toHaveBeenCalledWith('s1', { consistent: true });

    mockScheduleDb.getScheduleById.mockClear();
    await update(portalOwner, { keywords: ['z'] });
    await update(emmaInOwnersChat, { keywords: ['z'] });
    expect(mockScheduleDb.getScheduleById).toHaveBeenNthCalledWith(1, 's1');
    expect(mockScheduleDb.getScheduleById).toHaveBeenNthCalledWith(2, 's1');
  });

  it('judges a field against the FRESH version, not a stale replica: the same keywords are a change against one and a no-op against the other', async () => {
    const stale = stored({ keywords: ['old'] });
    const fresh = stored({ keywords: ['z'] });
    mockScheduleDb.getScheduleById.mockImplementation((async (_id: string, options?: { consistent?: boolean }) => (options?.consistent ? fresh : stale)) as any);

    await update(visitorByClaim, { keywords: ['z'] });
    expect(updatedWith()).not.toHaveProperty('provenanceAdd'); // identical to what is really stored

    mockScheduleDb.updateSchedule.mockClear();
    await update(visitorByClaim, { keywords: ['old'] });
    expect(updatedWith().provenanceAdd).toEqual(['keywords']); // equal only to the stale copy: a real change
  });

  it('a create is not an edit: it still marks every tracked field it carries', async () => {
    await create(visitorByClaim, { startingMessage: 'Hi', keywords: [] });
    expect(created().provenance).toEqual(['startingMessage', 'keywords']);
  });
});

describe('submitScheduledChatVariables', () => {
  const withVariable = (extra: Record<string, unknown> = {}) =>
    stored({ startingMessage: 'Hello {{who}}', variables: [{ name: 'who' }], variableValues: { who: 'Alice' }, ...extra });
  const submit = async (caller: Caller, variableValues: Record<string, string>) => {
    const res = makeRes();
    await agentModeController.submitScheduledChatVariables(
      makeReq(caller, { body: { variableValues, triggerRun: false }, params: { scheduleId: 's1' } }), res);
    return res;
  };

  it('a visitor\'s submission marks variableValues in the same write', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable() as any);
    await submit(visitorByClaim, { who: 'Mallory' });
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    expect(updatedWith().variableValues).toEqual({ who: 'Mallory' });
    expect(updatedWith().provenanceAdd).toEqual(['variableValues']);
  });

  it('a visitor re-submitting the STORED values writes nothing of its own, so marks nothing; and reads consistently', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable() as any);
    await submit(visitorByClaim, { who: 'Alice' });
    expect(updatedWith()).not.toHaveProperty('provenanceAdd');
    expect(mockScheduleDb.getScheduleById).toHaveBeenCalledWith('s1', { consistent: true });
  });

  it('an owner\'s own submission reads as before, and whatever it changes marks nothing and unmarks nothing', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable({ provenance: ['variableValues'] }) as any);
    for (const values of [{ who: 'Alice' }, { who: 'Bob' }]) {
      mockScheduleDb.updateSchedule.mockClear();
      await submit(portalOwner, values);
      expect(updatedWith()).not.toHaveProperty('provenanceAdd');
      expect(updatedWith()).not.toHaveProperty('provenanceRemove');
    }
    expect(mockScheduleDb.getScheduleById).toHaveBeenCalledWith('s1');
  });

  it('Emma in the owner\'s chat, and a delegate, mark nothing and unmark nothing', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable({ provenance: ['variableValues'] }) as any);
    for (const caller of [emmaInOwnersChat, delegate]) {
      mockScheduleDb.updateSchedule.mockClear();
      await submit(caller, { who: 'Bob' });
      expect(updatedWith()).not.toHaveProperty('provenanceAdd');
      expect(updatedWith()).not.toHaveProperty('provenanceRemove');
    }
  });
});

describe('createScheduleFromTemplate', () => {
  const template = {
    templateId: 't1', createdBy: USER, visibility: 'private', name: 'T', startingMessage: 'From template', variables: [], keywords: [],
    requiredFunctionCalls: [], functionCallMinCalls: {}, suggestedFrequency: 'daily', emailNotifications: [OWNER_EMAIL], llmModel: '',
  };
  const use = async (caller: Caller, body: Record<string, unknown> = {}) => {
    const res = makeRes();
    await agentModeController.createScheduleFromTemplate(makeReq(caller, { body, params: { templateId: 't1' } }) as any, res);
    return res;
  };
  beforeEach(() => mockTemplateDb.getTemplateById.mockResolvedValue(template as any));

  it('marks EVERY tracked field on a visitor create (the content came from a template, which carries no provenance of its own)', async () => {
    const res = await use(visitorByClaim, { requiredFunctionCalls: ['save_memory'] });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(created().provenance).toEqual([...SCHEDULE_PROVENANCE_FIELDS]);
  });

  it('marks nothing for the owner, Emma in their chat, or a delegate', async () => {
    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      mockScheduleDb.createSchedule.mockClear();
      await use(caller, {});
      expect(created()).not.toHaveProperty('provenance');
    }
  });
});

describe('templates: a visitor cannot create, change, delete or submit one (a template has nowhere to carry a mark)', () => {
  const ownTemplate = (extra: Record<string, unknown> = {}) => ({ templateId: 't1', createdBy: USER, visibility: 'private', name: 'T', startingMessage: 'm', ...extra });
  const visitors: Array<[string, Caller]> = [['a visitor (claim)', visitorByClaim], ['a marked run', markedRunByClaim], ['a visitor (session marker only)', visitorByMarkerOnly]];
  const owners: Array<[string, Caller]> = [['a person in the portal', portalOwner], ['Emma in the owner\'s own chat', emmaInOwnersChat], ['a delegated admin', delegate]];

  const createTemplate = async (caller: Caller) => {
    const res = makeRes();
    await agentModeController.createScheduleTemplate(makeReq(caller, { body: { name: 'T', startingMessage: 'Hi {{who}}' } }) as any, res);
    return res;
  };
  const updateTemplate = async (caller: Caller, body: Record<string, unknown>) => {
    const res = makeRes();
    await agentModeController.updateScheduleTemplate(makeReq(caller, { body, params: { templateId: 't1' } }) as any, res);
    return res;
  };
  const deleteTemplate = async (caller: Caller) => {
    const res = makeRes();
    await agentModeController.deleteScheduleTemplate(makeReq(caller, { params: { templateId: 't1' } }) as any, res);
    return res;
  };
  const submitForReview = async (caller: Caller) => {
    const res = makeRes();
    await agentModeController.submitTemplateForReview(makeReq(caller, { params: { templateId: 't1' } }) as any, res);
    return res;
  };
  beforeEach(() => mockTemplateDb.getTemplateById.mockResolvedValue(ownTemplate() as any));

  it.each(visitors)('%s: create, update (any field, visibility or not), delete and submit-for-review are all 403, and nothing is read or written', async (_name, caller) => {
    for (const res of [
      await createTemplate(caller),
      await updateTemplate(caller, { name: 'Renamed', startingMessage: 'new' }),
      await updateTemplate(caller, { visibility: 'private' }),
      await deleteTemplate(caller),
    ]) {
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('Ask the account owner to do it from their own session') });
    }
    expect((await submitForReview(caller)).status).toHaveBeenCalledWith(403);
    expect(mockTemplateDb.createTemplate).not.toHaveBeenCalled();
    expect(mockTemplateDb.updateTemplate).not.toHaveBeenCalled();
    expect(mockTemplateDb.getTemplateById).not.toHaveBeenCalled();
  });

  it.each(owners)('%s keeps every one of them (nothing is taken from the owner)', async (_name, caller) => {
    mockTemplateDb.getTemplateById.mockResolvedValue(ownTemplate() as any);
    expect((await createTemplate(caller)).status).toHaveBeenCalledWith(201);
    await updateTemplate(caller, { name: 'Renamed' });
    expect(mockTemplateDb.updateTemplate).toHaveBeenCalledWith('t1', expect.objectContaining({ name: 'Renamed' }), expect.anything());
    mockTemplateDb.updateTemplate.mockClear();
    await submitForReview(caller);
    expect(mockTemplateDb.updateTemplate).toHaveBeenCalledWith('t1', expect.objectContaining({ visibility: 'pending_review' }));
  });

  it('a visitor can still USE a template: the schedule it creates is marked in full (covered above)', async () => {
    mockTemplateDb.getTemplateById.mockResolvedValue({ ...ownTemplate(), variables: [], keywords: [], requiredFunctionCalls: [], functionCallMinCalls: {}, suggestedFrequency: 'daily', emailNotifications: [OWNER_EMAIL], llmModel: '' } as any);
    const res = makeRes();
    await agentModeController.createScheduleFromTemplate(makeReq(visitorByClaim, { body: {}, params: { templateId: 't1' } }) as any, res);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('POST /scheduled-chats/:id/adopt-visitor-edits (the ONLY way a mark comes off)', () => {
  const markedSchedule = (extra: Record<string, unknown> = {}) => stored({ provenance: ['keywords', 'startingMessage'], ...extra });
  /** The version the portal list showed: computed from the schedule exactly as the list computes it. */
  const versionOf = (schedule: any) => scheduleContentVersion(schedule);
  const adopt = async (caller: Caller, body: Record<string, unknown> | undefined, scheduleId = 's1') => {
    const res = makeRes();
    await agentModeController.adoptScheduledChatVisitorEdits(makeReq(caller, { params: { scheduleId }, body }), res);
    return res;
  };
  const adoptWhatWasShown = (schedule: any, caller: Caller = portalOwner) => adopt(caller, { expectedContentVersion: versionOf(schedule) });
  const conditionalFailure = () => Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' });

  it('removes the WHOLE attribute from a real portal login that names the content it looked at, bound to the updatedAt it just read', async () => {
    const schedule = markedSchedule();
    mockScheduleDb.getScheduleById.mockResolvedValue(schedule as any);
    const res = await adoptWhatWasShown(schedule);

    expect(mockScheduleDb.getScheduleById).toHaveBeenCalledWith('s1', { consistent: true });
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    const [id, payload, expectation, shed, removals] = mockScheduleDb.updateSchedule.mock.calls[0] as any[];
    expect(id).toBe('s1');
    expect(Object.keys(payload)).toEqual(['updatedAt']);
    expect(expectation).toEqual({ updatedAt: schedule.updatedAt });
    expect(shed).toBeUndefined();
    expect(removals).toEqual(['provenance']);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ adopted: true, provenance: [] }));
  });

  it('adopts a provenance value that is not a well-formed set, because the whole attribute is removed', async () => {
    const schedule = markedSchedule({ provenance: 17 });
    mockScheduleDb.getScheduleById.mockResolvedValue(schedule as any);
    const res = await adoptWhatWasShown(schedule);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ adopted: true }));
    expect((mockScheduleDb.updateSchedule.mock.calls[0] as any[])[4]).toEqual(['provenance']);
  });

  describe('the owner adopts the CONTENT they saw', () => {
    it('answers 409 when the content changed since the list (a visitor edited it), and writes nothing', async () => {
      const shown = markedSchedule();
      mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule({ keywords: ['a', 'b', 'planted'] }) as any);
      const res = await adopt(portalOwner, { expectedContentVersion: versionOf(shown) });
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('Reopen it') });
      expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
    });

    it('answers 409 when only the MARKS changed (a visitor marked another field since the list)', async () => {
      const shown = markedSchedule();
      mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule({ provenance: ['keywords', 'startingMessage', 'selfImprove'] }) as any);
      expect((await adopt(portalOwner, { expectedContentVersion: versionOf(shown) })).status).toHaveBeenCalledWith(409);
    });

    it('still adopts when updatedAt (and other bookkeeping) moved since the list: a run, the cron, a toggle, identical variables', async () => {
      const shown = markedSchedule();
      mockScheduleDb.getScheduleById.mockResolvedValue({
        ...shown, updatedAt: '2026-11-17T23:59:59.000Z', lastRunTime: 'later', runCount: 9, runResults: [{ runId: 'r1' }], status: 'paused', claimedAt: 'x',
        variableValuesUpdatedAt: 'later', scheduleName: 'Renamed',
      } as any);
      const res = await adoptWhatWasShown(shown);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ adopted: true }));
      // ...and the write is bound to the updatedAt it JUST read, not the one the list showed.
      expect((mockScheduleDb.updateSchedule.mock.calls[0] as any[])[2]).toEqual({ updatedAt: '2026-11-17T23:59:59.000Z' });
    });

    it('bookkeeping landing BETWEEN the read and the write retries with the fresh updatedAt, and adopts', async () => {
      const shown = markedSchedule();
      mockScheduleDb.getScheduleById
        .mockResolvedValueOnce(shown as any)
        .mockResolvedValueOnce({ ...shown, updatedAt: '2026-11-17T09:00:00.000Z', runCount: 4 } as any);
      mockScheduleDb.updateSchedule.mockRejectedValueOnce(conditionalFailure()).mockResolvedValue(undefined as any);

      const res = await adoptWhatWasShown(shown);

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(2);
      expect((mockScheduleDb.updateSchedule.mock.calls[0] as any[])[2]).toEqual({ updatedAt: shown.updatedAt });
      expect((mockScheduleDb.updateSchedule.mock.calls[1] as any[])[2]).toEqual({ updatedAt: '2026-11-17T09:00:00.000Z' });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ adopted: true }));
    });

    it('a REAL visitor edit landing between the read and the write is NOT adopted: the retry sees the content changed and answers 409', async () => {
      const shown = markedSchedule();
      mockScheduleDb.getScheduleById
        .mockResolvedValueOnce(shown as any)
        .mockResolvedValueOnce(markedSchedule({ startingMessage: 'visitor rewrote it', updatedAt: '2026-11-17T09:00:00.000Z' }) as any);
      mockScheduleDb.updateSchedule.mockRejectedValueOnce(conditionalFailure());

      const res = await adoptWhatWasShown(shown);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1); // no second REMOVE
    });

    it('gives up after three attempts when the write keeps losing the race, answering 409', async () => {
      const shown = markedSchedule();
      mockScheduleDb.getScheduleById.mockImplementation((async () => ({ ...shown, updatedAt: String(Math.random()) })) as any);
      mockScheduleDb.updateSchedule.mockRejectedValue(conditionalFailure());
      const res = await adoptWhatWasShown(shown);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(3);
    });

    it('is not tied to the content version of a stale list that happens to match nothing: a made-up version is 409', async () => {
      mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule() as any);
      const res = await adopt(portalOwner, { expectedContentVersion: 'a'.repeat(32) });
      expect(res.status).toHaveBeenCalledWith(409);
      expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
    });

    it('ignores a client that still sends expectedUpdatedAt (it was never part of the API)', async () => {
      const schedule = markedSchedule();
      mockScheduleDb.getScheduleById.mockResolvedValue(schedule as any);
      const res = await adopt(portalOwner, { expectedUpdatedAt: schedule.updatedAt });
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  it.each([
    ['absent', {}],
    ['empty', { expectedContentVersion: '' }],
    ['a number', { expectedContentVersion: 12345 }],
    ['null', { expectedContentVersion: null }],
    ['an object', { expectedContentVersion: { v: 'x' } }],
  ])('answers 400 when expectedContentVersion is %s, reading and writing nothing', async (_name, body) => {
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule() as any);
    const res = await adopt(portalOwner, body as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('expectedContentVersion is required') });
    expect(mockScheduleDb.getScheduleById).not.toHaveBeenCalled();
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it.each([
    ['a self-call (Emma in the owner\'s chat, an external MCP client)', emmaInOwnersChat],
    ['a visitor by claim', visitorByClaim],
    ['a marked run', markedRunByClaim],
    ['a visitor by session marker only', visitorByMarkerOnly],
    ['a delegated admin', delegate],
  ])('refuses %s with 403, reads nothing and writes nothing', async (_name, caller) => {
    const schedule = markedSchedule();
    mockScheduleDb.getScheduleById.mockResolvedValue(schedule as any);
    const res = await adoptWhatWasShown(schedule, caller);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockScheduleDb.getScheduleById).not.toHaveBeenCalled();
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('is 404 for a missing schedule and for someone else\'s', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(undefined as any);
    expect((await adopt(portalOwner, { expectedContentVersion: 'x' })).status).toHaveBeenCalledWith(404);
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule({ userId: 'someone-else' }) as any);
    expect((await adopt(portalOwner, { expectedContentVersion: 'x' })).status).toHaveBeenCalledWith(404);
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('an unmarked schedule has nothing to adopt and is not written', async () => {
    const schedule = stored();
    mockScheduleDb.getScheduleById.mockResolvedValue(schedule as any);
    const res = await adoptWhatWasShown(schedule);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ adopted: false, provenance: [] }));
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });
});

describe('contentVersion: computed on the list, never stored', () => {
  const list = async () => {
    const res = makeRes();
    await agentModeController.getScheduledChats(makeReq(portalOwner, { body: {} }) as any, res);
    return res.json.mock.calls[0][0] as any[];
  };
  const row = () => ({ ...stored({ provenance: ['keywords'] }), type: 'scheduled_chat', createdAt: '2026-11-17T00:00:00.000Z', runResults: [{ runId: 'r' }] });

  it('every row carries the digest of its own tracked content and marks (what the portal sends back to adopt)', async () => {
    const a = row();
    const b = { ...stored({ scheduleId: 's2', keywords: ['other'] }), type: 'scheduled_chat', createdAt: '2026-11-16T00:00:00.000Z' };
    mockScheduleDb.getSchedulesByUserId.mockResolvedValue([a, b] as any);
    const items = await list();
    expect(items.find((i) => i.scheduleId === 's1')!.contentVersion).toBe(scheduleContentVersion(a));
    expect(items.find((i) => i.scheduleId === 's2')!.contentVersion).toBe(scheduleContentVersion(b));
    expect(items[0].contentVersion).not.toBe(items[1].contentVersion);
  });

  it('is never written back: the stored row is untouched, and no write handler ever puts it on an item (even if the portal posts it back)', async () => {
    const a = row();
    mockScheduleDb.getSchedulesByUserId.mockResolvedValue([a] as any);
    await list();
    expect(a).not.toHaveProperty('contentVersion');

    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    await update(portalOwner, { ...wholeForm(), contentVersion: 'abc', expectedContentVersion: 'abc' });
    await update(visitorByClaim, { keywords: ['z'], contentVersion: 'abc' });
    await create(portalOwner, { startingMessage: 'Hi', contentVersion: 'abc' });
    await create(visitorByClaim, { startingMessage: 'Hi', contentVersion: 'abc' });
    for (const call of mockScheduleDb.updateSchedule.mock.calls) expect(JSON.stringify(call)).not.toContain('contentVersion');
    for (const call of mockScheduleDb.createSchedule.mock.calls) expect(JSON.stringify(call)).not.toContain('contentVersion');
  });

  it('moves when a visitor changes content, and not when only bookkeeping moves', async () => {
    const before = row();
    expect(scheduleContentVersion({ ...before, updatedAt: 'later', runResults: [], runCount: 5, status: 'paused' })).toBe(scheduleContentVersion(before));
    expect(scheduleContentVersion({ ...before, keywords: ['x'] })).not.toBe(scheduleContentVersion(before));
  });
});

// ENG-2816 (step 3): a schedule a visitor CREATES holds at the publish step until the owner decides otherwise, so that ADOPTING it
// does not also switch on unattended publishing the owner never decided. (The resolver's legacy branch reads a schedule that was
// never asked as AUTHORIZED for the publish tools it requires; a visitor writes the tools it requires.)
describe('a visitor-created schedule stays on "Require approval before publishing" (M1)', () => {
  const publishing = { startingMessage: 'Post this', requiredFunctionCalls: ['post_on_connected_account'] };

  it('createScheduledChat by a visitor stores requirePublishApproval: true; by anyone else, exactly what it always stored', async () => {
    for (const caller of [visitorByClaim, markedRunByClaim, visitorByMarkerOnly]) {
      mockScheduleDb.createSchedule.mockClear();
      await create(caller, publishing);
      expect(created().requirePublishApproval).toBe(true);
    }
    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      mockScheduleDb.createSchedule.mockClear();
      await create(caller, publishing);
      expect(created().requirePublishApproval).toBe(false);
    }
  });

  it('an owner create that explicitly asks for the hold still gets it (unchanged)', async () => {
    await create(portalOwner, { ...publishing, requirePublishApproval: true });
    expect(created().requirePublishApproval).toBe(true);
  });

  it('createScheduleFromTemplate by a visitor stores it; by anyone else the field is simply not there (unchanged)', async () => {
    mockTemplateDb.getTemplateById.mockResolvedValue({
      templateId: 't1', createdBy: USER, visibility: 'private', name: 'T', startingMessage: 'm', variables: [], keywords: [], requiredFunctionCalls: ['post_on_connected_account'],
      functionCallMinCalls: {}, suggestedFrequency: 'daily', emailNotifications: [OWNER_EMAIL], llmModel: '',
    } as any);
    const use = (caller: Caller) => agentModeController.createScheduleFromTemplate(makeReq(caller, { body: {}, params: { templateId: 't1' } }) as any, makeRes());
    await use(visitorByClaim);
    expect(created().requirePublishApproval).toBe(true);
    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      mockScheduleDb.createSchedule.mockClear();
      await use(caller);
      expect(created()).not.toHaveProperty('requirePublishApproval');
    }
  });

  it('a visitor EDIT that adds no new publish tool does not touch requirePublishApproval (owner schedules are unaffected; adding one is the next describe)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ requirePublishApproval: false, requiredFunctionCalls: ['post_on_connected_account'] }) as any);
    await update(visitorByClaim, { startingMessage: 'new', requiredFunctionCalls: ['post_on_connected_account'] });
    expect(updatedWith()).not.toHaveProperty('requirePublishApproval');
  });

  it('ADOPT THEN RESOLVE: the adopted visitor-created schedule still drafts instead of publishing, until the owner grants consent', async () => {
    await create(visitorByClaim, publishing);
    const createdItem = { ...created(), userId: USER };
    // As written: marked, so unauthorized.
    expect(resolveSchedulePublishAuthorization(createdItem).authorized).toBe(false);
    expect(describePublishAuthorizationWithholdReason(createdItem)).toBe('visitor_edited');

    // The owner clicks Adopt: the whole provenance attribute comes off (what the route's REMOVE does).
    const { provenance: _removed, ...adopted } = createdItem;
    expect(resolveSchedulePublishAuthorization(adopted)).toEqual({ authorized: false, tools: [] });
    expect(describePublishAuthorizationWithholdReason(adopted)).toBe('require_publish_approval');

    // Only the owner's own decision turns publishing on: turning the hold OFF is what makes the legacy default apply, and
    // an explicit grant is the other way. Adopt alone is neither.
    expect(resolveSchedulePublishAuthorization({ ...adopted, requirePublishApproval: false }).authorized).toBe(true);
  });

  it('CONTROL: without the hold, an adopted visitor-written publish tool WOULD resolve as authorized (the thing this prevents)', async () => {
    const { requirePublishApproval: _hold, ...withoutHold } = { ...(await (async () => { await create(visitorByClaim, publishing); return created(); })()), userId: USER };
    const { provenance: _removed, ...adopted } = withoutHold;
    expect(resolveSchedulePublishAuthorization(adopted)).toEqual({ authorized: true, tools: ['post_on_connected_account'] });
  });
});

// ENG-2816 (step 3): the consent-narrowing write derives the STORED grant, not "may this run publish". A marked schedule may not
// publish, but removing a publish tool from it must still narrow what the owner granted, or the removed tool's grant would come back
// the day the owner adopts the schedule.
describe('consent narrowing on an edit of a MARKED schedule', () => {
  const granted = (over: Record<string, unknown> = {}) => stored({
    requiredFunctionCalls: ['post_on_connected_account', 'publish_blog_article'],
    autopublishAuthorized: true,
    autopublishAuthorizedTools: ['post_on_connected_account', 'publish_blog_article'],
    ...over,
  });
  const edit = (tools: string[]) => update(portalOwner, { ...wholeForm(), requiredFunctionCalls: tools });

  it('narrows the stored grant when the owner removes one publish tool, in the same write, bound to the grant it was derived from', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(granted({ provenance: ['startingMessage'] }) as any);
    await edit(['post_on_connected_account']);

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    const [, payload, expectation] = mockScheduleDb.updateSchedule.mock.calls[0] as any[];
    expect(payload.requiredFunctionCalls).toEqual(['post_on_connected_account']);
    expect(payload.autopublishAuthorizedTools).toEqual(['post_on_connected_account']);
    expect(payload).not.toHaveProperty('autopublishAuthorized'); // still granted, for the one tool that remains
    expect(expectation).toMatchObject({ autopublishAuthorized: true });
  });

  it('revokes the stored grant when no publish tool remains', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(granted({ provenance: ['startingMessage'] }) as any);
    await edit([]);
    const [, payload] = mockScheduleDb.updateSchedule.mock.calls[0] as any[];
    expect(payload).toMatchObject({ autopublishAuthorized: false, autopublishAuthorizedTools: [], autopublishAuthorizedAt: null, autopublishAuthorizedBy: null });
  });

  it('does exactly the same for an UNMARKED schedule (nothing changed for existing schedules)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(granted() as any);
    await edit(['post_on_connected_account']);
    const [, payload] = mockScheduleDb.updateSchedule.mock.calls[0] as any[];
    expect(payload.autopublishAuthorizedTools).toEqual(['post_on_connected_account']);
  });

  it('and a visitor edit of a marked schedule narrows it the same way (the write also adds its marks)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(granted({ provenance: ['startingMessage'] }) as any);
    await update(visitorByClaim, { requiredFunctionCalls: ['post_on_connected_account'] });
    const [, payload] = mockScheduleDb.updateSchedule.mock.calls[0] as any[];
    expect(payload.autopublishAuthorizedTools).toEqual(['post_on_connected_account']);
    expect(payload.provenanceAdd).toEqual(['requiredFunctionCalls']);
  });
});

// ENG-2816 (step 3), round 3.
describe('a publish tool or Slack send a VISITOR newly adds is held too (M2)', () => {
  const PUBLISH = 'post_on_connected_account';
  const consentless = (extra: Record<string, unknown> = {}) => stored({ requiredFunctionCalls: ['t1'], ...extra });
  const given = (schedule: Record<string, unknown>) => mockScheduleDb.getScheduleById.mockResolvedValue(schedule as any);

  it('a visitor edit that adds a publish tool to a consent-less schedule stores the hold, in the same write; adopting then still drafts', async () => {
    const before = consentless();
    given(before);
    await update(visitorByClaim, { requiredFunctionCalls: ['t1', PUBLISH] });
    expect(updatedWith().requirePublishApproval).toBe(true);
    expect(updatedWith().provenanceAdd).toEqual(['requiredFunctionCalls']);

    // What is stored after that write, then the owner adopts (the whole provenance attribute comes off).
    const { provenance: _marks, ...adopted } = { ...before, ...updatedWith(), provenance: ['requiredFunctionCalls'] };
    delete (adopted as any).provenanceAdd;
    expect(resolveSchedulePublishAuthorization(adopted)).toEqual({ authorized: false, tools: [] });
    expect(describePublishAuthorizationWithholdReason(adopted)).toBe('require_publish_approval');
  });

  it('CONTROL: without the hold, the same adopted schedule WOULD publish (the thing this prevents)', () => {
    expect(resolveSchedulePublishAuthorization({ ...consentless(), requiredFunctionCalls: ['t1', PUBLISH] })).toEqual({ authorized: true, tools: [PUBLISH] });
  });

  it('a visitor edit that adds slack_send_message stores requireSlackApproval', async () => {
    given(consentless());
    await update(visitorByClaim, { requiredFunctionCalls: ['t1', 'slack_send_message'] });
    expect(updatedWith().requireSlackApproval).toBe(true);
    expect(updatedWith()).not.toHaveProperty('requirePublishApproval');
  });

  it('a publish tool added next to ones the schedule already had is still a NEW tool', async () => {
    given(consentless({ requiredFunctionCalls: [PUBLISH] }));
    await update(visitorByClaim, { requiredFunctionCalls: [PUBLISH, 'publish_blog_article'] });
    expect(updatedWith().requirePublishApproval).toBe(true);
  });

  it('a visitor edit that adds NOTHING new leaves a pre-existing publishing schedule\'s settings alone (no-op, unrelated edit, tool removed, reorder)', async () => {
    given(consentless({ requiredFunctionCalls: [PUBLISH, 'slack_send_message'] }));
    for (const body of [
      { requiredFunctionCalls: [PUBLISH, 'slack_send_message'] },
      { startingMessage: 'something else entirely' },
      { requiredFunctionCalls: [PUBLISH] },
      { requiredFunctionCalls: ['slack_send_message', PUBLISH, 'a_read_tool'] },
    ]) {
      mockScheduleDb.updateSchedule.mockClear();
      await update(visitorByClaim, body);
      expect(updatedWith()).not.toHaveProperty('requirePublishApproval');
      expect(updatedWith()).not.toHaveProperty('requireSlackApproval');
    }
  });

  it('an OWNER edit never changes either setting, whatever it adds', async () => {
    given(consentless());
    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      mockScheduleDb.updateSchedule.mockClear();
      await update(caller, { requiredFunctionCalls: ['t1', PUBLISH, 'slack_send_message'] });
      expect(updatedWith()).not.toHaveProperty('requirePublishApproval');
      expect(updatedWith()).not.toHaveProperty('requireSlackApproval');
    }
  });

  it('an existing owner consent is untouched (the grant is scoped to the tools the owner approved)', async () => {
    given(consentless({ requiredFunctionCalls: [PUBLISH], autopublishAuthorized: true, autopublishAuthorizedTools: [PUBLISH] }));
    await update(visitorByClaim, { requiredFunctionCalls: [PUBLISH, 'publish_blog_article'] });
    expect(updatedWith()).not.toHaveProperty('requirePublishApproval');
  });

  it('an existing hold is never lowered (the write only ever sets true)', async () => {
    given(consentless({ requirePublishApproval: true, requireSlackApproval: true }));
    await update(visitorByClaim, { requiredFunctionCalls: ['t1'] });
    expect(updatedWith().requirePublishApproval).not.toBe(false);
    expect(updatedWith().requireSlackApproval).not.toBe(false);
    mockScheduleDb.updateSchedule.mockClear();
    await update(visitorByClaim, { requiredFunctionCalls: ['t1', PUBLISH, 'slack_send_message'] });
    expect(updatedWith().requirePublishApproval).toBe(true);
    expect(updatedWith().requireSlackApproval).toBe(true);
  });

  describe('creates', () => {
    it('a visitor create that requires slack_send_message also stores requireSlackApproval (it already stores the publish hold)', async () => {
      await create(visitorByClaim, { startingMessage: 'Hi', requiredFunctionCalls: ['slack_send_message'] });
      expect(created().requireSlackApproval).toBe(true);
      expect(created().requirePublishApproval).toBe(true);
    });

    it('a visitor create that does not require it does not', async () => {
      await create(visitorByClaim, { startingMessage: 'Hi', requiredFunctionCalls: ['get_marketing_tips'] });
      expect(created().requireSlackApproval).toBe(false);
    });

    it('an owner create is exactly as before, Slack tool or not', async () => {
      for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
        mockScheduleDb.createSchedule.mockClear();
        await create(caller, { startingMessage: 'Hi', requiredFunctionCalls: ['slack_send_message'] });
        expect(created().requireSlackApproval).toBe(false);
        expect(created().requirePublishApproval).toBe(false);
      }
    });

    it('a visitor create from a template stores requireSlackApproval when the schedule requires the send (template or override)', async () => {
      const template = (tools: string[]) => ({
        templateId: 't1', createdBy: USER, visibility: 'private', name: 'T', startingMessage: 'm', variables: [], keywords: [], requiredFunctionCalls: tools,
        functionCallMinCalls: {}, suggestedFrequency: 'daily', emailNotifications: [OWNER_EMAIL], llmModel: '',
      });
      const use = (caller: Caller, body: Record<string, unknown> = {}) =>
        agentModeController.createScheduleFromTemplate(makeReq(caller, { body, params: { templateId: 't1' } }) as any, makeRes());

      mockTemplateDb.getTemplateById.mockResolvedValue(template(['slack_send_message']) as any);
      await use(visitorByClaim);
      expect(created().requireSlackApproval).toBe(true);

      mockScheduleDb.createSchedule.mockClear();
      mockTemplateDb.getTemplateById.mockResolvedValue(template([]) as any);
      await use(visitorByClaim, { requiredFunctionCalls: ['slack_send_message'] });
      expect(created().requireSlackApproval).toBe(true);

      mockScheduleDb.createSchedule.mockClear();
      await use(visitorByClaim);
      expect(created()).not.toHaveProperty('requireSlackApproval');

      for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
        mockScheduleDb.createSchedule.mockClear();
        mockTemplateDb.getTemplateById.mockResolvedValue(template(['slack_send_message']) as any);
        await use(caller);
        expect(created()).not.toHaveProperty('requireSlackApproval');
      }
    });
  });
});

describe('the "is this a visitor write?" question is asked ONCE, before anything is awaited (L1)', () => {
  /** The turn ends (its lock is released, the marker goes) while the handler is still awaiting its first dependency. */
  const turnEndsDuringFirstAwait = () =>
    (isSubscriptionFeatureEnabled as jest.Mock).mockImplementationOnce(async () => { clearShareVisitorTurn('visitor-session'); return true; });

  it('createScheduledChat', async () => {
    turnEndsDuringFirstAwait();
    await create(visitorByMarkerOnly, { startingMessage: 'Hi', requiredFunctionCalls: ['slack_send_message'] });
    expect(created().provenance).toEqual(['startingMessage', 'requiredFunctionCalls']);
    expect(created().requirePublishApproval).toBe(true);
    expect(created().requireSlackApproval).toBe(true);
  });

  it('updateScheduledChat', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    turnEndsDuringFirstAwait();
    await update(visitorByMarkerOnly, { startingMessage: 'visitor wrote this' });
    expect(updatedWith().provenanceAdd).toEqual(['startingMessage']);
    expect(mockScheduleDb.getScheduleById).toHaveBeenCalledWith('s1', { consistent: true });
    expect((mockScheduleDb.updateSchedule.mock.calls[0] as any[])[2]).toEqual({ updatedAt: stored().updatedAt });
  });

  it('submitScheduledChatVariables', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ startingMessage: 'Hello {{who}}', variables: [{ name: 'who' }], variableValues: { who: 'Alice' } }) as any);
    turnEndsDuringFirstAwait();
    await agentModeController.submitScheduledChatVariables(
      makeReq(visitorByMarkerOnly, { body: { variableValues: { who: 'Mallory' }, triggerRun: false }, params: { scheduleId: 's1' } }), makeRes());
    expect(updatedWith().provenanceAdd).toEqual(['variableValues']);
  });

  it('createScheduleFromTemplate', async () => {
    mockTemplateDb.getTemplateById.mockResolvedValue({
      templateId: 't1', createdBy: USER, visibility: 'private', name: 'T', startingMessage: 'm', variables: [], keywords: [], requiredFunctionCalls: [],
      functionCallMinCalls: {}, suggestedFrequency: 'daily', emailNotifications: [OWNER_EMAIL], llmModel: '',
    } as any);
    turnEndsDuringFirstAwait();
    await agentModeController.createScheduleFromTemplate(makeReq(visitorByMarkerOnly, { body: {}, params: { templateId: 't1' } }) as any, makeRes());
    expect(created().provenance).toEqual([...SCHEDULE_PROVENANCE_FIELDS]);
    expect(created().requirePublishApproval).toBe(true);
  });
});

describe('a visitor UPDATE lands on the version it was diffed against, or not at all (L3)', () => {
  const conditionalFailure = () => Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' });
  const errorOf = (res: any) => (res.json.mock.calls[0]?.[0] as any)?.error as string;

  it('every visitor write is conditioned on the updatedAt of the consistent read; an owner write passes no condition at all', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    await update(visitorByClaim, { keywords: ['z'] });
    expect((mockScheduleDb.updateSchedule.mock.calls[0] as any[])[2]).toEqual({ updatedAt: stored().updatedAt });

    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      mockScheduleDb.updateSchedule.mockClear();
      await update(caller, { keywords: ['z'] });
      expect(mockScheduleDb.updateSchedule.mock.calls[0]).toHaveLength(2); // (scheduleId, payload): exactly the call it always was
    }
  });

  it('a row with no updatedAt is conditioned on the attribute still being absent', async () => {
    const { updatedAt: _gone, ...legacy } = stored();
    mockScheduleDb.getScheduleById.mockResolvedValue(legacy as any);
    await update(visitorByClaim, { keywords: ['z'] });
    const expectation = (mockScheduleDb.updateSchedule.mock.calls[0] as any[])[2];
    expect(Object.prototype.hasOwnProperty.call(expectation, 'updatedAt')).toBe(true);
    expect(expectation.updatedAt).toBeUndefined();
  });

  it('STALE READ: a second writer lands between the read and the write -> 409 with a clear retry message, nothing written', async () => {
    mockScheduleDb.getScheduleById
      .mockResolvedValueOnce(stored() as any)                                             // the visitor's consistent read
      .mockResolvedValue(stored({ updatedAt: '2026-11-17T09:00:00.000Z', keywords: ['b', 'a', 'planted'] }) as any); // what is there now
    mockScheduleDb.updateSchedule.mockRejectedValue(conditionalFailure());

    const res = await update(visitorByClaim, { keywords: ['z'] });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(errorOf(res)).toContain('changed while your edit was being saved');
    expect(errorOf(res)).toContain('retry');
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
  });

  it('a re-read that fails cannot show the schedule did not move, so it is a 409 too', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValueOnce(stored() as any).mockRejectedValue(new Error('blip'));
    mockScheduleDb.updateSchedule.mockRejectedValue(conditionalFailure());
    expect((await update(visitorByClaim, { keywords: ['z'] })).status).toHaveBeenCalledWith(409);
  });

  it('a failure that is NOT the baseline (the schedule did not move) keeps its own handling: the consent retry loop, then success', async () => {
    const grantedSchedule = stored({
      requiredFunctionCalls: ['post_on_connected_account', 'publish_blog_article'],
      autopublishAuthorized: true, autopublishAuthorizedTools: ['post_on_connected_account', 'publish_blog_article'],
    });
    mockScheduleDb.getScheduleById.mockResolvedValue(grantedSchedule as any); // same updatedAt on every read: the baseline did not move
    mockScheduleDb.updateSchedule.mockRejectedValueOnce(conditionalFailure()).mockResolvedValue(undefined as any);

    const res = await update(visitorByClaim, { requiredFunctionCalls: ['post_on_connected_account'] });

    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(2);
  });

  it('the version condition rides WITH the consent-narrowing condition in the same write', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({
      requiredFunctionCalls: ['post_on_connected_account', 'publish_blog_article'],
      autopublishAuthorized: true, autopublishAuthorizedTools: ['post_on_connected_account', 'publish_blog_article'],
    }) as any);
    await update(visitorByClaim, { requiredFunctionCalls: ['post_on_connected_account'] });
    const [, payload, expectation] = mockScheduleDb.updateSchedule.mock.calls[0] as any[];
    expect(payload.autopublishAuthorizedTools).toEqual(['post_on_connected_account']);
    expect(expectation).toMatchObject({ updatedAt: stored().updatedAt, autopublishAuthorized: true });
  });

  it('an OWNER edit that loses a race keeps the existing behaviour (no new 409 path, no extra read)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    mockScheduleDb.updateSchedule.mockRejectedValue(conditionalFailure());
    const res = await update(portalOwner, { keywords: ['z'] });
    expect(errorOf(res)).not.toContain('changed while your edit was being saved');
  });
});

describe('a digest that cannot be computed omits contentVersion on that row, never failing the list (L5)', () => {
  it('one row with a pathological value loses its contentVersion; every other row keeps it, and there is no 500', async () => {
    const circular: any = {};
    circular.self = circular;
    const bad = { ...stored({ scheduleId: 'bad', variables: [circular] }), type: 'scheduled_chat', createdAt: '2026-11-17T00:00:00.000Z' };
    const good = { ...stored({ scheduleId: 'good' }), type: 'scheduled_chat', createdAt: '2026-11-16T00:00:00.000Z' };
    mockScheduleDb.getSchedulesByUserId.mockResolvedValue([bad, good] as any);

    const res = makeRes();
    await agentModeController.getScheduledChats(makeReq(portalOwner, { body: {} }) as any, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const items = res.json.mock.calls[0][0] as any[];
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.scheduleId === 'bad')).not.toHaveProperty('contentVersion');
    expect(items.find((i) => i.scheduleId === 'good').contentVersion).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('a visitor can only RAISE the publish and Slack holds, and cannot set the autonomy waiver (defence in depth)', () => {
  const given = (schedule: Record<string, unknown>) => mockScheduleDb.getScheduleById.mockResolvedValue(schedule as any);

  it('a visitor body with requirePublishApproval/requireSlackApproval false on stored-true holds drops the false: the write carries no value for them', async () => {
    given(stored({ requirePublishApproval: true, requireSlackApproval: true }));
    await update(visitorByClaim, { requirePublishApproval: false, requireSlackApproval: false, startingMessage: 'x' });
    expect(updatedWith()).not.toHaveProperty('requirePublishApproval');
    expect(updatedWith()).not.toHaveProperty('requireSlackApproval');
    expect(updatedWith().provenanceAdd).toEqual(['startingMessage']); // the rest of the edit still lands
  });

  it('a visitor body with true writes true (raising is allowed), whatever is stored', async () => {
    given(stored({ requirePublishApproval: false, requireSlackApproval: false }));
    await update(visitorByClaim, { requirePublishApproval: true, requireSlackApproval: true });
    expect(updatedWith().requirePublishApproval).toBe(true);
    expect(updatedWith().requireSlackApproval).toBe(true);
  });

  it('non-boolean junk from a visitor is not a raise and not a write', async () => {
    given(stored({ requirePublishApproval: true }));
    await update(visitorByClaim, { requirePublishApproval: 'false', requireSlackApproval: 0 });
    expect(updatedWith()).not.toHaveProperty('requirePublishApproval');
    expect(updatedWith()).not.toHaveProperty('requireSlackApproval');
  });

  it('a newly added publish tool still raises the hold when the same body said false (the add wins; never lowered)', async () => {
    given(stored({ requiredFunctionCalls: ['t1'], requirePublishApproval: false }));
    await update(visitorByClaim, { requirePublishApproval: false, requiredFunctionCalls: ['t1', 'post_on_connected_account'] });
    expect(updatedWith().requirePublishApproval).toBe(true);
  });

  it('a visitor body fullAutonomy is ignored (stored value kept, false or true); absent behaves as before', async () => {
    given(stored({ fullAutonomy: false }));
    await update(visitorByClaim, { fullAutonomy: true });
    expect(updatedWith().fullAutonomy).toBe(false);

    mockScheduleDb.updateSchedule.mockClear();
    given(stored({ fullAutonomy: true }));
    await update(visitorByClaim, { fullAutonomy: false });
    expect(updatedWith().fullAutonomy).toBe(true);

    mockScheduleDb.updateSchedule.mockClear();
    await update(visitorByClaim, { keywords: ['z'] });
    expect(updatedWith().fullAutonomy).toBe(true);
  });

  it('OWNER writes are unchanged: the false lowers a stored true, the true raises, fullAutonomy follows the body', async () => {
    for (const caller of [portalOwner, emmaInOwnersChat, delegate]) {
      mockScheduleDb.updateSchedule.mockClear();
      given(stored({ requirePublishApproval: true, requireSlackApproval: true, fullAutonomy: false }));
      await update(caller, { requirePublishApproval: false, requireSlackApproval: false, fullAutonomy: true });
      expect(updatedWith().requirePublishApproval).toBe(false);
      expect(updatedWith().requireSlackApproval).toBe(false);
      expect(updatedWith().fullAutonomy).toBe(true);
    }
    mockScheduleDb.updateSchedule.mockClear();
    given(stored());
    await update(portalOwner, { requirePublishApproval: true, requireSlackApproval: true });
    expect(updatedWith().requirePublishApproval).toBe(true);
    expect(updatedWith().requireSlackApproval).toBe(true);
  });
});
