/**
 * ENG-2840 (W2-7): PUT/PATCH /lists/:listId/leads/:leadId takes an optional `statusNote` for the auto `status.changed` event.
 * It is taken out of the body before anything else reads it (never stored on the lead, never seen by the write guard), validated (400),
 * stored as the event's `notes` only when the status really changes, and answered as `statusNoteRecorded`.
 * Setup mirrors crm.leadPutGuard.test.ts; the write guard is the real one, wrapped so the body it receives can be inspected.
 */
jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));
jest.mock('../controllers/templates', () => ({
  createTemplate: jest.fn(), getTemplates: jest.fn(), getTemplate: jest.fn(), updateTemplate: jest.fn(), deleteTemplate: jest.fn(), publishTemplate: jest.fn(),
}));
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadById: jest.fn(),
    createLead: jest.fn(),
    updateLead: jest.fn(),
    addLeadEngagement: jest.fn(),
    getLeadEngagementCount: jest.fn(),
  },
  taskDb: { getTaskById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: {} }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn() }));
jest.mock('../services/settingsService', () => ({ settingsService: {} }));
jest.mock('../services/resendService', () => ({ resendService: {} }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));
jest.mock('../services/contactDedupService', () => ({ dedupContactsForUser: jest.fn() }));
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../services/enrichSoLeadValidation', () => ({
  validateLeadEmailInBackground: jest.fn().mockResolvedValue(undefined),
  validateLeadsInBackground: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

/** The keys of every body the write guard received, captured at call time. */
const mockGuardSaw: string[][] = [];
jest.mock('../utils/leadWriteGuard', () => {
  const actual = jest.requireActual('../utils/leadWriteGuard');
  return {
    ...actual,
    guardLeadPutBody: (body: any, opts: any) => {
      mockGuardSaw.push(Object.keys(body ?? {}));
      return actual.guardLeadPutBody(body, opts);
    },
  };
});

import router from '../routes/crm';
import { crmDb, userDb } from '../services/db';

const asMock = (fn: any) => fn as jest.Mock;
const LIST = { listId: 'list1', userId: 'test-user-id' };
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

const findHandler = (method: 'put' | 'patch') => {
  const layer = (router as any).stack.find((r: any) => r.route?.path === '/lists/:listId/leads/:leadId' && r.route?.methods?.[method]);
  const handle = layer.route.stack[layer.route.stack.length - 1].handle;
  return (req: any, res: any) => handle(req, res, jest.fn());
};

const call = async (body: any, method: 'put' | 'patch' = 'put') => {
  const req: any = { params: { listId: 'list1', leadId: 'lead1' }, body, user: { userId: 'test-user-id' }, headers: {} };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await findHandler(method)(req, res);
  const statusCode = res.status.mock.calls.at(-1)?.[0] ?? 200;
  return { req, res, statusCode, answer: res.json.mock.calls.at(-1)?.[0] };
};

const sentToDb = () => asMock(crmDb.updateLead).mock.calls.at(-1)?.[2];
const statusEvents = () => asMock(crmDb.addLeadEngagement).mock.calls.filter((c) => c[2]?.eventType === 'status.changed');

beforeEach(() => {
  jest.clearAllMocks();
  mockGuardSaw.length = 0;
  delete process.env.CRM_LEAD_PUT_GUARD;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  asMock(crmDb.getLeadListById).mockResolvedValue(LIST);
  asMock(crmDb.getLeadById).mockResolvedValue({ leadId: 'lead1', status: 'new', contactStatus: 'active', notes: 'the lead\'s own notes' });
  asMock(crmDb.updateLead).mockImplementation(async (_l: string, id: string, u: any) => ({ leadId: id, ...u }));
  asMock(crmDb.addLeadEngagement).mockResolvedValue({});
});
afterEach(() => jest.restoreAllMocks());

describe('a status change with a statusNote', () => {
  it('stores the trimmed note as the status.changed event\'s notes and answers statusNoteRecorded: true', async () => {
    const { statusCode, answer } = await call({ status: 'qualified', statusNote: '  Spoke to the CFO, budget approved  ' });
    expect(statusCode).toBe(200);
    expect(statusEvents()).toHaveLength(1);
    expect(statusEvents()[0][2].eventData).toStrictEqual({
      from: 'new', to: 'qualified', dealValue: null, dealCurrency: 'USD', notes: 'Spoke to the CFO, budget approved',
    });
    expect(answer.statusNoteRecorded).toBe(true);
  });

  it('never reaches updateLead or the write guard, and is not stored as the lead\'s own notes', async () => {
    await call({ status: 'qualified', statusNote: 'reason' });
    expect(sentToDb()).toBeDefined();
    expect('statusNote' in sentToDb()).toBe(false);
    expect(sentToDb().notes).toBeUndefined();
    expect(mockGuardSaw).toHaveLength(1);
    expect(mockGuardSaw[0]).not.toContain('statusNote');
  });

  it('keeps line breaks and tabs inside the note', async () => {
    const note = `line one${NL}line two${TAB}tabbed`;
    const { answer } = await call({ status: 'won', statusNote: note });
    expect(statusEvents()[0][2].eventData.notes).toBe(note);
    expect(answer.statusNoteRecorded).toBe(true);
  });

  it('a 500-character note is accepted', async () => {
    const { statusCode } = await call({ status: 'won', statusNote: 'n'.repeat(500) });
    expect(statusCode).toBe(200);
    expect(statusEvents()[0][2].eventData.notes).toHaveLength(500);
  });

  it('works on PATCH too (same handler)', async () => {
    const { answer } = await call({ status: 'qualified', statusNote: 'via patch' }, 'patch');
    expect(statusEvents()[0][2].eventData.notes).toBe('via patch');
    expect(answer.statusNoteRecorded).toBe(true);
    expect('statusNote' in sentToDb()).toBe(false);
  });

  it('a leading/trailing whitespace-only difference in the note does not survive (stored trimmed)', async () => {
    await call({ status: 'qualified', statusNote: `${NL}${TAB}  note  ${NL}` });
    expect(statusEvents()[0][2].eventData.notes).toBe('note');
  });
});

describe('a statusNote when the status does not change', () => {
  it('writes no event and answers statusNoteRecorded: false; the note is not stored anywhere', async () => {
    const { statusCode, answer } = await call({ status: 'new', statusNote: 'no change really' });
    expect(statusCode).toBe(200);
    expect(statusEvents()).toHaveLength(0);
    expect(answer.statusNoteRecorded).toBe(false);
    expect('statusNote' in sentToDb()).toBe(false);
    expect(JSON.stringify(sentToDb())).not.toContain('no change really');
  });
});

describe('a request without statusNote is unchanged', () => {
  it('has no statusNoteRecorded key and the event shape has no notes', async () => {
    const { answer } = await call({ status: 'qualified' });
    expect(answer).toBeDefined();
    expect('statusNoteRecorded' in answer).toBe(false);
    expect(statusEvents()[0][2].eventData).toStrictEqual({ from: 'new', to: 'qualified', dealValue: null, dealCurrency: 'USD' });
  });

  it('an unchanged status without a note: no key, no event', async () => {
    const { answer } = await call({ status: 'new' });
    expect('statusNoteRecorded' in answer).toBe(false);
    expect(statusEvents()).toHaveLength(0);
  });

  it('a non-status update without a note: no key', async () => {
    const { answer } = await call({ company: 'Acme' });
    expect('statusNoteRecorded' in answer).toBe(false);
  });

  it('statusNote: null is dropped from the body and treated as absent', async () => {
    const { answer, statusCode } = await call({ status: 'qualified', statusNote: null });
    expect(statusCode).toBe(200);
    expect('statusNote' in sentToDb()).toBe(false);
    expect(mockGuardSaw[0]).not.toContain('statusNote');
    expect('notes' in statusEvents()[0][2].eventData).toBe(false);
    expect('statusNoteRecorded' in answer).toBe(false);
  });
});

describe('an invalid statusNote is a 400 and nothing is written', () => {
  const ctl = (code: number) => `before${String.fromCharCode(code)}after`;
  it.each([
    ['a number', 42],
    ['an object', { text: 'x' }],
    ['an array', ['x']],
    ['true', true],
    ['empty', ''],
    ['whitespace only', '   '],
    ['501 characters', 'n'.repeat(501)],
    ['a NUL', ctl(0x00)],
    ['a bell', ctl(0x07)],
    ['a carriage return', ctl(0x0d)],
    ['an escape', ctl(0x1b)],
    ['a DEL', ctl(0x7f)],
    ['a C1 control (NEL)', ctl(0x85)],
  ])('%s', async (_label, statusNote) => {
    const { statusCode, answer } = await call({ status: 'qualified', statusNote });
    expect(statusCode).toBe(400);
    expect(typeof answer.message).toBe('string');
    expect(crmDb.updateLead).not.toHaveBeenCalled();
    expect(crmDb.addLeadEngagement).not.toHaveBeenCalled();
    expect(mockGuardSaw).toHaveLength(0);
  });

  // Checked on the note as sent: trim would remove CR / VT / FF at the edges and hide them.
  it('a note ending in a carriage return is refused', async () => {
    const { statusCode } = await call({ status: 'qualified', statusNote: `note${String.fromCharCode(0x0d)}` });
    expect(statusCode).toBe(400);
  });

  it('statusNote without status in the body', async () => {
    const { statusCode, answer } = await call({ company: 'Acme', statusNote: 'why' });
    expect(statusCode).toBe(400);
    expect(answer.message).toMatch(/status/);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
    expect(crmDb.addLeadEngagement).not.toHaveBeenCalled();
  });

  it('statusNote alone', async () => {
    const { statusCode } = await call({ statusNote: 'why' });
    expect(statusCode).toBe(400);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
  });
});

describe('access is checked before the note', () => {
  it('a caller who cannot edit the list gets 403 and nothing is written', async () => {
    asMock(crmDb.getLeadListById).mockResolvedValue({ listId: 'list1', userId: 'other-owner' });
    asMock(userDb.getUserById).mockImplementation(async (id: string) => ({ userId: id, orgId: id === 'other-owner' ? 'org-b' : 'org-a' }));
    const { statusCode } = await call({ status: 'qualified', statusNote: 'x' });
    expect(statusCode).toBe(403);
    expect(crmDb.updateLead).not.toHaveBeenCalled();
    expect(crmDb.addLeadEngagement).not.toHaveBeenCalled();
  });
});
