/**
 * ENG-2840 (W2-10): `POST /api/emma/lead-email-draft` (routes/emmaLeadDraftRoutes.ts). The body is checked by name and value; access is
 * checked first (a list the caller cannot read answers like a missing one); Emma's own tool runs through her registry with
 * `{ userId: req.user.userId }` only; the answer is built from fixed fields and Emma's raw error never leaves.
 */
import express, { Router } from 'express';
import request from 'supertest';

const mockExecute = jest.fn();
jest.mock('../emma/registry', () => ({ emmaToolRegistry: { execute: (...args: unknown[]) => mockExecute(...args) } }));
jest.mock('../emma/tools', () => ({}));
const mockGetList = jest.fn();
jest.mock('../services/db', () => ({ crmDb: { getLeadListById: (...a: unknown[]) => mockGetList(...a) } }));
const mockCanAccess = jest.fn();
const mockCanEdit = jest.fn();
jest.mock('../services/crmAccessControl', () => ({
  canAccessCrmList: (...a: unknown[]) => mockCanAccess(...a),
  canDestructiveCrmList: (...a: unknown[]) => mockCanEdit(...a),
  CRM_EDITOR_REQUIRED_MESSAGE: 'Only an editor can change this list',
}));

import { registerLeadDraftRoutes, checkLeadDraftArgs, MAX_DRAFT_CHARS } from '../routes/emmaLeadDraftRoutes';
import { EvaluationDenied } from '../services/evaluationPolicy';

const router = Router();
router.use((req: any, _res: any, next: any) => {
  req.user = { userId: 'caller-1', email: 'caller@example.com', isAdmin: true };
  req.delegateInfo = { adminUserId: 'admin-9', isDelegated: true };
  next();
});
registerLeadDraftRoutes(router);
const app = express();
app.use(express.json());
app.use('/api/emma', router);
const post = (body: unknown) => request(app).post('/api/emma/lead-email-draft').send(body as any);

const VALID = { list_id: 'list-1', lead_id: 'lead-1', instruction: 'Follow up on their demo request' };
const OK_RESULT = {
  success: true,
  message: 'Email draft created successfully',
  data: { email: { subject: 'Hello', textContent: 'Hi Ann' }, message: { content: 'Hi Ann, let us connect' } },
  error: 'should never leave',
  sessionId: 'should never leave',
};

beforeEach(() => {
  mockExecute.mockReset();
  mockGetList.mockReset().mockResolvedValue({ listId: 'list-1', userId: 'caller-1' });
  mockCanAccess.mockReset().mockResolvedValue(true);
  mockCanEdit.mockReset().mockResolvedValue(true);
});

describe('arguments', () => {
  it.each([
    [{ ...VALID, userId: 'victim' }, /not accepted/],
    [{ ...VALID, session_id: 's' }, /not accepted/],
    [{ ...VALID, list_id: '' }, /list_id is required/],
    [{ ...VALID, lead_id: ' lead-1' }, /lead_id is not a valid id/],
    [{ ...VALID, lead_id: 'x'.repeat(201) }, /lead_id is not a valid id/],
    [{ ...VALID, instruction: '   ' }, /instruction is required/],
    [{ ...VALID, instruction: 'x'.repeat(2001) }, /at most 2000/],
    [{ ...VALID, instruction: `hi${String.fromCharCode(0)}there` }, /control or invisible/],
    [{ ...VALID, instruction: `hi${String.fromCharCode(0x202e)}there` }, /control or invisible/],
    [{ ...VALID, email_format: 'markdown' }, /email_format/],
  ])('refuses %j with 400 and calls nothing', async (body, message) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(mockGetList).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('keeps line breaks and tabs in an instruction', () => {
    const checked = checkLeadDraftArgs({ ...VALID, instruction: 'Line one\n\tLine two' });
    expect(checked.ok).toBe(true);
  });
});

describe('access, before Emma runs', () => {
  it('answers a list the caller cannot read exactly like a missing one (404)', async () => {
    mockCanAccess.mockResolvedValue(false);
    const foreign = await post(VALID);
    mockGetList.mockResolvedValue(null);
    const missing = await post(VALID);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('tells a member who may read but not edit the list that editing needs an editor (403)', async () => {
    mockCanEdit.mockResolvedValue(false);
    const res = await post(VALID);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Only an editor can change this list');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('checks access as req.user.userId', async () => {
    mockExecute.mockResolvedValue(OK_RESULT);
    await post(VALID);
    expect(mockCanAccess).toHaveBeenCalledWith('caller-1', expect.anything());
    expect(mockCanEdit).toHaveBeenCalledWith('caller-1', expect.anything());
  });
});

describe('running Emma', () => {
  it('runs Emma\'s tool with the checked arguments and { userId } only (no session, no delegate)', async () => {
    mockExecute.mockResolvedValue(OK_RESULT);
    const res = await post({ ...VALID, email_format: 'text' });
    expect(res.status).toBe(200);
    const [name, args, context] = mockExecute.mock.calls[0];
    expect(name).toBe('update_email_draft_for_lead');
    expect(args).toStrictEqual({ ...VALID, email_format: 'text' });
    expect(context).toStrictEqual({ userId: 'caller-1' });
  });

  it('answers from fixed fields only', async () => {
    mockExecute.mockResolvedValue(OK_RESULT);
    const res = await post(VALID);
    expect(res.body).toStrictEqual({
      success: true,
      email: { subject: 'Hello', format: 'text', text: 'Hi Ann' },
      linkedin_note: 'Hi Ann, let us connect',
    });
  });

  it('returns an html draft as html and cuts a huge body', async () => {
    mockExecute.mockResolvedValue({ success: true, data: { email: { subject: 'S', htmlContent: 'x'.repeat(MAX_DRAFT_CHARS + 10) }, message: null } });
    const res = await post({ ...VALID, email_format: 'html' });
    expect(res.body.email.format).toBe('html');
    expect(res.body.email.html.length).toBeLessThan(MAX_DRAFT_CHARS + 60);
    expect(res.body.email.html).toMatch(/cut at 50000 characters/);
    expect(res.body.linkedin_note).toBeNull();
  });

  it('passes on a skipped run as skipped', async () => {
    mockExecute.mockResolvedValue({ success: true, skipped: true, reason: 'nothing_generated', data: { email: null, message: null } });
    const res = await post(VALID);
    expect(res.body).toStrictEqual({ success: true, email: null, linkedin_note: null, skipped: true, reason: 'nothing_generated' });
  });

  it.each([
    ['Do not contact', 200, /do-not-contact/],
    ['No contact channel', 200, /no email address and no LinkedIn/],
    ['Lead not found', 404, /Lead not found in this list/],
    ['Access denied', 404, /^Lead list not found$/],
    ['Failed to create/update email draft', 500, /could not be written/],
  ])('maps Emma\'s "%s" to a fixed answer (%i) without her raw error', async (message, status, text) => {
    mockExecute.mockResolvedValue({ success: false, message, error: 'raw provider detail sk-123' });
    const res = await post(VALID);
    expect(res.status).toBe(status);
    expect(res.body.message).toMatch(text);
    expect(JSON.stringify(res.body)).not.toMatch(/raw provider detail|sk-123/);
  });

  it('refuses a sandbox workspace (403) and hides other failures behind a fixed text (500)', async () => {
    mockExecute.mockRejectedValueOnce(new EvaluationDenied());
    expect((await post(VALID)).status).toBe(403);
    mockExecute.mockRejectedValueOnce(new Error('dynamo exploded with secret'));
    const res = await post(VALID);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('The draft could not be written. Try again later.');
  });
});
