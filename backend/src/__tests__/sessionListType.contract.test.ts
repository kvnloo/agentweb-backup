/**
 * ENG-2311 — contract for the 'session' lead-list type.
 *
 * Pins only the invariants other code now depends on:
 *   1. the accepted listType vocabulary (and that sales/customers are untouched),
 *   2. a session list's default statusConfig can never express a conversion,
 *   3. cross-list "contacts" never silently include session rows,
 *   4. owner alerts and Slack lead notifications are suppressed for session lists only.
 * The forward-lead / crmPublic gating lives in webhooks.forwardLead.sessionList.test.ts.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadListById: jest.fn(),
    getLeadById: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/emailService', () => ({ emailService: { sendEmail: jest.fn(), escapeHtml: (s: string) => s } }));
jest.mock('../services/slackService', () => ({ sendLeadNotification: jest.fn() }));

import { crmDb, userDb } from '../services/db';
import { LEAD_LIST_TYPES, isLeadListType, defaultStatusConfigFor } from '../utils/leadSchema';
import { isSessionList, suppressLeadSideEffects, excludeSessionLists } from '../utils/sessionList';
import { dedupContactsForUser } from '../services/contactDedupService';
import { leadListAlertService } from '../services/leadListAlertService';
import { dispatchLeadCreated } from '../services/orgLeadNotificationService';
import { mapStatusToMetaEvent } from '../services/metaConversionRelay';

describe('listType vocabulary', () => {
  it('accepts exactly sales | customers | session', () => {
    expect([...LEAD_LIST_TYPES]).toEqual(['sales', 'customers', 'session']);
    for (const ok of ['sales', 'customers', 'session']) expect(isLeadListType(ok)).toBe(true);
  });

  it.each(['Session', 'SESSION', ' session', 'sessions', '', 'bogus', null, undefined, 1, {}, ['session']])(
    'rejects %p',
    (bad) => expect(isLeadListType(bad)).toBe(false),
  );

  it('isSessionList is true ONLY for listType === "session" (unset / sales / customers are not)', () => {
    expect(isSessionList({ listType: 'session' })).toBe(true);
    for (const l of [{}, { listType: 'sales' }, { listType: 'customers' }, { listType: undefined }, null, undefined]) {
      expect(isSessionList(l as any)).toBe(false);
      expect(suppressLeadSideEffects(l as any)).toBe(false);
    }
  });

  it('excludeSessionLists keeps every non-session list in order and tolerates a failed read', () => {
    const lists = [{ listId: 'a' }, { listId: 'b', listType: 'session' }, { listId: 'c', listType: 'customers' }, { listId: 'd', listType: 'sales' }];
    expect(excludeSessionLists(lists).map((l) => l.listId)).toEqual(['a', 'c', 'd']);
    expect(excludeSessionLists(undefined)).toEqual([]);
  });
});

describe('defaultStatusConfigFor', () => {
  it('session: non-empty, only non-terminal entries, so no status can express a conversion', () => {
    const cfg = defaultStatusConfigFor('session');
    expect(cfg.length).toBeGreaterThan(0);
    expect(cfg.every((s) => s.type === 'active')).toBe(true);
    // The relay maps won/qualified-ish statuses to Meta events; nothing here may.
    for (const s of cfg) expect(mapStatusToMetaEvent(cfg as any, s.value)).toBeNull();
  });

  it('sales (and unset) and customers keep their existing vocabulary', () => {
    expect(defaultStatusConfigFor('sales').map((s) => s.value)).toEqual(
      ['new', 'contacted', 'qualified', 'proposal_sent', 'negotiating', 'won', 'lost', 'churned']);
    expect(defaultStatusConfigFor(undefined)).toEqual(defaultStatusConfigFor('sales'));
    expect(defaultStatusConfigFor('customers').map((s) => s.value)).toEqual(['onboarding', 'active', 'at_risk', 'churned']);
  });

  it('returns fresh objects each call (it is persisted and handed to callers)', () => {
    const a = defaultStatusConfigFor('session');
    a[0].label = 'mutated';
    expect(defaultStatusConfigFor('session')[0].label).toBe('New');
  });
});

describe('cross-list contacts', () => {
  const lists = [
    { listId: 'S', listType: 'sales' },
    { listId: 'U' }, // legacy list with no listType counts as sales
    { listId: 'C', listType: 'customers' },
    { listId: 'X', listType: 'session' },
  ];
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue(lists);
    (crmDb.getLeadsByListId as jest.Mock).mockImplementation(async (listId: string) => ({
      items: [{ leadId: `l_${listId}`, email: `${listId.toLowerCase()}@x.com`, engagementCount: 1 }],
      lastEvaluatedKey: null,
    }));
  });
  const readListIds = () => (crmDb.getLeadsByListId as jest.Mock).mock.calls.map((c) => c[0]).sort();

  it('with no listType filter, session lists are never read and sales/unset/customers all are', async () => {
    const r = await dedupContactsForUser({ userId: 'u1' });
    expect(readListIds()).toEqual(['C', 'S', 'U']);
    expect(r.listsCount).toBe(3);
  });

  it('listType "session" reads only the session lists (explicit opt-in)', async () => {
    await dedupContactsForUser({ userId: 'u1', listType: 'session' });
    expect(readListIds()).toEqual(['X']);
  });

  it('listType "sales" is unchanged: sales + unset', async () => {
    await dedupContactsForUser({ userId: 'u1', listType: 'sales' });
    expect(readListIds()).toEqual(['S', 'U']);
  });
});

describe('side-effect suppression for notifications', () => {
  beforeEach(() => jest.clearAllMocks());

  it('owner alert email path is never reached for a session list', async () => {
    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      { listId: 'X', userId: 'u1', listType: 'session', alertEvents: ['api.lead_added', 'api.lead_failed'] },
      { leadId: 'l1', email: 's-abc@sessions.go.dramabreak.ai' },
      'api.lead_added', {}, new Date().toISOString(),
    );
    expect(userDb.getUserById).not.toHaveBeenCalled();
  });

  it('owner alert still proceeds for a sales list (gate is not over-broad)', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(undefined); // stop right after the lookup
    await leadListAlertService.notifyLeadListOwnerIfConfigured(
      { listId: 'S', userId: 'u1', listType: 'sales', alertEvents: ['api.lead_added'] },
      { leadId: 'l1' }, 'api.lead_added', {}, new Date().toISOString(),
    );
    expect(userDb.getUserById).toHaveBeenCalledWith('u1');
  });

  it('Slack lead notification stops at routing for a session list and never loads the owner', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'X', userId: 'u1', listType: 'session' });
    await dispatchLeadCreated('X', 'l1');
    expect(userDb.getUserById).not.toHaveBeenCalled();
  });

  it('Slack lead notification proceeds to routing for a sales list', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'S', userId: 'u1', listType: 'sales' });
    (userDb.getUserById as jest.Mock).mockResolvedValue(undefined);
    await dispatchLeadCreated('S', 'l1');
    expect(userDb.getUserById).toHaveBeenCalledWith('u1');
  });
});
