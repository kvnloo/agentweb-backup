/**
 * ENG-2361: update_lead_status can save the agent's exact draft text on the lead
 * in the same write that moves it to pending_review, in the shapes the portal reads.
 */
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
    addLeadEngagement: jest.fn(),
  },
}));
jest.mock('../services/crmAccessControl', () => ({
  ...jest.requireActual('../services/crmAccessControl'),
  canDestructiveCrmList: jest.fn().mockResolvedValue(true),
}));

import { updateLeadStatus } from '../emma/impl/leads';
import { crmDb } from '../services/db';

const db = crmDb as jest.Mocked<typeof crmDb>;

describe('updateLeadStatus draft saving (ENG-2361)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.getLeadListById.mockResolvedValue({ listId: 'L', userId: 'u' } as any);
    db.getLeadById.mockResolvedValue({ leadId: 'D', listId: 'L', status: 'qualified', firstName: 'Ana' } as any);
    db.updateLead.mockResolvedValue(undefined as any);
    db.addLeadEngagement.mockResolvedValue(undefined as any);
  });

  it('saves the LinkedIn message verbatim as messageDraft.content with the status', async () => {
    const r = await updateLeadStatus('L', 'D', 'pending_review', 'u', undefined, undefined, 'Borrador DM Impacto 1', {
      messageDraft: '  Hola Ana, vi tu trabajo en CX...  ',
      sessionId: 's1',
    });
    expect(r.success).toBe(true);
    expect(r.savedDrafts).toEqual(['messageDraft']);
    const updates = db.updateLead.mock.calls[0][2] as any;
    expect(updates.status).toBe('pending_review');
    expect(updates.messageDraft).toEqual(expect.objectContaining({ content: 'Hola Ana, vi tu trabajo en CX...', sessionId: 's1' }));
    expect(updates.emailDraft).toBeUndefined();
  });

  it('saves an email draft as emailDraft {subject, textContent}', async () => {
    const r = await updateLeadStatus('L', 'D', 'pending_review', 'u', undefined, undefined, undefined, {
      emailSubject: 'Invitación LinkedIn',
      emailBody: 'Hola Ana, Javier te envió una invitación...',
    });
    expect(r.success).toBe(true);
    const updates = db.updateLead.mock.calls[0][2] as any;
    expect(updates.emailDraft).toEqual(expect.objectContaining({ subject: 'Invitación LinkedIn', textContent: 'Hola Ana, Javier te envió una invitación...' }));
    expect(updates.emailDraftFormat).toBe('text');
  });

  it('rejects a half email draft and writes nothing', async () => {
    const r = await updateLeadStatus('L', 'D', 'pending_review', 'u', undefined, undefined, undefined, { emailSubject: 'Only subject' });
    expect(r.success).toBe(false);
    expect(db.updateLead).not.toHaveBeenCalled();
  });

  it('without drafts behaves exactly as before (status only, never clears drafts)', async () => {
    const r = await updateLeadStatus('L', 'D', 'contacted', 'u', undefined, undefined, undefined, { messageDraft: '   ' });
    expect(r.success).toBe(true);
    expect(r.savedDrafts).toBeUndefined();
    expect(db.updateLead.mock.calls[0][2]).toEqual({ status: 'contacted' });
  });
});
