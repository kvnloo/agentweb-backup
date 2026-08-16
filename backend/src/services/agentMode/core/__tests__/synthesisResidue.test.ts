/**
 * Unit tests for the PURE final-synthesis residue guard (ENG-1054).
 *
 * The production failure this pins: a 215-message session whose closing assistant
 * message was the literal string "}]" — serialization residue, not an answer. The
 * loop shipped it because its only "failed synthesis" check was `!content`.
 */

import {
  isUnusableSynthesis,
  buildExecutedActionsFallback,
} from '../synthesisResidue';
import { SYNTHESIS_NUDGE } from '../termination';

describe('isUnusableSynthesis', () => {
  it('flags the exact production residue "}]"', () => {
    expect(isUnusableSynthesis('}]')).toBe(true);
  });

  it('flags other structural-punctuation-only remnants', () => {
    for (const residue of ['}', ']', '}}', '"}]', '},{', '  }]\n', '{"', ':', '",']) {
      expect(isUnusableSynthesis(residue)).toBe(true);
    }
  });

  // Greptile P1: punctuation-only is not the same as unusable. A COMPLETE value is
  // a legitimate answer to "return an empty object" or "show me the list", and
  // discarding it would replace the user's answer with the synthesis-failure recap.
  // Residue never parses; a complete value always does.
  it('does NOT flag short but COMPLETE JSON values', () => {
    for (const valid of ['{}', '[]', '[{}]', '{ }', '[ ]', '[{},{}]', '""', '[""]']) {
      expect(isUnusableSynthesis(valid)).toBe(false);
    }
  });

  it('does NOT flag empty/whitespace content (the existing empty-synthesis ladder owns that)', () => {
    for (const empty of ['', '   ', '\n\t']) {
      expect(isUnusableSynthesis(empty)).toBe(false);
    }
  });

  it('does NOT flag short but genuine answers', () => {
    for (const real of ['Yes.', 'Done', 'OK', '42', 'Paused both campaigns.', '✅', '...', '—']) {
      expect(isUnusableSynthesis(real)).toBe(false);
    }
  });

  it('does NOT flag a long response that merely ends in structural punctuation', () => {
    expect(isUnusableSynthesis('I paused both campaigns. Here is the JSON I used: {"status":"PAUSED"}')).toBe(false);
  });

  // Message 163 of the production session: the model transcribed the preceding
  // tool result back as its own answer — 20,081 chars opening with the loop's own
  // degraded-history marker. Too long for the punctuation rule, same failure.
  it('flags a reply that echoes the loop\'s degraded tool history', () => {
    const echo =
      '[Result of call_meta_marketing_api: {"success":true,"message":"Found 25 ad(s)","ads":['
      + '{"id":"120248669405960585","name":"P3 A1"}'.repeat(200)
      + '\n\n[Content truncated — full response in S3]}}';
    expect(echo.length).toBeGreaterThan(1000);
    expect(isUnusableSynthesis(echo)).toBe(true);
  });

  it('flags a reply that opens with the degraded tool-call marker', () => {
    expect(isUnusableSynthesis('[Previously called call_meta_marketing_api({"action":"UPDATE"})]')).toBe(true);
  });

  // Observed live: driving the synthesis retry into a failure state made the model
  // collapse into a repetition loop and ship 180,180 chars — 30,791 words built
  // from 65 unique tokens — straight into the transcript.
  it('flags a degenerate repetition collapse', () => {
    const collapse = 'If you need to output a code block ensure it is properly enclosed. '
      + 'group '.repeat(20000);
    expect(collapse.length).toBeGreaterThan(100_000);
    expect(isUnusableSynthesis(collapse)).toBe(true);
  });

  it('does NOT flag long genuine prose with a normal vocabulary', () => {
    // ~600 words of varied text — the shape the guard must never touch.
    const words: string[] = [];
    for (let i = 0; i < 600; i++) words.push(`campaign${i} spend${i} result${i}`.split(' ')[i % 3]);
    const prose = words.join(' ');
    expect(prose.split(/\s+/).length).toBeGreaterThan(300);
    expect(isUnusableSynthesis(prose)).toBe(false);
  });

  it('does NOT flag a long but legitimately repetitive status list', () => {
    // A real answer can repeat heavily — 10-15% unique is normal for a table.
    const rows: string[] = [];
    for (let i = 0; i < 400; i++) rows.push(`- Campaign ${i} status PAUSED budget 3000 daily`);
    expect(isUnusableSynthesis(rows.join('\n'))).toBe(false);
  });

  it('does NOT flag a short repetitive answer below the word floor', () => {
    expect(isUnusableSynthesis('yes '.repeat(50))).toBe(false);
  });

  // ENG-1188: a 101-message gemini-3.1-pro-preview work-plan session generated and
  // screenshot-verified the corrected ad assets, then closed with the model echoing
  // the injected synthesis nudge back verbatim instead of writing the delivery
  // message — three repeats in 744 chars, well under isDegenerateRepetition's
  // 1000-char/300-word floor, so the real answer never reached the user even though
  // the guard built for exactly this failure class (ENG-1054/946) was already live.
  it('flags a reply that echoes the injected synthesis nudge back verbatim', () => {
    const echo = `${SYNTHESIS_NUDGE} ${SYNTHESIS_NUDGE} ${SYNTHESIS_NUDGE}`;
    expect(echo.length).toBeLessThan(1000);
    expect(isUnusableSynthesis(echo)).toBe(true);
  });

  // ENG-1188 follow-up: a terminating turn whose ENTIRE content is exactly one bare
  // copy of the nudge is non-empty, so it never re-triggers the empty-synthesis
  // retry ladder in termination.ts either — it must be caught here.
  it('flags a reply that is exactly one bare copy of the nudge', () => {
    expect(isUnusableSynthesis(SYNTHESIS_NUDGE)).toBe(true);
  });

  // Pins the exact >= 2 cutoff used by isNudgeEcho, distinct from the 3-repeat and
  // exact-single-copy cases already covered above.
  it('flags exactly two verbatim copies of the nudge (the boundary)', () => {
    expect(isUnusableSynthesis(`${SYNTHESIS_NUDGE} ${SYNTHESIS_NUDGE}`)).toBe(true);
  });

  it('does NOT flag a single quoted mention of the nudge text', () => {
    expect(
      isUnusableSynthesis(`I saw the system message "${SYNTHESIS_NUDGE}" and then finished the export.`)
    ).toBe(false);
  });

  it('does NOT flag prose that merely mentions a tool result', () => {
    for (const real of [
      'The result of call_meta_marketing_api was a success — both campaigns are paused.',
      'Here is what I found. [Result data is summarized below.]',
      '[Note] I previously called the Meta API to pause both campaigns.',
    ]) {
      expect(isUnusableSynthesis(real)).toBe(false);
    }
  });

  it('does NOT flag a large brace blob (only short remnants are residue)', () => {
    expect(isUnusableSynthesis('}'.repeat(200))).toBe(false);
  });

  it('is defensive about non-string input', () => {
    for (const bad of [null, undefined, 42, {}, []] as any[]) {
      expect(isUnusableSynthesis(bad)).toBe(false);
    }
  });
});

describe('buildExecutedActionsFallback', () => {
  it('reports each executed tool with its success/failure counts', () => {
    const text = buildExecutedActionsFallback([
      { name: 'call_meta_marketing_api' },
      { name: 'call_meta_marketing_api' },
      { name: 'call_meta_marketing_api', error: 'boom' },
      { name: 'list_knowledge_base_files' },
    ]);
    expect(text).toContain('call_meta_marketing_api');
    expect(text).toContain('2 succeeded');
    expect(text).toContain('1 failed');
    expect(text).toContain('list_knowledge_base_files');
  });

  it('warns the user not to re-run already-applied actions', () => {
    const text = buildExecutedActionsFallback([{ name: 'call_meta_marketing_api' }]);
    expect(text.toLowerCase()).toContain('already');
  });

  it('never claims work happened when no tools ran', () => {
    const text = buildExecutedActionsFallback([]);
    expect(text).toContain('No actions were taken');
    expect(text).not.toContain('succeeded');
  });

  it('tolerates malformed ledger entries without throwing', () => {
    const text = buildExecutedActionsFallback([null, undefined, {}, { name: '' }] as any[]);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});
