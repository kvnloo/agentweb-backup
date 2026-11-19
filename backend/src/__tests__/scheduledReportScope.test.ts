/**
 * ENG-1904: may a NON-admin recipient receive an admin-owned run's report? Only when everything the run read was about that
 * recipient and nothing else. These tests pin the privacy invariant: every unclear case answers "no".
 *
 * Message shapes are the real ones from a run on the test environment (AW-ChatMessages): the assistant row carries
 * `tool_calls[].function.arguments` as a JSON string, the tool-result row carries the full result JSON including
 * `client{userId,email}`, and the assistant's `metadata.toolCalls` ledger carries the prepared arguments.
 */
import {
  RECIPIENT_NEUTRAL_REPORT_TOOLS,
  RECIPIENT_SCOPABLE_TOOLS,
  evaluateRunForRecipient,
  extractRunScope,
} from '../services/scheduledReportScope';
import {
  ADMIN_SCOPED_CROSS_ACCOUNT_TOOLS,
  CROSS_ACCOUNT_USER_DATA_TOOLS,
  crossAccountToolsFor,
  reportContainsCrossAccountData,
} from '../services/scheduledReportAccess';

const RECIPIENT = { userId: 'user-recipient', email: 'client@example.com' };
const OTHER = { userId: 'user-other', email: 'other@example.com' };
const CROSS = crossAccountToolsFor();

const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const assistantCalls = (...calls: any[]) => ({ role: 'assistant', content: '', tool_calls: calls });
const result = (id: string, name: string, content: unknown) => ({ role: 'tool', tool_call_id: id, name, content: typeof content === 'string' ? content : JSON.stringify(content) });
const ledger = (...entries: Array<{ id: string; name: string; arguments: unknown; error?: string }>) => ({ role: 'assistant', content: 'report', metadata: { toolCalls: entries } });
const ok = (messages: any[], recipient = RECIPIENT) => evaluateRunForRecipient(extractRunScope(messages), recipient, CROSS);

describe('ENG-1904 scoped report recipients: the run read only the recipient\'s own account', () => {
  describe('delivers (the ENG-1880 shape: ad numbers, lead counts, report builders)', () => {
    const run = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'run the report' },
      assistantCalls(call('c1', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' }), call('c2', 'list_html_templates', {})),
      result('c1', 'monitor_lead_volume', { success: true, client: { userId: 'user-recipient', email: 'client@example.com' } }),
      result('c2', 'list_html_templates', '[]'),
      assistantCalls(call('c3', 'get_meta_ads_metrics', { client_id: 'client@example.com', campaign_ids: ['1'] }), call('c4', 'perform_data_analysis', { file: 'x' })),
      result('c3', 'get_meta_ads_metrics', '{"ok":true}'),
      result('c4', 'perform_data_analysis', '{"ok":true}'),
      assistantCalls(call('c5', 'create_html_from_template', {})),
      result('c5', 'create_html_from_template', '{"url":"u"}'),
      ledger({ id: 'c1', name: 'monitor_lead_volume', arguments: { client_name_or_email: 'client@example.com' } }, { id: 'c3', name: 'get_meta_ads_metrics', arguments: { client_id: 'client@example.com' } }),
    ];

    it('is authorized', () => {
      expect(ok(run)).toEqual({ ok: true });
    });

    it('accepts the account named by its user id for the client_id tools, and email case and whitespace', () => {
      const byId = [assistantCalls(call('a', 'list_meta_ads_campaigns', { client_id: 'user-recipient' }))];
      expect(ok(byId)).toEqual({ ok: true });
      const messy = [assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: '  Client@Example.COM ' })), result('a', 'monitor_lead_volume', { client: { userId: 'user-recipient', email: 'CLIENT@example.com' } })];
      expect(ok(messy)).toEqual({ ok: true });
    });

    it('accepts the aliases the gateway rewrites (client_id / client_email / client for monitor_lead_volume)', () => {
      for (const key of ['client_id', 'client_email', 'client']) {
        expect(ok([assistantCalls(call('a', 'monitor_lead_volume', { [key]: 'client@example.com' }))])).toEqual({ ok: true });
      }
    });

    it('accepts a run whose arguments survive only in the executed ledger, or only in the request list', () => {
      expect(ok([ledger({ id: 'a', name: 'get_meta_ads_metrics', arguments: { client_id: 'client@example.com' } })])).toEqual({ ok: true });
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'client@example.com' }))])).toEqual({ ok: true });
    });

    it('accepts both Google Ads tools scoped to the recipient', () => {
      const m = [assistantCalls(call('a', 'call_google_ads_reporting_api', { client_id: 'client@example.com' }), call('b', 'call_google_ads_api', { client_id: 'user-recipient' }))];
      expect(ok(m)).toEqual({ ok: true });
    });
  });

  describe('withholds (fail closed)', () => {
    it('a call about someone else, and a run that mixes the recipient with someone else (any record, any source)', () => {
      expect(ok([assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'other@example.com' }))], RECIPIENT)).toMatchObject({ ok: false, reason: 'scope_other_account' });
      const mixed = [assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'client@example.com' }), call('b', 'get_meta_ads_metrics', { client_id: 'other@example.com' }))];
      expect(ok(mixed)).toMatchObject({ ok: false, reason: 'scope_other_account' });
      // the request list names the recipient but what ACTUALLY ran (the ledger) was someone else
      const ranOther = [assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' })), ledger({ id: 'a', name: 'monitor_lead_volume', arguments: { client_name_or_email: 'other@example.com' } })];
      expect(ok(ranOther)).toMatchObject({ ok: false, reason: 'scope_other_account' });
    });

    it('a loose name (the tool matches names by substring and takes the first hit)', () => {
      expect(ok([assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'Client' }))])).toMatchObject({ ok: false, reason: 'scope_not_exact' });
      expect(ok([assistantCalls(call('a', 'read_client_meta_activity', { client_name_or_email: 'client' }))])).toMatchObject({ ok: false, reason: 'scope_not_exact' });
    });

    it('an exact email whose saved RESULT says the tool resolved a different account', () => {
      const m = [assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' })), result('a', 'monitor_lead_volume', { success: true, client: OTHER })];
      expect(ok(m)).toMatchObject({ ok: false, reason: 'result_other_account' });
      const byEmail = [assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' })), result('a', 'monitor_lead_volume', { client: { email: 'other@example.com' } })];
      expect(ok(byEmail)).toMatchObject({ ok: false, reason: 'result_other_account' });
      // each identity field is checked on its own: a result naming only a different user id, or the right email with a different user id
      const onlyId = [assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' })), result('a', 'monitor_lead_volume', { client: { userId: 'someone-else' } })];
      expect(ok(onlyId)).toMatchObject({ ok: false, reason: 'result_other_account' });
      const sameEmailOtherId = [assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' })), result('a', 'monitor_lead_volume', { client: { userId: 'someone-else', email: 'client@example.com' } })];
      expect(ok(sameEmailOtherId)).toMatchObject({ ok: false, reason: 'result_other_account' });
    });

    it('a Meta or Google Ads call with no client_id (it reads the CALLER\'s own account: the admin\'s), or an empty one', () => {
      for (const tool of ['list_meta_ads_campaigns', 'get_meta_ads_metrics', 'call_meta_ads_insights_api', 'call_google_ads_api', 'call_google_ads_reporting_api']) {
        expect(ok([assistantCalls(call('a', tool, { account_id: '123' }))])).toMatchObject({ ok: false, reason: 'scope_missing' });
        expect(ok([assistantCalls(call('a', tool, { client_id: '   ' }))])).toMatchObject({ ok: false, reason: 'scope_missing' });
      }
    });

    it('every cross-account tool that is not scopable, for ever (multi-subject, internal data, loose matching)', () => {
      for (const tool of CROSS.filter((t) => !RECIPIENT_SCOPABLE_TOOLS[t])) {
        expect(ok([assistantCalls(call('a', tool, { client_name_or_email: 'client@example.com' }))])).toMatchObject({ ok: false, reason: 'tool_not_scopable' });
      }
      // sanity: the ones the card names
      for (const tool of ['list_all_clients', 'get_users_by_lifecycle_stage', 'get_chat_history', 'get_session_transcript', 'inspect_client_usage', 'manage_user_notes', 'assess_client_health', 'diagnose_leads_at_zero', 'check_account_tracking_health', 'get_registration_status', 'get_user_by_id']) {
        expect(RECIPIENT_SCOPABLE_TOOLS[tool]).toBeUndefined();
      }
    });

    it('any other tool in the run (it may have read the admin\'s own CRM, memory or files)', () => {
      const run = (extra: string) => [assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' }), call('b', extra, {}))];
      for (const tool of ['ask_crm', 'save_memory', 'search_knowledge_base', 'send_email_from_sender', 'constructor', '__proto__', 'toString']) {
        expect(ok(run(tool))).toMatchObject({ ok: false, reason: 'tool_not_neutral' });
      }
    });

    it('messages that could not be read, arguments that cannot be parsed, a result row with no arguments, an unresolved recipient', () => {
      expect(ok([])).toMatchObject({ ok: false, reason: 'messages_unreadable' });
      expect(evaluateRunForRecipient(extractRunScope(undefined), RECIPIENT, CROSS)).toMatchObject({ ok: false, reason: 'messages_unreadable' });
      expect(ok([assistantCalls(call('a', 'monitor_lead_volume', '{not json'))])).toMatchObject({ ok: false, reason: 'arguments_unreadable' });
      expect(ok([assistantCalls(call('a', 'monitor_lead_volume', '"just a string"'))])).toMatchObject({ ok: false, reason: 'arguments_unreadable' });
      expect(ok([result('a', 'monitor_lead_volume', { client: RECIPIENT })])).toMatchObject({ ok: false, reason: 'arguments_missing' });
      expect(ok([assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' }))], { userId: '', email: 'client@example.com' })).toMatchObject({ ok: false, reason: 'recipient_unresolved' });
    });

    it('a run with no scoped call at all (nothing proves the data is the recipient\'s)', () => {
      expect(ok([assistantCalls(call('a', 'list_html_templates', {}))])).toMatchObject({ ok: false, reason: 'no_scoped_call' });
    });

    it('a user id that is not the recipient\'s, for the client_id tools', () => {
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'user-other' }))])).toMatchObject({ ok: false, reason: 'scope_other_account' });
    });
  });

  describe('message extraction', () => {
    it('reads the three sources of one real run and ignores rows it does not understand', () => {
      const scope = extractRunScope([
        null as any, 'junk' as any, { role: 'user', content: 'x' },
        assistantCalls(call('c1', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' }), { id: 'bad', function: {} }),
        result('c1', 'monitor_lead_volume', '{not json'),
        ledger({ id: 'c1', name: 'monitor_lead_volume', arguments: { client_name_or_email: 'client@example.com' } }),
      ]);
      expect(scope.readOk).toBe(true);
      expect(scope.toolNames).toEqual(['monitor_lead_volume']);
      expect(scope.records.map((r) => r.source).sort()).toEqual(['ledger', 'request', 'result']);
      expect(scope.records.find((r) => r.source === 'result')?.resultSubject).toBeNull();
    });
  });

  describe('the lists it depends on', () => {
    it('every scopable tool is on the guard\'s cross-account list, and no neutral tool is', () => {
      for (const tool of Object.keys(RECIPIENT_SCOPABLE_TOOLS)) expect(CROSS_ACCOUNT_USER_DATA_TOOLS).toContain(tool);
      for (const tool of RECIPIENT_NEUTRAL_REPORT_TOOLS) expect(CROSS_ACCOUNT_USER_DATA_TOOLS).not.toContain(tool);
    });

    it('the Google Ads tools are on the guard\'s list and treated like the Meta tools (admin-scoped, dropped for a verified non-admin owner)', () => {
      for (const tool of ['call_google_ads_api', 'call_google_ads_reporting_api']) {
        expect(CROSS_ACCOUNT_USER_DATA_TOOLS).toContain(tool);
        expect(ADMIN_SCOPED_CROSS_ACCOUNT_TOOLS).toContain(tool);
        expect(reportContainsCrossAccountData({ [tool]: 1 })).toBe(true); // owner unknown: safe side
        expect(reportContainsCrossAccountData({ [tool]: 1 }, { ownerIsAdmin: true })).toBe(true); // admin-owned run: counts
        expect(reportContainsCrossAccountData({ [tool]: 1 }, { ownerIsAdmin: false })).toBe(false); // a customer's own report: unchanged
      }
    });
  });
});
