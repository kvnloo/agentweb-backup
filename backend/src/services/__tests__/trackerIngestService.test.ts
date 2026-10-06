/**
 * ENG-2316 — routing fan-out. The parent keeps every session; matching children get the SAME session
 * (own deterministic id); a child problem never fails the request or the parent.
 */
import { crmDb } from '../db';
import { ingestTrackerEvent } from '../trackerIngestService';
import { parseIngestBody } from '../../utils/trackingIngest';
import { sessionLeadId, SESSION_START_GENERATION_MS } from '../../utils/sessionList';

jest.mock('../db', () => ({
  crmDb: { getLeadListById: jest.fn(), getLeadById: jest.fn(), createLead: jest.fn(), mergeSessionLeadEvent: jest.fn() },
}));

const NOW = Date.now();
const SID = 'abcd1234-ef56-7890';
const START = NOW - 5000;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120';
const IG = 'https://go.example.com/p?utm_source=instagram&utm_medium=bio';
const PAID = 'https://go.example.com/p?utm_source=facebook&utm_medium=paid&fbclid=Z';

const parsed = (landingUrl: string, over: Record<string, any> = {}) => {
  const r = parseIngestBody({ listId: 'list_parent_001', event: 'lp_view', sessionId: SID, sessionStartMs: START, eventCount: 1, landingUrl, ...over }, NOW);
  if (!r.ok) throw new Error(r.code);
  return r.value;
};
const parent = (routing: any[]) => ({ listId: 'list_parent_001', userId: 'u1', listType: 'session', publicAccessEnabled: true, trackingConfig: { allowedOrigins: ['https://go.example.com'], routing } });
const child = (id: string, over: Record<string, any> = {}) => ({ listId: id, userId: 'u1', listType: 'session', ...over });
const ROUTING = [
  { id: 'organic', match: { trafficType: 'organic' }, childListId: 'list_child_org1' },
  { id: 'paid', match: { trafficType: 'paid' }, childListId: 'list_child_paid' },
];
const ingest = (landing: string, routing: any[] = ROUTING) => ingestTrackerEvent({ list: parent(routing), parsed: parsed(landing), userAgent: CHROME, visitorIp: '203.0.113.9' });
const writtenTo = () => (crmDb.createLead as jest.Mock).mock.calls.map((c) => c[0]).sort();

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  (crmDb.getLeadListById as jest.Mock).mockImplementation(async (id: string) => ({ list_child_org1: child('list_child_org1'), list_child_paid: child('list_child_paid') } as any)[id] ?? null);
  (crmDb.createLead as jest.Mock).mockImplementation(async (_l: string, d: any) => ({ ...d }));
  (crmDb.mergeSessionLeadEvent as jest.Mock).mockResolvedValue({ exists: true, changed: true, guardApplied: true });
});

describe('fan-out', () => {
  it('a paid session goes to the parent and ONLY the paid child', async () => {
    const r = await ingest(PAID);
    expect(writtenTo()).toEqual(['list_child_paid', 'list_parent_001']);
    expect(r.childListIds).toEqual(['list_child_paid']);
  });

  it('an organic session goes to the parent and ONLY the organic child', async () => {
    await ingest(IG);
    expect(writtenTo()).toEqual(['list_child_org1', 'list_parent_001']);
  });

  it('a session matching no rule is written to the parent only, and no child list is even read', async () => {
    await ingest(IG, [{ id: 'paid', match: { trafficType: 'paid' }, childListId: 'list_child_paid' }]);
    expect(writtenTo()).toEqual(['list_parent_001']);
    expect(crmDb.getLeadListById).not.toHaveBeenCalled();
  });

  it('a list without routing behaves exactly as before: one write', async () => {
    await ingestTrackerEvent({ list: { ...parent([]), trackingConfig: { allowedOrigins: [] } }, parsed: parsed(IG), userAgent: CHROME, visitorIp: '' });
    expect(writtenTo()).toEqual(['list_parent_001']);
  });

  it('each target gets the SAME sessionId + sessionStartMs and its OWN deterministic leadId', async () => {
    await ingest(IG);
    const calls = (crmDb.createLead as jest.Mock).mock.calls;
    const ids = calls.map(([l, d]) => [l, d.leadId, d.customFields.sessionId, d.customFields.sessionStartMs]);
    expect(ids).toHaveLength(2);
    for (const [listId, leadId, sid, start] of ids) {
      expect(sid).toBe(SID);
      expect(start).toBe(START);
      expect(leadId).toBe(sessionLeadId(listId, { sessionId: SID, sessionStartMs: START }));
    }
    expect(ids[0][1]).not.toBe(ids[1][1]);
  });

  it('every target gets an independent copy of the row (a mutation for one cannot leak to another)', async () => {
    await ingest(IG, [{ id: 'a', match: { trafficType: 'organic' }, childListId: 'list_child_org1' }]);
    const [a, b] = (crmDb.createLead as jest.Mock).mock.calls.map((c) => c[1].customFields);
    expect(a).not.toBe(b);
    expect(a.channel).toBe(b.channel);
  });

  it('a rule that names the parent itself never double-writes it', async () => {
    (crmDb.getLeadListById as jest.Mock).mockImplementation(async (id: string) => child(id)); // the parent is a perfectly valid-looking "child"
    await ingest(IG, [{ id: 'self', match: { trafficType: 'organic' }, childListId: 'list_parent_001' }]);
    expect(writtenTo()).toEqual(['list_parent_001']);
  });

  it('a later event for an existing session merges into the parent AND the child (atomic merge, per list)', async () => {
    (crmDb.createLead as jest.Mock).mockRejectedValue(Object.assign(new Error('exists'), { leadAlreadyExists: true }));
    await ingest(IG);
    const merged = (crmDb.mergeSessionLeadEvent as jest.Mock).mock.calls.map((c) => c[0]).sort();
    expect(merged).toEqual(['list_child_org1', 'list_parent_001']);
  });
});

describe('child failure isolation', () => {
  it('a child write error is logged, does not reject, and the parent is still written', async () => {
    (crmDb.createLead as jest.Mock).mockImplementation(async (l: string, d: any) => {
      if (l === 'list_child_org1') throw new Error('ProvisionedThroughputExceeded');
      return { ...d };
    });
    const r = await ingest(IG);
    expect(r.childFailures).toEqual(['list_child_org1']);
    expect(writtenTo()).toEqual(['list_child_org1', 'list_parent_001']);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('list_child_org1'));
  });

  it.each([
    ['does not exist', async () => null],
    ['is not a session list', async (id: string) => child(id, { listType: 'sales' })],
    ['belongs to someone else', async (id: string) => child(id, { userId: 'other' })],
    ['cannot be read', async () => { throw new Error('read failed'); }],
  ])('a child that %s is skipped, never written, and does not fail the event', async (_l, lookup) => {
    (crmDb.getLeadListById as jest.Mock).mockImplementation(lookup as any);
    const r = await ingest(IG);
    expect(r.childFailures).toEqual(['list_child_org1']);
    expect(writtenTo()).toEqual(['list_parent_001']);
  });

  it('one failing child does not stop a healthy sibling', async () => {
    (crmDb.getLeadListById as jest.Mock).mockImplementation(async (id: string) => (id === 'list_child_bad' ? null : child(id)));
    await ingest(IG, [
      { id: 'bad', match: { trafficType: 'organic' }, childListId: 'list_child_bad' },
      { id: 'good', match: { trafficType: 'organic' }, childListId: 'list_child_org1' },
    ]);
    expect(writtenTo()).toEqual(['list_child_org1', 'list_parent_001']);
  });

  it('a PARENT failure still fails the event (the caller sees a 5xx)', async () => {
    (crmDb.createLead as jest.Mock).mockImplementation(async (l: string, d: any) => {
      if (l === 'list_parent_001') throw new Error('parent write failed');
      return { ...d };
    });
    await expect(ingest(IG)).rejects.toThrow('parent write failed');
  });
});

describe('ENG-2324: substituted session start', () => {
  const skewed = () => parsed(IG, { sessionStartMs: NOW + 3 * 24 * 3600_000 });
  const run = () => ingestTrackerEvent({ list: parent(ROUTING), parsed: skewed(), userAgent: CHROME, visitorIp: '' });

  it('first event: no row under the previous generation -> creates under the current one, on every target', async () => {
    (crmDb.getLeadById as jest.Mock).mockResolvedValue(null);
    await run();
    const cur = skewed().identity;
    for (const [listId, d] of (crmDb.createLead as jest.Mock).mock.calls) {
      expect(d.leadId).toBe(sessionLeadId(listId, { sessionId: SID, sessionStartMs: cur.sessionStartMs }));
      expect(d.customFields.sessionStartMs).toBe(cur.sessionStartMs);
    }
    // the probe is an exact-key CONSISTENT read of the previous generation's id, per target
    expect((crmDb.getLeadById as jest.Mock).mock.calls).toContainEqual(
      ['list_parent_001', sessionLeadId('list_parent_001', { sessionId: SID, sessionStartMs: cur.probeStartsMs![0] }), { consistentRead: true }]);
  });

  it('the session already has its row under the previous generation -> keeps writing THERE (no second row after the daily advance)', async () => {
    (crmDb.getLeadById as jest.Mock).mockResolvedValue({ leadId: 'exists' });
    (crmDb.createLead as jest.Mock).mockRejectedValue(Object.assign(new Error('exists'), { leadAlreadyExists: true }));
    await run();
    const prevStart = skewed().identity.probeStartsMs![0];
    expect(prevStart).toBe(skewed().identity.sessionStartMs - SESSION_START_GENERATION_MS);
    // the stored sessionStartMs follows the row actually written, not the current generation
    const planned = JSON.stringify((crmDb.mergeSessionLeadEvent as jest.Mock).mock.calls.map((c) => c[2]));
    expect(planned).toContain(`"sessionStartMs":${prevStart}`);
    expect(planned).not.toContain(`"sessionStartMs":${skewed().identity.sessionStartMs}`);
    for (const [listId, leadId] of (crmDb.mergeSessionLeadEvent as jest.Mock).mock.calls.map((c) => [c[0], c[1]])) {
      expect(leadId).toBe(sessionLeadId(listId, { sessionId: SID, sessionStartMs: prevStart }));
    }
  });

  it('a normal in-window session never reads the probe', async () => {
    await ingest(IG);
    expect(crmDb.getLeadById).not.toHaveBeenCalled();
  });

  it('a probe failure fails the parent (500 upstream) and is isolated for a child, like any write', async () => {
    (crmDb.getLeadById as jest.Mock).mockImplementation(async (l: string) => { if (l === 'list_child_paid') throw new Error('throttled'); return null; });
    const r = await ingestTrackerEvent({ list: parent(ROUTING), parsed: parsed(PAID, { sessionStartMs: NOW + 3 * 24 * 3600_000 }), userAgent: CHROME, visitorIp: '' });
    expect(r.childFailures).toEqual(['list_child_paid']);
    (crmDb.getLeadById as jest.Mock).mockRejectedValue(new Error('throttled'));
    await expect(run()).rejects.toThrow('throttled');
  });
});
