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
