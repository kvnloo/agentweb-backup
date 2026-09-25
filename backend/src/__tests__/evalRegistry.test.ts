/**
 * ENG-2134 / ENG-2128 principle 2: "Unvalidated judges cannot gate or alert."
 */
import * as fs from 'fs';
import * as path from 'path';
import { EVAL_REGISTRY, MIN_KAPPA, MIN_VALIDATION_N, mayGate } from '../loops/eval/evalRegistry';

describe('eval registry', () => {
  it('has unique grader ids', () => {
    const ids = EVAL_REGISTRY.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lets no grader gate without a recorded validation meeting kappa and n', () => {
    for (const g of EVAL_REGISTRY) {
      const v = g.validation;
      const qualifies = !!v && v.kappa >= MIN_KAPPA && v.n >= MIN_VALIDATION_N;
      expect({ id: g.id, mayGate: mayGate(g.id) }).toEqual({ id: g.id, mayGate: qualifies });
    }
    expect(mayGate('no-such-grader')).toBe(false);
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
      for (const f of files.filter((x) => !x.startsWith('partner-portal'))) {
        expect({ id: g.id, file: f, exists: fs.existsSync(path.join(srcRoot, f)) })
          .toEqual({ id: g.id, file: f, exists: true });
      }
    }
  });
});
