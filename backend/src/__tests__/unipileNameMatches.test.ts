// Tests for unipileNameMatches — the name validator used by the v3.1
// enrichment waterfall's Unipile (tier 3.5) LinkedIn URL lookup.
//
// Unipile's people-search endpoint returns a combined `name` field rather
// than separate first_name / last_name. The validator must accept those
// responses, not silently reject every match.

import { unipileNameMatches } from '../services/enrichmentV3RealDeps';

describe('unipileNameMatches — combined `name` field (Unipile people-search shape)', () => {
  it('accepts an item that only has `name` matching firstName + lastName', () => {
    // Repro: Ayush Jha search returned exactly one match with `name: "Ayush Jha"`
    // and `public_identifier: "ayushjha17"` — no first_name/last_name. The
    // pre-fix validator rejected this, dropping the LinkedIn URL.
    expect(
      unipileNameMatches({ name: 'Ayush Jha', public_identifier: 'ayushjha17' }, 'Ayush', 'Jha'),
    ).toBe(true);
  });

  it('accepts when `name` has a middle name between first and last', () => {
    expect(
      unipileNameMatches({ name: 'Ayush Kumar Jha' }, 'Ayush', 'Jha'),
    ).toBe(true);
  });

  it('rejects when `name` last token does not match leadLast', () => {
    expect(
      unipileNameMatches({ name: 'Ayush Smith' }, 'Ayush', 'Jha'),
    ).toBe(false);
  });

  it('rejects when `name` first token does not match leadFirst', () => {
    expect(
      unipileNameMatches({ name: 'Bob Jha' }, 'Ayush', 'Jha'),
    ).toBe(false);
  });

  it('rejects when neither `name` nor first_name/last_name is present', () => {
    expect(
      unipileNameMatches({ public_identifier: 'x' }, 'Ayush', 'Jha'),
    ).toBe(false);
  });

  it('ignores a leading emoji/symbol token so the real first name is compared', () => {
    // Live finding: a profile named "💡 Paul Graham" split to tokens
    // ["💡","Paul","Graham"], taking "💡" as the first name. After
    // normalization that token is empty → treated as "no constraint", which
    // let a WRONG first initial ("Q") slip through. The splitter must drop
    // symbol-only tokens BEFORE choosing first/last.
    expect(unipileNameMatches({ name: '💡 Paul Graham' }, 'Paul', 'Graham')).toBe(true);
    expect(unipileNameMatches({ name: '💡 Paul Graham' }, 'Q', 'Graham')).toBe(false);
  });

  it('accepts a dotted-initial first name against the combined `name` field', () => {
    expect(unipileNameMatches({ name: 'Paul Graham' }, 'P.', 'Graham')).toBe(true);
  });
});

describe('unipileNameMatches — separate first_name / last_name (existing behavior)', () => {
  it('accepts on exact match', () => {
    expect(
      unipileNameMatches({ first_name: 'Ayush', last_name: 'Jha' }, 'Ayush', 'Jha'),
    ).toBe(true);
  });

  it('rejects on mismatch', () => {
    expect(
      unipileNameMatches({ first_name: 'Bob', last_name: 'Smith' }, 'Ayush', 'Jha'),
    ).toBe(false);
  });

  it('prefers first_name / last_name over name when both are present', () => {
    // Conflict: split fields say "Bob Smith", combined `name` says "Ayush Jha".
    // The split fields win — they are the authoritative shape.
    expect(
      unipileNameMatches(
        { first_name: 'Bob', last_name: 'Smith', name: 'Ayush Jha' },
        'Ayush', 'Jha',
      ),
    ).toBe(false);
  });
});
