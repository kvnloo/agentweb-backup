import { nameTokensMatch } from '../utils/nameMatch';

describe('nameTokensMatch', () => {
  it('matches identical names (case-insensitive)', () => {
    expect(nameTokensMatch('Joe', 'Hio', 'joe', 'HIO')).toBe(true);
  });

  it('rejects when both tokens differ', () => {
    expect(nameTokensMatch('Awais', 'Haider', 'Joe', 'Hio')).toBe(false);
  });

  it('rejects when only the first name differs', () => {
    expect(nameTokensMatch('Bob', 'Hio', 'Joe', 'Hio')).toBe(false);
  });

  it('rejects when only the last name differs', () => {
    expect(nameTokensMatch('Joe', 'Smith', 'Joe', 'Hio')).toBe(false);
  });

  it('allows nickname / prefix matches in both directions', () => {
    expect(nameTokensMatch('Robert', 'Hio', 'Rob', 'Hio')).toBe(true);
    expect(nameTokensMatch('Rob', 'Hio', 'Robert', 'Hio')).toBe(true);
  });

  it('treats an empty token as "no constraint"', () => {
    expect(nameTokensMatch('Joe', '', 'Joe', 'Hio')).toBe(true);
    expect(nameTokensMatch('', '', 'Joe', 'Hio')).toBe(true);
    expect(nameTokensMatch(undefined, null, 'Joe', 'Hio')).toBe(true);
  });

  it('still rejects on a populated contradicting token even when the other side is empty', () => {
    expect(nameTokensMatch('Awais', '', 'Joe', 'Hio')).toBe(false);
  });

  // ─── Initials, punctuation, and accents ──────────────────────────────────
  // People are listed with initials ("P. Graham"), accented characters
  // ("José"), and punctuated surnames ("O'Brien"). Normalization must recover
  // these as matches WITHOUT loosening the wrong-person guard.

  it('matches a dotted initial against the full first name (both directions)', () => {
    expect(nameTokensMatch('Paul', 'Graham', 'P.', 'Graham')).toBe(true);
    expect(nameTokensMatch('P.', 'Graham', 'Paul', 'Graham')).toBe(true);
  });

  it('matches a bare initial against the full first name', () => {
    expect(nameTokensMatch('Paul', 'Graham', 'P', 'Graham')).toBe(true);
  });

  it('still rejects a WRONG initial', () => {
    // "Q" is not a prefix of "Paul" → must stay a reject.
    expect(nameTokensMatch('Paul', 'Graham', 'Q', 'Graham')).toBe(false);
  });

  it('matches across accent differences (José ↔ Jose)', () => {
    expect(nameTokensMatch('José', 'Garcia', 'Jose', 'Garcia')).toBe(true);
    expect(nameTokensMatch('Renée', 'Dubois', 'Renee', 'Dubois')).toBe(true);
  });

  it('matches across apostrophes / punctuation in surnames (O\'Brien ↔ OBrien)', () => {
    expect(nameTokensMatch('Sean', "O'Brien", 'Sean', 'OBrien')).toBe(true);
    expect(nameTokensMatch('Sean', 'O Brien', 'Sean', "O'Brien")).toBe(true);
  });

  it('matches a dotted middle-initial form like "J.R." against "JR" / "J R"', () => {
    expect(nameTokensMatch('J.R.', 'Smith', 'JR', 'Smith')).toBe(true);
  });

  it('matches a concatenated first+middle initial against the full first name', () => {
    // Lead stored as full "Paul Graham"; LinkedIn profile shows "P.G. Graham"
    // (first + middle initial). The first initial must still match "Paul".
    expect(nameTokensMatch('Paul', 'Graham', 'P.G.', 'Graham')).toBe(true);
    expect(nameTokensMatch('P.G.', 'Graham', 'Paul', 'Graham')).toBe(true);
    expect(nameTokensMatch('Paul', 'Graham', 'P. G.', 'Graham')).toBe(true);
  });

  it('rejects a multi-initial whose FIRST initial is wrong', () => {
    // "Q.G." → first initial "q" is not a prefix of "Paul" → reject.
    expect(nameTokensMatch('Paul', 'Graham', 'Q.G.', 'Graham')).toBe(false);
  });

  it('does NOT let punctuation-stripping create a false match between different names', () => {
    // Stripping punctuation must not collapse genuinely different surnames.
    expect(nameTokensMatch('Paul', "O'Brien", 'Paul', 'Obrienson')).toBe(true); // prefix — acceptable (Obrien… ⊂ Obrienson)
    expect(nameTokensMatch('Paul', "O'Brien", 'Paul', 'Murphy')).toBe(false);
  });

  it('rejects a single wrong-letter initial on the last name', () => {
    expect(nameTokensMatch('Paul', 'Graham', 'Paul', 'H')).toBe(false);
  });
});
