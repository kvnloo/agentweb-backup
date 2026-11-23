/**
 * ENG-1904: may a NON-admin recipient receive an admin-owned run's report? Only when everything the run read was about that
 * recipient and nothing else. These tests pin the privacy invariant: every unclear case answers "no".
 *
 * Message shapes are the real ones from a run on the test environment (AW-ChatMessages): the assistant row carries
 * `tool_calls[].function.arguments` as a JSON string, the tool-result row carries the full result JSON including
 * `client{userId,email}`, and the assistant's `metadata.toolCalls` ledger carries the prepared arguments.
 */
import { buildToolResponseS3Header } from '../utils/toolResponseS3Ref';
import { buildCitationIndexBlock } from '../utils/citations';
import { sealTruncatedPayload } from '../services/agentMode/core/truncatedPayload';
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
/** A monitor_lead_volume call with its paired result row (the loosely matching tools need one per call). `client: null` = no result row. */
const mon = (id: string, args: object, client: object | null = RECIPIENT) => [assistantCalls(call(id, 'monitor_lead_volume', args)), ...(client ? [result(id, 'monitor_lead_volume', { success: true, client })] : [])];
const ok = (messages: any[], recipient = RECIPIENT, calledFunctions?: Record<string, number>) => evaluateRunForRecipient(extractRunScope(messages, calledFunctions), recipient);

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
        expect(ok(mon('a', { [key]: 'client@example.com' }))).toEqual({ ok: true });
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
      expect(ok(mon('a', { client_name_or_email: 'other@example.com' }))).toMatchObject({ ok: false, reason: 'scope_other_account' });
      const mixed = [assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'client@example.com' }), call('b', 'get_meta_ads_metrics', { client_id: 'other@example.com' }))];
      expect(ok(mixed)).toMatchObject({ ok: false, reason: 'scope_other_account' });
      // the request list names the recipient but what ACTUALLY ran (the ledger) was someone else
      const ranOther = [...mon('a', { client_name_or_email: 'client@example.com' }), ledger({ id: 'a', name: 'monitor_lead_volume', arguments: { client_name_or_email: 'other@example.com' } })];
      expect(ok(ranOther)).toMatchObject({ ok: false, reason: 'scope_other_account' });
    });

    it('a loose name (the tool matches names by substring and takes the first hit)', () => {
      expect(ok(mon('a', { client_name_or_email: 'Client' }))).toMatchObject({ ok: false, reason: 'scope_not_exact' });
      expect(ok([assistantCalls(call('a', 'read_client_meta_activity', { client_name_or_email: 'client' })), result('a', 'read_client_meta_activity', { client: RECIPIENT })])).toMatchObject({ ok: false, reason: 'scope_not_exact' });
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
        expect(ok([assistantCalls(call('a', tool, { client_id: '   ' }))])).toMatchObject({ ok: false, reason: 'scope_blank' });
      }
    });

    it('a blank, padded or non-string subject key, and ANY subject key that is not the recipient (the gateway only treats "", null and undefined as missing)', () => {
      const monitor = (args: object) => ok(mon('a', args));
      // the tool would receive the blank one and match a loose name; the other key must not rescue it
      expect(monitor({ client_name_or_email: ' ', client_id: 'client@example.com' })).toMatchObject({ ok: false, reason: 'scope_blank' });
      expect(monitor({ client_name_or_email: '', client_id: 'client@example.com' })).toMatchObject({ ok: false, reason: 'scope_blank' });
      expect(monitor({ client_name_or_email: 5, client_id: 'client@example.com' })).toMatchObject({ ok: false, reason: 'scope_blank' });
      expect(monitor({ client_name_or_email: ['client@example.com'] })).toMatchObject({ ok: false, reason: 'scope_blank' });
      expect(monitor({ client_name_or_email: 'other@example.com', client_id: 'client@example.com' })).toMatchObject({ ok: false, reason: 'scope_other_account' });
      expect(monitor({ client_name_or_email: 'client@example.com', client: 'Customer' })).toMatchObject({ ok: false, reason: 'scope_not_exact' });
      // null / undefined are "missing" to the gateway, which repairs them from the alias: the other key decides
      expect(monitor({ client_name_or_email: null, client_id: 'client@example.com' })).toEqual({ ok: true });
      expect(monitor({ client_name_or_email: 'client@example.com', client_id: 'client@example.com', client_email: ' Client@Example.com ' })).toEqual({ ok: true });
      // the same for the client_id tools
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: ' ' }))])).toMatchObject({ ok: false, reason: 'scope_blank' });
    });

    it('a tool that left no message row but is in the session\'s own calledFunctions counter still counts', () => {
      const clean = mon('a', { client_name_or_email: 'client@example.com' });
      expect(ok(clean, RECIPIENT, { monitor_lead_volume: 1 })).toEqual({ ok: true });
      expect(ok(clean, RECIPIENT, { monitor_lead_volume: 1, ask_crm: 1 })).toMatchObject({ ok: false, reason: 'tool_not_allowed' });
      expect(ok(clean, RECIPIENT, { list_all_clients: 2 } as any)).toMatchObject({ ok: false, reason: 'tool_not_allowed' });
      expect(extractRunScope(clean, ['ask_crm']).toolNames).toContain('ask_crm');
    });

    it('a tool name that appears only in a tool-result row counts', () => {
      const m = [...mon('a', { client_name_or_email: 'client@example.com' }), result('z', 'ask_crm', '{}')];
      expect(ok(m)).toMatchObject({ ok: false, reason: 'tool_not_allowed' });
    });

    it('resolve_skill is not a report builder: for an admin it lists every tenant\'s skills with their owners', () => {
      expect(RECIPIENT_NEUTRAL_REPORT_TOOLS).not.toContain('resolve_skill');
      const m = [assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' }), call('b', 'resolve_skill', {}))];
      expect(ok(m)).toMatchObject({ ok: false, reason: 'tool_not_allowed' });
    });

    it('every cross-account tool that is not scopable, for ever (multi-subject, internal data, loose matching)', () => {
      for (const tool of CROSS.filter((t) => !RECIPIENT_SCOPABLE_TOOLS[t])) {
        expect(ok([assistantCalls(call('a', tool, { client_name_or_email: 'client@example.com' }))])).toMatchObject({ ok: false, reason: 'tool_not_allowed' });
      }
      // sanity: the ones the card names
      for (const tool of ['list_all_clients', 'get_users_by_lifecycle_stage', 'get_chat_history', 'get_session_transcript', 'inspect_client_usage', 'manage_user_notes', 'assess_client_health', 'diagnose_leads_at_zero', 'check_account_tracking_health', 'get_registration_status', 'get_user_by_id']) {
        expect(RECIPIENT_SCOPABLE_TOOLS[tool]).toBeUndefined();
      }
    });

    it('any other tool in the run (it may have read the admin\'s own CRM, memory or files)', () => {
      const run = (extra: string) => [assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' }), call('b', extra, {}))];
      for (const tool of ['ask_crm', 'save_memory', 'search_knowledge_base', 'send_email_from_sender', 'constructor', '__proto__', 'toString']) {
        expect(ok(run(tool))).toMatchObject({ ok: false, reason: 'tool_not_allowed' });
      }
    });

    it('messages that could not be read, arguments that cannot be parsed, a result row with no arguments, an unresolved recipient', () => {
      expect(ok([])).toMatchObject({ ok: false, reason: 'messages_unreadable' });
      expect(evaluateRunForRecipient(extractRunScope(undefined), RECIPIENT)).toMatchObject({ ok: false, reason: 'messages_unreadable' });
      expect(ok([assistantCalls(call('a', 'monitor_lead_volume', '{not json')), result('a', 'monitor_lead_volume', { client: RECIPIENT })])).toMatchObject({ ok: false, reason: 'arguments_unreadable' });
      expect(ok([assistantCalls(call('a', 'monitor_lead_volume', '"just a string"')), result('a', 'monitor_lead_volume', { client: RECIPIENT })])).toMatchObject({ ok: false, reason: 'arguments_unreadable' });
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

  describe('pairing, spellings the gateway repairs, and rows that were lost', () => {
    it('a loosely matching call with no saved result is a no (a lost row, or a padded value the tool matches loosely)', () => {
      expect(ok(mon('a', { client_name_or_email: 'client@example.com' }, null))).toMatchObject({ ok: false, reason: 'result_missing' });
      expect(ok(mon('a', { client_name_or_email: '  client@example.com ' }, null))).toMatchObject({ ok: false, reason: 'result_missing' });
      // two calls, only one result row
      const two = [...mon('a', { client_name_or_email: 'client@example.com' }), assistantCalls(call('b', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' }))];
      expect(ok(two)).toMatchObject({ ok: false, reason: 'result_missing' });
      // a request or ledger row with no call id cannot be paired
      expect(ok([{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'monitor_lead_volume', arguments: '{"client_name_or_email":"client@example.com"}' } }] }])).toMatchObject({ ok: false, reason: 'call_id_missing' });
    });

    it('a spelling of a subject key that the gateway would repair but this module does not read (case, separators, a wrapper object)', () => {
      const variants: object[] = [
        { clientNameOrEmail: 'other@example.com', client_id: 'client@example.com' },
        { 'Client_ID': 'other@example.com', client_name_or_email: 'client@example.com' },
        { 'client id': 'other@example.com', client_name_or_email: 'client@example.com' },
        { 'client_id ': 'other@example.com', client_name_or_email: 'client@example.com' },
        { client_name_or_email: 'client@example.com', params: { client_id: 'other@example.com' } },
        { client_name_or_email: 'client@example.com', args: { nested: { 'Client-Email': 'other@example.com' } } },
      ];
      for (const v of variants) expect(ok(mon('a', v))).toMatchObject({ ok: false, reason: 'scope_key_variant' });
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'client@example.com', ClientId: 'other@example.com' }))])).toMatchObject({ ok: false, reason: 'scope_key_variant' });
      // unrelated nested data is fine
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'client@example.com', campaign_ids: { c1: { name: 'Client campaign' } } }))])).toEqual({ ok: true });
    });

    it('the session counter showing more calls to a scopable tool than left rows (a later call whose rows were lost)', () => {
      const one = mon('a', { client_name_or_email: 'client@example.com' });
      expect(ok(one, RECIPIENT, { monitor_lead_volume: 1 })).toEqual({ ok: true });
      expect(ok(one, RECIPIENT, { monitor_lead_volume: 2 })).toMatchObject({ ok: false, reason: 'rows_missing' });
      const meta = [assistantCalls(call('m1', 'get_meta_ads_metrics', { client_id: 'client@example.com' }))];
      expect(ok(meta, RECIPIENT, { get_meta_ads_metrics: 1 })).toEqual({ ok: true });
      expect(ok(meta, RECIPIENT, { get_meta_ads_metrics: 3 })).toMatchObject({ ok: false, reason: 'rows_missing' });
    });

    it('a null or undefined subject is missing (as in the gateway), and a user id is compared exactly', () => {
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: null }))])).toMatchObject({ ok: false, reason: 'scope_missing' });
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'User-Recipient' }))])).toMatchObject({ ok: false, reason: 'scope_other_account' });
    });

    it('the plan plumbing tools are neutral, but the arbitrary-key readers and the skill resolver are not', () => {
      const withTool = (tool: string) => [...mon('a', { client_name_or_email: 'client@example.com' }), assistantCalls(call('b', tool, {}))];
      for (const tool of ['launch_predefined_work_plan', 'set_work_plan_status']) {
        expect(RECIPIENT_NEUTRAL_REPORT_TOOLS).toContain(tool);
        expect(ok(withTool(tool))).toEqual({ ok: true });
      }
      for (const tool of ['search_tool_response', 'read_tool_response', 'resolve_skill', 'save_file', 'ask_crm']) {
        expect(RECIPIENT_NEUTRAL_REPORT_TOOLS).not.toContain(tool);
        expect(ok(withTool(tool))).toMatchObject({ ok: false, reason: 'tool_not_allowed' });
      }
    });

    it('the work-plan counter: a step that completed reads 0 but keeps its key, so rows must still exist; duplicates need no result of their own', () => {
      const one = mon('p', { client_name_or_email: 'client@example.com' });
      // plan flow: the counter was reset on launch and decremented per step to 0, rows are present: fine
      expect(ok(one, RECIPIENT, { monitor_lead_volume: 0 })).toEqual({ ok: true });
      // the key is there but EVERY row of that tool is gone (lost message rows): fail closed
      const none = [assistantCalls(call('z', 'list_html_templates', {})), result('z', 'list_html_templates', '[]')];
      expect(ok([...none, ...mon('p', { client_name_or_email: 'client@example.com' })], RECIPIENT, { monitor_lead_volume: 0, get_meta_ads_metrics: 0 })).toMatchObject({ ok: false, reason: 'rows_missing' });
      expect(ok(none, RECIPIENT, { monitor_lead_volume: 0 })).toMatchObject({ ok: false, reason: 'rows_missing' });
      // a same-turn duplicate (the dispatcher collapses it: no result row, a ledger entry with duplicateOf) did not run
      const dup = [...mon('d1', { client_name_or_email: 'client@example.com' }), assistantCalls(call('d2', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' })),
        { role: 'tool', tool_call_id: 'd2', name: 'monitor_lead_volume', content: 'This call was collapsed: an identical monitor_lead_volume call ...', metadata: { duplicateSuppressed: true, duplicateOfId: 'd1' } },
        ledger({ id: 'd1', name: 'monitor_lead_volume', arguments: { client_name_or_email: 'client@example.com' } }, { id: 'd2', name: 'monitor_lead_volume', arguments: { client_name_or_email: 'client@example.com' }, duplicateOf: 'd1' } as any)];
      expect(ok(dup, RECIPIENT, { monitor_lead_volume: 1 })).toEqual({ ok: true });
      // the same duplicate whose collapsed-result row was lost: the ledger's duplicateOf alone shows it never ran
      const dupNoRow = [...mon('d1', { client_name_or_email: 'client@example.com' }), assistantCalls(call('d2', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' })),
        ledger({ id: 'd1', name: 'monitor_lead_volume', arguments: { client_name_or_email: 'client@example.com' } }, { id: 'd2', name: 'monitor_lead_volume', arguments: { client_name_or_email: 'client@example.com' }, duplicateOf: 'd1' } as any)];
      expect(ok(dupNoRow, RECIPIENT, { monitor_lead_volume: 1 })).toEqual({ ok: true });
      // a call that ERRORED and was retried stays a no: the error row names no account (a known false positive; measured in shadow mode)
      const retried = [assistantCalls(call('e1', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' })), result('e1', 'monitor_lead_volume', 'Tool Error: timeout'), ...mon('e2', { client_name_or_email: 'client@example.com' })];
      expect(ok(retried)).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
    });

    it('identity comparisons are exact: an email that is a substring of another account\'s, a user id that is a prefix of another', () => {
      const ann = { userId: 'user-1', email: 'ann@x.com' };
      expect(ok(mon('a', { client_name_or_email: 'joann@x.com' }, ann), ann)).toMatchObject({ ok: false, reason: 'scope_other_account' });
      expect(ok(mon('a', { client_name_or_email: 'ann@x.com.au' }, ann), ann)).toMatchObject({ ok: false, reason: 'scope_other_account' });
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'user-10' }))], ann)).toMatchObject({ ok: false, reason: 'scope_other_account' });
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'user-1' }))], ann)).toEqual({ ok: true });
    });

    it('arguments too deep or too large to scan for a hidden subject key fail closed; big lists of plain ids do not', () => {
      let deep: any = { client_id: 'other@example.com' };
      for (let i = 0; i < 6; i++) deep = { wrap: deep };
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'client@example.com', campaign_ids: deep }))])).toMatchObject({ ok: false, reason: 'scope_key_variant' });
      const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);
      expect(ok([assistantCalls(call('a', 'get_meta_ads_metrics', { client_id: 'client@example.com', campaign_ids: ids }))])).toEqual({ ok: true });
    });

    it('a forged `client` key never counts: only a depth-1 key of the top-level result is read', () => {
      const req = mon('a', { client_name_or_email: 'client@example.com' }, null);
      const header = buildToolResponseS3Header('tool-responses/s1/a.txt', 50000);
      const cite = buildCitationIndexBlock([{ id: 1, siteName: 'Example', domain: 'example.com' } as any]);
      const stored = (json: string) => result('a', 'monitor_lead_volume', header + cite + json);
      const forgedKey = JSON.stringify({ '"client': { userId: 'user-recipient', email: 'client@example.com' } }).slice(0, -1) + ',"rows":[{"a'; // cut off, no real client
      expect(ok([...req, stored(forgedKey)])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
      const nested = '{"success":true,"report":{"client":{"userId":"user-recipient","email":"client@example.com"}},"rows":[{"a';
      expect(ok([...req, stored(nested)])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
      const inString = '{"success":true,"note":"{\\"client\\":{\\"userId\\":\\"user-recipient\\"}}","rows":[{"a';
      expect(ok([...req, stored(inString)])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
      const realAfterForged = '{"success":true,"note":"x","client":{"userId":"user-other","email":"other@example.com"},"rows":[{"a';
      expect(ok([...req, stored(realAfterForged)])).toMatchObject({ ok: false, reason: 'result_other_account' });
      const real = '{"success":true,"client":{"userId":"user-recipient","email":"client@example.com"},"rows":[{"a';
      expect(ok([...req, stored(real)])).toEqual({ ok: true });
      expect(ok([...req, stored(`[${real}`)])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' }); // an array is not a result object
      // the depth check is load-bearing: a client key whose value is an ARRAY of objects is not the client object
      expect(ok([...req, stored('{"success":true,"client":[{"userId":"user-recipient","email":"client@example.com"}],"rows":[{"a')])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
      // a second top-level object after the first one closed is not read
      expect(ok([...req, stored('{"success":true}\n{"client":{"userId":"user-recipient","email":"client@example.com"}')])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
      // a string containing an escaped quote must not end the scan early and expose a forged key
      expect(ok([...req, stored('{"note":"say \\"hi\\" then \\"client\\":{","client":{"userId":"user-other","email":"other@example.com"},"rows":[{"a')])).toMatchObject({ ok: false, reason: 'result_other_account' });
      // the real client AFTER a string with escaped quotes or backslashes is still found in a cut-off result (the scan must not lose its place)
      for (const note of ['a"b', 'a\\"b', '"', 'q\\"', '{"a":"b\\"c"}']) {
        const whole = JSON.stringify({ note, client: { userId: 'user-recipient', email: 'client@example.com' }, rows: [1, 2, 3] });
        expect(ok([...req, result('a', 'monitor_lead_volume', whole.slice(0, whole.length - 5))])).toEqual({ ok: true });
      }
      // complete JSON whose `client` is not at the top level
      expect(ok([...req, result('a', 'monitor_lead_volume', { data: { client: RECIPIENT } })])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
      // a forged top-level object planted in a prefix that is not the real header or citation block, or in a plain-text row
      expect(ok([...req, result('a', 'monitor_lead_volume', `Tool note\n{"client":{"userId":"user-recipient","email":"client@example.com"},"rows":[{"a`)])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
      expect(ok([...req, result('a', 'monitor_lead_volume', `${header}note: see below\n{"client":{"userId":"user-recipient","email":"client@example.com"},"rows":[{"a`)])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
    });
  });

  describe('message extraction', () => {
    it('reads the three sources of one real run and skips rows that are not tool rows', () => {
      const scope = extractRunScope([
        null as any, 'junk' as any, { role: 'user', content: 'x' },
        assistantCalls(call('c1', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' })),
        result('c1', 'monitor_lead_volume', '{not json'),
        ledger({ id: 'c1', name: 'monitor_lead_volume', arguments: { client_name_or_email: 'client@example.com' } }),
      ]);
      expect(scope.readOk).toBe(true);
      expect(scope.unrecognized).toBe(false);
      expect(scope.toolNames).toEqual(['monitor_lead_volume']);
      expect(scope.records.map((r) => r.source).sort()).toEqual(['ledger', 'request', 'result']);
      expect(scope.records.find((r) => r.source === 'result')?.resultSubject).toBeNull();
    });

    it('a row shape it does not understand makes the whole run unprovable (fail closed)', () => {
      const good = call('c1', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' });
      const shapes: any[][] = [
        [assistantCalls(good, { id: 'bad', function: {} })], // a tool call with no name
        [assistantCalls(good), { role: 'assistant', content: '', function_call: { name: 'ask_crm', arguments: '{}' } }], // the legacy single-call shape
        [assistantCalls(good), { role: 'assistant', content: '', tool_calls: 'not-an-array' }],
        [assistantCalls(good), { role: 'tool', content: '{}' }], // a tool row with no name
        [assistantCalls(good), { role: 'assistant', content: '', metadata: { toolCalls: [{ tool: 'ask_crm', arguments: {} }] } }], // a ledger entry keyed differently
        [assistantCalls(good), { role: 'assistant', content: '', metadata: { toolCalls: 'x' } }],
      ];
      for (const messages of shapes) expect(ok(messages)).toMatchObject({ ok: false, reason: 'messages_unrecognized' });
    });

    it('reads the account from a result that was offloaded to S3 (header plus a truncated preview), not just from complete JSON', () => {
      const header = buildToolResponseS3Header('tool-responses/s1/c1.txt', 91234);
      const preview = (client: object, tail = '"daily_rows":[{"day":"2026-11-01","leads":3},{"day":"2026-1') => `${header}{"success":true,"client":${JSON.stringify(client)},${tail}`;
      const req = assistantCalls(call('a', 'monitor_lead_volume', { client_name_or_email: 'client@example.com' }));
      expect(ok([req, result('a', 'monitor_lead_volume', preview(RECIPIENT))])).toEqual({ ok: true });
      expect(ok([req, result('a', 'monitor_lead_volume', preview(OTHER))])).toMatchObject({ ok: false, reason: 'result_other_account' });
      // a preview that never names the account, or a result with no client at all (an error), cannot prove a loosely matched call
      expect(ok([req, result('a', 'monitor_lead_volume', `${header}{"success":true,"daily_rows":[{"day":"2026-1`)])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
      expect(ok([req, result('a', 'monitor_lead_volume', { success: false, error: 'No client found' })])).toMatchObject({ ok: false, reason: 'result_subject_unreadable' });
      // the REAL offload path: a large result is cut to 20,000 characters, sealed, and prefixed with the real S3 header
      const rows = Array.from({ length: 1500 }, (_, i) => ({ day: `2026-01-${i}`, campaign: `Campaign ${i}`, leads: i, note: 'x'.repeat(20) }));
      const full = JSON.stringify({ success: true, client: { userId: 'user-recipient', email: 'client@example.com', displayName: 'Client Co' }, campaigns: rows });
      expect(full.length).toBeGreaterThan(20000);
      const stored = buildToolResponseS3Header('tool-responses/s1/c1.txt', full.length) + sealTruncatedPayload(full.substring(0, 20000));
      expect(() => JSON.parse(stored)).toThrow();
      expect(ok([req, result('a', 'monitor_lead_volume', stored)])).toEqual({ ok: true });
      const otherFull = JSON.stringify({ success: true, client: { userId: 'user-other', email: 'other@example.com' }, campaigns: rows });
      const otherStored = buildToolResponseS3Header('tool-responses/s1/c1.txt', otherFull.length) + sealTruncatedPayload(otherFull.substring(0, 20000));
      expect(ok([req, result('a', 'monitor_lead_volume', otherStored)])).toMatchObject({ ok: false, reason: 'result_other_account' });
      // a spoofed `"client":` inside a string is escaped in JSON and is not read as the key
      const spoof = `{"note":"x \\"client\\":{\\"userId\\":\\"user-recipient\\"}","client":{"userId":"user-other","email":"other@example.com"},"rows":[{"a`;
      expect(ok([req, result('a', 'monitor_lead_volume', spoof)])).toMatchObject({ ok: false, reason: 'result_other_account' });
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
