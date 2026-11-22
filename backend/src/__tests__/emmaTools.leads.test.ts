/**
 * ENG-2103 F2 — proves emma/tools.ts's 19 leads/CRM tool execute() bodies
 * call emma/impl/leads.ts directly (not agentModeService.<method>) and
 * forward args unchanged. Same pattern as emmaTools.googleDrive.test.ts /
 * emmaTools.htmlTools.test.ts.
 *
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A):
 * import_leads_from_search is now ALSO covered — it used to remain on
 * agentModeService for the identical this.callLLM-shaped reason as
 * update_email_draft_for_lead, but importLeadsFromSearch itself moved to
 * emma/impl/leads.ts this round (its real coupling was always to `callLLM`
 * via module-scope `batchParseCompaniesFromTitlesWithLLM`, not its own
 * identity), and `callLLM` is `public` on AgentModeService, so this file can
 * bind it straight off the singleton — same treatment as
 * create_html_from_template. It's covered in its own describe block below,
 * separate from the 19-method cluster loop, since it needs a `callLLM`
 * assertion the other 19 don't.
 *
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A, later round):
 * update_email_draft_for_lead is now ALSO covered, in its own describe block
 * below — it moved to emma/impl/leads.ts too, with `callLLM`,
 * `getReportGenerationDefaultModel`, and `getSenderForLead` all injected
 * (`callLLM`/`getReportGenerationDefaultModel` are `public` on
 * AgentModeService; `getSenderForLead` is bound off the singleton the same
 * way even though its real body still lives on the class — see
 * emma/impl/leads.ts's own header comment for why it wasn't promoted to a
 * shared module this round).
 */

jest.mock('../emma/impl/leads', () => ({
  getLeadLists: jest.fn(),
  createLeadList: jest.fn(),
  addLeadsToList: jest.fn(),
  getLeads: jest.fn(),
  searchLeads: jest.fn(),
  getLeadDetails: jest.fn(),
  getLeadsNeedingFollowup: jest.fn(),
  updateLead: jest.fn(),
  setLeadContactStatus: jest.fn(),
  deleteLeads: jest.fn(),
  deleteLeadsByFilter: jest.fn(),
  updateLeadList: jest.fn(),
  deleteLeadList: jest.fn(),
  updateLeadStatus: jest.fn(),
  getLeadListStatuses: jest.fn(),
  configureLeadStatuses: jest.fn(),
  getLeadEngagements: jest.fn(),
  addLeadEngagement: jest.fn(),
  sendEmailToLead: jest.fn(),
  importLeadsFromSearch: jest.fn(),
  updateEmailDraftForLead: jest.fn(),
}));

const LEADS_CLUSTER_METHODS = [
  'getLeadLists', 'createLeadList', 'addLeadsToList', 'getLeads', 'searchLeads',
  'getLeadDetails', 'getLeadsNeedingFollowup', 'updateLead', 'setLeadContactStatus',
  'deleteLeads', 'deleteLeadsByFilter', 'updateLeadList', 'deleteLeadList',
  'updateLeadStatus', 'getLeadListStatuses', 'configureLeadStatuses',
  'getLeadEngagements', 'addLeadEngagement', 'sendEmailToLead',
];

// agentModeService.<leadsClusterMethod> must NOT be called by these 19 tools
// anymore, and agentModeService.importLeadsFromSearch/updateEmailDraftForLead
// must not be called by import_leads_from_search/update_email_draft_for_lead
// anymore either (both are repointed to leadsImpl). `callLLM`,
// `getReportGenerationDefaultModel`, and `getSenderForLead` are allowed
// through as stable target properties — the real execute() bodies bind them
// off the singleton and forward them to leadsImpl, so they must resolve to
// real (and, for assertion purposes, IDENTICAL) functions, not throw.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    // Stable target properties (not returned fresh per access like the
    // fallback branch below) so a tool's `agentModeService.<fn>.bind(...)`
    // and this test's own `agentModeService.<fn>` assertion resolve to the
    // SAME jest.fn().
    {
      callLLM: jest.fn().mockResolvedValue({ success: true }),
      getReportGenerationDefaultModel: jest.fn().mockResolvedValue('gpt-5.5'),
      getSenderForLead: jest.fn().mockResolvedValue(null),
    },
    {
      get(target: any, prop) {
        if (prop in target) return target[prop];
        if (
          LEADS_CLUSTER_METHODS.includes(String(prop)) ||
          prop === 'importLeadsFromSearch' ||
          prop === 'updateEmailDraftForLead'
        ) {
          return () => {
            throw new Error(`agentModeService.${String(prop)} should not be called by the leads/CRM cluster after ENG-2103 F2`);
          };
        }
        return jest.fn().mockResolvedValue({ success: true });
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as leadsImpl from '../emma/impl/leads';
import { agentModeService } from '../services/agentModeService';
import '../emma/tools';

const mockLeads = leadsImpl as jest.Mocked<typeof leadsImpl>;

describe('leads/CRM cluster delegates to emma/impl/leads.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('get_lead_lists forwards userId and returns the result unchanged', async () => {
    const expected = { success: true, lists: [] };
    mockLeads.getLeadLists.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('get_lead_lists')!.execute({}, { userId: 'u1' });

    expect(mockLeads.getLeadLists).toHaveBeenCalledWith('u1');
    expect(result).toBe(expected);
  });

  it('create_lead_list forwards name/description/userId/list_type and returns the result unchanged', async () => {
    const expected = { success: true, list: { listId: 'L1' } };
    mockLeads.createLeadList.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('create_lead_list')!.execute(
      { name: 'ICP', description: 'desc', list_type: 'sales' },
      { userId: 'u1' }
    );

    expect(mockLeads.createLeadList).toHaveBeenCalledWith('ICP', 'desc', 'u1', 'sales');
    expect(result).toBe(expected);
  });

  it('create_lead_list defaults description to empty string when omitted', async () => {
    mockLeads.createLeadList.mockResolvedValue({ success: true });

    await emmaToolRegistry.getTool('create_lead_list')!.execute({ name: 'ICP' }, { userId: 'u1' });

    expect(mockLeads.createLeadList).toHaveBeenCalledWith('ICP', '', 'u1', undefined);
  });

  it('add_leads_to_list forwards list_id/leads/userId and the turn hard cap as turnDeadlineMs', async () => {
    const expected = { success: true, attempted: 1 };
    mockLeads.addLeadsToList.mockResolvedValue(expected);
    const leads = [{ email: 'a@example.com' }];

    const result = await emmaToolRegistry.getTool('add_leads_to_list')!.execute(
      { list_id: 'L1', leads },
      { userId: 'u1', turnHardCapMs: 12345 }
    );

    expect(mockLeads.addLeadsToList).toHaveBeenCalledWith('L1', leads, 'u1', { turnDeadlineMs: 12345 });
    expect(result).toBe(expected);
  });

  it('get_leads forwards list_id/userId and the options bag with snake_case args mapped to camelCase', async () => {
    const expected = { success: true, leads: [] };
    mockLeads.getLeads.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('get_leads')!.execute(
      { list_id: 'L1', search: 'acme', status: 'qualified', icp_only: true, engaged_only: false, limit: 10, cursor: 'c1' },
      { userId: 'u1' }
    );

    // include_all_fields (ENG-425) is always forwarded as a strict boolean; omitted -> false.
    expect(mockLeads.getLeads).toHaveBeenCalledWith('L1', 'u1', {
      search: 'acme', status: 'qualified', icpOnly: true, engagedOnly: false, limit: 10, cursor: 'c1',
      includeAllFields: false, // defaults false when include_all_fields isn't requested
    });
    expect(result).toBe(expected);
  });

  it('get_leads forwards include_all_fields: true as includeAllFields (ENG-425 export path), and only a literal true', async () => {
    mockLeads.getLeads.mockResolvedValue({ success: true, leads: [] });
    const tool = emmaToolRegistry.getTool('get_leads')!;

    await tool.execute({ list_id: 'L1', include_all_fields: true }, { userId: 'u1' });
    expect(mockLeads.getLeads).toHaveBeenLastCalledWith('L1', 'u1', expect.objectContaining({ includeAllFields: true }));

    // A truthy non-boolean (e.g. the string "true" from a sloppy caller) must NOT enable the full export.
    await tool.execute({ list_id: 'L1', include_all_fields: 'true' }, { userId: 'u1' });
    expect(mockLeads.getLeads).toHaveBeenLastCalledWith('L1', 'u1', expect.objectContaining({ includeAllFields: false }));
  });

  it('search_leads forwards list_id/filters/userId/limit and the options bag (list_ids -> listIds)', async () => {
    const expected = { success: true, leads: [] };
    mockLeads.searchLeads.mockResolvedValue(expected);
    const filters = [{ field: 'email', operator: 'contains', value: '@acme.com' }];

    const result = await emmaToolRegistry.getTool('search_leads')!.execute(
      { list_id: 'L1', filters, limit: 5, search: 'kw', cursor: 'c2', list_ids: ['L1', 'L2'] },
      { userId: 'u1' }
    );

    expect(mockLeads.searchLeads).toHaveBeenCalledWith('L1', filters, 'u1', 5, {
      search: 'kw', cursor: 'c2', listIds: ['L1', 'L2'],
    });
    expect(result).toBe(expected);
  });

  it('get_lead_details forwards list_id/lead_id/userId and returns the result unchanged', async () => {
    const expected = { success: true, lead: { leadId: 'LD1' } };
    mockLeads.getLeadDetails.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('get_lead_details')!.execute(
      { list_id: 'L1', lead_id: 'LD1' },
      { userId: 'u1' }
    );

    expect(mockLeads.getLeadDetails).toHaveBeenCalledWith('L1', 'LD1', 'u1');
    expect(result).toBe(expected);
  });

  it('get_leads_needing_followup forwards list_id/userId and maps scan_limit -> scanLimit', async () => {
    const expected = { success: true, leads: [] };
    mockLeads.getLeadsNeedingFollowup.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('get_leads_needing_followup')!.execute(
      { list_id: 'L1', limit: 25, scan_limit: 2000 },
      { userId: 'u1' }
    );

    expect(mockLeads.getLeadsNeedingFollowup).toHaveBeenCalledWith('L1', 'u1', { limit: 25, scanLimit: 2000 });
    expect(result).toBe(expected);
  });

  it('update_lead forwards list_id/lead_id/updates/userId and returns the result unchanged', async () => {
    const expected = { success: true };
    mockLeads.updateLead.mockResolvedValue(expected);
    const updates = { status: 'qualified' };

    const result = await emmaToolRegistry.getTool('update_lead')!.execute(
      { list_id: 'L1', lead_id: 'LD1', updates },
      { userId: 'u1' }
    );

    expect(mockLeads.updateLead).toHaveBeenCalledWith('L1', 'LD1', updates, 'u1');
    expect(result).toBe(expected);
  });

  it('set_lead_contact_status forwards all args in the underlying method parameter order', async () => {
    const expected = { success: true, updated: 2 };
    mockLeads.setLeadContactStatus.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('set_lead_contact_status')!.execute(
      { list_id: 'L1', lead_ids: ['LD1', 'LD2'], contact_status: 'do-not-contact', reason: 'requested-removal', note: 'n' },
      { userId: 'u1' }
    );

    expect(mockLeads.setLeadContactStatus).toHaveBeenCalledWith('L1', ['LD1', 'LD2'], 'do-not-contact', 'requested-removal', 'n', 'u1');
    expect(result).toBe(expected);
  });

  it('delete_leads forwards list_id/lead_ids/userId and returns the result unchanged', async () => {
    const expected = { success: true, deleted: 2 };
    mockLeads.deleteLeads.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('delete_leads')!.execute(
      { list_id: 'L1', lead_ids: ['LD1', 'LD2'] },
      { userId: 'u1' }
    );

    expect(mockLeads.deleteLeads).toHaveBeenCalledWith('L1', ['LD1', 'LD2'], 'u1');
    expect(result).toBe(expected);
  });

  it('delete_leads_by_filter forwards list_id/filters/userId/confirm and returns the result unchanged', async () => {
    const expected = { success: true, matchCount: 3 };
    mockLeads.deleteLeadsByFilter.mockResolvedValue(expected);
    const filters = [{ field: 'icpScore', operator: 'less_than', value: 50 }];

    const result = await emmaToolRegistry.getTool('delete_leads_by_filter')!.execute(
      { list_id: 'L1', filters, confirm: true },
      { userId: 'u1' }
    );

    expect(mockLeads.deleteLeadsByFilter).toHaveBeenCalledWith('L1', filters, 'u1', true);
    expect(result).toBe(expected);
  });

  it('update_lead_list forwards list_id/userId and maps every snake_case arg to its camelCase field', async () => {
    const expected = { success: true };
    mockLeads.updateLeadList.mockResolvedValue(expected);
    const statusConfig = [{ value: 'won', label: 'Won', color: 'green', type: 'won' as const }];

    const result = await emmaToolRegistry.getTool('update_lead_list')!.execute(
      {
        list_id: 'L1', name: 'New Name', description: 'New Desc', icps_only: true, engaged_only: false,
        auto_draft_enabled: true, auto_draft_instruction: 'follow up warmly', status_config: statusConfig,
        list_type: 'customers',
      },
      { userId: 'u1' }
    );

    expect(mockLeads.updateLeadList).toHaveBeenCalledWith('L1', {
      name: 'New Name', description: 'New Desc', icpsOnly: true, engagedOnly: false,
      autoDraftEnabled: true, autoDraftInstruction: 'follow up warmly', statusConfig, listType: 'customers',
    }, 'u1');
    expect(result).toBe(expected);
  });

  it('delete_lead_list forwards list_id/userId and returns the result unchanged', async () => {
    const expected = { success: true };
    mockLeads.deleteLeadList.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('delete_lead_list')!.execute({ list_id: 'L1' }, { userId: 'u1' });

    expect(mockLeads.deleteLeadList).toHaveBeenCalledWith('L1', 'u1');
    expect(result).toBe(expected);
  });

  it('update_lead_status forwards list_id/lead_id/status/userId/deal_value/deal_currency/notes and drafts', async () => {
    const expected = { success: true };
    mockLeads.updateLeadStatus.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('update_lead_status')!.execute(
      { list_id: 'L1', lead_id: 'LD1', status: 'won', deal_value: 5000, deal_currency: 'USD', notes: 'closed', message_draft: 'Hola', email_subject: 'S', email_body: 'B' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockLeads.updateLeadStatus).toHaveBeenCalledWith('L1', 'LD1', 'won', 'u1', 5000, 'USD', 'closed',
      { messageDraft: 'Hola', emailSubject: 'S', emailBody: 'B', sessionId: 's1' });
    expect(result).toBe(expected);
  });

  it('get_lead_list_statuses forwards list_id/userId and returns the result unchanged', async () => {
    const expected = { success: true, statuses: [] };
    mockLeads.getLeadListStatuses.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('get_lead_list_statuses')!.execute({ list_id: 'L1' }, { userId: 'u1' });

    expect(mockLeads.getLeadListStatuses).toHaveBeenCalledWith('L1', 'u1');
    expect(result).toBe(expected);
  });

  it('configure_lead_statuses forwards list_id/statuses/userId and returns the result unchanged', async () => {
    const expected = { success: true };
    mockLeads.configureLeadStatuses.mockResolvedValue(expected);
    const statuses = [{ value: 'new', label: 'New', color: 'gray', type: 'active' as const }];

    const result = await emmaToolRegistry.getTool('configure_lead_statuses')!.execute(
      { list_id: 'L1', statuses },
      { userId: 'u1' }
    );

    expect(mockLeads.configureLeadStatuses).toHaveBeenCalledWith('L1', statuses, 'u1');
    expect(result).toBe(expected);
  });

  it('get_lead_engagements forwards list_id/lead_id/userId/limit and returns the result unchanged', async () => {
    const expected = { success: true, engagements: [] };
    mockLeads.getLeadEngagements.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('get_lead_engagements')!.execute(
      { list_id: 'L1', lead_id: 'LD1', limit: 10 },
      { userId: 'u1' }
    );

    expect(mockLeads.getLeadEngagements).toHaveBeenCalledWith('L1', 'LD1', 'u1', 10);
    expect(result).toBe(expected);
  });

  it('add_lead_engagement forwards list_id/lead_id/event_type/userId/event_data/event_date', async () => {
    const expected = { success: true };
    mockLeads.addLeadEngagement.mockResolvedValue(expected);
    const eventData = { notes: 'called' };

    const result = await emmaToolRegistry.getTool('add_lead_engagement')!.execute(
      { list_id: 'L1', lead_id: 'LD1', event_type: 'custom.phone_call', event_data: eventData, event_date: '2026-01-01T00:00:00Z' },
      { userId: 'u1' }
    );

    expect(mockLeads.addLeadEngagement).toHaveBeenCalledWith('L1', 'LD1', 'custom.phone_call', 'u1', eventData, '2026-01-01T00:00:00Z');
    expect(result).toBe(expected);
  });

  it('send_email_to_lead forwards list_id/lead_id/userId and returns the result unchanged', async () => {
    const expected = { success: true, messageId: 'm1' };
    mockLeads.sendEmailToLead.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('send_email_to_lead')!.execute(
      { list_id: 'L1', lead_id: 'LD1' },
      { userId: 'u1' }
    );

    expect(mockLeads.sendEmailToLead).toHaveBeenCalledWith('L1', 'LD1', 'u1');
    expect(result).toBe(expected);
  });
});

// ENG-2103 (F2 design-decision-list follow-up, Pattern A): separate describe
// block — import_leads_from_search isn't one of the 19 LEADS_CLUSTER_METHODS
// (it has its own callLLM-binding assertion the others don't need).
describe('import_leads_from_search calls leadsImpl.importLeadsFromSearch with agentModeService.callLLM bound (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards agentModeService.callLLM bound, userId, and the mapped args, and returns the result unchanged', async () => {
    const expected = { success: true, imported: 3 };
    mockLeads.importLeadsFromSearch.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('import_leads_from_search')!.execute(
      { list_id: 'L1', title: 'CTO', company_size_max: 200, limit: 10, auto_enrich: true },
      { userId: 'u1' }
    );

    expect(mockLeads.importLeadsFromSearch).toHaveBeenCalledTimes(1);
    const [passedCallLLM, passedUserId, passedArgs] = mockLeads.importLeadsFromSearch.mock.calls[0];
    expect(typeof passedCallLLM).toBe('function');
    expect(passedUserId).toBe('u1');
    expect(passedArgs).toMatchObject({
      listId: 'L1', title: 'CTO', company_size_max: 200, limit: 10, auto_enrich: true,
    });
    expect(result).toBe(expected);

    // The bound callLLM must actually be agentModeService.callLLM, not a
    // stand-in — prove it by calling it and checking the underlying mock saw it.
    await passedCallLLM('m', [], {} as any);
    expect(agentModeService.callLLM).toHaveBeenCalledWith('m', [], {});
  });

  it('caps limit at 500', async () => {
    mockLeads.importLeadsFromSearch.mockResolvedValue({ success: true });

    await emmaToolRegistry.getTool('import_leads_from_search')!.execute(
      { list_id: 'L1', title: 'CTO', limit: 10000 },
      { userId: 'u1' }
    );

    expect(mockLeads.importLeadsFromSearch.mock.calls[0][2]).toMatchObject({ limit: 500 });
  });

  it('throws when userId is missing', async () => {
    await expect(
      emmaToolRegistry.getTool('import_leads_from_search')!.execute({ list_id: 'L1', title: 'CTO' }, {})
    ).rejects.toThrow('Authentication required');
    expect(mockLeads.importLeadsFromSearch).not.toHaveBeenCalled();
  });
});

// ENG-2103 (F2 design-decision-list follow-up, Pattern A, later round):
// separate describe block — update_email_draft_for_lead isn't one of the 19
// LEADS_CLUSTER_METHODS (it has its own callLLM/getReportGenerationDefaultModel/
// getSenderForLead-binding assertions the others don't need).
describe('update_email_draft_for_lead calls leadsImpl.updateEmailDraftForLead with agentModeService.callLLM/getReportGenerationDefaultModel/getSenderForLead bound (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards the mapped args plus the three bound gateway functions, and returns the result unchanged', async () => {
    const expected = { success: true, data: { email: { subject: 's', textContent: 't' } } };
    mockLeads.updateEmailDraftForLead.mockResolvedValue(expected);

    const result = await emmaToolRegistry.getTool('update_email_draft_for_lead')!.execute(
      { list_id: 'L1', lead_id: 'LD1', instruction: 'Write a welcome email', email_format: 'text' },
      { sessionId: 's1', userId: 'u1' }
    );

    expect(mockLeads.updateEmailDraftForLead).toHaveBeenCalledTimes(1);
    const [listId, leadId, instruction, sessionId, userId, emailFormat, passedCallLLM, passedGetReportModel, passedGetSenderForLead] =
      mockLeads.updateEmailDraftForLead.mock.calls[0];
    expect(listId).toBe('L1');
    expect(leadId).toBe('LD1');
    expect(instruction).toBe('Write a welcome email');
    expect(sessionId).toBe('s1');
    expect(userId).toBe('u1');
    expect(emailFormat).toBe('text');
    expect(typeof passedCallLLM).toBe('function');
    expect(typeof passedGetReportModel).toBe('function');
    expect(typeof passedGetSenderForLead).toBe('function');
    expect(result).toBe(expected);

    // Each bound function must actually be the real agentModeService method,
    // not a stand-in — prove it by calling it and checking the underlying
    // mock saw it (same discipline as import_leads_from_search's own test).
    await passedCallLLM('m', [], {} as any);
    expect(agentModeService.callLLM).toHaveBeenCalledWith('m', [], {});
    await passedGetReportModel();
    expect(agentModeService.getReportGenerationDefaultModel).toHaveBeenCalledTimes(1);
    await passedGetSenderForLead('u1', undefined, undefined, undefined);
    expect(agentModeService.getSenderForLead).toHaveBeenCalledWith('u1', undefined, undefined, undefined);
  });
});
