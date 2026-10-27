import { linkVisitorToAccount, DEFAULT_HIREEMMA_SIGNAL_LIST_ID } from '../services/serverSignalEmitter';
import { buildSessionRow, parseIngestBody, type ParsedIngest } from '../utils/trackingIngest';
import { resolvePersons } from '../utils/identityStitching';

const LIST = DEFAULT_HIREEMMA_SIGNAL_LIST_ID;
const NOW = 1_800_000_000_000;
const VID = 'vid-abcdef12-3456';
const user = { userId: 'u-42', createdAt: '2026-10-01T00:00:00.000Z' };
const sessionList = { listId: LIST, listType: 'session', userId: 'owner' };

/** In-memory stand-in for the session list: one row per sessionId, per-key SET merge (as mergeSessionLeadEvent). */
function fakeStore() {
  const rows = new Map<string, { customFields: Record<string, any> }>();
  let tick = 0;
  const write = (parsed: ParsedIngest) => {
    const nowIso = new Date(NOW + tick++ * 1000).toISOString();
    const { customFields } = buildSessionRow(parsed, { userAgent: '', nowIso });
    customFields.forwardedAt = nowIso;
    const prev = rows.get(parsed.identity.sessionId);
    rows.set(parsed.identity.sessionId, { customFields: { ...(prev?.customFields || {}), ...customFields } });
  };
  return { rows, write };
}

function deps(store: ReturnType<typeof fakeStore>) {
  return {
    getList: jest.fn().mockResolvedValue(sessionList),
    ingest: jest.fn(async ({ parsed }: any) => { store.write(parsed); return {}; }),
    findUserByStripeCustomerId: jest.fn(),
    now: () => NOW,
    logger: { warn: jest.fn(), error: jest.fn() },
  };
}

function browserEvent(store: ReturnType<typeof fakeStore>, sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  const r = parseIngestBody({ listId: LIST, event, sessionId, sessionStartMs: NOW - 60_000, clientNowMs: NOW, visitorId: VID, visitNo: 1, eventCount: 1, ...extra }, NOW);
  if (!r.ok) throw new Error(r.code);
  store.write(r.value);
}

describe('ENG-2687 identity stitching visitorId -> account_id', () => {
  it('pre-signup browser sessions and post-signup account events resolve to ONE person', async () => {
    const store = fakeStore();
    // Pre-signup: two anonymous sessions of the same browser.
    browserEvent(store, 'sess-pre-1', 'lp_view');
    browserEvent(store, 'sess-pre-2', 'app_cta_click');
    // Before any link they are an anonymous visitor, not an account.
    expect(resolvePersons([...store.rows.values()]).map((p) => p.personId)).toEqual([`visitor:${VID}`]);

    const d = deps(store);
    await expect(linkVisitorToAccount(user, 'registration_completed', VID, d)).resolves.toBe(true);
    // Post-signup: a server signal on the account row (no visitorId of its own).
    browserEvent(store, 'sess-post-1', 'lp_view');

    const people = resolvePersons([...store.rows.values()]);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ personId: 'acct:u-42', accountId: 'u-42', visitorIds: [VID] });
    expect(people[0].sessionIds.sort()).toEqual(['acct-u-42', 'sess-post-1', 'sess-pre-1', 'sess-pre-2']);
    // The link is written onto the account row through the existing ingest path.
    const parsed = d.ingest.mock.calls[0][0].parsed;
    expect(parsed.identity.sessionId).toBe('acct-u-42');
    expect(parsed.customName).toBe('registration_completed');
    expect(parsed.client).toMatchObject({ accountId: 'u-42', visitorId: VID });
  });

  it('re-linking is idempotent: same row, same mapping, still one person', async () => {
    const store = fakeStore();
    browserEvent(store, 'sess-pre-1', 'lp_view');
    const d = deps(store);
    await linkVisitorToAccount(user, 'registration_completed', VID, d);
    const once = resolvePersons([...store.rows.values()]);
    await linkVisitorToAccount(user, 'lead_identified', VID, d);
    await linkVisitorToAccount(user, 'lead_identified', VID, d);
    const again = resolvePersons([...store.rows.values()]);
    expect(store.rows.size).toBe(2); // no new rows from re-linking
    expect(again).toEqual(once);
    expect(new Set(d.ingest.mock.calls.map(([i]: any[]) => i.parsed.identity.sessionId))).toEqual(new Set(['acct-u-42']));
  });

  it('an invalid visitorId still records the event but links nothing; another visitor stays separate', async () => {
    const store = fakeStore();
    browserEvent(store, 'sess-pre-1', 'lp_view');
    const d = deps(store);
    await expect(linkVisitorToAccount(user, 'registration_completed', '<script>', d)).resolves.toBe(true);
    expect(d.ingest.mock.calls[0][0].parsed.client.visitorId).toBeUndefined();
    const ids = resolvePersons([...store.rows.values()]).map((p) => p.personId).sort();
    expect(ids).toEqual(['acct:u-42', `visitor:${VID}`]);
  });

  it('never throws (fire-and-forget) when the write fails', async () => {
    const d = { ...deps(fakeStore()), ingest: jest.fn().mockRejectedValue(new Error('ddb down')) };
    await expect(linkVisitorToAccount(user, 'lead_identified', VID, d)).resolves.toBe(false);
    await expect(linkVisitorToAccount(null, 'lead_identified', VID, d)).resolves.toBe(false);
  });

  it('a browser linked to two accounts maps to the most recent link', () => {
    const rows = [
      { customFields: { sessionId: 'acct-a', accountId: 'a', visitorId: VID, forwardedAt: '2026-10-01T00:00:00Z' } },
      { customFields: { sessionId: 'acct-b', accountId: 'b', visitorId: VID, forwardedAt: '2026-10-02T00:00:00Z' } },
      { customFields: { sessionId: 's1', visitorId: VID } },
    ];
    const s1Owner = resolvePersons(rows).find((p) => p.sessionIds.includes('s1'));
    expect(s1Owner?.accountId).toBe('b');
    expect(resolvePersons([...rows].reverse()).find((p) => p.sessionIds.includes('s1'))?.accountId).toBe('b');
  });
});
