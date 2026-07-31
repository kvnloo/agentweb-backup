// ENG-787: a sent LinkedIn invitation must be mirrored back into the CRM lead list.
// These tests pin the reconciliation core (find-or-create the lead, mark it
// 'contacted', stamp linkedInInviteSentAt, append a linkedin.invite.sent engagement)
// independent of the LLM/outreach caller.

const getLeadById = jest.fn();
const findLeadsByLinkedin = jest.fn();
const createLead = jest.fn();
const updateLead = jest.fn();
const addLeadEngagement = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: (...a: any[]) => getLeadById(...a),
    findLeadsByLinkedin: (...a: any[]) => findLeadsByLinkedin(...a),
    createLead: (...a: any[]) => createLead(...a),
    updateLead: (...a: any[]) => updateLead(...a),
    addLeadEngagement: (...a: any[]) => addLeadEngagement(...a),
  },
}));

import { mirrorLinkedInInviteToCrm } from '../services/linkedInInviteCrmMirror';

const LIST = 'list_1782945941846_b0ptvsguv';

describe('mirrorLinkedInInviteToCrm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findLeadsByLinkedin.mockResolvedValue([]);
    createLead.mockResolvedValue({ leadId: 'lead_new_1' });
    updateLead.mockResolvedValue({});
    addLeadEngagement.mockResolvedValue({});
    getLeadById.mockResolvedValue(null);
  });

  // ---- FAIL / no-op cases ----

  it('returns null and writes nothing when the LinkedIn URL is missing/blank', async () => {
    expect(await mirrorLinkedInInviteToCrm({ listId: LIST, linkedinUrl: '' })).toBeNull();
    expect(await mirrorLinkedInInviteToCrm({ listId: LIST, linkedinUrl: '   ' })).toBeNull();
    expect(createLead).not.toHaveBeenCalled();
    expect(addLeadEngagement).not.toHaveBeenCalled();
    expect(updateLead).not.toHaveBeenCalled();
  });

  it('returns null when the URL is not a personal /in/ profile (company page)', async () => {
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/company/acme',
    });
    expect(res).toBeNull();
    expect(createLead).not.toHaveBeenCalled();
  });

  it('returns null when listId is missing', async () => {
    const res = await mirrorLinkedInInviteToCrm({
      listId: '',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
    });
    expect(res).toBeNull();
    expect(createLead).not.toHaveBeenCalled();
  });

  // ---- dry-run (preview counts, no writes) ----

  it('dryRun reports created=true for an absent invitee without writing', async () => {
    findLeadsByLinkedin.mockResolvedValue([]);
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/in/new-person',
      dryRun: true,
    });
    expect(res).toEqual({ leadId: '', created: true });
    expect(createLead).not.toHaveBeenCalled();
    expect(updateLead).not.toHaveBeenCalled();
    expect(addLeadEngagement).not.toHaveBeenCalled();
  });

  it('dryRun reports created=false with the existing leadId for a matched invitee, no writes', async () => {
    findLeadsByLinkedin.mockResolvedValue([{ leadId: 'lead_existing', listId: LIST, status: 'new' }]);
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/in/existing',
      dryRun: true,
    });
    expect(res).toEqual({ leadId: 'lead_existing', created: false });
    expect(createLead).not.toHaveBeenCalled();
    expect(updateLead).not.toHaveBeenCalled();
    expect(addLeadEngagement).not.toHaveBeenCalled();
  });

  // ---- create path (invitee not yet in CRM — the reporter's disjoint set) ----

  it('creates a contacted lead + engagement when the invitee is not in the list', async () => {
    const res = await mirrorLinkedInInviteToCrm({
      userId: 'user_1',
      listId: LIST,
      linkedinUrl: 'https://linkedin.com/in/David-Yao/?miniProfileUrn=x',
      firstName: 'David',
      lastName: 'Yao',
      company: 'Acme',
      note: 'David, saw your work...',
      accountId: 'tMgX8uZJTZWTG_mFY1aI2A',
    });

    expect(res).toEqual({ leadId: 'lead_new_1', created: true });
    // normalized (lowercased, query/trailing-slash stripped, www-canonical)
    expect(createLead).toHaveBeenCalledWith(LIST, expect.objectContaining({
      linkedin: 'https://www.linkedin.com/in/david-yao',
      firstName: 'David',
      lastName: 'Yao',
      company: 'Acme',
      status: 'contacted',
      userId: 'user_1',
    }));
    expect(addLeadEngagement).toHaveBeenCalledWith(LIST, 'lead_new_1', expect.objectContaining({
      eventType: 'linkedin.invite.sent',
      eventData: expect.objectContaining({
        note: 'David, saw your work...',
        accountId: 'tMgX8uZJTZWTG_mFY1aI2A',
        linkedin: 'https://www.linkedin.com/in/david-yao',
      }),
    }));
    // stamps the invite timestamp
    expect(updateLead).toHaveBeenCalledWith(LIST, 'lead_new_1', expect.objectContaining({
      linkedInInviteSentAt: expect.any(String),
    }));
  });

  it('does not reuse a same-URL lead that lives in a DIFFERENT list', async () => {
    findLeadsByLinkedin.mockResolvedValue([
      { leadId: 'lead_other', listId: 'some_other_list', status: 'won' },
    ]);
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/in/david-yao',
    });
    expect(res?.created).toBe(true);
    expect(createLead).toHaveBeenCalledTimes(1);
  });

  // ---- update path (invitee already a lead) ----

  it('marks an existing uncontacted lead as contacted and logs the invite', async () => {
    findLeadsByLinkedin.mockResolvedValue([
      { leadId: 'lead_existing', listId: LIST, status: 'new' },
    ]);
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/in/david-yao',
    });
    expect(res).toEqual({ leadId: 'lead_existing', created: false });
    expect(createLead).not.toHaveBeenCalled();
    expect(updateLead).toHaveBeenCalledWith(LIST, 'lead_existing', expect.objectContaining({
      status: 'contacted',
      linkedInInviteSentAt: expect.any(String),
    }));
    expect(addLeadEngagement).toHaveBeenCalledWith(LIST, 'lead_existing', expect.objectContaining({
      eventType: 'linkedin.invite.sent',
    }));
  });

  it('never regresses a lead already further along the funnel', async () => {
    findLeadsByLinkedin.mockResolvedValue([
      { leadId: 'lead_hot', listId: LIST, status: 'meeting_booked' },
    ]);
    await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/in/david-yao',
    });
    const call = updateLead.mock.calls[0];
    expect(call[2]).not.toHaveProperty('status');
    expect(call[2]).toHaveProperty('linkedInInviteSentAt');
    expect(addLeadEngagement).toHaveBeenCalled();
  });

  it('uses the known leadId when the caller already has one (manual CRM button)', async () => {
    getLeadById.mockResolvedValue({ leadId: 'lead_known', listId: LIST, status: '' });
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      leadId: 'lead_known',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      sentAt: '2026-07-31T00:00:00.000Z',
    });
    expect(res).toEqual({ leadId: 'lead_known', created: false });
    expect(findLeadsByLinkedin).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    expect(updateLead).toHaveBeenCalledWith(LIST, 'lead_known', {
      status: 'contacted',
      linkedInInviteSentAt: '2026-07-31T00:00:00.000Z',
    });
    expect(addLeadEngagement).toHaveBeenCalledWith(LIST, 'lead_known', expect.objectContaining({
      eventType: 'linkedin.invite.sent',
      createdAt: '2026-07-31T00:00:00.000Z',
    }));
  });
});
