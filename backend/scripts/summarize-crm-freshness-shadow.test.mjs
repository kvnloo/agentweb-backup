import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLines, summarize, format } from './summarize-crm-freshness-shadow.mjs';

const line = (o) => `[Worker] [crm-freshness-shadow] CRM freshness mismatch (message NOT modified) ${JSON.stringify(o)}`;

test('aggregates by model and kind, ignores unrelated and broken lines', () => {
  const log = [
    'AgentMode: something else',
    line({ sessionId: 's1', model: 'gemini-3.1-flash-lite', kinds: ['cited_tool_not_run'], sample: { kind: 'cited_tool_not_run', tag: '[verified: get_lead_lists]' } }),
    line({ sessionId: 's1', model: 'gemini-3.1-flash-lite', kinds: ['inventory_total_not_in_tool_results'], sample: { kind: 'inventory_total_not_in_tool_results', claimed: 47 } }),
    line({ sessionId: 's2', model: 'gpt-4o-mini', kinds: ['inventory_total_not_in_tool_results'], sample: { claimed: 47 } }),
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
  assert.match(format(s, skipped), /gemini-3\.1-flash-lite: 2 line\(s\), 1 session\(s\)/);
});

test('says so when there is nothing', () => {
  assert.match(format(summarize([]), 0), /no \[crm-freshness-shadow\] lines found/);
});
