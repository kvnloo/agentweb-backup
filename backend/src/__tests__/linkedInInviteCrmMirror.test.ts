// ENG-787: a sent LinkedIn invitation must be mirrored back into the CRM lead list.
// These tests pin the reconciliation core (find-or-create the lead, mark it
// 'contacted', stamp linkedInInviteSentAt, append a linkedin.invite.sent engagement)
// independent of the LLM/outreach caller.

const getLeadById = jest.fn();
const findLeadByLinkedinInList = jest.fn();
const createLead = jest.fn();
const updateLead = jest.fn();
const addLeadEngagement = jest.fn();

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: (...a: any[]) => getLeadById(...a),
    findLeadByLinkedinInList: (...a: any[]) => findLeadByLinkedinInList(...a),
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
    findLeadByLinkedinInList.mockResolvedValue(null);
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
    findLeadByLinkedinInList.mockResolvedValue(null);
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/in/new-person',
      dryRun: true,
    });
    expect(res).toEqual({ leadId: '', created: true, engagementLogged: true });
    expect(createLead).not.toHaveBeenCalled();
    expect(updateLead).not.toHaveBeenCalled();
    expect(addLeadEngagement).not.toHaveBeenCalled();
  });

  it('dryRun reports created=false with the existing leadId for a matched invitee, no writes', async () => {
    findLeadByLinkedinInList.mockResolvedValue({ leadId: 'lead_existing', listId: LIST, status: 'new' });
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/in/existing',
      dryRun: true,
    });
    expect(res).toEqual({ leadId: 'lead_existing', created: false, engagementLogged: true });
    expect(createLead).not.toHaveBeenCalled();
    expect(updateLead).not.toHaveBeenCalled();
    expect(addLeadEngagement).not.toHaveBeenCalled();
  });

  it('dryRun reports engagementLogged=false when the invitation is already recorded', async () => {
    findLeadByLinkedinInList.mockResolvedValue({
      leadId: 'lead_existing',
      listId: LIST,
      status: 'contacted',
      engagements: [{
        eventType: 'linkedin.invite.sent',
        createdAt: '2026-07-20T00:00:00.000Z',
        eventData: { accountId: 'acct_1', linkedin: 'https://www.linkedin.com/in/existing' },
      }],
    });
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/in/existing',
      accountId: 'acct_1',
      sentAt: '2026-07-20T00:00:00.000Z',
      dryRun: true,
    });
    expect(res).toEqual({ leadId: 'lead_existing', created: false, engagementLogged: false });
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

    expect(res).toEqual({ leadId: 'lead_new_1', created: true, engagementLogged: true });
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

  it('scopes the lookup to the target list so a same-URL lead elsewhere is never reused', async () => {
    // findLeadByLinkedinInList filters on listId server-side, so a foreign-list lead
    // can never come back — the invitee is created in THIS list instead.
    findLeadByLinkedinInList.mockResolvedValue(null);
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/in/david-yao',
    });
    expect(findLeadByLinkedinInList).toHaveBeenCalledWith(LIST, 'https://www.linkedin.com/in/david-yao');
    expect(res?.created).toBe(true);
    expect(createLead).toHaveBeenCalledTimes(1);
  });

  // ---- update path (invitee already a lead) ----

  it('marks an existing uncontacted lead as contacted and logs the invite', async () => {
    findLeadByLinkedinInList.mockResolvedValue({ leadId: 'lead_existing', listId: LIST, status: 'new' });
    const res = await mirrorLinkedInInviteToCrm({
      listId: LIST,
      linkedinUrl: 'https://www.linkedin.com/in/david-yao',
    });
    expect(res).toEqual({ leadId: 'lead_existing', created: false, engagementLogged: true });
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
    findLeadByLinkedinInList.mockResolvedValue({ leadId: 'lead_hot', listId: LIST, status: 'meeting_booked' });
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
    expect(res).toEqual({ leadId: 'lead_known', created: false, engagementLogged: true });
    expect(findLeadByLinkedinInList).not.toHaveBeenCalled();
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

  // ---- engagement idempotency (ENG-787: re-mirroring must not duplicate) ----

  describe('engagement idempotency', () => {
    const PROFILE = 'https://www.linkedin.com/in/david-yao';
    const SENT_AT = '2026-07-20T09:15:00.000Z';
    const recordedInvite = {
      eventType: 'linkedin.invite.sent',
      createdAt: SENT_AT,
      eventData: { note: 'hi', accountId: 'acct_1', linkedin: PROFILE },
    };

    it('does not append a second engagement when re-mirroring the same pending invitation', async () => {
      // The send-time dedup guard re-runs the mirror on EVERY outreach run for an
      // invite that is still pending; without this guard the lead would collect one
      // duplicate engagement per run.
      findLeadByLinkedinInList.mockResolvedValue({
        leadId: 'lead_existing', listId: LIST, status: 'contacted', engagements: [recordedInvite],
      });
      const res = await mirrorLinkedInInviteToCrm({
        listId: LIST, linkedinUrl: PROFILE, accountId: 'acct_1', sentAt: SENT_AT,
      });
      expect(res).toEqual({ leadId: 'lead_existing', created: false, engagementLogged: false });
      expect(addLeadEngagement).not.toHaveBeenCalled();
      // the timestamp is still refreshed — only the duplicate event is suppressed
      expect(updateLead).toHaveBeenCalledWith(LIST, 'lead_existing', expect.objectContaining({
        linkedInInviteSentAt: SENT_AT,
      }));
    });

    it('appends when the same invitee is re-invited later (a genuinely new send)', async () => {
      findLeadByLinkedinInList.mockResolvedValue({
        leadId: 'lead_existing', listId: LIST, status: 'contacted', engagements: [recordedInvite],
      });
      const res = await mirrorLinkedInInviteToCrm({
        listId: LIST, linkedinUrl: PROFILE, accountId: 'acct_1',
        sentAt: '2026-09-01T12:00:00.000Z',
      });
      expect(res?.engagementLogged).toBe(true);
      expect(addLeadEngagement).toHaveBeenCalledTimes(1);
    });

    it('appends when the same invitee is invited from a DIFFERENT sending account', async () => {
      findLeadByLinkedinInList.mockResolvedValue({
        leadId: 'lead_existing', listId: LIST, status: 'contacted', engagements: [recordedInvite],
      });
      const res = await mirrorLinkedInInviteToCrm({
        listId: LIST, linkedinUrl: PROFILE, accountId: 'acct_2', sentAt: SENT_AT,
      });
      expect(res?.engagementLogged).toBe(true);
      expect(addLeadEngagement).toHaveBeenCalledTimes(1);
    });

    it('is unaffected by unrelated engagements already on the lead', async () => {
      findLeadByLinkedinInList.mockResolvedValue({
        leadId: 'lead_existing',
        listId: LIST,
        status: 'contacted',
        engagements: [
          { eventType: 'email.opened', createdAt: SENT_AT, eventData: {} },
          { eventType: 'linkedin.message.sent', createdAt: SENT_AT, eventData: { linkedin: PROFILE, accountId: 'acct_1' } },
        ],
      });
      const res = await mirrorLinkedInInviteToCrm({
        listId: LIST, linkedinUrl: PROFILE, accountId: 'acct_1', sentAt: SENT_AT,
      });
      expect(res?.engagementLogged).toBe(true);
      expect(addLeadEngagement).toHaveBeenCalledTimes(1);
    });

    it('always logs on the create path — a brand-new lead has no prior engagement', async () => {
      findLeadByLinkedinInList.mockResolvedValue(null);
      const res = await mirrorLinkedInInviteToCrm({
        listId: LIST, linkedinUrl: PROFILE, accountId: 'acct_1', sentAt: SENT_AT,
      });
      expect(res).toEqual({ leadId: 'lead_new_1', created: true, engagementLogged: true });
      expect(addLeadEngagement).toHaveBeenCalledTimes(1);
    });
  });
});
