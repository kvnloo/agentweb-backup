/**
 * ENG-2840 (W2-7): emma/impl/leads.addLeadEngagement with the outside-agent limits (MCP add_lead_engagement), and without them (Emma, unchanged).
 * crmDb is mocked (as in agentModeService.crmTools.test.ts); the list access check is the real crmAccessControl.
 */
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadById: jest.fn(),
    addLeadEngagement: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

import { crmDb, userDb } from '../services/db';
import { addLeadEngagement, type AgentEngagementLimits } from '../emma/impl/leads';

const db = crmDb as unknown as { getLeadListById: jest.Mock; getLeadById: jest.Mock; addLeadEngagement: jest.Mock };
const users = userDb as unknown as { getUserById: jest.Mock };

const LIST = { listId: 'L1', userId: 'u1' };
const UPDATED_AT = '2026-11-20T10:00:00.000Z';
const baseLead = (extra: Record<string, unknown> = {}) => ({
  listId: 'L1', leadId: 'LD1', firstName: 'Ann', lastName: 'Lee', status: 'new', updatedAt: UPDATED_AT, engagements: [], ...extra,
});
const LIMITS: AgentEngagementLimits = { channel: 'mcp', maxChannelEvents: 50, maxLeadBytes: 300_000 };
const KEY = 'call-2026-11-20_A';
const preconditionFailed = () => Object.assign(new Error('Lead engagement precondition failed'), { preconditionFailed: true });
const mcpEvents = (n: number, channel = 'mcp') =>
  Array.from({ length: n }, (_, i) => ({ eventId: `e${i}`, eventType: 'custom.x', eventData: { channel }, createdAt: UPDATED_AT }));

beforeEach(() => {
  db.getLeadListById.mockReset();
  db.getLeadById.mockReset();
  db.addLeadEngagement.mockReset();
  users.getUserById.mockReset();
  db.getLeadListById.mockResolvedValueOnce(LIST);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('without agentLimits (Emma): unchanged', () => {
  it('reads the lead without options and appends the caller\'s data as given, with no CAS option', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead());
    db.addLeadEngagement.mockResolvedValueOnce({});
    const result = await addLeadEngagement('L1', 'LD1', 'custom.phone_call', 'u1', { outcome: 'booked' }, '2026-11-19T09:00:00.000Z');
    expect(result).toEqual({ success: true, message: 'Engagement "custom.phone_call" recorded for Ann Lee', eventType: 'custom.phone_call', leadName: 'Ann Lee' });
    expect(db.getLeadById).toHaveBeenCalledTimes(1);
    expect(db.getLeadById.mock.calls[0][2]).toBeUndefined();
    expect(db.addLeadEngagement).toHaveBeenCalledTimes(1);
    const call = db.addLeadEngagement.mock.calls[0];
    expect(call).toHaveLength(3);
    expect(call[2]).toStrictEqual({ eventType: 'custom.phone_call', eventData: { outcome: 'booked' }, createdAt: '2026-11-19T09:00:00.000Z' });
  });

  it('has no per-lead cap and no duplicate check', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead({ engagements: [...mcpEvents(60), { eventData: { idempotencyKey: KEY } }] }));
    db.addLeadEngagement.mockResolvedValueOnce({});
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', { idempotencyKey: KEY });
    expect(result.success).toBe(true);
    expect(db.addLeadEngagement).toHaveBeenCalledTimes(1);
  });
});

describe('list access is checked first, as before', () => {
  it('a missing list: "Lead list not found", the lead is never read', async () => {
    db.getLeadListById.mockReset();
    db.getLeadListById.mockResolvedValueOnce(null);
    const result = await addLeadEngagement('L1', 'LD1', 'custom.x', 'u1', undefined, undefined, LIMITS);
    expect(result).toMatchObject({ success: false, message: 'Lead list not found' });
    expect(db.getLeadById).not.toHaveBeenCalled();
    expect(db.addLeadEngagement).not.toHaveBeenCalled();
  });

  it('another tenant\'s list: "Access denied", the lead is never read or written', async () => {
    users.getUserById.mockImplementation(async (id: string) => ({ userId: id, orgId: id === 'u1' ? 'org-a' : 'org-b' }));
    const result = await addLeadEngagement('L1', 'LD1', 'custom.x', 'intruder', { a: 1 }, undefined, { ...LIMITS, idempotencyKey: KEY });
    expect(result).toMatchObject({ success: false, message: 'Access denied' });
    expect(db.getLeadById).not.toHaveBeenCalled();
    expect(db.addLeadEngagement).not.toHaveBeenCalled();
  });

  it('a missing lead on the first read: "Lead not found"', async () => {
    db.getLeadById.mockResolvedValueOnce(null);
    const result = await addLeadEngagement('L1', 'LD1', 'custom.x', 'u1', undefined, undefined, LIMITS);
    expect(result).toMatchObject({ success: false, message: 'Lead not found' });
    expect(db.addLeadEngagement).not.toHaveBeenCalled();
  });
});

describe('with agentLimits', () => {
  it('reads consistently, stamps the channel, sends the CAS token and answers recorded: true', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead());
    db.addLeadEngagement.mockResolvedValueOnce({});
    const result = await addLeadEngagement('L1', 'LD1', 'custom.phone_call', 'u1', { outcome: 'booked' }, '2026-11-19T09:00:00.000Z', LIMITS);
    expect(result).toMatchObject({ success: true, recorded: true, eventType: 'custom.phone_call', leadName: 'Ann Lee' });
    expect(db.getLeadById).toHaveBeenCalledWith('L1', 'LD1', { consistentRead: true });
    expect(db.addLeadEngagement).toHaveBeenCalledTimes(1);
    const [listId, leadId, event, opts] = db.addLeadEngagement.mock.calls[0];
    expect([listId, leadId]).toEqual(['L1', 'LD1']);
    expect(event).toStrictEqual({ eventType: 'custom.phone_call', eventData: { outcome: 'booked', channel: 'mcp' }, createdAt: '2026-11-19T09:00:00.000Z' });
    expect(opts).toStrictEqual({ expectedUpdatedAt: UPDATED_AT });
  });

  it('stores the idempotency key in the event data when given', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead());
    db.addLeadEngagement.mockResolvedValueOnce({});
    await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, { ...LIMITS, idempotencyKey: KEY });
    expect(db.addLeadEngagement.mock.calls[0][2].eventData).toStrictEqual({ channel: 'mcp', idempotencyKey: KEY });
  });

  it('the caller\'s own channel / idempotencyKey keys cannot replace the stamped ones', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead());
    db.addLeadEngagement.mockResolvedValueOnce({});
    await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', { channel: 'web', idempotencyKey: 'forged-key-1' }, undefined, { ...LIMITS, idempotencyKey: KEY });
    expect(db.addLeadEngagement.mock.calls[0][2].eventData).toMatchObject({ channel: 'mcp', idempotencyKey: KEY });
  });

  it('without a key of ours, a caller\'s own idempotencyKey in the data is dropped (only the server sets it)', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead());
    db.addLeadEngagement.mockResolvedValueOnce({});
    await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', { channel: 'web', idempotencyKey: 'forged-key-1', note: 'kept' }, undefined, LIMITS);
    expect(db.addLeadEngagement.mock.calls[0][2].eventData).toStrictEqual({ note: 'kept', channel: 'mcp' });
  });

  it('a default createdAt is now when no date is given', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead());
    db.addLeadEngagement.mockResolvedValueOnce({});
    const before = Date.now();
    await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, LIMITS);
    const at = Date.parse(db.addLeadEngagement.mock.calls[0][2].createdAt);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('a lead without a string updatedAt is written without the CAS option', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead({ updatedAt: undefined }));
    db.addLeadEngagement.mockResolvedValueOnce({});
    await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, LIMITS);
    expect(db.addLeadEngagement.mock.calls[0][3]).toStrictEqual({});
  });

  it('a key already on one of the lead\'s events: duplicate, recorded: false, and NO write', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead({ engagements: [{ eventId: 'e1', eventType: 'custom.note', eventData: { channel: 'mcp', idempotencyKey: KEY } }] }));
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, { ...LIMITS, idempotencyKey: KEY });
    expect(result).toMatchObject({ success: true, recorded: false, duplicate: true });
    expect(db.addLeadEngagement).not.toHaveBeenCalled();
  });

  it('a different key on the lead does not block the write', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead({ engagements: [{ eventData: { channel: 'mcp', idempotencyKey: 'other-key-1' } }] }));
    db.addLeadEngagement.mockResolvedValueOnce({});
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, { ...LIMITS, idempotencyKey: KEY });
    expect(result).toMatchObject({ success: true, recorded: true });
    expect(db.addLeadEngagement).toHaveBeenCalledTimes(1);
  });

  it('a lead already holding maxChannelEvents events of this channel is refused, with no write', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead({ engagements: mcpEvents(50) }));
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, LIMITS);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/holds 50 events/);
    expect(db.addLeadEngagement).not.toHaveBeenCalled();
  });

  it('only this channel\'s events count toward the cap (49 mcp + 30 others still records)', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead({ engagements: [...mcpEvents(49), ...mcpEvents(30, 'smartlead'), { eventType: 'status.changed', eventData: {} }] }));
    db.addLeadEngagement.mockResolvedValueOnce({});
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, LIMITS);
    expect(result).toMatchObject({ success: true, recorded: true });
  });

  it('the duplicate check wins over the cap (a retry of an already-recorded event is a duplicate, not a refusal)', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead({ engagements: [...mcpEvents(49), { eventData: { channel: 'mcp', idempotencyKey: KEY } }] }));
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, { ...LIMITS, idempotencyKey: KEY });
    expect(result).toMatchObject({ success: true, recorded: false, duplicate: true });
  });

  it('a lead whose stored JSON is maxLeadBytes or more (in UTF-8 bytes) is refused, with no write', async () => {
    // 'é' is 2 bytes in UTF-8: the record's character count stays under the limit while its byte count reaches it.
    const lead = baseLead({ notes: String.fromCharCode(0xe9).repeat(200) });
    const bytes = Buffer.byteLength(JSON.stringify(lead), 'utf8');
    expect(JSON.stringify(lead).length).toBeLessThan(bytes);
    db.getLeadById.mockResolvedValueOnce(lead);
    const atLimit = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, { ...LIMITS, maxLeadBytes: bytes });
    expect(atLimit.success).toBe(false);
    expect(db.addLeadEngagement).not.toHaveBeenCalled();

    db.getLeadListById.mockResolvedValueOnce(LIST);
    db.getLeadById.mockResolvedValueOnce(lead);
    db.addLeadEngagement.mockResolvedValueOnce({});
    const under = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, { ...LIMITS, maxLeadBytes: bytes + 1 });
    expect(under).toMatchObject({ success: true, recorded: true });
  });

  it('a lost race (preconditionFailed) re-reads consistently and writes again with the new token', async () => {
    const second = baseLead({ updatedAt: '2026-11-20T10:00:05.000Z', engagements: mcpEvents(1) });
    db.getLeadById.mockResolvedValueOnce(baseLead()).mockResolvedValueOnce(second);
    db.addLeadEngagement.mockRejectedValueOnce(preconditionFailed()).mockResolvedValueOnce({});
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, { ...LIMITS, idempotencyKey: KEY });
    expect(result).toMatchObject({ success: true, recorded: true });
    expect(db.getLeadById).toHaveBeenCalledTimes(2);
    expect(db.getLeadById.mock.calls[1]).toEqual(['L1', 'LD1', { consistentRead: true }]);
    expect(db.addLeadEngagement).toHaveBeenCalledTimes(2);
    expect(db.addLeadEngagement.mock.calls[0][3]).toStrictEqual({ expectedUpdatedAt: UPDATED_AT });
    expect(db.addLeadEngagement.mock.calls[1][3]).toStrictEqual({ expectedUpdatedAt: '2026-11-20T10:00:05.000Z' });
  });

  it('a key that appeared during the race makes the retry a duplicate, with no second write', async () => {
    const second = baseLead({ updatedAt: '2026-11-20T10:00:05.000Z', engagements: [{ eventData: { channel: 'mcp', idempotencyKey: KEY } }] });
    db.getLeadById.mockResolvedValueOnce(baseLead()).mockResolvedValueOnce(second);
    db.addLeadEngagement.mockRejectedValueOnce(preconditionFailed());
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, { ...LIMITS, idempotencyKey: KEY });
    expect(result).toMatchObject({ success: true, recorded: false, duplicate: true });
    expect(db.addLeadEngagement).toHaveBeenCalledTimes(1);
  });

  it('a cap reached during the race refuses on the retry', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead({ engagements: mcpEvents(49) })).mockResolvedValueOnce(baseLead({ updatedAt: 'x2', engagements: mcpEvents(50) }));
    db.addLeadEngagement.mockRejectedValueOnce(preconditionFailed());
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, LIMITS);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/holds 50 events/);
    expect(db.addLeadEngagement).toHaveBeenCalledTimes(1);
  });

  it('at most 3 attempts, then "The lead kept changing..." and nothing recorded', async () => {
    db.getLeadById
      .mockResolvedValueOnce(baseLead({ updatedAt: 't1' }))
      .mockResolvedValueOnce(baseLead({ updatedAt: 't2' }))
      .mockResolvedValueOnce(baseLead({ updatedAt: 't3' }))
      .mockResolvedValueOnce(baseLead({ updatedAt: 't4' }));
    db.addLeadEngagement
      .mockRejectedValueOnce(preconditionFailed())
      .mockRejectedValueOnce(preconditionFailed())
      .mockRejectedValueOnce(preconditionFailed());
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, LIMITS);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/^The lead kept changing/);
    expect(db.addLeadEngagement).toHaveBeenCalledTimes(3);
    expect(db.addLeadEngagement.mock.calls.map((c) => c[3].expectedUpdatedAt)).toEqual(['t1', 't2', 't3']);
  });

  it('a lead gone on the re-read: "Lead not found"', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead()).mockResolvedValueOnce(null);
    db.addLeadEngagement.mockRejectedValueOnce(preconditionFailed());
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, LIMITS);
    expect(result).toEqual({ success: false, message: 'Lead not found' });
    expect(db.addLeadEngagement).toHaveBeenCalledTimes(1);
  });

  it('any other write error is not retried', async () => {
    db.getLeadById.mockResolvedValueOnce(baseLead());
    db.addLeadEngagement.mockRejectedValueOnce(new Error('ValidationException: Item size has exceeded the maximum allowed size'));
    const result = await addLeadEngagement('L1', 'LD1', 'custom.note', 'u1', undefined, undefined, LIMITS);
    expect(result.success).toBe(false);
    expect(db.addLeadEngagement).toHaveBeenCalledTimes(1);
    expect(db.getLeadById).toHaveBeenCalledTimes(1);
  });
});
