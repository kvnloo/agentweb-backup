import {
  SERVER_OWNED_LEAD_KEYS, contactSuppressionAuditEnabled, contactSuppressionAuditEvent, guardLeadPutBody, leadPutGuardMode,
  leadWriteChannel, touchesContactSuppression,
} from '../utils/leadWriteGuard';

const run = (body: unknown, mode: 'off' | 'log' | 'enforce', extra: Partial<Parameters<typeof guardLeadPutBody>[1]> = {}) => {
  const logs: Array<[string, Record<string, unknown>]> = [];
  const r = guardLeadPutBody(body, { mode, channel: 'ui', userId: 'user-1', log: (m, d) => logs.push([m, d]), ...extra });
  return { r, logs };
};

describe('leadPutGuardMode / audit switch (ENG-2157)', () => {
  it.each([[undefined, 'log'], ['', 'log'], ['log', 'log'], ['LOG', 'log'], ['enforce', 'enforce'], [' Enforce ', 'enforce'], ['off', 'off'], ['OFF', 'off'], ['yes', 'log'], ['1', 'log']])(
    'CRM_LEAD_PUT_GUARD=%p -> %p (anything unknown stays on the harmless default)', (v, want) => {
      expect(leadPutGuardMode({ CRM_LEAD_PUT_GUARD: v } as any)).toBe(want);
    });
  it('the audit is on unless explicitly off', () => {
    expect(contactSuppressionAuditEnabled({} as any)).toBe(true);
    expect(contactSuppressionAuditEnabled({ CRM_CONTACT_STATUS_AUDIT: 'off' } as any)).toBe(false);
    expect(contactSuppressionAuditEnabled({ CRM_CONTACT_STATUS_AUDIT: 'OFF' } as any)).toBe(false);
    expect(contactSuppressionAuditEnabled({ CRM_CONTACT_STATUS_AUDIT: 'false' } as any)).toBe(true);
  });
  it('channel is agent only for the MCP header', () => {
    expect(leadWriteChannel({ headers: { 'x-agentweb-channel': 'agent' } })).toBe('agent');
    expect(leadWriteChannel({ headers: { 'x-agentweb-channel': 'AGENT' } })).toBe('agent');
    expect(leadWriteChannel({ headers: {} })).toBe('ui');
    expect(leadWriteChannel(undefined)).toBe('ui');
  });
});

describe('guardLeadPutBody (ENG-2157)', () => {
  const body = { firstName: 'A', notes: 'n', customFields: { x: 1 }, syncMetadata: { hubspot_contact_id: 'FORGED' }, lastAutoSendAt: null, clickIds: { fbclid: 'x' }, customFieldsKeyMerge: true };

  it('log mode returns the SAME object (zero behaviour change) and reports the keys', () => {
    const { r, logs } = run(body, 'log');
    expect(r.body).toBe(body);
    expect(r.dropped).toBe(false);
    expect(r.flaggedKeys.sort()).toEqual(['clickIds', 'customFieldsKeyMerge', 'lastAutoSendAt', 'syncMetadata']);
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({ mode: 'log', channel: 'ui', userId: 'user-1', dropped: false });
  });

  it('enforce mode drops exactly the server-owned keys, keeps everything else, and does not mutate the input', () => {
    const copy = JSON.parse(JSON.stringify(body));
    const { r, logs } = run(body, 'enforce');
    expect(r.dropped).toBe(true);
    expect(r.body).toEqual({ firstName: 'A', notes: 'n', customFields: { x: 1 } });
    expect(body).toEqual(copy);
    expect(logs[0][1]).toMatchObject({ mode: 'enforce', dropped: true });
  });

  it('off mode does nothing and logs nothing', () => {
    const { r, logs } = run(body, 'off');
    expect(r.body).toBe(body);
    expect(r.flaggedKeys).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('a body with no server-owned keys is untouched and silent in every mode', () => {
    for (const mode of ['log', 'enforce'] as const) {
      const clean = { firstName: 'A', contactStatus: 'do-not-contact', unsubscribedFromGroupEmail: true, accountOwnerUserId: 'u', enrichmentMetadata: { a: 1 } };
      const { r, logs } = run(clean, mode);
      expect(r.body).toBe(clean);
      expect(logs).toEqual([]);
    }
  });

  it('never drops the compliance keys the portal buttons use', () => {
    const b = { contactStatus: 'active', contactStatusReason: null, contactStatusNote: null, unsubscribedFromGroupEmail: false, unsubscribedFromGroupEmailAt: '2026-01-01T00:00:00.000Z' };
    expect(run(b, 'enforce').r.body).toEqual(b);
  });

  it('enforce: the client no longer decides who or when; the authenticated user is stamped', () => {
    const { r } = run({ contactStatus: 'do-not-contact', contactStatusUpdatedBy: 'forged@example.invalid', contactStatusUpdatedAt: '2020-01-01T00:00:00.000Z' }, 'enforce');
    expect(r.body).toEqual({ contactStatus: 'do-not-contact', contactStatusUpdatedBy: 'user-1' });
  });
  it('enforce: no stamp when contactStatus is absent or null (updateLead writes no actor/time then)', () => {
    expect(run({ contactStatusUpdatedBy: 'x', notes: 'n' }, 'enforce').r.body).toEqual({ notes: 'n' });
    expect(run({ contactStatus: null, contactStatusUpdatedBy: 'x' }, 'enforce').r.body).toEqual({ contactStatus: null });
  });
  it.each(['', 'active', 5, { a: 1 }, false])('enforce: stamps the authenticated user whenever updateLead would write the actor/time pair (contactStatus=%p), never the client value', (v) => {
    expect(run({ contactStatus: v, contactStatusUpdatedBy: 'forged@example.invalid' }, 'enforce').r.body).toEqual({ contactStatus: v, contactStatusUpdatedBy: 'user-1' });
  });

  it('the log line carries key names, channel and user id only, never a value', () => {
    const secret = 'SECRET-VALUE-jane@acme.com';
    const { logs } = run({ syncMetadata: { hubspot_contact_id: secret }, utmSource: secret, firstName: secret }, 'log');
    const line = JSON.stringify(logs);
    expect(line).not.toContain('SECRET');
    expect(line).not.toContain('acme');
    expect(Object.keys(logs[0][1]).sort()).toEqual(['channel', 'dropped', 'keys', 'mode', 'userId']);
  });

  it('reports the agent channel', () => {
    expect(run({ syncMetadata: {} }, 'log', { channel: 'agent' }).logs[0][1].channel).toBe('agent');
  });

  it.each([null, undefined, 'str', 5, true, [], [{ syncMetadata: 1 }]])('non-object body %p passes through untouched', (b) => {
    const { r, logs } = run(b, 'enforce');
    expect(r.body).toBe(b);
    expect(logs).toEqual([]);
  });

  it('a throwing logger cannot affect the request, and enforce still drops', () => {
    const r = guardLeadPutBody({ syncMetadata: {}, a: 1 }, { mode: 'enforce', channel: 'ui', userId: 'u', log: () => { throw new Error('sink down'); } });
    expect(r.body).toEqual({ a: 1 });
  });

  it('a hostile body (getter that throws, huge key count) cannot throw out of the guard', () => {
    const evil: any = {}; Object.defineProperty(evil, 'syncMetadata', { enumerable: true, get() { throw new Error('boom'); } });
    expect(() => run(evil, 'enforce')).not.toThrow();
    const big: Record<string, number> = {}; for (let i = 0; i < 5000; i++) big['k' + i] = i; big.syncMetadata = 1;
    const t0 = Date.now(); const { r } = run(big, 'log'); expect(Date.now() - t0).toBeLessThan(200);
    expect(r.body).toBe(big);
  });

  it.each([600, 5000, 50000])('padding the body with %p filler keys cannot hide a server-owned key (reported in log mode, dropped in enforce mode)', (n) => {
    const padded: Record<string, unknown> = {}; for (let i = 0; i < n; i++) padded['filler' + i] = i;
    padded.syncMetadata = { hubspot_contact_id: 'FORGED' }; padded.lastAutoSendAt = null;
    expect(run(padded, 'log').r.flaggedKeys.sort()).toEqual(['lastAutoSendAt', 'syncMetadata']);
    const e = run(padded, 'enforce').r.body;
    expect('syncMetadata' in e).toBe(false);
    expect('lastAutoSendAt' in e).toBe(false);
    expect(Object.keys(e)).toHaveLength(n);
  });

  it('inherited properties are not treated as keys the client sent', () => {
    const inherited = Object.create({ syncMetadata: { x: 1 } }); inherited.firstName = 'A';
    expect(run(inherited, 'enforce').r.flaggedKeys).toEqual([]);
  });

  it('reports at most 25 keys', () => {
    const b: Record<string, number> = {}; for (const k of SERVER_OWNED_LEAD_KEYS) b[k] = 1;
    expect(((run(b, 'log').logs[0][1].keys) as string[]).length).toBeLessThanOrEqual(25);
  });

  it('the drop list contains none of the keys a verified caller sends (portal drawer, edit dialog, drafts, deal editor, Emma)', () => {
    const legit = ['email', 'firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin', 'companyLinkedin', 'customFields', 'selectedSenderId',
      'emailDraft', 'emailDraftFormat', 'messageDraft', 'icpMatch', 'status', 'dealValue', 'dealCurrency', 'enrichmentMetadata', 'accountOwnerUserId', 'pocEmails',
      'contactStatus', 'contactStatusReason', 'contactStatusNote', 'unsubscribedFromGroupEmail', 'unsubscribedFromGroupEmailAt', 'lifecycle'];
    for (const k of legit) expect(SERVER_OWNED_LEAD_KEYS).not.toContain(k);
  });
});

describe('contactSuppressionAuditEvent (ENG-2157)', () => {
  const base = { actorUserId: 'user-1', channel: 'ui' as const, now: new Date('2026-10-12T12:00:00.000Z') };

  it('records Mark Do Not Contact with the real actor and a server timestamp', () => {
    const ev = contactSuppressionAuditEvent({ ...base, before: { contactStatus: 'active' }, updates: { contactStatus: 'do-not-contact', contactStatusReason: 'admin-flagged', unsubscribedFromGroupEmail: true } });
    expect(ev).toMatchObject({
      eventType: 'contact_status.changed', createdAt: '2026-10-12T12:00:00.000Z',
      eventData: { fromStatus: 'active', toStatus: 'do-not-contact', fromGroupEmailUnsubscribed: false, toGroupEmailUnsubscribed: true, reason: 'admin-flagged', actorUserId: 'user-1', channel: 'ui', via: 'lead-put' },
    });
    expect((ev!.eventData as any).note).toBe('Contact status: active → do-not-contact; Group email: unsubscribed');
  });

  it('records clearing a suppression (Remove / Resubscribe)', () => {
    const ev = contactSuppressionAuditEvent({ ...base, before: { contactStatus: 'unsubscribed', unsubscribedFromGroupEmail: true }, updates: { contactStatus: 'active', contactStatusReason: null, unsubscribedFromGroupEmail: false } });
    expect((ev!.eventData as any).note).toBe('Contact status: unsubscribed → active; Group email: subscribed');
    expect((ev!.eventData as any).reason).toBeNull();
  });

  it('records the legacy-flag-only Resubscribe (just unsubscribedFromGroupEmail:false)', () => {
    const ev = contactSuppressionAuditEvent({ ...base, before: { unsubscribedFromGroupEmail: true }, updates: { unsubscribedFromGroupEmail: false } });
    expect((ev!.eventData as any).note).toBe('Group email: subscribed');
  });

  it('records nothing when the stored state does not change (no-op writes, repeated clicks)', () => {
    expect(contactSuppressionAuditEvent({ ...base, before: { contactStatus: 'active' }, updates: { contactStatus: 'active' } })).toBeNull();
    expect(contactSuppressionAuditEvent({ ...base, before: { contactStatus: 'do-not-contact', unsubscribedFromGroupEmail: true }, updates: { contactStatus: 'do-not-contact', unsubscribedFromGroupEmail: true } })).toBeNull();
    expect(contactSuppressionAuditEvent({ ...base, before: { unsubscribedFromGroupEmail: false }, updates: { unsubscribedFromGroupEmail: false } })).toBeNull();
    expect(contactSuppressionAuditEvent({ ...base, before: {}, updates: { contactStatus: null } })).toBeNull();
    expect(contactSuppressionAuditEvent({ ...base, before: { contactStatus: 'active' }, updates: { notes: 'x' } })).toBeNull();
  });

  it('records the delegated admin when an admin acts as the customer', () => {
    const ev = contactSuppressionAuditEvent({ ...base, delegatedByUserId: 'admin-9', before: { contactStatus: 'active' }, updates: { contactStatus: 'do-not-contact' } });
    expect((ev!.eventData as any).delegatedByUserId).toBe('admin-9');
    expect((contactSuppressionAuditEvent({ ...base, before: { contactStatus: 'active' }, updates: { contactStatus: 'do-not-contact' } })!.eventData as any).delegatedByUserId).toBeUndefined();
  });

  it('never trusts client-supplied actor or time', () => {
    const ev = contactSuppressionAuditEvent({ ...base, before: { contactStatus: 'active' }, updates: { contactStatus: 'do-not-contact', contactStatusUpdatedBy: 'forged@example.invalid', contactStatusUpdatedAt: '2020-01-01T00:00:00.000Z' } });
    expect(JSON.stringify(ev)).not.toContain('forged');
    expect(ev!.createdAt).toBe('2026-10-12T12:00:00.000Z');
    expect((ev!.eventData as any).actorUserId).toBe('user-1');
  });

  // db.addLeadEngagement raises isEngaged when the event's type or JSON mentions these words. The PUT route does not validate contactStatus.
  it.each(['replied', 'clicked', 'received', 'Replied to you', '<script>', 'x'.repeat(5000)])('arbitrary client text %p never reaches the stored event', (evil) => {
    const ev = contactSuppressionAuditEvent({ ...base, before: { contactStatus: 'active' }, updates: { contactStatus: evil, contactStatusReason: evil } });
    const text = JSON.stringify(ev).toLowerCase();
    for (const kw of ['clicked', 'replied', 'received']) expect(text).not.toContain(kw);
    expect(text.length).toBeLessThan(1500);
    expect((ev!.eventData as any).toStatus).toBe('other');
  });

  // The portal's Engagements dialog (customer-portal CRM.tsx ~9166) does `const from = eventData.from || ''` and renders {from} for EVERY event type, and
  // `to.join(', ')`: an object-valued from/to throws "Objects are not valid as a React child" and takes the page down.
  it('the event is flat: every eventData value is a primitive, and no key collides with the portal dialog\'s from/to/subject/message/content/platform', () => {
    const cases: Array<[any, any]> = [
      [{ contactStatus: 'active' }, { contactStatus: 'do-not-contact', contactStatusReason: 'admin-flagged', unsubscribedFromGroupEmail: true }],
      [{ contactStatus: 'unsubscribed', unsubscribedFromGroupEmail: true }, { contactStatus: 'active', contactStatusReason: null, unsubscribedFromGroupEmail: false }],
      [{}, { unsubscribedFromGroupEmail: true }],
      [{ contactStatus: 'active' }, { contactStatus: { evil: 1 }, contactStatusReason: ['x'] }],
    ];
    for (const [b, u] of cases) {
      const ev = contactSuppressionAuditEvent({ ...base, delegatedByUserId: 'admin-9', before: b, updates: u })!;
      expect(ev).not.toBeNull();
      for (const [k, v] of Object.entries(ev.eventData)) {
        expect(['string', 'boolean']).toContain(v === null ? 'string' : typeof v);
        expect(['from', 'to', 'subject', 'message', 'content', 'platform']).not.toContain(k);
      }
    }
  });

  it('every normal event is free of the engaged keywords', () => {
    for (const [b, u] of [
      [{ contactStatus: 'active' }, { contactStatus: 'do-not-contact', contactStatusReason: 'requested-removal', unsubscribedFromGroupEmail: true }],
      [{ contactStatus: 'unsubscribed', unsubscribedFromGroupEmail: true }, { contactStatus: 'active', unsubscribedFromGroupEmail: false }],
    ] as const) {
      const text = JSON.stringify(contactSuppressionAuditEvent({ ...base, before: b, updates: u })).toLowerCase();
      for (const kw of ['clicked', 'replied', 'received']) expect(text).not.toContain(kw);
    }
  });

  it.each([null, undefined, 'x', 5, []])('bad input %p returns null and never throws', (v) => {
    expect(() => contactSuppressionAuditEvent({ ...base, before: v as any, updates: { contactStatus: 'active' } })).not.toThrow();
    expect(contactSuppressionAuditEvent({ ...base, before: {}, updates: v as any })).toBeNull();
  });

  it('touchesContactSuppression', () => {
    expect(touchesContactSuppression({ contactStatus: 'active' })).toBe(true);
    expect(touchesContactSuppression({ unsubscribedFromGroupEmail: false })).toBe(true);
    expect(touchesContactSuppression({ notes: 'x' })).toBe(false);
    expect(touchesContactSuppression(null)).toBe(false);
    expect(touchesContactSuppression([])).toBe(false);
  });
});
