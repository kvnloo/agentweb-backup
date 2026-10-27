import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLines, parseCheckedLines, summarize, summarizeChecked, format } from './summarize-crm-freshness-shadow.mjs';

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
