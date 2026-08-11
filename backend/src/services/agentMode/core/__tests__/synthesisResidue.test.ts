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

describe('isUnusableSynthesis', () => {
  it('flags the exact production residue "}]"', () => {
    expect(isUnusableSynthesis('}]')).toBe(true);
  });

  it('flags other structural-punctuation-only remnants', () => {
    for (const residue of ['}', ']', '}}', '"}]', '},{', '  }]\n', '{"', ':', '[{}]', '",']) {
      expect(isUnusableSynthesis(residue)).toBe(true);
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
