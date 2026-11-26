/**
 * ENG-2840 (W2-7): the two /api/emma routes behind the MCP tools read_file_content and add_lead_engagement.
 *  - POST /read-file: own_storage_only / max_bytes are validated (400 on a bad value, never a silent "no limit") and passed to readFileContent.
 *  - POST /add-lead-engagement: body validated, then Emma's handler is called as the authenticated caller with the outside-agent limits.
 * Setup follows emmaApi.leadReadback.test.ts.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'caller-1', email: 'qa-user@agentweb.pro', isAdmin: false };
    next();
  },
  AuthenticatedRequest: jest.fn(),
}));
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({ allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-11' }),
}));

const mockService = {
  readFileContent: jest.fn(),
  addLeadEngagement: jest.fn(),
};
jest.mock('../services/agentModeService', () => ({ agentModeService: mockService }));

import emmaApiRouter from '../routes/emmaApi';
import { classifyEmmaRoute, EMMA_ROUTE_BUDGET } from '../middleware/emmaTokenBudget';

const app = express();
app.use(express.json());
app.use('/api/emma', emmaApiRouter);

const FILE = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/caller-1/files/a.txt';
const MAX = 52428800;

beforeEach(() => {
  mockService.readFileContent.mockReset();
  mockService.addLeadEngagement.mockReset();
});

describe('POST /api/emma/read-file limits', () => {
  const post = (body: Record<string, unknown>) => {
    mockService.readFileContent.mockResolvedValueOnce({ success: true, content: 'x' });
    return request(app).post('/api/emma/read-file').send({ file_url: FILE, ...body });
  };
  const lastCaller = () => mockService.readFileContent.mock.calls.at(-1)?.[1];

  it('absent fields: called with { userId } only (Emma\'s read, unchanged)', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, content: 'x' });
    expect(mockService.readFileContent).toHaveBeenCalledWith(FILE, expect.anything());
    expect(lastCaller()).toStrictEqual({ userId: 'caller-1' });
  });

  it('null fields: called with { userId } only', async () => {
    await post({ own_storage_only: null, max_bytes: null });
    expect(lastCaller()).toStrictEqual({ userId: 'caller-1' });
  });

  it('own_storage_only: true and a valid max_bytes are passed on as ownStorageOnly / maxBytes', async () => {
    await post({ own_storage_only: true, max_bytes: 10 * 1024 * 1024 });
    expect(lastCaller()).toStrictEqual({ userId: 'caller-1', ownStorageOnly: true, maxBytes: 10 * 1024 * 1024 });
  });

  it('each field alone is passed on alone', async () => {
    await post({ own_storage_only: true });
    expect(lastCaller()).toStrictEqual({ userId: 'caller-1', ownStorageOnly: true });
    await post({ max_bytes: 1 });
    expect(lastCaller()).toStrictEqual({ userId: 'caller-1', maxBytes: 1 });
    await post({ max_bytes: MAX });
    expect(lastCaller()).toStrictEqual({ userId: 'caller-1', maxBytes: MAX });
  });

  it('an identity in the body changes nothing', async () => {
    await post({ own_storage_only: true, userId: 'someone-else', user_id: 'someone-else' });
    expect(lastCaller()).toStrictEqual({ userId: 'caller-1', ownStorageOnly: true });
  });

  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['an object', { on: true }],
    ['an empty string', ''],
  ])('own_storage_only as %s is a 400 and reads nothing', async (_label, value) => {
    const res = await request(app).post('/api/emma/read-file').send({ file_url: FILE, own_storage_only: value });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('own_storage_only must be true or false');
    expect(mockService.readFileContent).not.toHaveBeenCalled();
  });

  it.each([
    ['0', 0],
    ['a negative number', -5],
    ['a fraction', 1.5],
    ['one over 50 MB', MAX + 1],
    ['a numeric string', '1024'],
    ['true', true],
    ['an empty string', ''],
    ['an array', [1024]],
  ])('max_bytes as %s is a 400 and reads nothing', async (_label, value) => {
    const res = await request(app).post('/api/emma/read-file').send({ file_url: FILE, own_storage_only: true, max_bytes: value });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toMatch(/^max_bytes must be/);
    expect(mockService.readFileContent).not.toHaveBeenCalled();
  });

  it('a thrown service error is a 500', async () => {
    mockService.readFileContent.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/emma/read-file').send({ file_url: FILE });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/emma/add-lead-engagement', () => {
  const LIMITS = { channel: 'mcp', maxChannelEvents: 50, maxLeadBytes: 300000 };
  const VALID = { list_id: 'list-1', lead_id: 'lead-1', event_type: 'custom.phone_call' };
  const send = (body: unknown) => request(app).post('/api/emma/add-lead-engagement').send(body as any);

  it('calls Emma\'s handler as the caller with the outside-agent limits and returns its answer as JSON', async () => {
    const answer = { success: true, recorded: true, eventType: 'custom.phone_call', leadName: 'Ann Lee' };
    mockService.addLeadEngagement.mockResolvedValueOnce(answer);
    const res = await send({
      ...VALID, event_data: { outcome: 'booked' }, event_date: '2026-11-20T10:00:00.000Z', idempotency_key: 'call-2026-11-20_A',
      userId: 'someone-else', user_id: 'someone-else',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(answer);
    expect(mockService.addLeadEngagement).toHaveBeenCalledTimes(1);
    const args = mockService.addLeadEngagement.mock.calls[0];
    expect(args).toHaveLength(7);
    expect(args.slice(0, 6)).toEqual(['list-1', 'lead-1', 'custom.phone_call', 'caller-1', { outcome: 'booked' }, '2026-11-20T10:00:00.000Z']);
    expect(args[6]).toStrictEqual({ ...LIMITS, idempotencyKey: 'call-2026-11-20_A' });
  });

  it('without optional fields: event_data and event_date are undefined and no idempotencyKey is passed', async () => {
    mockService.addLeadEngagement.mockResolvedValueOnce({ success: true });
    const res = await send(VALID);
    expect(res.status).toBe(200);
    const args = mockService.addLeadEngagement.mock.calls[0];
    expect(args[4]).toBeUndefined();
    expect(args[5]).toBeUndefined();
    expect(args[6]).toStrictEqual(LIMITS);
  });

  it('null optional fields are treated as absent', async () => {
    mockService.addLeadEngagement.mockResolvedValueOnce({ success: true });
    await send({ ...VALID, event_data: null, event_date: null, idempotency_key: null });
    const args = mockService.addLeadEngagement.mock.calls[0];
    expect(args[4]).toBeUndefined();
    expect(args[5]).toBeUndefined();
    expect(args[6]).toStrictEqual(LIMITS);
  });

  it('a refusal from the handler ({ success: false }) is passed through as HTTP 200', async () => {
    mockService.addLeadEngagement.mockResolvedValueOnce({ success: false, message: 'Access denied' });
    const res = await send(VALID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false, message: 'Access denied' });
  });

  it('a thrown handler error is a 500', async () => {
    mockService.addLeadEngagement.mockRejectedValueOnce(new Error('db down'));
    const res = await send(VALID);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('db down');
  });

  it.each([
    ['list_id missing', { lead_id: 'lead-1', event_type: 'custom.x' }],
    ['lead_id missing', { list_id: 'list-1', event_type: 'custom.x' }],
    ['list_id empty', { ...VALID, list_id: '' }],
    ['lead_id blank', { ...VALID, lead_id: '   ' }],
    ['list_id a number', { ...VALID, list_id: 7 }],
    ['event_type missing', { list_id: 'list-1', lead_id: 'lead-1' }],
    ['event_type empty', { ...VALID, event_type: '' }],
    ['event_type blank', { ...VALID, event_type: '   ' }],
    ['event_type a number', { ...VALID, event_type: 3 }],
    ['event_data an array', { ...VALID, event_data: [{ a: 1 }] }],
    ['event_data a string', { ...VALID, event_data: 'note' }],
    ['event_data a number', { ...VALID, event_data: 5 }],
    ['event_data true', { ...VALID, event_data: true }],
    ['event_date a number', { ...VALID, event_date: 1732000000000 }],
    ['event_date an object', { ...VALID, event_date: { at: 'now' } }],
    ['idempotency_key too short (7)', { ...VALID, idempotency_key: 'abcdefg' }],
    ['idempotency_key too long (65)', { ...VALID, idempotency_key: 'a'.repeat(65) }],
    ['idempotency_key with a space', { ...VALID, idempotency_key: 'abc defgh' }],
    ['idempotency_key with a dot', { ...VALID, idempotency_key: 'abc.defgh' }],
    ['idempotency_key a number', { ...VALID, idempotency_key: 123456789 }],
    ['idempotency_key empty', { ...VALID, idempotency_key: '' }],
    ['idempotency_key with a trailing newline', { ...VALID, idempotency_key: `abcdefgh${String.fromCharCode(10)}` }],
  ])('400 when %s, and the handler is not called', async (_label, body) => {
    const res = await send(body);
    expect(res.status).toBe(400);
    expect(typeof res.body.message).toBe('string');
    expect(mockService.addLeadEngagement).not.toHaveBeenCalled();
  });

  it.each([
    ['8 characters', 'abcd-_12'],
    ['64 characters', 'A'.repeat(64)],
  ])('an idempotency_key of %s is accepted and passed on', async (_label, key) => {
    mockService.addLeadEngagement.mockResolvedValueOnce({ success: true });
    const res = await send({ ...VALID, idempotency_key: key });
    expect(res.status).toBe(200);
    expect(mockService.addLeadEngagement.mock.calls[0][6]).toStrictEqual({ ...LIMITS, idempotencyKey: key });
  });

  it('is classified as a metered route', () => {
    expect(EMMA_ROUTE_BUDGET['POST /add-lead-engagement']).toBe('metered');
    expect(classifyEmmaRoute('POST', '/add-lead-engagement')).toBe('metered');
  });
});
