// Tests for the real-context-size + resume-base-selection helpers that back /context and the
// "what will the next turn actually resume" number. Run: node test/context-usage.test.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transcriptContextUsed, pickResumeBase } from '../chat/context-usage.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const asst = (u, model = 'claude-opus-4-8') => JSON.stringify({ type: 'assistant', message: { model, usage: u } });
const userLine = (t) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: t }] } });

// ── transcriptContextUsed: reads the LAST assistant usage = the real current context ──
console.log('transcriptContextUsed');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'ctx-'));
  try {
    // invalid: missing file → null
    ok(transcriptContextUsed(path.join(dir, 'nope.jsonl')) === null, 'missing file → null');

    // boundary: a transcript with no assistant-usage lines → null
    const f1 = path.join(dir, 'a.jsonl');
    writeFileSync(f1, [userLine('hi'), userLine('there')].join('\n') + '\n');
    ok(transcriptContextUsed(f1) === null, 'no assistant usage → null');

    // happy: sums input + cache_read + cache_creation of the LAST assistant line, returns model
    const f2 = path.join(dir, 'b.jsonl');
    writeFileSync(f2, [
      asst({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 1000 }),
      userLine('next'),
      asst({ input_tokens: 5, cache_read_input_tokens: 14932, cache_creation_input_tokens: 381970 }),
    ].join('\n') + '\n');
    const r = transcriptContextUsed(f2);
    ok(r && r.contextUsed === 5 + 14932 + 381970, `last-assistant tokens summed (got ${r && r.contextUsed})`);
    ok(r && r.model === 'claude-opus-4-8', 'model returned');

    // error path: malformed JSON + a trailing zero-usage line are skipped; earlier real usage wins
    const f3 = path.join(dir, 'c.jsonl');
    writeFileSync(f3, [
      asst({ input_tokens: 3, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0 }),
      '{ this is not json',
      asst({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), // zero → skipped
      '',
    ].join('\n') + '\n');
    const r3 = transcriptContextUsed(f3);
    ok(r3 && r3.contextUsed === 200003, `malformed + zero-usage skipped, real usage found (got ${r3 && r3.contextUsed})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── pickResumeBase: mirrors runTurn's non-edit session selection (server.mjs ~810-825) ──
console.log('pickResumeBase');
{
  const WT = '/wt/ENG-1', ROOT = '/root';
  const opt = (o) => ({ cwd: WT, agentRoot: ROOT, pipelineSid: null, ...o });

  // the ENG-200 bug shape: a stored chat session WINS even when a compactSummary exists — which is
  // exactly why a stale compact never shrinks what the next turn resumes.
  const r1 = pickResumeBase({ sessions: { chat: 'S1' }, compactSummary: 'x'.repeat(400), cwd: WT }, opt());
  ok(r1.kind === 'session' && r1.sid === 'S1', 'chat session wins over a present compactSummary');

  // no chat session but a compactSummary → fresh, seeded from the summary (small token estimate)
  const r2 = pickResumeBase({ sessions: {}, compactSummary: 'x'.repeat(400) }, opt());
  ok(r2.kind === 'compact' && r2.tokens === Math.round(400 / 4) + 3000, `compact seed sized from summary (got ${r2.tokens})`);

  // DEFAULT (resumePipeline off): a first chat turn does NOT resume the 300-400k fixer transcript —
  // it seeds a fresh curated context instead. This is the whole point of the context-curation change.
  const r3 = pickResumeBase({ sessions: {} }, opt({ pipelineSid: 'FIX' }));
  ok(r3.kind === 'fresh', 'default: pipeline session NOT resumed (curated fresh context)');

  // opt-in (resumePipeline true) restores the old resume-the-fixer behavior
  const r3b = pickResumeBase({ sessions: {} }, opt({ pipelineSid: 'FIX', resumePipeline: true }));
  ok(r3b.kind === 'session' && r3b.sid === 'FIX', 'resumePipeline=true resumes the pipeline session');

  // nothing at all → fresh
  const r4 = pickResumeBase({ sessions: {} }, opt());
  ok(r4.kind === 'fresh', 'no base → fresh');

  // a chat session recorded under a DIFFERENT cwd must not be resumed here (sameCwd=false)
  const r5 = pickResumeBase({ sessions: { chat: 'S1' }, cwd: '/other' }, opt());
  ok(r5.kind !== 'session' || r5.sid !== 'S1', 'chat session from a different cwd is not reused');

  // even with resumePipeline on, a pipeline session is NOT resumed at agentRoot (read-only main checkout)
  const r6 = pickResumeBase({ sessions: {} }, { cwd: ROOT, agentRoot: ROOT, pipelineSid: 'FIX', resumePipeline: true });
  ok(r6.kind === 'fresh', 'pipeline session not used at agentRoot');

  // an existing chat session is always continued, regardless of the flag
  const r7 = pickResumeBase({ sessions: { chat: 'C1' }, cwd: WT }, opt({ pipelineSid: 'FIX' }));
  ok(r7.kind === 'session' && r7.sid === 'C1', 'existing chat session is continued (not the pipeline)');
}

console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
