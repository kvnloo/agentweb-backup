import { detectCrmFreshnessMismatch, runCrmFreshnessShadow } from '../utils/crmFreshnessGuard';

const ok = (name: string, result: any = { success: true }) => ({ id: name, name, arguments: {}, result });

describe('detectCrmFreshnessMismatch (ENG-2263)', () => {
  it('flags a [verified: get_lead_lists] tag when no CRM tool ran this turn', () => {
    const r = detectCrmFreshnessMismatch('Total leads across all lists: 47 [verified: get_lead_lists]', []);
    expect(r.findings).toEqual([expect.objectContaining({ kind: 'cited_tool_not_run', cited: ['get_lead_lists'] })]);
  });

  it('flags it when a DIFFERENT CRM tool ran (the one cited did not)', () => {
    const r = detectCrmFreshnessMismatch(
      'You have 5 Test leads [verified: search_leads]. Overall: 47 leads [verified: get_lead_lists]',
      [ok('search_leads')],
    );
    expect(r.findings.map((f) => f.cited)).toEqual([['get_lead_lists']]);
    expect(r.crmToolsSucceeded).toEqual(['search_leads']);
  });

  it('does not flag a tag whose cited tool succeeded this turn', () => {
    const r = detectCrmFreshnessMismatch('17 lists [verified: get_lead_lists]', [ok('get_lead_lists')]);
    expect(r.findings).toEqual([]);
  });

  it('sees through HTML wrappers and backticks around the tag', () => {
    const html = '<p>47 leads <span class="c">[verified: <code>get_lead_lists</code>]</span></p>';
    expect(detectCrmFreshnessMismatch(html, []).findings).toHaveLength(1);
    expect(detectCrmFreshnessMismatch('47 leads `[verified: get_lead_lists]`', []).findings).toHaveLength(1);
  });

  it.each([
    ['an errored call', { id: 'a', name: 'get_lead_lists', arguments: {}, error: 'boom' }],
    ['a success:false preflight rejection', ok('get_lead_lists', { success: false })],
    ['a suppressed same-turn duplicate', { id: 'a', name: 'get_lead_lists', arguments: {}, result: {}, duplicateOf: 'b' }],
    ['a deferred call', ok('get_lead_lists', { deferred: true })],
  ])('treats %s as NOT run', (_label, call) => {
    expect(detectCrmFreshnessMismatch('17 lists [verified: get_lead_lists]', [call]).findings).toHaveLength(1);
  });

  it('leaves an already-honest tag alone', () => {
    for (const text of [
      '47 leads [verified: get_lead_lists earlier]',
      '47 leads [verified: previous turn]',
      '47 leads [verified: get_lead_lists, possibly out of date]',
    ]) {
      expect(detectCrmFreshnessMismatch(text, []).findings).toEqual([]);
    }
  });

  it('flags a bare [verified] beside CRM wording only when no CRM tool succeeded', () => {
    const text = 'You have 18 lead lists [verified] and 47 leads.';
    expect(detectCrmFreshnessMismatch(text, []).findings).toEqual([expect.objectContaining({ kind: 'bare_tag_no_crm_tool' })]);
    expect(detectCrmFreshnessMismatch(text, [ok('get_leads')]).findings).toEqual([]);
  });

  it('ignores a bare [verified] that is not about CRM data', () => {
    expect(detectCrmFreshnessMismatch('The pixel fires on page load [verified]', []).findings).toEqual([]);
  });

  it('ignores tags citing non-CRM tools', () => {
    expect(detectCrmFreshnessMismatch('Spend is $40 [verified: get_meta_ads_metrics]', []).findings).toEqual([]);
  });

  it('does not treat a longer tool name as a CRM tool (get_leads vs get_leads_needing_followup is distinct)', () => {
    const r = detectCrmFreshnessMismatch('3 due [verified: get_leads_needing_followup]', [ok('get_leads')]);
    expect(r.findings).toHaveLength(1);
  });

  it.each([undefined, null, 42, '', {}, []])('returns nothing for non-text input %p', (input) => {
    expect(detectCrmFreshnessMismatch(input, [ok('get_leads')]).findings).toEqual([]);
  });

  it('tolerates malformed tool-call ledgers', () => {
    expect(() => detectCrmFreshnessMismatch('x [verified: get_leads]', [null, 7, { name: 5 }, undefined] as any)).not.toThrow();
    expect(detectCrmFreshnessMismatch('x [verified: get_leads]', 'nope' as any).findings).toHaveLength(1);
  });

  // Real outputs captured in the ENG-2263 replay (cheap model, no CRM tool called).
  it('flags the real carry-over shapes seen in the replay', () => {
    const real = [
      '- Total lead lists: 18 [verified: get_lead_lists]\n- Total leads across all lists: 47 [verified: get_lead_lists]',
      "**Lead overview** [verified: get_lead_lists]:\n- Total lead lists: 18\n- Total leads across all lists: 47",
      'In total, you have 18 lists and 47 leads across your entire CRM [verified: get_leads, list_id: list_1]',
    ];
    for (const text of real) expect(detectCrmFreshnessMismatch(text, []).findings.length).toBeGreaterThan(0);
  });

  it('stays quiet on the real good shapes (fresh re-query, truthful tag)', () => {
    const calls = [ok('get_lead_lists'), ok('search_leads')];
    const good = [
      '<p><strong>5</strong> <span>[verified: <code>get_lead_lists</code> + <code>search_leads</code> across all 17 lists]</span></p>',
      'Exact total: 5 leads [verified: search_leads, all 17 lists covered]',
    ];
    for (const text of good) expect(detectCrmFreshnessMismatch(text, calls).findings).toEqual([]);
  });
});

describe('runCrmFreshnessShadow (ENG-2263)', () => {
  const OLD = process.env.AGENT_CRM_FRESHNESS_GUARD;
  afterEach(() => {
    if (OLD === undefined) delete process.env.AGENT_CRM_FRESHNESS_GUARD; else process.env.AGENT_CRM_FRESHNESS_GUARD = OLD;
  });

  it('logs once with the model, kinds and a sample, and never touches the message', () => {
    const log = jest.fn();
    const text = '47 leads [verified: get_lead_lists]';
    const findings = runCrmFreshnessShadow({ finalText: text, toolCalls: [], sessionId: 's1', model: 'gemini-3.1-flash-lite', log });
    expect(findings).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('[crm-freshness-shadow]');
    expect(log.mock.calls[0][0]).toContain('message NOT modified');
    expect(log.mock.calls[0][1]).toMatchObject({ sessionId: 's1', model: 'gemini-3.1-flash-lite', kinds: ['cited_tool_not_run'], findingCount: 1 });
    expect(text).toBe('47 leads [verified: get_lead_lists]');
  });

  it('is silent when there is nothing to report', () => {
    const log = jest.fn();
    runCrmFreshnessShadow({ finalText: '17 lists [verified: get_lead_lists]', toolCalls: [ok('get_lead_lists')], log });
    runCrmFreshnessShadow({ finalText: 'No tags here.', toolCalls: [], log });
    expect(log).not.toHaveBeenCalled();
  });

  it('is disabled by AGENT_CRM_FRESHNESS_GUARD=off', () => {
    process.env.AGENT_CRM_FRESHNESS_GUARD = 'off';
    const log = jest.fn();
    expect(runCrmFreshnessShadow({ finalText: '47 [verified: get_lead_lists]', toolCalls: [], log })).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('never throws, even if the logger does', () => {
    const log = jest.fn(() => { throw new Error('log sink down'); });
    expect(() => runCrmFreshnessShadow({ finalText: '47 [verified: get_lead_lists]', toolCalls: [], log })).not.toThrow();
  });
});
