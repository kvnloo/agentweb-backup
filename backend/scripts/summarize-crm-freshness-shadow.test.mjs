import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLines, parseCheckedLines, summarize, summarizeChecked, format, unwrapAwsLogs } from './summarize-crm-freshness-shadow.mjs';

const line = (o) => `[Worker] [crm-freshness-shadow] CRM freshness mismatch (message NOT modified) ${JSON.stringify(o)}`;

test('aggregates by model and kind, ignores unrelated and broken lines', () => {
  const log = [
    'AgentMode: something else',
    line({ sessionId: 's1', model: 'gemini-3.1-flash-lite', kinds: ['cited_tool_not_run'], cited: ['get_lead_lists'], claimed: [] }),
    line({ sessionId: 's1', model: 'gemini-3.1-flash-lite', kinds: ['inventory_total_not_in_tool_results'], claimed: [47, 18], cited: [] }),
    line({ sessionId: 's2', model: 'gpt-4o-mini', kinds: ['inventory_total_not_in_tool_results'], claimed: [47], cited: [] }),
    '[crm-freshness-shadow] CRM freshness mismatch {not json',
    '[crm-freshness-shadow] no braces at all',
  ].join('\n');
  const { records, skipped } = parseLines(log);
  assert.equal(records.length, 3);
  assert.equal(skipped, 2);
  const s = summarize(records);
  assert.equal(s.totalLines, 3);
  assert.equal(s.distinctSessions, 2);
  assert.equal(s.byModel['gemini-3.1-flash-lite'].lines, 2);
  assert.deepEqual(s.byModel['gemini-3.1-flash-lite'].kinds, { cited_tool_not_run: 1, inventory_total_not_in_tool_results: 1 });
  assert.equal(s.byModel['gpt-4o-mini'].claimedNumbers[47], 1);
  assert.equal(s.byModel['gemini-3.1-flash-lite'].claimedNumbers[18], 1, 'second claimed number is counted, not just the first');
  assert.equal(s.byModel['gemini-3.1-flash-lite'].citedTools['get_lead_lists'], 1);
  assert.match(format(s, skipped), /gemini-3\.1-flash-lite: 2 line\(s\), 1 session\(s\)/);
});

test('counts arithmetic-drift findings per model and says so in the output', () => {
  const log = [
    line({ sessionId: 's1', model: 'm1', kinds: ['inventory_total_not_in_tool_results'], claimed: [15479], cited: [], drift: 1 }),
    line({ sessionId: 's2', model: 'm1', kinds: ['inventory_total_not_in_tool_results'], claimed: [6000], cited: [], drift: 0 }),
    line({ sessionId: 's3', model: 'm1', kinds: ['cited_tool_not_run'], claimed: [], cited: ['get_lead_lists'] }), // older line, no drift key
  ].join('\n');
  const { records } = parseLines(log);
  const s = summarize(records);
  assert.equal(s.byModel.m1.drift, 1);
  assert.match(format(s, 0), /arithmetic drift .*: 1/);
  assert.doesNotMatch(format(summarize(parseLines(line({ sessionId: 'x', model: 'm2', kinds: [], claimed: [1], cited: [] })).records), 0), /arithmetic drift/);
});

test('says so when there is nothing', () => {
  assert.match(format(summarize([]), 0), /no \[crm-freshness-shadow\] lines found/);
});

test('splits stale-looking lines (restate an earlier turn\'s number) from merely unbacked ones, and says what absence means', () => {
  const text = [
    line({ sessionId: 's1', model: 'm1', kinds: ['inventory_total_not_in_tool_results'], claimed: [18, 47], cited: [], drift: 0, echoesEarlier: 2 }),
    line({ sessionId: 's2', model: 'm1', kinds: ['inventory_total_not_in_tool_results'], claimed: [76], cited: [], drift: 0, echoesEarlier: 0 }),
    line({ sessionId: 's3', model: 'm1', kinds: ['cited_tool_not_run'], claimed: [], cited: ['get_lead_lists'] }), // older line, no echo key
  ].join('\n');
  const s = summarize(parseLines(text).records);
  assert.equal(s.byModel.m1.echoLines, 1);
  assert.equal(s.byModel.m1.echoes, 2);
  assert.match(format(s, 0), /EARLIER turn.*: 1 of 3 line\(s\).*predates persisted evidence/);
  assert.doesNotMatch(format(summarize(parseLines(line({ sessionId: 'x', model: 'm2', kinds: [], claimed: [1], cited: [] })).records), 0), /EARLIER turn/);
});

// ENG-2382: the flagged lines alone had no denominator and no way to tell a coincidence from a stale restatement.
const checked = (o) => `[Worker] [crm-freshness-checked] CRM reply checked ${JSON.stringify(o)}`;

test('parses the per-reply checked lines and ignores the flagged ones and broken ones', () => {
  const text = [
    checked({ model: 'm1', flagged: false, findingCount: 0, tagsSeen: 1, claimsSeen: 0, crmToolsSucceeded: 1, totalsAbstained: false }),
    checked({ model: 'm1', flagged: true, findingCount: 1, tagsSeen: 0, claimsSeen: 2, crmToolsSucceeded: 0, totalsAbstained: false }),
    line({ sessionId: 's1', model: 'm1', kinds: ['cited_tool_not_run'], claimed: [], cited: [] }),
    '[crm-freshness-checked] CRM reply checked {not json',
  ].join('\n');
  const { records, skipped } = parseCheckedLines(text);
  assert.equal(records.length, 2);
  assert.equal(skipped, 1);
  assert.equal(parseLines(text).records.length, 1, 'the shadow parser is unchanged by the new marker');
});

test('gives a flag rate per model from the checked lines (the denominator)', () => {
  const text = [
    ...Array.from({ length: 8 }, () => checked({ model: 'm1', flagged: false, claimsSeen: 0, tagsSeen: 1, crmToolsSucceeded: 1, totalsAbstained: false })),
    ...Array.from({ length: 2 }, () => checked({ model: 'm1', flagged: true, claimsSeen: 1, tagsSeen: 0, crmToolsSucceeded: 0, totalsAbstained: false })),
    checked({ model: 'm2', flagged: false, claimsSeen: 1, tagsSeen: 0, crmToolsSucceeded: 1, totalsAbstained: true }),
  ].join('\n');
  const c = summarizeChecked(parseCheckedLines(text).records);
  assert.deepEqual([c.m1.checked, c.m1.flagged, c.m2.checked, c.m2.abstained], [10, 2, 1, 1]);
  const out = format(summarize(parseLines(line({ sessionId: 's', model: 'm1', kinds: ['cited_tool_not_run'], claimed: [], cited: [] })).records), 0, c);
  assert.match(out, /m1: .*\n[\s\S]*CRM replies checked: 10, flagged: 2 \(20%\)/);
});

test('says how crowded the session number set was for the stale-looking lines, and what that means', () => {
  const text = [
    line({ sessionId: 's1', model: 'm1', kinds: ['inventory_total_not_in_tool_results'], claimed: [14], cited: [], echoesEarlier: 1, sessionNumberCount: 40, sessionDensity20: 0.6, sessionMessages: 647 }),
    line({ sessionId: 's2', model: 'm1', kinds: ['inventory_total_not_in_tool_results'], claimed: [5], cited: [], echoesEarlier: 1, sessionNumberCount: 10, sessionDensity20: 0.2, sessionMessages: 30 }),
    line({ sessionId: 's3', model: 'm1', kinds: ['inventory_total_not_in_tool_results'], claimed: [0], cited: [], echoesEarlier: 1 }), // older line, no density keys
    line({ sessionId: 's4', model: 'm1', kinds: ['inventory_total_not_in_tool_results'], claimed: [9], cited: [], echoesEarlier: 0, sessionNumberCount: 99, sessionDensity20: 0.9 }),
    line({ sessionId: 's5', model: 'm1', kinds: ['inventory_total_not_in_tool_results'], claimed: [2], cited: [], echoesEarlier: 1, sessionNumberCount: 12, sessionDensity20: 0.2 }),
  ].join('\n');
  const s = summarize(parseLines(text).records);
  assert.deepEqual(s.byModel.m1.echoDensities, [0.6, 0.2, 0.2], 'only stale-looking lines that carry the key; older lines are skipped');
  const out = format(s, 0);
  assert.match(out, /session number set on those lines: density of 0\.\.20 median 0\.2 \(range 0\.2-0\.6\)/);
  assert.match(out, /crowded set means a match is expected by chance/);
});

test('the density sentence is absent when no stale-looking line carries the key', () => {
  const s = summarize(parseLines(line({ sessionId: 's', model: 'm1', kinds: [], claimed: [1], cited: [], echoesEarlier: 1 })).records);
  assert.doesNotMatch(format(s, 0), /density of 0\.\.20/);
});

test('a model with checked lines but NO flagged lines still shows its denominator (the best-behaved model)', () => {
  const c = summarizeChecked(parseCheckedLines([
    ...Array.from({ length: 4 }, () => checked({ model: 'clean-model', flagged: false, claimsSeen: 0, tagsSeen: 1, crmToolsSucceeded: 1, totalsAbstained: false })),
  ].join('\n')).records);
  const out = format(summarize([]), 0, c);
  assert.match(out, /clean-model: 0 line\(s\)/);
  assert.match(out, /CRM replies checked: 4, flagged: 0 \(0%\)/);
  assert.doesNotMatch(out, /no \[crm-freshness-shadow\] lines found/, 'checked data alone is not "nothing found"');
  assert.doesNotMatch(out, /kinds:/, 'no empty kinds line for a model with nothing flagged');
});

test('a small flag rate is not rounded down to 0%', () => {
  const rows = [...Array.from({ length: 199 }, () => ({ model: 'm', flagged: false })), { model: 'm', flagged: true }];
  const out = format(summarize(parseLines(line({ sessionId: 's', model: 'm', kinds: ['cited_tool_not_run'], claimed: [], cited: [] })).records), 0, summarizeChecked(rows));
  assert.match(out, /checked: 200, flagged: 1 \(0\.5%\)/);
});

test('says nothing found only when there are neither flagged nor checked lines', () => {
  assert.match(format(summarize([]), 0, {}), /no \[crm-freshness-shadow\] lines found/);
});

test('warns when there are flagged lines but no checked lines, because the pull filter was too narrow to include the denominator', () => {
  const flagged = summarize(parseLines(line({ sessionId: 's', model: 'm', kinds: ['cited_tool_not_run'], claimed: [], cited: [] })).records);
  const out = format(flagged, 0, {});
  assert.match(out, /no \[crm-freshness-checked\] lines/);
  assert.match(out, /--filter-pattern/, 'tells the reader which filter to use');
  const withChecked = format(flagged, 0, summarizeChecked([{ model: 'm', flagged: true }]));
  assert.doesNotMatch(withChecked, /no \[crm-freshness-checked\] lines/);
  assert.doesNotMatch(format(summarize([]), 0, {}), /no \[crm-freshness-checked\] lines/, 'nothing at all is not a warning');
});

test('splits the flag rate by how many of the integers 0..20 the session number set holds, and skips lines that lack the key', () => {
  const rows = [
    ...Array.from({ length: 40 }, () => ({ model: 'm', flagged: false, sessionNumberCount: 5, sessionDensity20: 0.1 })),
    { model: 'm', flagged: true, sessionNumberCount: 5, sessionDensity20: 0.1 },
    ...Array.from({ length: 9 }, () => ({ model: 'm', flagged: false, sessionNumberCount: 30, sessionDensity20: 0.62 })),
    ...Array.from({ length: 3 }, () => ({ model: 'm', flagged: true, sessionNumberCount: 30, sessionDensity20: 0.62 })),
    { model: 'm', flagged: true },
  ];
  const c = summarizeChecked(rows);
  assert.deepEqual(c.m.byDensity.sparse, { checked: 41, flagged: 1 });
  assert.deepEqual(c.m.byDensity.crowded, { checked: 12, flagged: 3 });
  assert.deepEqual(c.m.byDensity.mid, { checked: 0, flagged: 0 });
  const out = format(summarize(parseLines(line({ sessionId: 's', model: 'm', kinds: ['cited_tool_not_run'], claimed: [], cited: [] })).records), 0, c);
  assert.match(out, /flag rate by how many of the integers 0\.\.20 the session number set holds \(all flag kinds; this only bears on echo lines\): .*sparse 0-4 1\/41 \(2\.4%\), mid 5-10 0\/0, crowded 11-21 3\/12 \(25%\)/);
});

test('an EMPTY session number set (first turn, no earlier evidence) is its own bucket and does not pollute "sparse"', () => {
  const rows = [
    ...Array.from({ length: 10 }, () => ({ model: 'm', flagged: false, sessionNumberCount: 0, sessionDensity20: 0 })),
    { model: 'm', flagged: true, sessionNumberCount: 0, sessionDensity20: 0 },
    { model: 'm', flagged: false, sessionNumberCount: 3, sessionDensity20: 0 },
  ];
  const c = summarizeChecked(rows);
  assert.deepEqual(c.m.byDensity.none, { checked: 11, flagged: 1 });
  assert.deepEqual(c.m.byDensity.sparse, { checked: 1, flagged: 0 });
  const out = format(summarize(parseLines(line({ sessionId: 's', model: 'm', kinds: ['cited_tool_not_run'], claimed: [], cited: [] })).records), 0, c);
  assert.match(out, /empty set 1\/11 \(9\.1%\)/);
});

test('density buckets use the values the guard can actually emit (k of 21 integers, 2 dp): 4 and 5 split sparse/mid, 10 and 11 split mid/crowded', () => {
  const d = (k) => Math.round((k / 21) * 100) / 100;
  const c = summarizeChecked(Array.from({ length: 22 }, (_, k) => ({ model: 'm', flagged: false, sessionNumberCount: 30, sessionDensity20: d(k) })));
  assert.deepEqual([c.m.byDensity.sparse.checked, c.m.byDensity.mid.checked, c.m.byDensity.crowded.checked], [5, 6, 11], 'k=0..4 sparse, 5..10 mid, 11..21 crowded');
  const edge = (k) => summarizeChecked([{ model: 'm', flagged: false, sessionNumberCount: 30, sessionDensity20: d(k) }]).m.byDensity;
  assert.equal(edge(4).sparse.checked, 1); assert.equal(edge(5).mid.checked, 1);
  assert.equal(edge(10).mid.checked, 1); assert.equal(edge(11).crowded.checked, 1);
});

test('splits the flag rate by session length (messages in the history at the start of the turn), skipping lines without it', () => {
  const rows = [
    ...Array.from({ length: 30 }, () => ({ model: 'm', flagged: false, sessionMessages: 12 })),
    { model: 'm', flagged: false, sessionMessages: 49 },
    { model: 'm', flagged: true, sessionMessages: 50 },
    ...Array.from({ length: 4 }, () => ({ model: 'm', flagged: false, sessionMessages: 199 })),
    { model: 'm', flagged: false, sessionMessages: 200 },
    ...Array.from({ length: 2 }, () => ({ model: 'm', flagged: true, sessionMessages: 647 })),
    { model: 'm', flagged: true },
  ];
  const c = summarizeChecked(rows);
  assert.deepEqual(c.m.byLength.short, { checked: 31, flagged: 0 });
  assert.deepEqual(c.m.byLength.medium, { checked: 5, flagged: 1 });
  assert.deepEqual(c.m.byLength.long, { checked: 3, flagged: 2 });
  const out = format(summarize(parseLines(line({ sessionId: 's', model: 'm', kinds: ['cited_tool_not_run'], claimed: [], cited: [] })).records), 0, c);
  assert.match(out, /flag rate by session length \(messages\): short <50 0\/31 \(0%\), medium 50-199 1\/5 \(20%\), long 200\+ 2\/3 \(67%\)/);
});

test('no density line when no checked line carries the key (older lines)', () => {
  const out = format(summarize(parseLines(line({ sessionId: 's', model: 'm', kinds: ['cited_tool_not_run'], claimed: [], cited: [] })).records), 0, summarizeChecked([{ model: 'm', flagged: false }]));
  assert.doesNotMatch(out, /by session number-set density/);
});

test('no session-length line when no checked line carries sessionMessages', () => {
  const out = format(summarize(parseLines(line({ sessionId: 's', model: 'm', kinds: ['cited_tool_not_run'], claimed: [], cited: [] })).records), 0, summarizeChecked([{ model: 'm', flagged: false, sessionDensity20: 0.3 }]));
  assert.doesNotMatch(out, /by session length/);
});

test('a model with flagged lines but no checked lines says so while other models have a rate', () => {
  const text = [
    line({ sessionId: 's1', model: 'retired-model', kinds: ['cited_tool_not_run'], claimed: [], cited: [] }),
    line({ sessionId: 's2', model: 'live-model', kinds: ['cited_tool_not_run'], claimed: [], cited: [] }),
  ].join('\n');
  const out = format(summarize(parseLines(text).records), 0, summarizeChecked([{ model: 'live-model', flagged: true }]));
  assert.match(out, /retired-model: 1 line\(s\)[\s\S]*no checked lines for this model/);
  assert.doesNotMatch(out.split('live-model:')[1], /no checked lines for this model/);
});

test('says when flagged and checked-flagged counts differ (the pull window straddles the deploy), and not when they agree', () => {
  const flagged = (n) => Array.from({ length: n }, (_, i) => line({ sessionId: 's' + i, model: 'm', kinds: ['cited_tool_not_run'], claimed: [], cited: [] })).join('\n');
  const checkedFor = (nFlagged) => summarizeChecked([...Array.from({ length: nFlagged }, () => ({ model: 'm', flagged: true })), { model: 'm', flagged: false }]);
  const straddle = format(summarize(parseLines(flagged(5)).records), 0, checkedFor(2));
  assert.match(straddle, /5 flagged line\(s\) but 2 flagged checked line\(s\).*straddles the deploy/);
  assert.doesNotMatch(format(summarize(parseLines(flagged(2)).records), 0, checkedFor(2)), /straddles the deploy/);
});

test('counts unparseable checked lines, and does not call them "no checked lines"', () => {
  const flagged = summarize(parseLines(line({ sessionId: 's', model: 'm', kinds: ['cited_tool_not_run'], claimed: [], cited: [] })).records);
  const out = format(flagged, 0, {}, 3);
  assert.match(out, /unparseable checked lines: 3/);
  assert.match(out, /3 \[crm-freshness-checked\] lines could not be parsed/);
  assert.doesNotMatch(out, /no \[crm-freshness-checked\] lines:/);
});

test('reads the aws logs JSON (the output of filter-log-events) as well as plain log text', () => {
  const msgs = [
    line({ sessionId: 's1', model: 'm', kinds: ['cited_tool_not_run'], claimed: [], cited: [] }),
    checked({ model: 'm', flagged: true, claimsSeen: 0, tagsSeen: 1, crmToolsSucceeded: 0, totalsAbstained: false }),
    'unrelated line',
  ];
  const awsJson = JSON.stringify({ events: msgs.map((message, i) => ({ message, timestamp: i, eventId: String(i) })), searchedLogStreams: [] });
  const text = unwrapAwsLogs(awsJson);
  assert.equal(parseLines(text).records.length, 1);
  assert.equal(parseCheckedLines(text).records.length, 1);
  assert.equal(parseLines(text).skipped, 0, 'no escaped-quote garbage from the JSON wrapper');
  const plain = msgs.join('\n');
  assert.equal(unwrapAwsLogs(plain), plain, 'plain log text passes through unchanged');
  assert.equal(unwrapAwsLogs('{"not":"aws"}'), '{"not":"aws"}', 'JSON without events passes through');
  assert.equal(unwrapAwsLogs('{broken'), '{broken', 'a broken document is not swallowed');
  assert.equal(unwrapAwsLogs(JSON.stringify({ events: [{ message: 5 }, null, {}] })), '\n\n', 'events without a string message contribute nothing');
});
