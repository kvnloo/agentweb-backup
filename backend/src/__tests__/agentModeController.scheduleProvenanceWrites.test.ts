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
import { markShareVisitorTurn, clearShareVisitorTurn } from '../services/shareVisitorTurnMarker';
import { SCHEDULE_PROVENANCE_FIELDS } from '../utils/scheduleProvenance';

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

  it('does not track session_id, self_improve, timing, model, name or description', async () => {
    await create(visitorByClaim, { startingMessage: 'Hi', selfImprove: true, nextRunTime: '2030-01-01T09:00:00Z', timezone: 'UTC', description: 'd', runCount: 3, scheduleName: 'Renamed' });
    expect(created().provenance).toEqual(['startingMessage']);
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
  ])('tracks %s on its own', async (field, body) => {
    await update(visitorByClaim, body);
    expect(updatedWith().provenanceAdd).toEqual([field]);
  });

  it('tracks variables and variableValues (values are substituted into the run\'s prompt)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ startingMessage: 'Hello {{who}}', variables: [{ name: 'who' }] }) as any);
    await update(visitorByClaim, { variables: [{ name: 'who', description: 'a person' }], variableValues: { who: 'Mallory' } });
    expect(updatedWith().provenanceAdd).toEqual(['variables', 'variableValues']);
  });

  it('a visitor edit of only the name, timing or model marks nothing and writes no provenance at all', async () => {
    await update(visitorByClaim, { scheduleName: 'Renamed', nextRunTime: '2030-02-01T09:00:00Z', timezone: 'UTC', selfImprove: true });
    const payload = updatedWith();
    expect(payload).not.toHaveProperty('provenanceAdd');
    expect(payload).not.toHaveProperty('provenanceRemove');
  });

  it('a visitor edit marks even when it re-sends the value that was already there (it is now the last writer)', async () => {
    await update(visitorByClaim, { keywords: ['a', 'b'] });
    expect(updatedWith().provenanceAdd).toEqual(['keywords']);
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

  it('an owner\'s own submission, whatever it changes, marks nothing and unmarks nothing', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable({ provenance: ['variableValues'] }) as any);
    for (const values of [{ who: 'Alice' }, { who: 'Bob' }]) {
      mockScheduleDb.updateSchedule.mockClear();
      await submit(portalOwner, values);
      expect(updatedWith()).not.toHaveProperty('provenanceAdd');
      expect(updatedWith()).not.toHaveProperty('provenanceRemove');
    }
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

describe('templates: a visitor cannot widen a template\'s reach', () => {
  const ownTemplate = (extra: Record<string, unknown> = {}) => ({ templateId: 't1', createdBy: USER, visibility: 'private', name: 'T', startingMessage: 'm', ...extra });

  const updateTemplate = async (caller: Caller, body: Record<string, unknown>) => {
    const res = makeRes();
    await agentModeController.updateScheduleTemplate(makeReq(caller, { body, params: { templateId: 't1' } }) as any, res);
    return res;
  };
  const submitForReview = async (caller: Caller) => {
    const res = makeRes();
    await agentModeController.submitTemplateForReview(makeReq(caller, { params: { templateId: 't1' } }) as any, res);
    return res;
  };

  it('a visitor cannot change visibility (here: pull a template back from review to private), and nothing is written', async () => {
    mockTemplateDb.getTemplateById.mockResolvedValue(ownTemplate({ visibility: 'pending_review' }) as any);
    for (const caller of [visitorByClaim, markedRunByClaim, visitorByMarkerOnly]) {
      const res = await updateTemplate(caller, { visibility: 'private' });
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(mockTemplateDb.updateTemplate).not.toHaveBeenCalled();
  });

  it('the owner can make the same visibility change (unchanged)', async () => {
    mockTemplateDb.getTemplateById.mockResolvedValue(ownTemplate({ visibility: 'pending_review' }) as any);
    await updateTemplate(portalOwner, { visibility: 'private' });
    expect(mockTemplateDb.updateTemplate).toHaveBeenCalledWith('t1', expect.objectContaining({ visibility: 'private' }), expect.anything());
  });

  it('a visitor can still edit a template without touching visibility (nothing is taken away)', async () => {
    mockTemplateDb.getTemplateById.mockResolvedValue(ownTemplate() as any);
    await updateTemplate(visitorByClaim, { name: 'Renamed', startingMessage: 'new' });
    expect(mockTemplateDb.updateTemplate).toHaveBeenCalledWith('t1', expect.objectContaining({ name: 'Renamed' }), expect.anything());
  });

  it('a visitor cannot submit a template for review, and the template is not moved', async () => {
    mockTemplateDb.getTemplateById.mockResolvedValue(ownTemplate() as any);
    for (const caller of [visitorByClaim, markedRunByClaim, visitorByMarkerOnly]) {
      const res = await submitForReview(caller);
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(mockTemplateDb.updateTemplate).not.toHaveBeenCalled();
  });

  it('the owner (portal, or Emma in their own chat) still can submit for review (unchanged)', async () => {
    mockTemplateDb.getTemplateById.mockResolvedValue(ownTemplate() as any);
    await submitForReview(portalOwner);
    await submitForReview(emmaInOwnersChat);
    expect(mockTemplateDb.updateTemplate).toHaveBeenCalledTimes(2);
    expect(mockTemplateDb.updateTemplate).toHaveBeenCalledWith('t1', expect.objectContaining({ visibility: 'pending_review' }));
  });
});

describe('POST /scheduled-chats/:id/adopt-visitor-edits (the ONLY way a mark comes off)', () => {
  const VERSION = '2026-11-17T08:00:00.000Z';
  const adopt = async (caller: Caller, body: Record<string, unknown> | undefined = { expectedUpdatedAt: VERSION }, scheduleId = 's1') => {
    const res = makeRes();
    await agentModeController.adoptScheduledChatVisitorEdits(makeReq(caller, { params: { scheduleId }, body }), res);
    return res;
  };
  const markedSchedule = (extra: Record<string, unknown> = {}) => stored({ provenance: ['keywords', 'startingMessage'], ...extra });

  it('removes the WHOLE attribute from a real portal login that names the version it looked at, in one write bound to that version', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule() as any);
    const res = await adopt(portalOwner);

    expect(mockScheduleDb.getScheduleById).toHaveBeenCalledWith('s1', { consistent: true });
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    const [id, payload, expectation, shed, removals] = mockScheduleDb.updateSchedule.mock.calls[0] as any[];
    expect(id).toBe('s1');
    expect(Object.keys(payload)).toEqual(['updatedAt']);
    expect(expectation).toEqual({ updatedAt: VERSION });
    expect(shed).toBeUndefined();
    expect(removals).toEqual(['provenance']);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ adopted: true, provenance: [] }));
  });

  it('adopts a provenance value that is not a well-formed set, because the whole attribute is removed', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule({ provenance: 17 }) as any);
    const res = await adopt(portalOwner);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ adopted: true }));
    expect((mockScheduleDb.updateSchedule.mock.calls[0] as any[])[4]).toEqual(['provenance']);
  });

  it('answers 409 when the body names a STALE version (a visitor edited after the owner opened it), and writes nothing', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule({ updatedAt: '2026-11-17T09:30:00.000Z' }) as any);
    const res = await adopt(portalOwner, { expectedUpdatedAt: VERSION });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('Reopen it') });
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('answers 409 when the schedule moves between the read and the write (the write is conditioned on that version too)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule() as any);
    mockScheduleDb.updateSchedule.mockRejectedValue(Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' }));
    const res = await adopt(portalOwner);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it.each([
    ['absent', {}],
    ['empty', { expectedUpdatedAt: '' }],
    ['a number', { expectedUpdatedAt: 1731830400000 }],
    ['null', { expectedUpdatedAt: null }],
    ['an object', { expectedUpdatedAt: { v: VERSION } }],
  ])('answers 400 when expectedUpdatedAt is %s, reading and writing nothing', async (_name, body) => {
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule() as any);
    const res = await adopt(portalOwner, body as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('expectedUpdatedAt is required') });
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
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule() as any);
    const res = await adopt(caller);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockScheduleDb.getScheduleById).not.toHaveBeenCalled();
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('is 404 for a missing schedule and for someone else\'s', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(undefined as any);
    expect((await adopt(portalOwner)).status).toHaveBeenCalledWith(404);
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule({ userId: 'someone-else' }) as any);
    expect((await adopt(portalOwner)).status).toHaveBeenCalledWith(404);
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('an unmarked schedule has nothing to adopt and is not written', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    const res = await adopt(portalOwner);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ adopted: false, provenance: [] }));
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
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
