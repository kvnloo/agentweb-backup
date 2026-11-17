/**
 * ENG-2816 (step 3): who wrote a schedule's content, recorded where the schedule is written.
 *
 * A share-link visitor acts under the owner's userId. Every schedule write handler asks "is this write a visitor's?" (the self-call
 * carries a restriction claim, OR the session it names is running a share route's visitor turn) and, if so, marks the tracked
 * content fields it carries IN THE SAME WRITE. The mark comes off only on positive owner evidence: a real portal login (not a
 * self-call, not a delegate, not a visitor), for a field that is in the request AND whose new value differs from what is stored.
 * The portal posts the whole form on every save, so a routine save must lift nothing.
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

describe('updateScheduledChat: lifting (positive owner evidence only)', () => {
  const marked = (provenance: string[]) => mockScheduleDb.getScheduleById.mockResolvedValue(stored({ provenance }) as any);

  it('a ROUTINE whole-form portal save lifts nothing', async () => {
    marked(['startingMessage', 'keywords', 'requiredFunctionCalls', 'emailNotifications']);
    await update(portalOwner, { ...wholeForm(), scheduleName: 'Just a rename' });
    expect(updatedWith()).not.toHaveProperty('provenanceRemove');
    expect(updatedWith()).not.toHaveProperty('provenanceAdd');
  });

  it('a whole-form save that only reorders a list or re-cases an address lifts nothing (set equality)', async () => {
    marked(['keywords', 'requiredFunctionCalls', 'emailNotifications']);
    await update(portalOwner, { ...wholeForm(), keywords: ['b', 'a'], emailNotifications: ['OWNER@example.com'] });
    expect(updatedWith()).not.toHaveProperty('provenanceRemove');
  });

  it('a CHANGED field lifts only that field', async () => {
    marked(['startingMessage', 'keywords']);
    await update(portalOwner, { ...wholeForm(), startingMessage: 'The owner rewrote this' });
    expect(updatedWith().provenanceRemove).toEqual(['startingMessage']);
    expect(updatedWith()).not.toHaveProperty('provenanceAdd');
  });

  it.each([
    ['keywords', { keywords: ['a', 'b', 'c'] }],
    ['requiredFunctionCalls', { requiredFunctionCalls: ['t2'] }],
    ['functionCallMinCalls', { functionCallMinCalls: { t1: 9 } }],
    ['emailNotifications', { emailNotifications: ['colleague@example.com'] }],
  ])('lifts %s when the owner changes it', async (field, body) => {
    marked(['startingMessage', field]);
    await update(portalOwner, { ...wholeForm(), ...body });
    expect(updatedWith().provenanceRemove).toEqual([field]);
  });

  it('lifts variables and variableValues when the owner changes them', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(
      stored({ startingMessage: 'Hello {{who}}', variables: [{ name: 'who', description: '' }], variableValues: { who: 'Mallory' }, provenance: ['variables', 'variableValues'] }) as any
    );
    await update(portalOwner, { startingMessage: 'Hello {{who}}', variables: [{ name: 'who', description: 'the person to greet' }], variableValues: { who: 'Alice' } });
    expect(updatedWith().provenanceRemove).toEqual(['variables', 'variableValues']);
  });

  it('never lifts a mark that is not there (nothing to remove is not a write of provenance)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    await update(portalOwner, { ...wholeForm(), startingMessage: 'changed' });
    expect(updatedWith()).not.toHaveProperty('provenanceRemove');
  });

  it.each([
    ['Emma in the owner\'s own chat (a self-call)', emmaInOwnersChat],
    ['a delegated admin', delegate],
    ['a visitor', visitorByClaim],
    ['a marked run', markedRunByClaim],
    ['a visitor by session marker only', visitorByMarkerOnly],
  ])('%s never lifts, whatever it changes', async (_name, caller) => {
    marked(['startingMessage', 'keywords']);
    await update(caller, { ...wholeForm(), startingMessage: 'changed', keywords: ['changed'] });
    expect(updatedWith()).not.toHaveProperty('provenanceRemove');
  });

  it('a self-call and a delegate that EDIT an unmarked schedule leave it unmarked', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    for (const caller of [emmaInOwnersChat, delegate]) {
      mockScheduleDb.updateSchedule.mockClear();
      await update(caller, { startingMessage: 'x' });
      expect(updatedWith()).not.toHaveProperty('provenanceAdd');
    }
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

  it('an owner\'s own portal submission that CHANGES the values lifts the mark; the same values lift nothing', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(withVariable({ provenance: ['variableValues'] }) as any);
    await submit(portalOwner, { who: 'Alice' });
    expect(updatedWith()).not.toHaveProperty('provenanceRemove');

    mockScheduleDb.updateSchedule.mockClear();
    await submit(portalOwner, { who: 'Bob' });
    expect(updatedWith().provenanceRemove).toEqual(['variableValues']);
  });

  it('Emma in the owner\'s chat, and a delegate, mark nothing and lift nothing', async () => {
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

describe('POST /scheduled-chats/:id/adopt-visitor-edits', () => {
  const adopt = async (caller: Caller, scheduleId = 's1') => {
    const res = makeRes();
    await agentModeController.adoptScheduledChatVisitorEdits(makeReq(caller, { params: { scheduleId } }), res);
    return res;
  };
  const markedSchedule = () => stored({ provenance: ['keywords', 'startingMessage'] });

  it('removes the WHOLE set, bound to the version the owner read, from a real portal login', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule() as any);
    const res = await adopt(portalOwner);

    expect(mockScheduleDb.getScheduleById).toHaveBeenCalledWith('s1', { consistent: true });
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    const [id, payload, expectation] = mockScheduleDb.updateSchedule.mock.calls[0] as any[];
    expect(id).toBe('s1');
    expect(payload.provenanceRemove).toEqual(['keywords', 'startingMessage']);
    expect(payload).not.toHaveProperty('provenanceAdd');
    expect(expectation).toEqual({ updatedAt: '2026-11-17T08:00:00.000Z' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ adopted: true, provenance: [] }));
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
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ userId: 'someone-else', provenance: ['keywords'] }) as any);
    expect((await adopt(portalOwner)).status).toHaveBeenCalledWith(404);
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('an unmarked schedule has nothing to adopt and is not written', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    const res = await adopt(portalOwner);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ adopted: false, provenance: [] }));
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('answers 409 when the schedule changed since it was read (a visitor edit in between is not adopted unseen)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(markedSchedule() as any);
    mockScheduleDb.updateSchedule.mockRejectedValue(Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' }));
    const res = await adopt(portalOwner);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('GET /scheduled-chats (what list_scheduled_chats and the portal read)', () => {
  const list = async () => {
    const res = makeRes();
    await agentModeController.getScheduledChats(makeReq(portalOwner, { body: {} }) as any, res);
    return res.json.mock.calls[0][0] as any[];
  };

  it('shows a marked schedule\'s provenance as an array, so Emma and the owner can see why it is restricted', async () => {
    mockScheduleDb.getSchedulesByUserId.mockResolvedValue([
      { ...stored({ provenance: ['keywords', 'startingMessage'] }), type: 'scheduled_chat', createdAt: '2026-11-17T00:00:00.000Z' },
    ] as any);
    const [item] = await list();
    expect(item.provenance).toEqual(['keywords', 'startingMessage']);
    expect(Array.isArray(item.provenance)).toBe(true);
  });

  it('adds nothing to an unmarked schedule', async () => {
    mockScheduleDb.getSchedulesByUserId.mockResolvedValue([{ ...stored(), type: 'scheduled_chat', createdAt: '2026-11-17T00:00:00.000Z' }] as any);
    const [item] = await list();
    expect(item).not.toHaveProperty('provenance');
  });
});
