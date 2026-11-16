/**
 * ENG-2134 / ENG-2128 principle 2: "Unvalidated judges cannot gate or alert."
 */
import * as fs from 'fs';
import * as path from 'path';
import { EVAL_REGISTRY, MIN_KAPPA, MIN_VALIDATION_N, isQualifyingValidation, mayGate } from '../loops/eval/evalRegistry';

describe('eval registry', () => {
  it('has unique grader ids', () => {
    const ids = EVAL_REGISTRY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lets no grader gate today: none has a qualifying validation (2026-09-25 audit)', () => {
    for (const g of EVAL_REGISTRY) {
      expect({ id: g.id, mayGate: mayGate(g.id) }).toEqual({ id: g.id, mayGate: isQualifyingValidation(g.validation) });
      expect({ id: g.id, mayGate: mayGate(g.id) }).toEqual({ id: g.id, mayGate: false });
    }
    expect(mayGate('no-such-grader')).toBe(false);
  });

  it('qualifies a validation only with kappa, n, an http(s) evidence link and HUMAN labels together', () => {
    const ok = { kappa: MIN_KAPPA, n: MIN_VALIDATION_N, date: '2026-09-25', evidence: 'https://linear.app/emmabyaw/issue/ENG-2136', labelSource: 'human' as const };
    expect(isQualifyingValidation(ok)).toBe(true);
    // A record that does not say its labels are human can never qualify a grader, so a hand-written registry entry
    // has to claim human labels explicitly (ENG-2135).
    expect(isQualifyingValidation({ ...ok, labelSource: undefined })).toBe(false);
    expect(isQualifyingValidation({ ...ok, labelSource: 'ai' as unknown as 'human' })).toBe(false);
    expect(isQualifyingValidation({ ...ok, kappa: MIN_KAPPA - 0.01 })).toBe(false);
    expect(isQualifyingValidation({ ...ok, n: MIN_VALIDATION_N - 1 })).toBe(false);
    expect(isQualifyingValidation({ ...ok, evidence: 'see slack' })).toBe(false);
    expect(isQualifyingValidation({ ...ok, evidence: 'ftp://example.com/run' })).toBe(false);
    expect(isQualifyingValidation(undefined)).toBe(false);
  });

  it('requires evidence for every recorded validation', () => {
    for (const g of EVAL_REGISTRY.filter((x) => x.validation)) {
      expect(g.validation!.evidence).toMatch(/^https?:\/\//);
    }
  });

  it('points every code source at a file that exists', () => {
    const srcRoot = path.join(__dirname, '..');
    for (const g of EVAL_REGISTRY) {
      const files = g.source.match(/[\w./-]+\.tsx?/g) || [];
      // Only backend sources are checkable from here; other repos are named with a "<repo>:" prefix.
      if (/^[\w-]+:/.test(g.source)) continue;
      for (const f of files.filter((x) => !x.startsWith('partner-portal'))) {
        expect({ id: g.id, file: f, exists: fs.existsSync(path.join(srcRoot, f)) })
          .toEqual({ id: g.id, file: f, exists: true });
      }
    }
  });
});
