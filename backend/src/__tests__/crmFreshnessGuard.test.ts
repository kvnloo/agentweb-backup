import {
  createCrmEvidenceCollector, crmEvidenceFromEarlierInvocations, crmToolsFromEarlierInvocations, detectCrmFreshnessMismatch,
  crmNumbersFromSessionHistory, looksLikeContinueRequest, runCrmFreshnessShadow, serializeCrmEvidence,
} from '../utils/crmFreshnessGuard';

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

  it('skips the honest labels the models actually write (captured from gemini-3.8-flash on the preview)', () => {
    for (const text of [
      'You have 96 lead lists in total (from our check a moment ago).',
      'You have 96 lead lists in total, based on our check earlier in this session.',
      'From our check just moments ago, you have 96 lead lists in total (unverified this turn, as requested).',
      'You have 96 lead lists in total (per the previous lookup, not re-queried).',
      'In our session you had 96 lead lists in total; I have not re-run it.',
    ]) expect(kinds(text)).toEqual([]);
  });

  it('still flags the same sentence when nothing says it is old', () => {
    expect(kinds('You have 96 lead lists in total.').map((x) => x.claimed)).toEqual([96]);
    expect(kinds('Right now you have 96 lead lists in total, confirmed.').map((x) => x.claimed)).toEqual([96]);
  });

  it('skips a claim with honest wording right next to it', () => {
    expect(kinds('As of my earlier check, you had 47 leads in total across 18 lists.')).toEqual([]);
    expect(kinds('Both moved since my previous answer: 43 leads in total (was 47), 17 lead lists (was 18).')).toEqual([]);
  });

  it('does not treat a subset breakdown as the account total (captured from gemini-3.8-flash: "Remaining 15 lists")', () => {
    expect(kinds('5 Test leads [verified: search_leads]:\n  Test Lead List: 3 leads\n  Remaining 15 lists: 0 leads', [ok('search_leads', { count: 5 })])).toEqual([]);
    expect(kinds('The other 4 lists are empty.')).toEqual([]);
    expect(kinds('Plus 12 lists with no matches.')).toEqual([]);
  });

  it('still flags a bare total with no subset word in front', () => {
    expect(kinds('Across the CRM you have 15 lists.').map((x) => x.claimed)).toEqual([15]);
  });

  it('does not flag small numbers unrelated to inventory', () => {
    expect(kinds('Step 2 of 3: I will send 5 emails and update 3 contacts.')).toEqual([]);
  });

  it('reports each distinct stale number once', () => {
    expect(kinds('Your CRM has 47 leads in total. Again: your CRM has 47 leads in total.')).toHaveLength(1);
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
describe('false alarms and masks found by the PR #3351 review (ENG-2263)', () => {
  const inv = (t: string, calls: any[] = [], ev?: any) =>
    detectCrmFreshnessMismatch(t, calls, ev).findings.filter((f) => f.kind === 'inventory_total_not_in_tool_results').map((f) => f.claimed);
  const led = (name: string, result: any = {}) => ({ id: name, name, arguments: {}, result });
  const col = (...p: Array<[string, unknown]>) => { const c = createCrmEvidenceCollector(); for (const [n, r] of p) c.record(n, r); return c.snapshot(); };

  it('does not read a non-CRM lead total as the CRM total', () => {
    expect(inv('Apollo found 2,500 leads in total.')).toEqual([]);
    expect(inv('Got it, you have 50 leads in total.')).toEqual([]);
    expect(inv('Here are the total leads:\n\n1. Alice\n2. Bob')).toEqual([]);
    expect(inv('Total leads\n\n2024 plan')).toEqual([]);
  });

  it('still judges the generic form when CRM wording is in the same sentence', () => {
    expect(inv('Your CRM has 47 leads in total.')).toEqual([47]);
    expect(inv('Across all your lists you have 47 leads in total.')).toEqual([47]);
  });

  it('abstains after a CRM write (the totals changed, so an earlier read is not comparable)', () => {
    expect(inv('Your CRM now has 150 leads in total.', [led('add_leads_to_list', { success: true })])).toEqual([]);
    expect(inv('I created 4 lead lists.', [led('create_lead_list', { success: true })])).toEqual([]);
  });

  it('does not read "I created/added N lists" as a total even without a write ledger', () => {
    expect(inv('I created 4 lead lists for you.')).toEqual([]);
    expect(inv('Imported 12 lead lists from the CSV.')).toEqual([]);
  });

  it('accepts the number of DISTINCT lists a multi-list search touched', () => {
    const r = { count: 20, leads: Array.from({ length: 20 }, (_, i) => ({ listId: `list_${i % 3}`, leadId: `l${i}` })) };
    expect(inv('Found 20 leads across 3 lists.', [led('search_leads')], col(['search_leads', r]))).toEqual([]);
  });

  it('does not let numbers inside lead rows (scores, deal values, phone digits) back a stale total', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ leadId: `l${i}`, icpScore: 60 + i, engagementCount: i, dealValue: 100 + i, phone: `${5550000 + i}` }));
    const ev = col(['get_leads', { success: true, count: 20, leads: rows }]);
    const calls = [led('get_leads')];
    expect(inv('Your CRM has 63 leads in total.', calls, ev)).toEqual([63]);
    expect(inv('You have 15 lead lists.', calls, ev)).toEqual([15]);
    expect(inv('Your CRM has 20 leads in total.', calls, ev)).toEqual([]);
  });

  it('an honest label two sentences away does NOT excuse a stale claim', () => {
    expect(inv('Your last import was 2 days ago. You have 18 lead lists.')).toEqual([18]);
    expect(inv('Before I continue, here is the summary: you have 18 lead lists.')).toEqual([18]);
    expect(inv('You have 18 lead lists. (This was last checked before your import.)')).toEqual([18]);
  });

  it('catches the bullet-list form: "Lead lists: 18" with "Total leads: 47" on the next line (gpt-4o-mini)', () => {
    expect(inv('**Overview Summary:**\n- Lead lists: 18\n- Total leads: 47\n- Specific lead total: 1').sort()).toEqual([18, 47]);
    expect(inv('- **Overall Lead Lists:** 17\n- **Total Leads:** 47').sort()).toEqual([17, 47]);
  });

  it('paragraph-level CRM wording enables the generic form, a different paragraph does not', () => {
    expect(inv('Your CRM summary\n- Total leads: 47')).toEqual([47]);
    expect(inv('Your CRM is great.\n\nApollo search results\n- Total leads: 47')).toEqual([]);
  });

  it('a label phrase in a PREVIOUS sentence does not excuse a later claim', () => {
    expect(inv('Earlier I imported your file. You have 18 lead lists.')).toEqual([18]);
    expect(inv('I checked this previously for another account. Your CRM has 47 leads in total.')).toEqual([47]);
  });

  it('a heading with CRM wording does not capture the number on the next line (list index / year)', () => {
    expect(inv('Your CRM total leads\n\n2024 plan')).toEqual([]);
    expect(inv('Total lead lists\n3. Review')).toEqual([]);
    expect(inv('Total lead lists: 17', [], undefined)).toEqual([17]);
  });

  it('an honest label in the SAME sentence still excuses it', () => {
    expect(inv('You have 18 lead lists (from our check earlier).')).toEqual([]);
    expect(inv('You have 18 lead lists, per the prior check.')).toEqual([]);
    expect(inv('You have 18 lead lists (from our check a moment ago).')).toEqual([]);
    expect(inv('As noted previously, you have 18 lead lists.')).toEqual([]);
    expect(inv('Based on the prior analysis, you have 18 lead lists.')).toEqual([]);
  });
});

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

// One user-visible task can be several invocations. The ledger result of an earlier one is minimised (numbers gone), so its CRM
// calls can be named but not checked: count them as run for the tag check and abstain on the total check.
describe('work that spans several invocations (ENG-2263)', () => {
  const user = (content: string, metadata: any = {}) => ({ role: 'user', content, metadata });
  const asst = (content: string, tools: any[] = [], metadata: any = {}) => ({ role: 'assistant', content, metadata: { ...metadata, ...(tools.length ? { toolCalls: tools } : {}) } });
  const call = (name: string, extra: any = {}) => ({ id: name, name, arguments: {}, result: {}, ...extra });
  const earlier = crmToolsFromEarlierInvocations;

  it('auto-continuation: the CRM calls of the invocation it continues count', () => {
    expect(earlier([user('How many lead lists?'), asst('96', [call('get_lead_lists')]), user('[SYSTEM] auto', { kind: 'auto-continuation' })])).toEqual(['get_lead_lists']);
  });

  it('a chain of continuations reaches back to the request that opened the task', () => {
    const h = [
      user('Build the batch'), asst('part 1', [call('get_lead_lists')]),
      user('[SYSTEM] auto', { kind: 'auto-continuation' }), asst('part 2', [call('search_leads')]),
      user('[SYSTEM] auto', { kind: 'auto-continuation' }),
    ];
    expect(earlier(h)).toEqual(['get_lead_lists', 'search_leads']);
  });

  it('an answer to a question card or approval deck continues the task that asked', () => {
    for (const md of [{ askUserQuestionAnswer: { questionId: 'q', optionId: 'o' } }, { approvalDeckAnswer: {} }, { approvalDeckCancelled: {} }]) {
      expect(earlier([user('go'), asst('which list?', [call('get_lead_lists')]), user('the second one', md)])).toEqual(['get_lead_lists']);
    }
  });

  it('the user typing "continue" after a time-limit partial continues the task', () => {
    const h = [user('Audit everything'), asst('working', [call('get_leads')]), asst('Partial results - reply continue', [], { kind: 'generation-timeout-continuation' }), user('continue')];
    expect(earlier(h)).toEqual(['get_leads']);
  });

  it('THE TICKET SCENARIO is not a continuation: a number carried across unrelated turns is still checked', () => {
    const h = [
      user('Overview of my CRM?'), asst('96 lists', [call('get_lead_lists')]),
      user('On Test Lead List, first names?'), asst('A, B'),
      user('Search all lists for Test, exact total'),
    ];
    expect(earlier(h)).toEqual([]);
  });

  it('a plain follow-up right after a CRM answer is not a continuation either', () => {
    expect(earlier([user('How many lists?'), asst('96', [call('get_lead_lists')]), user('Remind me the total, do not re-run anything')])).toEqual([]);
  });

  it('a genuine request in the middle stops the walk (earlier tasks do not leak in)', () => {
    const h = [
      user('task one'), asst('x', [call('get_lead_lists')]),
      user('task two'), asst('y', [call('search_leads')]),
      user('[SYSTEM] auto', { kind: 'auto-continuation' }),
    ];
    expect(earlier(h)).toEqual(['search_leads']);
  });

  it('ignores errored calls and non-CRM tools', () => {
    const h = [user('go'), asst('x', [call('get_lead_lists', { error: 'boom' }), call('web_search'), call('get_leads', { result: { success: false } })]), user('', { kind: 'auto-continuation' })];
    expect(earlier(h)).toEqual([]);
  });

  it('returns [] when the current user message is not the last history entry, or history is junk', () => {
    expect(earlier([user('a', { kind: 'auto-continuation' }), asst('b', [call('get_leads')])])).toEqual([]);
    for (const junk of [undefined, null, 5, 'x', {}, [], [null, 7, undefined], [{ role: 'user' }]]) expect(earlier(junk)).toEqual([]);
  });

  it('stays bounded on a huge history of continuations', () => {
    const h: any[] = [];
    for (let i = 0; i < 20_000; i++) h.push(user('', { kind: 'auto-continuation' }), asst('x', [call('get_leads')]));
    h.push(user('', { kind: 'auto-continuation' }));
    const t0 = process.hrtime.bigint();
    expect(earlier(h)).toEqual(['get_leads']);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(500);
  });

  describe('in the detector', () => {
    const inv = (t: string, calls: any[], ev: any, prior: string[]) => detectCrmFreshnessMismatch(t, calls, ev, prior).findings;

    it('a tag citing a tool that ran in an EARLIER invocation of the task is backed', () => {
      expect(inv('17 lists [verified: get_lead_lists]', [], undefined, ['get_lead_lists'])).toEqual([]);
      expect(inv('17 lists [verified: get_lead_lists]', [], undefined, []).filter((f) => f.kind === 'cited_tool_not_run')).toHaveLength(1);
    });

    it('a tag citing a tool that ran in NEITHER is still flagged', () => {
      expect(inv('17 lists [verified: get_lead_lists]', [], undefined, ['search_leads']).filter((f) => f.kind === 'cited_tool_not_run')).toHaveLength(1);
    });

    it('abstains on the total check when the task continues earlier work (the numbers are unrecoverable)', () => {
      const text = 'Your CRM has 18 lead lists and 47 leads in total.';
      expect(inv(text, [], undefined, ['get_lead_lists'])).toEqual([]);
      expect(inv(text, [], undefined, []).length).toBeGreaterThan(0);
    });

    it('the log says it was a continuation', () => {
      const log = jest.fn();
      runCrmFreshnessShadow({ finalText: '17 lists [verified: search_leads]', toolCalls: [], earlier: ['get_lead_lists'], log });
      expect(log.mock.calls[0][1]).toMatchObject({ continuation: true });
      const log2 = jest.fn();
      runCrmFreshnessShadow({ finalText: '17 lists [verified: search_leads]', toolCalls: [], log: log2 });
      expect(log2.mock.calls[0][1]).toMatchObject({ continuation: false });
    });
  });
});

describe('number formats and phrasings beyond "N leads in total" (ENG-2263)', () => {
  const inv = (t: string, calls: any[] = [], ev?: any) =>
    detectCrmFreshnessMismatch(t, calls, ev).findings.filter((f) => f.kind === 'inventory_total_not_in_tool_results').map((f) => f.claimed);
  const led = (name: string) => ({ id: name, name, arguments: {}, result: {} });
  const ev = (counts: number[]) => { const c = createCrmEvidenceCollector(); c.record('get_lead_lists', listsResult(counts)); return c.snapshot(); };

  it.each([
    ['You have 1.2k leads in total across your CRM.', 1200],
    ['Your CRM has 12k leads.', 12000],
    ['You have 12 thousand leads in total in your CRM.', 12000],
    ['Your CRM has twelve lead lists.', 12],
    ['You have forty-seven leads in total across your CRM.', 47],
    ['Your CRM has one hundred and five leads.', 105],
    ['Your CRM contains 1,234 leads.', 1234],
    ['You have 47 leads in total across your CRM.', 47],
  ])('flags a stale total written as %p', (text, claimed) => {
    // fresh state is nowhere near the claim, so any claim in this table is stale
    expect(inv(text, [led('get_lead_lists')], ev([5, 5, 3]))).toEqual([claimed]);
  });

  it('a rounded form is backed when the real number rounds to it (1.2k vs 1,234; about 40 vs 43)', () => {
    const big = (() => { const c = createCrmEvidenceCollector(); c.record('get_leads', { success: true, count: 1234, leads: [{}] }); return c.snapshot(); })();
    expect(inv('Your CRM has about 1.2k leads in total.', [led('get_leads')], big)).toEqual([]);
    expect(inv('Your CRM has 1.3k leads in total.', [led('get_leads')], big)).toEqual([1300]);
    const forty = ev([20, 15, 8]); // 43 leads, 3 lists
    expect(inv('Your CRM has about 40 leads in total.', [led('get_lead_lists')], forty)).toEqual([]);
    expect(inv('Your CRM has about 50 leads in total.', [led('get_lead_lists')], forty)).toEqual([50]);
  });

  it('a k/thousand form is itself a rounding (no hedge word needed): 1.2k covers 1,234 but not 1,300', () => {
    const big = (() => { const c = createCrmEvidenceCollector(); c.record('get_leads', { success: true, count: 1234, leads: [{}] }); return c.snapshot(); })();
    expect(inv('Your CRM has 1.2k leads in total.', [led('get_leads')], big)).toEqual([]);
    expect(inv('Your CRM has 1.3k leads in total.', [led('get_leads')], big)).toEqual([1300]);
    expect(inv('Your CRM has 1k leads in total.', [led('get_leads')], big)).toEqual([]); // nearest thousand
    expect(inv('Your CRM has 2k leads in total.', [led('get_leads')], big)).toEqual([2000]);
  });

  it('a list\'s own lead count does not back a wrong NUMBER OF LISTS (only the sum and the list count do)', () => {
    expect(inv('You have 8 lead lists.', [led('get_lead_lists')], ev([20, 15, 8]))).toEqual([8]);
    expect(inv('You have 3 lead lists and 43 leads in total.', [led('get_lead_lists')], ev([20, 15, 8]))).toEqual([]);
  });

  it('an unhedged number must match exactly: 47 is not "near" 43', () => {
    expect(inv('Your CRM has 47 leads in total.', [led('get_lead_lists')], ev([20, 15, 8]))).toEqual([47]);
  });

  it('a correct number written as a word or with k is backed', () => {
    expect(inv('Your CRM has three lead lists.', [led('get_lead_lists')], ev([20, 15, 8]))).toEqual([]);
    expect(inv('You have forty-three leads in total across your CRM.', [led('get_lead_lists')], ev([20, 15, 8]))).toEqual([]);
  });

  it('catches "Your CRM has/contains N leads" and a bare "You have N leads."', () => {
    expect(inv('Your CRM currently contains 47 leads.')).toEqual([47]);
    expect(inv('Right now your CRM holds approximately 47 leads and 18 lists.').sort()).toEqual([18, 47]);
    expect(inv('Across the CRM, you have 47 leads.')).toEqual([47]);
  });

  it('does not read a search or segment count as the account total', () => {
    expect(inv('You have 5 leads named Test across your lists.')).toEqual([]);
    expect(inv('You have 3 leads needing follow-up in your CRM.')).toEqual([]);
    expect(inv('You have 47 leads.')).toEqual([]); // no CRM wording anywhere: not judged
  });

  it('does not misread ordinary words that are number words or contain them', () => {
    for (const t of ['Someone lists the features.', 'One of your lists is empty.', 'Phone lists are great.', 'No one lists the prices.', 'The money lists below.']) expect(inv(t)).toEqual([]);
  });

  it('stays linear on hostile number-word / separator input', () => {
    const t0 = process.hrtime.bigint();
    for (const text of ['one '.repeat(100_000), 'forty-'.repeat(60_000), 'twelve' + ' '.repeat(100_000) + 'lists', ('five ' + '-'.repeat(50)).repeat(5000), 'crm '.repeat(40_000) + 'has', '1.2'.repeat(60_000) + 'k leads']) {
      detectCrmFreshnessMismatch(text, []);
    }
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(1500);
  });
});

// Captured from the real-pipeline run on the preview (gemini-3.8-flash / gpt-4o-mini): Emma replies are HTML.
describe('HTML replies, lead-in labels and arithmetic drift (ENG-2263)', () => {
  const inv = (t: string, calls: any[] = [], ev?: any) => detectCrmFreshnessMismatch(t, calls, ev).findings.filter((f) => f.kind === 'inventory_total_not_in_tool_results');
  const nums = (t: string, calls: any[] = [], ev?: any) => inv(t, calls, ev).map((f) => f.claimed);
  const led = (name: string) => ({ id: name, name, arguments: {}, result: {} });
  const evFor = (counts: number[]) => { const c = createCrmEvidenceCollector(); c.record('get_lead_lists', listsResult(counts)); return c.snapshot(); };

  it('a block tag becomes a line break, so a bulleted HTML list is read line by line', () => {
    const html = '<p>Going from what we know:</p><ul><li>Total lead lists: 97</li><li>Total leads: 15,480</li></ul>';
    expect(nums(html).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([97, 15480]);
  });

  it('an honest lead-in line that introduces the list labels every bullet under it', () => {
    const html = '<p>From our check earlier in the conversation (not freshly re-queried):</p><ul><li>Total lead lists: 97</li><li>Total leads: 15,480</li></ul>';
    expect(nums(html)).toEqual([]);
    expect(nums('From earlier in our conversation (unverified this turn):\n- Total lead lists: 96\n- Total leads: 6,000')).toEqual([]);
  });

  it('a lead-in only counts when it ends with a colon: an unrelated earlier line never excuses a claim', () => {
    expect(nums('Earlier I imported your file.\n- Total lead lists: 97')).toEqual([97]);
    expect(nums('<p>From our check earlier we saw a few things.</p><ul><li>Total lead lists: 97</li></ul>')).toEqual([97]);
  });

  it('a lead-in label does not leak past a new paragraph that makes its own claim', () => {
    expect(nums('From our check earlier:\n- Total lead lists: 97\n\nYour CRM now has 150 leads in total.')).toEqual([150]);
  });

  it('inline tags vanish without breaking a number or a sentence', () => {
    expect(nums('<p>Your CRM has <strong>97</strong> <code>lead lists</code> and <em>15,480</em> leads in total.</p>').sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([97, 15480]);
  });

  it('catches "a total of N leads" (gpt-4o-mini) only with CRM wording', () => {
    const real = evFor([...Array(95).fill(100), 5978]); // 96 lists, 15,478 leads
    expect(nums('You have a total of **96 lead lists** and a total of 6,000 leads overall.', [led('get_lead_lists')], real)).toEqual([6000]);
    expect(nums('You have a total of **96 lead lists** and a total of 15,478 leads overall.', [led('get_lead_lists')], real)).toEqual([]);
    expect(nums('Apollo returned a total of 6,000 leads.')).toEqual([]);
  });

  it('a lead-in covers the unbroken run of bullets under it, in plain text and in HTML', () => {
    expect(nums('From our check earlier:\n- Total lead lists: 97\n- Total leads: 15,480\n- Overall lead lists: 97')).toEqual([]);
    expect(nums('<p>From our check earlier (not re-queried):</p><ol><li>Total lead lists: 97</li><li>Total leads: 15,480</li></ol>')).toEqual([]);
  });

  it('a plain claim right under the list is not part of the list, even with no blank line', () => {
    expect(nums('From our check earlier:\n- Total lead lists: 97\nYour CRM now has 150 leads in total.')).toEqual([150]);
    expect(nums('<p>From our check earlier:</p><ul><li>Total lead lists: 97</li></ul><p>Your CRM now has 150 leads in total.</p>')).toEqual([150]);
  });

  it('a blank line inside the bullet run ends the lead-in\'s reach', () => {
    expect(nums('From our check earlier:\n- Total lead lists: 97\n\n- Your CRM has 15,480 leads in total')).toEqual([15480]);
    expect(nums('From our check earlier:\n- Total lead lists: 97\n- Your CRM has 15,480 leads in total')).toEqual([]);
  });

  it('a blank line directly between the lead-in and its first bullet does not break the link', () => {
    expect(nums('From our check earlier:\n\n- Total lead lists: 97\n- Your CRM has 15,480 leads in total')).toEqual([]);
  });

  it('a plain claim directly under a lead-in is covered', () => {
    expect(nums('From our check earlier:\nYour CRM has 97 lead lists.')).toEqual([]);
  });

  it('marks a claim within 0.5% of a number the tools really returned as arithmetic drift, not a stale total', () => {
    const ev = evFor([8000, 7478]); // 15,478 leads, 2 lists
    const f = inv('Your CRM has 15,479 leads in total.', [led('get_lead_lists')], ev);
    expect(f.map((x) => x.claimed)).toEqual([15479]);
    expect(f[0]?.drift).toBe(true);
  });

  it('a stale or invented total is NOT drift', () => {
    const ev = evFor([8000, 7478]);
    expect(inv('Your CRM has 6,000 leads in total.', [led('get_lead_lists')], ev)[0]?.drift).toBeUndefined();
    expect(inv('Your CRM has 15,000 leads in total.', [led('get_lead_lists')], ev)[0]?.drift).toBeUndefined();
  });

  it('drift is not claimed for tiny numbers (a list count of 3 vs 4 is a real difference)', () => {
    const ev = evFor([5, 5, 3]); // 3 lists
    expect(inv('You have 4 lead lists.', [led('get_lead_lists')], ev)[0]?.drift).toBeUndefined();
  });

  it('the log carries the drift count and still no text', () => {
    const logs: any[] = [];
    runCrmFreshnessShadow({ finalText: 'Your CRM has 15,479 leads in total.', toolCalls: [led('get_lead_lists')], evidence: evFor([8000, 7478]), log: (_m, d) => logs.push(d) });
    expect(logs[0]).toMatchObject({ drift: 1, claimed: [15479] });
  });

  it('stays linear on a huge HTML reply of block tags and bullets', () => {
    const t0 = process.hrtime.bigint();
    detectCrmFreshnessMismatch('<ul>' + '<li>Total leads: 15,480</li>'.repeat(20_000) + '</ul>', []);
    detectCrmFreshnessMismatch('<p>'.repeat(100_000), []);
    detectCrmFreshnessMismatch('<li>\n \n \t'.repeat(60_000), []);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(2000);
  });
});

describe('what a continuation can be checked against (ENG-2263)', () => {
  const user = (content: string, metadata: any = {}) => ({ role: 'user', content, metadata });
  const asst = (content: string, tools: any[] = [], metadata: any = {}) => ({ role: 'assistant', content, metadata: { ...metadata, ...(tools.length ? { toolCalls: tools } : {}) } });
  const call = (name: string, extra: any = {}) => ({ id: name, name, arguments: {}, result: {}, ...extra });
  const taskEvidence = (...pairs: Array<[string, unknown]>) => { const c = createCrmEvidenceCollector(); for (const [n, r] of pairs) c.record(n, r); return serializeCrmEvidence(c.snapshot()); };
  const inv = (text: string, history: any[], calls: any[] = [], ev?: any) =>
    detectCrmFreshnessMismatch(text, calls, ev, crmEvidenceFromEarlierInvocations(history)).findings
      .filter((f) => f.kind === 'inventory_total_not_in_tool_results').map((f) => f.claimed);

  it('serialises numbers and tool names only, bounded', () => {
    const c = createCrmEvidenceCollector();
    c.record('get_leads', { success: true, count: 3, leads: [{ email: 'jane@acme.com', firstName: 'Jane', dealValue: 98500 }] });
    const e = serializeCrmEvidence(c.snapshot());
    expect(e?.tools).toEqual(['get_leads']);
    expect(JSON.stringify(e)).not.toMatch(/jane|acme|98500/i);
    const many = createCrmEvidenceCollector();
    for (let i = 0; i < 150; i++) many.record('get_leads', { success: true, count: 1000 + i, leads: [] });
    const capped = serializeCrmEvidence(many.snapshot())!;
    expect(capped.numbers.length).toBeLessThanOrEqual(64);
    expect(capped.truncated).toBe(true);
    expect(serializeCrmEvidence(createCrmEvidenceCollector().snapshot())).toBeUndefined();
    expect(serializeCrmEvidence(undefined)).toBeUndefined();
  });

  it('a continuation restating the TASK\'s own total is not flagged (the numbers are on file)', () => {
    const h = [user('How many lists?'), asst('96', [call('get_lead_lists')], { crmEvidence: taskEvidence(['get_lead_lists', listsResult([5, 5, 3])]) }), user('continue')];
    expect(inv('Your CRM has 3 lead lists and 13 leads in total.', h)).toEqual([]);
  });

  it('a continuation restating a total from BEFORE the task IS flagged (this was the unfixable gap)', () => {
    const h = [
      user('How many lists?'), asst('96', [call('get_lead_lists')], { crmEvidence: taskEvidence(['get_lead_lists', listsResult(Array(96).fill(1))]) }),
      user('Find leads named Test'), asst('found 5', [call('search_leads')], { crmEvidence: taskEvidence(['search_leads', { count: 5, leads: [{}, {}, {}, {}, {}] }]) }),
      user('continue'),
    ];
    expect(inv('Your CRM has 96 lead lists.', h)).toEqual([96]);
    expect(inv('You have 5 leads in total across your CRM.', h)).toEqual([]);
  });

  it('abstains when an earlier invocation has no persisted evidence (messages saved before this existed)', () => {
    const h = [user('How many lists?'), asst('96', [call('get_lead_lists')]), user('continue')];
    expect(crmEvidenceFromEarlierInvocations(h).complete).toBe(false);
    expect(inv('Your CRM has 96 lead lists.', h)).toEqual([]);
  });

  it('abstains when the persisted evidence was truncated or a CRM write changed the totals in between', () => {
    const many = createCrmEvidenceCollector(); for (let i = 0; i < 150; i++) many.record('get_leads', { success: true, count: 1000 + i, leads: [] });
    const truncated = [user('go'), asst('x', [call('get_leads')], { crmEvidence: serializeCrmEvidence(many.snapshot()) }), user('continue')];
    expect(inv('Your CRM has 9999 lead lists.', truncated)).toEqual([]);
    const wrote = [user('go'), asst('x', [call('get_lead_lists'), call('add_leads_to_list', { result: { success: true } })], { crmEvidence: taskEvidence(['get_lead_lists', listsResult([1])]) }), user('continue')];
    expect(crmEvidenceFromEarlierInvocations(wrote).complete).toBe(false);
    expect(inv('Your CRM has 9999 lead lists.', wrote)).toEqual([]);
  });

  it('ignores malformed persisted evidence rather than trusting it', () => {
    for (const bad of [null, 'x', 5, [], { tools: 'get_leads', numbers: [1] }, { tools: ['get_leads'], numbers: 'no' }, { tools: ['rm_rf'], numbers: [1e30, -1, 'a'] }]) {
      const h = [user('go'), asst('x', [call('get_leads')], { crmEvidence: bad }), user('continue')];
      expect(() => crmEvidenceFromEarlierInvocations(h)).not.toThrow();
      expect(crmEvidenceFromEarlierInvocations(h).complete).toBe(false);
    }
  });

  it('drops tool names the guard does not know from stored evidence', () => {
    const h = [user('go'), asst('x', [call('get_leads')], { crmEvidence: { tools: ['rm_rf', 'get_leads', 42], numbers: [3] } }), user('continue')];
    expect(crmEvidenceFromEarlierInvocations(h).tools).toEqual(['get_leads']);
  });

  it('the current invocation own evidence still applies on top of the earlier evidence', () => {
    const h = [user('go'), asst('x', [call('get_leads')], { crmEvidence: taskEvidence(['get_leads', { count: 7, leads: [] }]) }), user('continue')];
    const c = createCrmEvidenceCollector(); c.record('get_lead_lists', listsResult([5, 5, 3]));
    expect(inv('Your CRM has 3 lead lists and 13 leads in total.', h, [call('get_lead_lists')], c.snapshot())).toEqual([]);
    expect(inv('Your CRM has 40 leads in total.', h, [call('get_lead_lists')], c.snapshot())).toEqual([40]);
  });
});

describe('what counts as asking to continue (ENG-2263)', () => {
  it.each(['continue', 'Continue.', 'continue!', 'ok continue', 'yes, please continue', 'go on', 'keep going', 'carry on', 'proceed', 'resume', 'go ahead', 'pick it up', 'continue with the rest'])('%p is a continue request', (t) => {
    expect(looksLikeContinueRequest(t)).toBe(true);
  });

  it.each([
    'continue. Remind me, how many lead lists do I have in total? Do not re-run anything.',
    'How many lead lists do I have?', 'yes', 'ok', 'thanks', 'what is the weather', 'discontinue the campaign', 'Please do not continue.',
    'continuing is not an option for this one at all really today', '', '   ', 'x'.repeat(500),
    'continue a b c d e f g h i j k',
  ])('%p is not', (t) => { expect(looksLikeContinueRequest(t)).toBe(false); });

  it.each([undefined, null, 5, {}, []])('%p is not (non-text)', (t) => { expect(looksLikeContinueRequest(t as any)).toBe(false); });

  const user = (content: string, metadata: any = {}) => ({ role: 'user', content, metadata });
  const asst = (content: string, tools: any[] = [], metadata: any = {}) => ({ role: 'assistant', content, metadata: { ...metadata, ...(tools.length ? { toolCalls: tools } : {}) } });
  const call = (name: string) => ({ id: name, name, arguments: {}, result: {} });

  it('after a time-limit partial, someone who ignores it and asks something new is NOT continuing', () => {
    const h = [user('Audit'), asst('x', [call('get_leads')]), asst('Partial - reply continue', [], { kind: 'generation-timeout-continuation' }), user('Actually, how many lead lists do I have?')];
    expect(crmToolsFromEarlierInvocations(h)).toEqual([]);
  });

  it('a typed "continue" counts even with NO marker (the step-budget and time-budget stops leave none)', () => {
    expect(crmToolsFromEarlierInvocations([user('Audit'), asst('Reached the step limit - reply continue', [call('get_leads')]), user('continue')])).toEqual(['get_leads']);
  });

  it('a long message that merely starts with "continue" is a new request', () => {
    const h = [user('How many lists?'), asst('96', [call('get_lead_lists')]), user('continue. Remind me how many lead lists I have in total? Do not re-run anything.')];
    expect(crmToolsFromEarlierInvocations(h)).toEqual([]);
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

  it('default sink writes ONE line of valid JSON and NEVER any reply text (names, emails, amounts)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Inventory finding FIRST and a tag finding after, with PII in the surrounding reply.
      const reply = 'Hi Jane Doe (jane.doe@acme.com), you have 18 lead lists and 47 leads in total, deal value $98,500 [verified: get_lead_lists]';
      runCrmFreshnessShadow({ finalText: reply, toolCalls: [], sessionId: 's9', model: 'm1' });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line.includes('\n')).toBe(false);
      const json = JSON.parse(line.slice(line.indexOf('{')));
      expect(json).toMatchObject({ sessionId: 's9', model: 'm1' });
      expect(json.kinds).toEqual(expect.arrayContaining(['cited_tool_not_run', 'inventory_total_not_in_tool_results']));
      expect(json.claimed).toEqual(expect.arrayContaining([18, 47]));
      expect(json.cited).toEqual(['get_lead_lists']);
      expect(Object.keys(json).sort()).toEqual(['cited', 'claimed', 'continuation', 'crmToolsSucceeded', 'drift', 'echoesEarlier', 'findingCount', 'kinds', 'model', 'sessionId', 'tagsSeen']);
      for (const secret of ['Jane', 'Doe', 'jane.doe', 'acme', '98,500', 'deal value', 'lead lists and']) expect(line).not.toContain(secret);
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

describe('review findings on the continuation + parsing paths (ENG-2263)', () => {
  it.each(['go ahead, how many lists now?', 'keep going and re-query', 'continue and tell me the total', 'proceed - how many leads?'])(
    '%p is a new request, not a bare continue', (t) => { expect(looksLikeContinueRequest(t)).toBe(false); });

  it.each(['go ahead please', 'continue from where you left off', 'ok keep going now', 'yes, continue.'])(
    '%p is still a continue', (t) => { expect(looksLikeContinueRequest(t)).toBe(true); });

  it('a "go ahead, how many lists now?" follow-up still has its stale restated total flagged', () => {
    const history = [
      { role: 'user', content: 'how many lists?' },
      { role: 'assistant', content: 'You have 18 lead lists.', metadata: { toolCalls: [ok('get_lead_lists')], crmEvidence: { numbers: [18], tools: ['get_lead_lists'] } } },
      { role: 'user', content: 'go ahead, how many lists now?' },
    ];
    const r = detectCrmFreshnessMismatch('You have 18 lead lists.', [], undefined, crmEvidenceFromEarlierInvocations(history));
    expect(r.findings.map((f) => f.kind)).toEqual(['inventory_total_not_in_tool_results']);
  });

  it('abstains on totals when the earlier invocation only WROTE to the CRM (the totals moved and nothing recorded them)', () => {
    const history = [
      { role: 'user', content: 'make a list' },
      { role: 'assistant', content: 'done', metadata: { toolCalls: [ok('create_lead_list')] } },
      { role: 'user', content: 'go', metadata: { kind: 'auto-continuation' } },
    ];
    const r = detectCrmFreshnessMismatch('You now have 18 lead lists.', [], undefined, crmEvidenceFromEarlierInvocations(history));
    expect(r.findings).toEqual([]);
  });

  it('a colon followed by a huge whitespace run does not stall the detector (quadratic lead-in regex)', () => {
    const t0 = Date.now();
    const r = detectCrmFreshnessMismatch('Note:' + ' '.repeat(80000) + 'x\nYou have 47 lead lists.', []);
    expect(Date.now() - t0).toBeLessThan(400);
    expect(r.findings).toHaveLength(1);
  });

  it('200k of claims with no paragraph breaks stays fast (unbounded paragraph search)', () => {
    const t0 = Date.now();
    detectCrmFreshnessMismatch('5 leads in total. '.repeat(11000), []);
    expect(Date.now() - t0).toBeLessThan(400);
  });
});

describe('sub-breakdown phrasing is not an inventory claim (ENG-2263)', () => {
  const calls = [ok('get_lead_lists')];
  it('"Calendly Bookings (23 across 2 lists)" inside a CRM breakdown does not claim 2 lists', () => {
    const text = 'Your CRM breakdown: Targeted Outreach & Events: SF B2C Exec Event (600), Calendly Bookings (23 across 2 lists).';
    const c = createCrmEvidenceCollector();
    c.record('get_lead_lists', { success: true, totalLists: 96, lists: [{ listId: 'a', leadCount: 600 }, { listId: 'b', leadCount: 23 }, { listId: 'c', leadCount: 9 }] });
    expect(detectCrmFreshnessMismatch(text, calls, c.snapshot()).findings).toEqual([]);
  });
  it('a real stale total phrased "N leads across K lists" is still flagged', () => {
    const c = createCrmEvidenceCollector();
    c.record('get_lead_lists', { success: true, totalLists: 96, lists: [{ listId: 'a', leadCount: 600 }] });
    expect(detectCrmFreshnessMismatch('Your CRM has 15,490 leads across 97 lists.', calls, c.snapshot()).findings.length).toBeGreaterThan(0);
  });
});

describe('per-category breakdown rows are not account totals (ENG-2263, seen live on the default model)', () => {
  const calls = [ok('get_lead_lists')];
  const ev = () => {
    const c = createCrmEvidenceCollector();
    c.record('get_lead_lists', { success: true, totalLists: 96, lists: [{ listId: 'a', leadCount: 600 }, { listId: 'b', leadCount: 23 }, { listId: 'c', leadCount: 9 }] });
    return c.snapshot();
  };
  const flagged = (text: string) => detectCrmFreshnessMismatch(text, calls, ev()).findings.map((f) => f.kind);

  it.each([
    '3. Test & QA Verifications (~110 leads across 25 lists) Small operational lists.',
    '4. Landing Page Capture & Inactive (51 lists)',
    'Calendly Bookings: 23 leads across 2 lists (17 and 6)',
    '- Calendly Bookings: 23 leads across 2 lists',
    'Six lists account for 14,829 of your total contacts:',
    '- Landing Page Lead Lists: 15+ dedicated capture lists',
    '<strong>Local Ops CRM Sync</strong> holds 4,850 contacts from your offline sync.',
    '- Populated Lists (>=1 lead): 58 lists',
    '- Empty Lists (0 leads): 37 lists (mostly landing page stubs)',
    '12 lists together hold most of the volume.',
  ])('%p is not a total', (t) => { expect(flagged(`Your CRM has 96 lists.\n${t}`)).toEqual([]); });

  it.each([
    'Your CRM: 15,490 leads across 97 lists',
    'Summary: 15,490 leads across 97 lists',
    'You have 97 lead lists (15,490 leads in total).',
    'Your CRM has 15,490 leads across 97 lists.',
    'Your total lead lists: 97 (15,490 leads in total)',
    'Your CRM currently holds 15,490 leads.',
    'The CRM database now contains 15,490 leads.',
  ])('%p is still a total claim', (t) => { expect(flagged(t)).toContain('inventory_total_not_in_tool_results'); });
});

describe('echoesEarlier: a flagged number an earlier turn of the session really returned (ENG-2263)', () => {
  const calls = [ok('get_lead_lists')];
  const fresh = () => {
    const c = createCrmEvidenceCollector();
    c.record('get_lead_lists', { success: true, totalLists: 17, lists: Array.from({ length: 17 }, (_, i) => ({ listId: 'l' + i, leadCount: i === 0 ? 26 : 1 })) });
    return c.snapshot();
  };
  const asst = (numbers: number[], extra: any = {}) => ({ role: 'assistant', content: 'x', metadata: { crmEvidence: { tools: ['get_lead_lists'], numbers }, ...extra } });
  const earlierTurn = [{ role: 'user', content: 'how many?' }, asst([18, 47]), { role: 'user', content: 'and now?' }];

  it('collects numbers from persisted assistant evidence only', () => {
    const h = [...earlierTurn, { role: 'user', content: 'u', metadata: { crmEvidence: { tools: ['get_lead_lists'], numbers: [999] } } }, asst([200])];
    expect([...crmNumbersFromSessionHistory(h)].sort((a, b) => a - b)).toEqual([18, 47, 200]);
  });

  it.each([undefined, null, 'x', 5, {}, [null, 1, 'a', { role: 'assistant' }, { role: 'assistant', metadata: 5 }, { role: 'assistant', metadata: { crmEvidence: { numbers: 'no', tools: [] } } }]])(
    'survives hostile history %p', (h) => { expect(() => crmNumbersFromSessionHistory(h)).not.toThrow(); expect(crmNumbersFromSessionHistory(h).size).toBe(0); });

  it('bounds how many numbers it keeps', () => {
    const h = Array.from({ length: 120 }, (_, i) => asst(Array.from({ length: 64 }, (_, j) => i * 100 + j + 1)));
    expect(crmNumbersFromSessionHistory(h).size).toBeLessThanOrEqual(2000);
  });

  it('marks a restated earlier total (18 lists / 47 leads) that this turn does not back', () => {
    const r = detectCrmFreshnessMismatch('You have 18 lead lists and 47 leads in total.', calls, fresh(), undefined, crmNumbersFromSessionHistory(earlierTurn));
    expect(r.findings.map((f) => [f.claimed, f.echoesEarlier])).toEqual([[18, true], [47, true]]);
  });

  it('does not mark a number no earlier turn returned (invented, or a subtotal)', () => {
    const r = detectCrmFreshnessMismatch('You have 52 lead lists.', calls, fresh(), undefined, crmNumbersFromSessionHistory(earlierTurn));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].echoesEarlier).toBeUndefined();
  });

  it('marks nothing when there is no earlier evidence (older session): absence means unknown, not not-stale', () => {
    expect(detectCrmFreshnessMismatch('You have 18 lead lists.', calls, fresh()).findings[0].echoesEarlier).toBeUndefined();
    expect(detectCrmFreshnessMismatch('You have 18 lead lists.', calls, fresh(), undefined, new Set()).findings[0].echoesEarlier).toBeUndefined();
  });

  it('a number this turn backs is not flagged at all, echo or not', () => {
    expect(detectCrmFreshnessMismatch('You have 17 lead lists.', calls, fresh(), undefined, new Set([17])).findings).toEqual([]);
  });

  it('matches a rounded claim ("1.2k") against an earlier exact value inside its range', () => {
    const r = detectCrmFreshnessMismatch('Your CRM has about 1.2k leads in total.', calls, fresh(), undefined, new Set([1180]));
    expect(r.findings[0]?.echoesEarlier).toBe(true);
  });

  it('the log line carries the echo count and still only numbers', () => {
    const logs: any[] = [];
    runCrmFreshnessShadow({ finalText: 'You have 18 lead lists and 52 leads in total.', toolCalls: calls, evidence: fresh(), sessionNumbers: new Set([18, 47]), log: (_m, d) => logs.push(d) });
    expect(logs[0]).toMatchObject({ echoesEarlier: 1, claimed: [18, 52] });
  });

  it.each(['Across all 18 CRM lists, there are 5 leads whose first name contains "Test".', 'Your total CRM size remains 47 leads.', 'The CRM size is 47 leads.'])(
    '%p is read as a total claim', (t) => {
      expect(detectCrmFreshnessMismatch(t, calls, fresh()).findings.length).toBeGreaterThan(0);
    });

  it.each(['Across all 17 CRM lists, there are 5 leads.', 'The CRM size is 42 leads.'])('%p is backed and not flagged', (t) => {
    expect(detectCrmFreshnessMismatch(t, calls, fresh()).findings).toEqual([]);
  });
});

describe('"combined count of N leads" phrasing (ENG-2263, seen from a scheduled run)', () => {
  const calls = [ok('get_lead_lists')];
  const fresh = () => {
    const c = createCrmEvidenceCollector();
    c.record('get_lead_lists', { success: true, totalLists: 97, lists: [{ listId: 'a', leadCount: 15390 }, ...Array.from({ length: 96 }, (_, i) => ({ listId: 'l' + i, leadCount: 1 }))] });
    return c.snapshot();
  };

  it.each([
    'You have <strong>97 lead lists</strong> in total, containing a combined count of <strong>12,746 leads</strong>.',
    'Your CRM has 97 lead lists with an overall count of 12,746 leads.',
    'Your CRM has 97 lead lists with an aggregate total of 12,746 leads.',
    'Your CRM has 97 lead lists, a combined number of 12,746 leads.',
  ])('flags an unbacked sum in %p', (t) => {
    const f = detectCrmFreshnessMismatch(t, calls, fresh()).findings;
    expect(f.map((x) => x.claimed)).toEqual([12746]);
  });

  it('does not flag the same wording when the number is the real sum', () => {
    expect(detectCrmFreshnessMismatch('You have 97 lead lists in total, containing a combined count of 15,486 leads.', calls, fresh()).findings).toEqual([]);
  });

  it('does not flag it without CRM wording nearby', () => {
    expect(detectCrmFreshnessMismatch('The campaign reached a combined count of 12,746 leads from three sources.', calls, fresh()).findings).toEqual([]);
  });
});

describe('a REAL time-limit partial persists no evidence, so a "continue" after it abstains on totals (ENG-2263)', () => {
  const calls = [ok('get_lead_lists')];
  const fresh = () => {
    const c = createCrmEvidenceCollector();
    c.record('get_lead_lists', { success: true, totalLists: 97, lists: [{ listId: 'a', leadCount: 15400 }, ...Array.from({ length: 96 }, (_, i) => ({ listId: 'l' + i, leadCount: 1 }))] });
    return c.snapshot();
  };
  const marker = (extra: any = {}) => ({ role: 'assistant', content: 'Partial results', metadata: { kind: 'generation-timeout-continuation', ...extra } });
  const realTimeout = [{ role: 'user', content: 'analyse my CRM' }, marker(), { role: 'user', content: 'continue' }];
  const total = 'Your CRM has 97 lead lists holding 15,497 leads in total.';

  it('abstains: the earlier turn ran CRM tools whose results were never persisted', () => {
    const e = crmEvidenceFromEarlierInvocations(realTimeout);
    expect(e.complete).toBe(false);
    expect(detectCrmFreshnessMismatch(total, [ok('get_leads')], undefined, e).findings).toEqual([]);
  });

  it('still flags the same claim on a plain follow-up after a timeout (not a continue request)', () => {
    const h = [{ role: 'user', content: 'analyse my CRM' }, marker(), { role: 'user', content: 'how many lead lists do I have now?' }];
    const e = crmEvidenceFromEarlierInvocations(h);
    expect(e.complete).toBe(true);
    expect(detectCrmFreshnessMismatch(total, calls, fresh(), e).findings.map((f) => f.kind)).toEqual(['inventory_total_not_in_tool_results']);
  });

  it('a timeout message that DID persist evidence is still credited and checked (no abstain)', () => {
    const h = [{ role: 'user', content: 'x' }, marker({ toolCalls: [ok('get_lead_lists')], crmEvidence: { tools: ['get_lead_lists'], numbers: [97, 15497] } }), { role: 'user', content: 'continue' }];
    const e = crmEvidenceFromEarlierInvocations(h);
    expect(e.complete).toBe(true);
    const c = createCrmEvidenceCollector();
    c.record('get_leads', { success: true, leads: [{ firstName: 'a' }], count: 1 });
    expect(detectCrmFreshnessMismatch(total, [ok('get_leads')], c.snapshot(), e).findings).toEqual([]);
    expect(detectCrmFreshnessMismatch('Your CRM has 55 lead lists.', [ok('get_leads')], c.snapshot(), e).findings).toHaveLength(1);
  });

  it('the tag check is unaffected by the abstain', () => {
    const e = crmEvidenceFromEarlierInvocations(realTimeout);
    expect(detectCrmFreshnessMismatch('97 lists [verified: get_lead_lists]', [], undefined, e).findings.map((f) => f.kind)).toEqual(['cited_tool_not_run']);
  });

  it('an unrelated assistant message with no marker does not trigger it', () => {
    const h = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'continue' }];
    expect(crmEvidenceFromEarlierInvocations(h).complete).toBe(true);
  });
});
