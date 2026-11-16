/**
 * ENG-2996: CRM import validation + suppression enforcement.
 *
 * AC1 — bulk/CSV import and Emma add_leads_to_list validate each imported email
 *        (once per address) via validateLeadEmailInBackground.
 * AC2 — Emma suppression writes (update_lead / update_lead_status with status
 *        'do-not-contact') also set contactStatus, so isDoNotContact and
 *        contactGuard.blockedRecipients block the lead.
 * AC3 — an imported lead whose email matches an existing do-not-contact lead of
 *        the same owner inherits do-not-contact.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
    addLeadEngagement: jest.fn(),
    batchCreateLeads: jest.fn(),
    findAllLeadsByEmail: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgMembers: jest.fn() },
}));
jest.mock('../services/crmAccessControl', () => ({
  ...jest.requireActual('../services/crmAccessControl'),
  canDestructiveCrmList: jest.fn().mockResolvedValue(true),
}));
jest.mock('../services/enrichSoLeadValidation', () => ({
  validateLeadEmailInBackground: jest.fn().mockResolvedValue({ status: 'deliverable' }),
}));
jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: { autoSyncLead: jest.fn().mockResolvedValue(undefined) },
}));

import { crmDb, userDb } from '../services/db';
import { validateLeadEmailInBackground } from '../services/enrichSoLeadValidation';
import { applyLeadImportFollowups } from '../services/leadImportFollowups';
import { addLeadsToList, updateLead, updateLeadStatus } from '../emma/impl/leads';
import { isDoNotContact } from '../utils/leadContactStatus';
import { blockedRecipients } from '../services/contactGuard';

const db = crmDb as jest.Mocked<typeof crmDb>;
const validate = validateLeadEmailInBackground as jest.Mock;
const flush = () => new Promise((r) => setImmediate(r));

const OWNER = 'owner-1';

beforeEach(() => {
  jest.clearAllMocks();
  db.getLeadListById.mockImplementation(async (id: string) => ({ listId: id, userId: id === 'other-list' ? 'someone-else' : OWNER }) as any);
  db.updateLead.mockResolvedValue(undefined as any);
  db.addLeadEngagement.mockResolvedValue(undefined as any);
  db.findAllLeadsByEmail.mockResolvedValue([] as any);
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: OWNER });
});

describe('applyLeadImportFollowups', () => {
  it('AC1: validates each imported email once per address (case/space-insensitive), skipping email-less rows', async () => {
    await applyLeadImportFollowups('L1', OWNER, [
      { leadId: 'a', email: 'Ann@Acme.com' },
      { leadId: 'b', email: ' ann@acme.com ' },
      { leadId: 'c', email: 'bob@acme.com' },
      { leadId: 'd' },
      { leadId: 'e', email: '' },
    ], { actingUserId: OWNER });
    await flush();

    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledWith('L1', 'a', 'Ann@Acme.com', OWNER);
    expect(validate).toHaveBeenCalledWith('L1', 'c', 'bob@acme.com', OWNER);
  });

  it('AC1: validate:false skips paid validation (session lists)', async () => {
    await applyLeadImportFollowups('L1', OWNER, [{ leadId: 'a', email: 'ann@acme.com' }], { actingUserId: OWNER, validate: false });
    await flush();
    expect(validate).not.toHaveBeenCalled();
  });

  it('AC3: inherits do-not-contact from an existing same-owner DNC lead with the same email', async () => {
    db.findAllLeadsByEmail.mockImplementation(async (email: string) => (email === 'ann@acme.com'
      ? [
          { leadId: 'a', listId: 'L1', userId: OWNER, email }, // the new row itself
          { leadId: 'old', listId: 'L0', userId: OWNER, email, contactStatus: 'do-not-contact', contactStatusReason: 'opted-out' },
        ]
      : []) as any);

    const r = await applyLeadImportFollowups('L1', OWNER, [
      { leadId: 'a', email: 'Ann@acme.com' },
      { leadId: 'c', email: 'bob@acme.com' },
    ], { actingUserId: OWNER });

    expect(r.inheritedDoNotContact).toEqual(['a']);
    expect(db.updateLead).toHaveBeenCalledTimes(1);
    const [listId, leadId, updates] = db.updateLead.mock.calls[0] as any[];
    expect(listId).toBe('L1');
    expect(leadId).toBe('a');
    expect(updates.contactStatus).toBe('do-not-contact');
    expect(updates.contactStatusReason).toBe('opted-out');
    expect(updates.unsubscribedFromGroupEmail).toBe(true);
    expect(isDoNotContact(updates)).toBe(true);
  });

  it('AC3: inherits from a legacy-flag lead and from a lead whose owner is resolved through its list', async () => {
    db.findAllLeadsByEmail.mockResolvedValue([
      { leadId: 'old', listId: 'L0', email: 'ann@acme.com', unsubscribedFromGroupEmail: true },
    ] as any);
    const r = await applyLeadImportFollowups('L1', OWNER, [{ leadId: 'a', email: 'ann@acme.com' }], { actingUserId: OWNER });
    expect(r.inheritedDoNotContact).toEqual(['a']);
  });

  it('AC3: does NOT inherit from another owner\'s do-not-contact lead', async () => {
    db.findAllLeadsByEmail.mockResolvedValue([
      { leadId: 'x', listId: 'other-list', userId: 'someone-else', email: 'ann@acme.com', contactStatus: 'do-not-contact' },
      { leadId: 'y', listId: 'other-list', email: 'ann@acme.com', contactStatus: 'do-not-contact' },
    ] as any);
    const r = await applyLeadImportFollowups('L1', OWNER, [{ leadId: 'a', email: 'ann@acme.com' }], { actingUserId: OWNER });
    expect(r.inheritedDoNotContact).toEqual([]);
    expect(db.updateLead).not.toHaveBeenCalled();
  });

  it('a failed do-not-contact lookup is counted, never silently treated as clear, and does not throw', async () => {
    db.findAllLeadsByEmail.mockRejectedValue(new Error('ddb down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await applyLeadImportFollowups('L1', OWNER, [{ leadId: 'a', email: 'ann@acme.com' }], { actingUserId: OWNER });
    expect(r.doNotContactCheckFailed).toBe(1);
    errSpy.mockRestore();
  });
});

describe('Emma add_leads_to_list (AC1 + AC3)', () => {
  it('validates created leads and inherits do-not-contact from the owner\'s existing DNC lead', async () => {
    db.batchCreateLeads.mockResolvedValue({
      successCount: 2, newCount: 2, mergedCount: 0, errorCount: 0, errors: [], anonymizedSkipped: 0, alreadyPresentCount: 0,
      created: [{ leadId: 'n1', email: 'ann@acme.com', sourceIndex: 0 }, { leadId: 'n2', email: 'bob@acme.com', sourceIndex: 1 }],
      rowOutcomes: ['created', 'created'],
    } as any);
    db.findAllLeadsByEmail.mockImplementation(async (email: string) => (email === 'bob@acme.com'
      ? [{ leadId: 'old', listId: 'L0', userId: OWNER, email, contactStatus: 'unsubscribed' }]
      : []) as any);

    const r = await addLeadsToList('L1', [{ email: 'ann@acme.com' }, { email: 'bob@acme.com' }], OWNER);
    await flush();

    expect(r.success).toBe(true);
    expect(validate).toHaveBeenCalledWith('L1', 'n1', 'ann@acme.com', OWNER);
    expect(validate).toHaveBeenCalledWith('L1', 'n2', 'bob@acme.com', OWNER);
    expect(db.updateLead).toHaveBeenCalledWith('L1', 'n2', expect.objectContaining({ contactStatus: 'do-not-contact' }));
    expect(r.inheritedDoNotContact).toBe(1);
  });
});

describe('Emma suppression writes set contactStatus (AC2)', () => {
  const lead = { leadId: 'D', listId: 'L1', userId: OWNER, email: 'ann@acme.com', status: 'contacted' };

  beforeEach(() => {
    db.getLeadById.mockResolvedValue({ ...lead } as any);
  });

  async function assertBlocked(updates: any) {
    const stored = { ...lead, ...updates };
    expect(updates.contactStatus).toBe('do-not-contact');
    expect(isDoNotContact(stored)).toBe(true);
    db.findAllLeadsByEmail.mockResolvedValue([stored] as any);
    await expect(blockedRecipients([OWNER], 'ann@acme.com')).resolves.toEqual(['ann@acme.com']);
  }

  it('update_lead_status to do-not-contact flags contactStatus and is blocked by the guard', async () => {
    const r = await updateLeadStatus('L1', 'D', 'do-not-contact', OWNER);
    expect(r.success).toBe(true);
    await assertBlocked(db.updateLead.mock.calls[0][2]);
  });

  it('update_lead with status "Do Not Contact" flags contactStatus and is blocked by the guard', async () => {
    const r = await updateLead('L1', 'D', { status: 'Do Not Contact' }, OWNER);
    expect(r.success).toBe(true);
    await assertBlocked(db.updateLead.mock.calls[0][2]);
  });

  it('an ordinary status change leaves contactStatus untouched', async () => {
    await updateLeadStatus('L1', 'D', 'qualified', OWNER);
    expect((db.updateLead.mock.calls[0][2] as any).contactStatus).toBeUndefined();
  });

  it('does not overwrite an existing unsubscribed status', async () => {
    db.getLeadById.mockResolvedValue({ ...lead, contactStatus: 'unsubscribed' } as any);
    await updateLeadStatus('L1', 'D', 'do-not-contact', OWNER);
    expect((db.updateLead.mock.calls[0][2] as any).contactStatus).toBeUndefined();
  });
});
