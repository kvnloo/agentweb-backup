import {
  CRM_DATA_CHANGED_EVENT,
  CRM_MUTATING_TOOLS,
  buildCrmDataChangedPayload,
  shouldEmitCrmDataChanged,
} from '../emma/crmMutationEvents';

describe('crmMutationEvents', () => {
  describe('CRM_DATA_CHANGED_EVENT', () => {
    it('is the stable event name the CRM page listens to', () => {
      expect(CRM_DATA_CHANGED_EVENT).toBe('crm-data-changed');
    });
  });

  describe('buildCrmDataChangedPayload — non-mutating tools', () => {
    it('returns null for a read-only CRM tool', () => {
      expect(buildCrmDataChangedPayload('get_leads', { list_id: 'L1' })).toBeNull();
    });

    it('returns null for an unrelated tool', () => {
      expect(buildCrmDataChangedPayload('generate_image', { prompt: 'x' })).toBeNull();
    });

    it('returns null for enrichment tools (they emit their own completion events)', () => {
      expect(buildCrmDataChangedPayload('enrich_leads_execute', { list_id: 'L1' })).toBeNull();
      expect(buildCrmDataChangedPayload('enrich_leads_preview', { list_id: 'L1' })).toBeNull();
      expect(buildCrmDataChangedPayload('enrich_lead_custom', { list_id: 'L1' })).toBeNull();
    });
  });

  describe('buildCrmDataChangedPayload — mutating tools', () => {
    it('includes listId and leadId for a single-lead mutation', () => {
      const payload = buildCrmDataChangedPayload('update_lead', {
        list_id: 'L1',
        lead_id: 'lead-9',
        updates: { status: 'hot' },
      });
      expect(payload).toEqual({ source: 'update_lead', listId: 'L1', leadId: 'lead-9' });
    });

    it('includes listId for send_email_to_lead', () => {
      const payload = buildCrmDataChangedPayload('send_email_to_lead', {
        list_id: 'L2',
        lead_id: 'lead-3',
      });
      expect(payload).toEqual({ source: 'send_email_to_lead', listId: 'L2', leadId: 'lead-3' });
    });

    it('includes only listId for a list-level mutation (no lead_id)', () => {
      const payload = buildCrmDataChangedPayload('delete_leads', {
        list_id: 'L3',
        lead_ids: ['a', 'b'],
      });
      expect(payload).toEqual({ source: 'delete_leads', listId: 'L3' });
    });

    it('omits listId for create_lead_list (no list exists yet)', () => {
      const payload = buildCrmDataChangedPayload('create_lead_list', { name: 'New list' });
      expect(payload).toEqual({ source: 'create_lead_list' });
    });

    it('omits listId/leadId when args are missing entirely', () => {
      const payload = buildCrmDataChangedPayload('import_leads_from_search', undefined);
      expect(payload).toEqual({ source: 'import_leads_from_search' });
    });

    it('ignores non-string / empty id values defensively', () => {
      const payload = buildCrmDataChangedPayload('update_lead', {
        list_id: '',
        lead_id: 12345 as unknown as string,
      });
      expect(payload).toEqual({ source: 'update_lead' });
    });

    it('covers every tool in CRM_MUTATING_TOOLS', () => {
      for (const tool of CRM_MUTATING_TOOLS) {
        const payload = buildCrmDataChangedPayload(tool, { list_id: 'L1' });
        expect(payload).not.toBeNull();
        expect(payload!.source).toBe(tool);
      }
    });
  });

  // ENG-1133: a truncated import reports success:false so the agent resumes the
  // missing rows instead of claiming a clean import — but the rows that DID
  // land must still show up on the CRM page without a manual reload.
  describe('shouldEmitCrmDataChanged', () => {
    it('emits for an ordinary successful mutation', () => {
      expect(shouldEmitCrmDataChanged({ success: true })).toBe(true);
    });

    it('emits for a partial import that already wrote rows', () => {
      expect(shouldEmitCrmDataChanged({ success: false, partial: true, complete: false })).toBe(true);
    });

    it('stays silent for a failure that wrote nothing', () => {
      expect(shouldEmitCrmDataChanged({ success: false })).toBe(false);
      expect(shouldEmitCrmDataChanged({ success: false, partial: false })).toBe(false);
    });

    it('emits for a result that reports no success flag at all', () => {
      expect(shouldEmitCrmDataChanged({ listId: 'L1' })).toBe(true);
      expect(shouldEmitCrmDataChanged(undefined)).toBe(true);
    });
  });
});
