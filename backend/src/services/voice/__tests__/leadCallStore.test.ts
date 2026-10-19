jest.mock('../../db', () => ({
  // The real constant, so a keyword added in db.ts is exercised here without editing this test.
  ENGAGED_EVENT_KEYWORDS: jest.requireActual('../../db').ENGAGED_EVENT_KEYWORDS,
  crmDb: {
    getLeadById: jest.fn(),
    createLeadSystemRecordOnce: jest.fn(),
    updateLeadSystemRecordIf: jest.fn(),
    addLeadEngagement: jest.fn(),
  },
}));
import { crmDb, ENGAGED_EVENT_KEYWORDS } from '../../db';
import { getLeadCallStore, setLeadCallStoreForTests } from '../leadCallStore';
import type { HotLeadCallRecord } from '../leadCallStore.types';

const mock = (fn: unknown) => fn as jest.Mock;
const LIST = 'list-a';
const LEAD = 'lead-a';
const SID_OWNER = 'CA' + 'a1b2c3d4'.repeat(4);
const SID_LEAD = 'CA' + '12345678'.repeat(4);

// In-memory stand-in for the two crmDb primitives with the semantics of their DynamoDB conditions:
// each call is one atomic step (no await between check and write), exactly like a conditional UpdateItem.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
function installFakeDb(leads: Record<string, Row>) {
  const rowOf = (listId: string, leadId: string) => leads[`${listId}/${leadId}`];
  mock(crmDb.getLeadById).mockImplementation(async (l: string, i: string) => {
    const row = rowOf(l, i);
    return row ? structuredClone(row) : undefined;
  });
  mock(crmDb.createLeadSystemRecordOnce).mockImplementation(async (l: string, i: string, key: string, rec: Row) => {
    const row = rowOf(l, i);
    if (!row) return false;
    row.system = row.system ?? {};
    if (row.system[key] !== undefined) return false;
    row.system[key] = structuredClone(rec);
    return true;
  });
  mock(crmDb.updateLeadSystemRecordIf).mockImplementation(
    async (l: string, i: string, key: string, op: Row) => {
      const rec = rowOf(l, i)?.system?.[key];
      if (!rec || !op.stateIn.includes(rec.state)) return false;
      for (const [field, entries] of Object.entries<Record<string, number>>(op.maxIn ?? {})) {
        for (const [k, n] of Object.entries(entries)) {
          if (rec[field][k] !== undefined && !(rec[field][k] < n)) return false;
        }
      }
      for (const [field, items] of Object.entries<string[]>(op.appendNew ?? {})) {
        if (items.some((x) => rec[field].includes(x))) return false;
      }
      for (const [field, v] of Object.entries(op.set ?? {})) if (v !== undefined) rec[field] = v;
      for (const [field, entries] of Object.entries<Record<string, number>>(op.maxIn ?? {})) Object.assign(rec[field], entries);
      for (const [field, items] of Object.entries<string[]>(op.appendNew ?? {})) rec[field].push(...items);
      return true;
    },
  );
}

const baseRecord: HotLeadCallRecord = {
  state: 'dialing',
  jobKey: 'job-1',
  startedAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T10:00:00.000Z',
};

let leads: Record<string, Row>;
beforeEach(() => {
  jest.resetAllMocks();
  setLeadCallStoreForTests(null);
  leads = { [`${LIST}/${LEAD}`]: { listId: LIST, leadId: LEAD, system: {} } };
  installFakeDb(leads);
});

describe('leadCallStore create/get', () => {
  it('creates the record once and reads it back', async () => {
    const store = getLeadCallStore();
    expect(await store.get(LIST, LEAD)).toBeNull();
    expect(await store.create(LIST, LEAD, baseRecord)).toBe(true);
    expect(await store.get(LIST, LEAD)).toMatchObject({ state: 'dialing', jobKey: 'job-1', meteredLegs: [], lastSequence: {} });
  });

  it('never overwrites: a second create returns false and keeps the first record', async () => {
    const store = getLeadCallStore();
    expect(await store.create(LIST, LEAD, baseRecord)).toBe(true);
    expect(await store.create(LIST, LEAD, { ...baseRecord, jobKey: 'job-2' })).toBe(false);
    expect((await store.get(LIST, LEAD))?.jobKey).toBe('job-1');
  });

  it('returns false for a lead that does not exist', async () => {
    expect(await getLeadCallStore().create(LIST, 'missing', baseRecord)).toBe(false);
  });

  it('ignores a system value that is not a call record', async () => {
    leads[`${LIST}/${LEAD}`].system.hot_lead_call = 'dialing';
    expect(await getLeadCallStore().get(LIST, LEAD)).toBeNull();
  });

  it('persists only known record fields (no way to store a phone number)', async () => {
    const sneaky = { ...baseRecord, ownerPhone: '+15555550100' } as HotLeadCallRecord;
    await getLeadCallStore().create(LIST, LEAD, sneaky);
    expect(JSON.stringify(leads[`${LIST}/${LEAD}`])).not.toContain('5555550100');
  });
});

describe('leadCallStore transition', () => {
  beforeEach(async () => {
    await getLeadCallStore().create(LIST, LEAD, baseRecord);
  });

  it('applies the patch when the current state is allowed', async () => {
    const ok = await getLeadCallStore().transition(LIST, LEAD, ['dialing'], { state: 'owner_ringing', ownerCallSid: SID_OWNER });
    expect(ok).toBe(true);
    expect(await getLeadCallStore().get(LIST, LEAD)).toMatchObject({ state: 'owner_ringing', ownerCallSid: SID_OWNER, jobKey: 'job-1' });
  });

  it('is a no-op returning false from the wrong state', async () => {
    const ok = await getLeadCallStore().transition(LIST, LEAD, ['bridging'], { state: 'connected' });
    expect(ok).toBe(false);
    expect((await getLeadCallStore().get(LIST, LEAD))?.state).toBe('dialing');
  });

  it('returns false for an empty from list without calling the db', async () => {
    expect(await getLeadCallStore().transition(LIST, LEAD, [], { state: 'failed' })).toBe(false);
    // An empty IN () list is invalid DynamoDB syntax, so it must never reach the db.
    expect(crmDb.updateLeadSystemRecordIf).not.toHaveBeenCalled();
  });

  it('returns false for a lead without a record', async () => {
    expect(await getLeadCallStore().transition(LIST, 'other', ['dialing'], { state: 'failed' })).toBe(false);
  });

  it('does not move a terminal record backwards', async () => {
    const store = getLeadCallStore();
    await store.transition(LIST, LEAD, ['dialing'], { state: 'finished', outcome: 'completed' });
    expect(await store.transition(LIST, LEAD, ['dialing', 'owner_ringing'], { state: 'owner_answered' })).toBe(false);
    expect((await store.get(LIST, LEAD))?.state).toBe('finished');
  });

  it.each(['finished', 'failed', 'skipped'] as const)('refuses a from list containing terminal %s without calling the db', async (terminal) => {
    await getLeadCallStore().transition(LIST, LEAD, ['dialing'], { state: terminal });
    mock(crmDb.updateLeadSystemRecordIf).mockClear();
    expect(await getLeadCallStore().transition(LIST, LEAD, [terminal], { state: 'owner_answered' })).toBe(false);
    expect(await getLeadCallStore().transition(LIST, LEAD, ['dialing', terminal], { state: 'owner_answered' })).toBe(false);
    expect(crmDb.updateLeadSystemRecordIf).not.toHaveBeenCalled();
    expect((await getLeadCallStore().get(LIST, LEAD))?.state).toBe(terminal);
  });

  it('keeps lastSequence monotonic per CallSid and rejects a replayed or older sequence', async () => {
    const store = getLeadCallStore();
    expect(await store.transition(LIST, LEAD, ['dialing'], { state: 'owner_ringing', lastSequence: { [SID_OWNER]: 2 } })).toBe(true);
    expect(await store.transition(LIST, LEAD, ['owner_ringing'], { state: 'owner_answered', lastSequence: { [SID_OWNER]: 2 } })).toBe(false);
    expect(await store.transition(LIST, LEAD, ['owner_ringing'], { state: 'owner_answered', lastSequence: { [SID_OWNER]: 1 } })).toBe(false);
    expect((await store.get(LIST, LEAD))?.state).toBe('owner_ringing');
    expect(await store.transition(LIST, LEAD, ['owner_ringing'], { state: 'owner_answered', lastSequence: { [SID_OWNER]: 3, [SID_LEAD]: 1 } })).toBe(true);
    expect((await store.get(LIST, LEAD))?.lastSequence).toEqual({ [SID_OWNER]: 3, [SID_LEAD]: 1 });
  });

  it('meters a leg at most once: the replay returns false and the list has no duplicate', async () => {
    const store = getLeadCallStore();
    expect(await store.transition(LIST, LEAD, ['dialing'], { state: 'owner_ringing', meteredLegs: ['owner'] })).toBe(true);
    expect(await store.transition(LIST, LEAD, ['owner_ringing'], { state: 'finished', meteredLegs: ['owner'] })).toBe(false);
    expect(await store.transition(LIST, LEAD, ['owner_ringing'], { state: 'finished', meteredLegs: ['lead'] })).toBe(true);
    expect((await store.get(LIST, LEAD))?.meteredLegs).toEqual(['owner', 'lead']);
  });

  it('de-duplicates legs inside one patch', async () => {
    await getLeadCallStore().transition(LIST, LEAD, ['dialing'], { state: 'finished', meteredLegs: ['owner', 'owner'] });
    expect((await getLeadCallStore().get(LIST, LEAD))?.meteredLegs).toEqual(['owner']);
  });

  it('stamps updatedAt itself and drops unknown patch keys', async () => {
    const patch = { state: 'failed', updatedAt: '1999-01-01T00:00:00.000Z', leadPhone: '+15555550100' } as never;
    await getLeadCallStore().transition(LIST, LEAD, ['dialing'], patch);
    const row = JSON.stringify(leads[`${LIST}/${LEAD}`]);
    expect(row).not.toContain('5555550100');
    expect(row).not.toContain('1999');
  });
});

describe('leadCallStore addEvent', () => {
  it('writes a lead engagement with the call event type and a timestamp', async () => {
    await getLeadCallStore().addEvent(LIST, LEAD, 'call.connected', { leg: 'lead', seconds: 12, answered: true });
    expect(crmDb.addLeadEngagement).toHaveBeenCalledWith(LIST, LEAD, {
      eventType: 'call.connected',
      eventData: { leg: 'lead', seconds: 12, answered: true },
      createdAt: expect.any(String),
    });
  });

  it('keeps CallSids but redacts phone numbers in any format', async () => {
    await getLeadCallStore().addEvent(LIST, LEAD, 'call.failed', {
      sid: SID_LEAD,
      reason: 'busy at +1 (555) 555-0100 then 555.555.0100 and +15555550100',
    });
    const { eventData } = mock(crmDb.addLeadEngagement).mock.calls[0][2];
    expect(eventData.sid).toBe(SID_LEAD);
    expect(eventData.reason).toBe('busy at [redacted] then [redacted] and [redacted]');
  });

  it('leaves ISO dates, timestamps and long ids intact', async () => {
    await getLeadCallStore().addEvent(LIST, LEAD, 'call.completed', {
      day: '2026-10-19', at: '2026-10-19T10:00:00.000Z', job: 'job_1234567', ref: 'job-1234567', range: '2026-10-19 to 2026-10-20',
    });
    expect(mock(crmDb.addLeadEngagement).mock.calls[0][2].eventData).toEqual({
      day: '2026-10-19', at: '2026-10-19T10:00:00.000Z', job: 'job_1234567', ref: 'job-1234567', range: '2026-10-19 to 2026-10-20',
    });
  });

  it.each([
    ['fullwidth digits', '４１５５５５０１００'],
    ['Arabic-Indic digits', '٤١٥٥٥٥٠١٠٠'],
    ['NBSP and non-breaking hyphens', '415\u00A0555\u20110100'],
    ['fullwidth plus', '＋1 415 555 0100'],
  ])('redacts a phone number written with %s', async (_label, phone) => {
    await getLeadCallStore().addEvent(LIST, LEAD, 'call.failed', { note: `dial ${phone} now` });
    expect(mock(crmDb.addLeadEngagement).mock.calls[0][2].eventData).toEqual({ note: 'dial [redacted] now' });
  });

  it('redacts a digit run glued to a trailing word but keeps ids glued on the left', async () => {
    await getLeadCallStore().addEvent(LIST, LEAD, 'call.failed', { a: 'ext 4155550100x', b: 'job_4155550100', c: `sid ${SID_OWNER}` });
    expect(mock(crmDb.addLeadEngagement).mock.calls[0][2].eventData).toEqual({ a: 'ext [redacted]x', b: 'job_4155550100', c: `sid ${SID_OWNER}` });
  });

  it('redacts a bare 10 digit number and a dashed number', async () => {
    await getLeadCallStore().addEvent(LIST, LEAD, 'call.failed', { a: '5555550100', b: 'call 555-555-0100 now' });
    expect(mock(crmDb.addLeadEngagement).mock.calls[0][2].eventData).toEqual({ a: '[redacted]', b: 'call [redacted] now' });
  });

  it('drops numeric values and keys that look like phone numbers', async () => {
    await getLeadCallStore().addEvent(LIST, LEAD, 'call.failed', { n: 15555550100, '+15555550100': 'x', ok: 3 });
    expect(mock(crmDb.addLeadEngagement).mock.calls[0][2].eventData).toEqual({ ok: 3 });
  });

  it('drops entries that would mark the lead engaged (clicked/replied/received)', async () => {
    await getLeadCallStore().addEvent(LIST, LEAD, 'call.completed', {
      outcome: 'Message_Received',
      replied: true,
      note: 'owner clicked 1',
      reason: 'owner_no_answer',
    });
    expect(mock(crmDb.addLeadEngagement).mock.calls[0][2].eventData).toEqual({ reason: 'owner_no_answer' });
  });

  it.each(ENGAGED_EVENT_KEYWORDS)('drops detail mentioning the db.ts engagement keyword %s', async (word) => {
    await getLeadCallStore().addEvent(LIST, LEAD, 'call.completed', { keep: 'fine', a: `x ${word.toUpperCase()} y`, [`k_${word}`]: 'v' });
    expect(mock(crmDb.addLeadEngagement).mock.calls[0][2].eventData).toEqual({ keep: 'fine' });
  });

  it('caps long string values', async () => {
    await getLeadCallStore().addEvent(LIST, LEAD, 'call.failed', { reason: 'x'.repeat(500) });
    expect(mock(crmDb.addLeadEngagement).mock.calls[0][2].eventData.reason).toHaveLength(200);
  });

  it('never throws when the timeline write fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mock(crmDb.addLeadEngagement).mockRejectedValue(new Error('Lead not found'));
    await expect(getLeadCallStore().addEvent(LIST, LEAD, 'call.skipped')).resolves.toBeUndefined();
  });
});

describe('leadCallStore wiring', () => {
  it('is a singleton and can be swapped for tests', async () => {
    expect(getLeadCallStore()).toBe(getLeadCallStore());
    const fake = { get: jest.fn() } as never;
    setLeadCallStoreForTests(fake);
    expect(getLeadCallStore()).toBe(fake);
    setLeadCallStoreForTests(null);
    expect(getLeadCallStore()).not.toBe(fake);
  });

  it('passes the stored key, consistent read and expected condition inputs to the db primitives', async () => {
    await getLeadCallStore().get(LIST, LEAD);
    expect(crmDb.getLeadById).toHaveBeenCalledWith(LIST, LEAD, { consistentRead: true });
    await getLeadCallStore().transition(LIST, LEAD, ['dialing'], { state: 'failed' });
    expect(mock(crmDb.updateLeadSystemRecordIf).mock.calls[0].slice(0, 3)).toEqual([LIST, LEAD, 'hot_lead_call']);
  });
});
