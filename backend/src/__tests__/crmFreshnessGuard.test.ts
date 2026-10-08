import { createCrmEvidenceCollector, detectCrmFreshnessMismatch, runCrmFreshnessShadow } from '../utils/crmFreshnessGuard';

const ok = (name: string, result: any = { success: true }) => ({ id: name, name, arguments: {}, result });
// The first describe is about the [verified: ...] tag check; account-wide totals are covered separately below.
const tagOnly = (text: unknown, calls: unknown) =>
  detectCrmFreshnessMismatch(text, calls).findings.filter((f) => f.kind === 'cited_tool_not_run');

describe('detectCrmFreshnessMismatch (ENG-2263)', () => {
  it('flags a [verified: get_lead_lists] tag when no CRM tool ran this turn', () => {
    expect(tagOnly('Total leads across all lists: 47 [verified: get_lead_lists]', [])).toEqual([
      expect.objectContaining({ kind: 'cited_tool_not_run', cited: ['get_lead_lists'] }),
    ]);
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
    const r = detectCrmFreshnessMismatch('17 lists [verified: get_lead_lists]', [ok('get_lead_lists', { success: true, lists: [{ leadCount: 5 }, { leadCount: 12 }], totalLists: 17 })]);
    expect(r.findings).toEqual([]);
  });

  it('sees through HTML wrappers and backticks around the tag', () => {
    const html = '<p>47 leads <span class="c">[verified: <code>get_lead_lists</code>]</span></p>';
    expect(tagOnly(html, [])).toHaveLength(1);
    expect(tagOnly('47 leads `[verified: get_lead_lists]`', [])).toHaveLength(1);
  });

  it.each([
    ['an errored call', { id: 'a', name: 'get_lead_lists', arguments: {}, error: 'boom' }],
    ['a success:false preflight rejection', ok('get_lead_lists', { success: false })],
    ['a suppressed same-turn duplicate', { id: 'a', name: 'get_lead_lists', arguments: {}, result: {}, duplicateOf: 'b' }],
    ['a deferred call', ok('get_lead_lists', { deferred: true })],
  ])('treats %s as NOT run', (_label, call) => {
    expect(tagOnly('17 lists [verified: get_lead_lists]', [call])).toHaveLength(1);
  });

  it('leaves an already-honest tag alone', () => {
    for (const text of [
      '47 leads [verified: get_lead_lists earlier]',
      '47 leads [verified: previous turn]',
      '47 leads [verified: get_lead_lists, possibly out of date]',
    ]) {
      expect(tagOnly(text, [])).toEqual([]);
    }
  });

  it('does not judge a bare [verified] that names no tool (it caught nothing extra in the replay and misfired on commentary)', () => {
    expect(tagOnly('You have 18 lead lists [verified] and 47 leads.', [])).toEqual([]);
    expect(tagOnly('The pixel fires on page load [verified]', [])).toEqual([]);
  });

  // Captured from the ENG-2263 preview run: gemini-3.8-flash declined to use the tag and said so.
  it('does not flag the model talking ABOUT the tag instead of using it', () => {
    const commentary = [
      'I cannot include the <code>[verified]</code> tag because no tool was run in this turn to verify the count.',
      'I cannot tag this count as verified because no tool was run in this turn — the <code>[verified]</code> tag is strictly reserved for data confirmed by a live tool call.',
      "I can't attach the [verified: get_lead_lists] tag because get_lead_lists did not run this turn.",
      'The [verified: get_lead_lists] label is only for numbers re-queried this turn, so I left it off.',
      'Without using [verified: get_lead_lists] here, the total is 47 as of earlier in the conversation.',
    ];
    for (const text of commentary) expect(tagOnly(text, [])).toEqual([]);
  });

  it('recognises a mention by the word AFTER the tag even when nothing introduces it', () => {
    expect(tagOnly('Skipping the usual [verified: get_lead_lists] tag, since nothing ran this turn.', [])).toEqual([]);
    expect(tagOnly('Total is 47 [verified: get_lead_lists] label omitted on purpose.', [])).toEqual([]);
  });

  it('still flags a real claim even when the sentence mentions a tag elsewhere', () => {
    const text = "I can't re-check right now, but you have 47 leads in total [verified: get_lead_lists].";
    expect(tagOnly(text, [])).toHaveLength(1);
  });

  it('ignores tags citing non-CRM tools', () => {
    expect(tagOnly('Spend is $40 [verified: get_meta_ads_metrics]', [])).toEqual([]);
  });

  it('does not treat a longer tool name as a CRM tool (get_leads vs get_leads_needing_followup is distinct)', () => {
    const r = detectCrmFreshnessMismatch('3 due [verified: get_leads_needing_followup]', [ok('get_leads')]);
    expect(r.findings).toHaveLength(1);
  });

  it.each([undefined, null, 42, '', {}, []])('returns nothing for non-text input %p', (input) => {
    expect(tagOnly(input, [ok('get_leads')])).toEqual([]);
  });

  it('tolerates malformed tool-call ledgers', () => {
    expect(() => detectCrmFreshnessMismatch('x [verified: get_leads]', [null, 7, { name: 5 }, undefined] as any)).not.toThrow();
    expect(tagOnly('x [verified: get_leads]', 'nope' as any)).toHaveLength(1);
  });

  // Real outputs captured in the ENG-2263 replay (cheap model, no CRM tool called).
  it('flags the real carry-over shapes seen in the replay', () => {
    const real = [
      '- Total lead lists: 18 [verified: get_lead_lists]\n- Total leads across all lists: 47 [verified: get_lead_lists]',
      "**Lead overview** [verified: get_lead_lists]:\n- Total lead lists: 18\n- Total leads across all lists: 47",
      'In total, you have 18 lists and 47 leads across your entire CRM [verified: get_leads, list_id: list_1]',
    ];
    for (const text of real) expect(tagOnly(text, []).length).toBeGreaterThan(0);
  });

  it('stays quiet on the real good shapes (fresh re-query, truthful tag)', () => {
    const calls = [ok('get_lead_lists'), ok('search_leads')];
    const good = [
      '<p><strong>5</strong> <span>[verified: <code>get_lead_lists</code> + <code>search_leads</code> across all 17 lists]</span></p>',
      'Exact total: 5 leads [verified: search_leads, all 17 lists covered]',
    ];
    for (const text of good) expect(tagOnly(text, calls)).toEqual([]);
  });
});

// Real get_lead_lists shape (emma/impl/leads.ts getLeadLists): per-list leadCount + totalLists, NO total-leads field,
// so a correct "N leads in total" is a sum the model computed.
const listsResult = (counts: number[]) => ({
  success: true,
  message: `Found ${counts.length} lead list(s)`,
  lists: counts.map((leadCount, i) => ({ listId: `list_${i}`, name: `L${i}`, leadCount })),
  totalLists: counts.length,
});

describe('detectCrmFreshnessMismatch - untagged account-wide totals (ENG-2263)', () => {
  const kinds = (text: string, calls: any[] = []) =>
    detectCrmFreshnessMismatch(text, calls).findings.filter((f) => f.kind === 'inventory_total_not_in_tool_results');

  it('flags a stale total restated with no CRM tool this turn, even with no tag at all', () => {
    const f = kinds('You have 18 lead lists containing a total of 47 leads in total.');
    expect(f.map((x) => x.claimed).sort()).toEqual([18, 47]);
  });

  it('accepts the sum of leadCount and totalLists from this turn get_lead_lists result', () => {
    const calls = [ok('get_lead_lists', listsResult([10, 8, 7, 6, 4, 4, 2, 2, 0]))];
    expect(kinds('You have 9 lead lists and 43 leads in total.', calls)).toEqual([]);
    expect(kinds('Total lead lists: 9. Total leads across all lists: 43', calls)).toEqual([]);
  });

  it('flags a stale total even when get_lead_lists ran, if the number is not in its result', () => {
    const calls = [ok('get_lead_lists', listsResult([10, 8, 7, 6, 4, 4, 2, 2, 0]))];
    expect(kinds('You have 9 lead lists and 47 leads in total.', calls).map((x) => x.claimed)).toEqual([47]);
  });

  it('accepts the sum of per-call match counts (3 + 1 + 1 = 5) without get_lead_lists', () => {
    const calls = [
      ok('search_leads', { leads: [{}, {}, {}], count: 3 }),
      ok('search_leads', { leads: [{}], count: 1 }),
      ok('search_leads', { leads: [{}], count: 1 }),
    ];
    expect(kinds('You have 5 leads in total matching Test.', calls)).toEqual([]);
  });

  it('accepts results delivered as JSON strings', () => {
    const calls = [{ id: 'a', name: 'get_lead_lists', arguments: {}, result: JSON.stringify(listsResult([3, 2])) }];
    expect(kinds('2 lead lists, 5 leads in total.', calls)).toEqual([]);
  });

  it('does not treat a filtered search total as an account-wide total', () => {
    expect(kinds('You have 5 leads named Test across all lists.')).toEqual([]);
    expect(kinds('Exact total: 5 leads across all lists [verified: search_leads].', [ok('search_leads', { count: 5 })])).toEqual([]);
    expect(kinds('I found 5 leads across all lists.')).toEqual([]);
    expect(kinds('I found 5 leads across all your lists.')).toEqual([]);
    expect(kinds('Total Test leads: 5', [ok('search_leads', { count: 5 })])).toEqual([]);
  });

  it('catches the "Total Leads Across All Lists: N" label form seen from gpt-4o-mini', () => {
    expect(kinds('- **Total Leads Across All Lists:** 47\n- **Total lead lists**: 17').map((x) => x.claimed).sort()).toEqual([17, 47]);
  });

  it('parses thousands separators and "N leads across K lists"', () => {
    expect(kinds('You have approximately 12,656 leads across 96 lists.').map((x) => x.claimed ?? 0).sort((a, b) => a - b)).toEqual([96, 12656]);
  });

  it('skips a claim with honest wording right next to it', () => {
    expect(kinds('As of my earlier check, you had 47 leads in total across 18 lists.')).toEqual([]);
    expect(kinds('Both moved since my previous answer: 43 leads in total (was 47), 17 lead lists (was 18).')).toEqual([]);
  });

  it('does not flag small numbers unrelated to inventory', () => {
    expect(kinds('Step 2 of 3: I will send 5 emails and update 3 contacts.')).toEqual([]);
  });

  it('reports each distinct stale number once', () => {
    expect(kinds('47 leads in total. Again: 47 leads in total.')).toHaveLength(1);
  });

  it('caps the number of claims it evaluates', () => {
    const text = Array.from({ length: 500 }, (_, i) => `${1000 + i} leads in total`).join('. ');
    expect(kinds(text).length).toBeLessThanOrEqual(20);
  });

  it('stays linear on hostile digit/space input', () => {
    const t0 = process.hrtime.bigint();
    detectCrmFreshnessMismatch('1 '.repeat(100_000) + 'total leads ' + '9'.repeat(100_000), []);
    detectCrmFreshnessMismatch(('9' + ' '.repeat(2000)).repeat(100), []);
    detectCrmFreshnessMismatch('total lists '.repeat(15_000), []);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(1000);
  });
});

// In production the ledger holds a MINIMISED result (get_lead_lists / search_leads collapse to {}), so numbers
// come from a collector fed the full result at dispatch. Without it, every correct answer would be flagged.
describe('CRM evidence from the real dispatch path (ENG-2263)', () => {
  const ledgerEmpty = (name: string) => ({ id: name, name, arguments: {}, result: {} });
  const inv = (text: string, calls: any[], evidence?: any) =>
    detectCrmFreshnessMismatch(text, calls, evidence).findings.filter((f) => f.kind === 'inventory_total_not_in_tool_results');
  const collector = (...pairs: Array<[string, unknown]>) => { const c = createCrmEvidenceCollector(); for (const [n, r] of pairs) c.record(n, r); return c; };

  it('REGRESSION: a correct total is not flagged when the ledger result is empty but the collector saw the real one', () => {
    const c = collector(['get_lead_lists', listsResult([10, 8, 7, 6, 4, 4, 2, 2, 0])]);
    expect(inv('You have 9 lead lists and 43 leads in total.', [ledgerEmpty('get_lead_lists')], c.snapshot())).toEqual([]);
  });

  it('flags a stale number even when the collector saw a fresh result', () => {
    const c = collector(['get_lead_lists', listsResult([10, 8, 7, 6, 4, 4, 2, 2, 0])]);
    expect(inv('You have 9 lead lists and 47 leads in total.', [ledgerEmpty('get_lead_lists')], c.snapshot()).map((f) => f.claimed)).toEqual([47]);
  });

  it('ABSTAINS when a CRM tool succeeded but nothing can verify its numbers (no collector, empty ledger result)', () => {
    expect(inv('You have 96 lead lists and 47 leads in total.', [ledgerEmpty('get_lead_lists')])).toEqual([]);
  });

  it('ABSTAINS for a succeeded tool the collector never saw, even if another tool was seen', () => {
    const c = collector(['search_leads', { count: 3, leads: [{}, {}, {}] }]);
    expect(inv('You have 47 leads in total.', [ledgerEmpty('search_leads'), ledgerEmpty('get_lead_lists')], c.snapshot())).toEqual([]);
  });

  it('with NO CRM tool at all it still judges (this is the carried-over total case)', () => {
    expect(inv('You have 18 lead lists and 47 leads in total.', [], collector().snapshot()).map((f) => f.claimed).sort()).toEqual([18, 47]);
  });

  it('sums match counts across several search calls', () => {
    const c = collector(['search_leads', { count: 3, leads: [{}, {}, {}] }], ['search_leads', { count: 1, leads: [{}] }], ['search_leads', { count: 1, leads: [{}] }]);
    const calls = [ledgerEmpty('search_leads'), ledgerEmpty('search_leads'), ledgerEmpty('search_leads')];
    expect(inv('You have 5 leads in total matching Test.', calls, c.snapshot())).toEqual([]);
  });

  it('keeps a second get_lead_lists result from corrupting the first (sums are per call)', () => {
    const c = collector(['get_lead_lists', listsResult([5, 5])], ['get_lead_lists', listsResult([7, 3, 2])]);
    const calls = [ledgerEmpty('get_lead_lists'), ledgerEmpty('get_lead_lists')];
    expect(inv('You have 3 lead lists and 12 leads in total.', calls, c.snapshot())).toEqual([]);
  });

  describe('collector', () => {
    it('ignores non-CRM tools and failed results', () => {
      const c = collector(['web_search', { count: 99 }], ['get_lead_lists', { success: false, totalLists: 77 }]);
      expect(c.snapshot().tools.size).toBe(0);
      expect(c.snapshot().numbers.has(99)).toBe(false);
      expect(c.snapshot().numbers.has(77)).toBe(false);
    });

    it.each([undefined, null, 5, 'not json', [], { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }])('never throws on result %p', (r) => {
      const c = createCrmEvidenceCollector();
      expect(() => c.record('get_lead_lists', r)).not.toThrow();
      expect(() => c.record(undefined, r)).not.toThrow();
      expect(() => c.record(42, r)).not.toThrow();
    });

    it('stays bounded on a giant result and on thousands of calls', () => {
      const c = createCrmEvidenceCollector();
      const t0 = process.hrtime.bigint();
      c.record('search_leads', { leads: Array.from({ length: 200_000 }, (_, i) => ({ leadCount: i, id: i })) });
      for (let i = 0; i < 5000; i++) c.record('get_leads', { count: i });
      expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(1500);
      // 5000 distinct result numbers + at most 200 recorded calls' running match-count sums.
      expect(c.snapshot().numbers.size).toBeLessThanOrEqual(5200);
    });

    it('parses JSON-string results', () => {
      const c = collector(['get_lead_lists', JSON.stringify(listsResult([3, 2]))]);
      expect(c.snapshot().numbers.has(5)).toBe(true);
    });
  });

  it('runCrmFreshnessShadow threads the evidence through to the detector', () => {
    const log = jest.fn();
    const c = collector(['get_lead_lists', listsResult([3, 2])]);
    runCrmFreshnessShadow({ finalText: '2 lead lists, 5 leads in total.', toolCalls: [ledgerEmpty('get_lead_lists')], evidence: c.snapshot(), log });
    expect(log).not.toHaveBeenCalled();
    runCrmFreshnessShadow({ finalText: '2 lead lists, 47 leads in total.', toolCalls: [ledgerEmpty('get_lead_lists')], evidence: c.snapshot(), log });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

// This runs synchronously on every reply. An unbounded `[^\]]*` / `[^>]*` regex is quadratic on unclosed
// delimiters (measured before the fix: 100KB of "[verified " blocked the event loop 1.5s, 500KB 37s).
describe('detectCrmFreshnessMismatch stays linear on hostile input (ENG-2263)', () => {
  const ms = (text: string) => { const t0 = process.hrtime.bigint(); detectCrmFreshnessMismatch(text, []); return Number(process.hrtime.bigint() - t0) / 1e6; };
  it.each([
    ['unclosed [verified', '[verified '.repeat(100_000)],
    ['unclosed <', '<'.repeat(500_000)],
    ['unclosed <a', '<a '.repeat(200_000)],
    ['"< " then one far ">"', '< '.repeat(100_000) + '>'],
    ['mixed unclosed < and [verified', '<[verified '.repeat(20_000)],
  ])('%s finishes well under a second', (_label, text) => {
    expect(ms(text)).toBeLessThan(500);
  });

  it('caps the work on a reply stuffed with tags', () => {
    const r = detectCrmFreshnessMismatch('[verified: get_leads] '.repeat(20_000), []);
    expect(r.tagsSeen).toBe(200);
    expect(r.findings).toHaveLength(200);
  });

  it('treats a lone "<" as text, and still finds a tag after it', () => {
    expect(detectCrmFreshnessMismatch('5 < 6 and 47 leads [verified: get_lead_lists]', []).findings).toHaveLength(1);
  });

  it('strips real markup around and inside a tag', () => {
    expect(detectCrmFreshnessMismatch('<b>47</b> leads <i>[verified: <code>get_lead_lists</code>]</i>', []).findings).toHaveLength(1);
  });

  it('does not match a tag longer than the 300-char bound (not a real tag)', () => {
    expect(detectCrmFreshnessMismatch('[verified: get_lead_lists ' + 'x'.repeat(400) + ']', []).findings).toEqual([]);
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

  it('default sink writes ONE line: the marker followed by valid JSON', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      runCrmFreshnessShadow({ finalText: 'You have 18 lead lists and 47 leads in total [verified: get_lead_lists]', toolCalls: [], sessionId: 's9', model: 'm1' });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line.includes('\n')).toBe(false);
      const json = JSON.parse(line.slice(line.indexOf('{')));
      expect(json).toMatchObject({ sessionId: 's9', model: 'm1' });
      expect(json.kinds).toEqual(expect.arrayContaining(['cited_tool_not_run', 'inventory_total_not_in_tool_results']));
      expect(JSON.stringify(json)).not.toContain('lead lists and');
    } finally { warn.mockRestore(); }
  });

  it('survives hostile input through the real entry point (not just the detector)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t0 = process.hrtime.bigint();
      for (const text of ['[verified '.repeat(500_000), '<'.repeat(2_000_000), '1 '.repeat(500_000), 'total lists '.repeat(100_000)]) {
        expect(() => runCrmFreshnessShadow({ finalText: text, toolCalls: [], sessionId: 'h', model: 'm' })).not.toThrow();
      }
      expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(1500);
    } finally { warn.mockRestore(); }
  });

  it('is silent when there is nothing to report', () => {
    const log = jest.fn();
    runCrmFreshnessShadow({ finalText: '17 lists [verified: get_lead_lists]', toolCalls: [ok('get_lead_lists', { success: true, lists: [{ leadCount: 5 }], totalLists: 17 })], log });
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
